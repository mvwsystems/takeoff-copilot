-- ============================================================
-- Takeoff Copilot — Migration 002: schema sync
-- Captures everything applied to the live DB after 001 that was
-- never committed (the former "migrations 002–009").
-- Idempotent: safe to run on the live DB (no-op) or a fresh one.
-- ============================================================

-- ── profiles ─────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text,
  company    text,
  phone      text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_own" on public.profiles;
create policy "profiles_own" on public.profiles
  for all using (auth.uid() = id);

-- Auto-create a profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- NOTE (manual step, not in this migration): the live DB also has a
-- trigger "notify-new-signup" AFTER INSERT ON public.profiles that calls
-- supabase_functions.http_request(
--   '<SITE_URL>/.netlify/functions/notify-signup', 'POST',
--   '{"Content-type":"application/json","x-webhook-secret":"<WEBHOOK_SECRET>"}',
--   '{}', '5000');
-- It embeds the webhook secret, so it is created via the Supabase
-- dashboard (Database → Webhooks), never committed here.

-- ── jobs (single-call analysis history) ──────────────────────
create table if not exists public.jobs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  project_id          uuid references public.projects(id) on delete set null,
  plan_filename       text,
  geotech_filename    text,
  screening_grade     text,
  screening_rationale text,
  line_item_count     int default 0,
  risk_flag_count     int default 0,
  result_json         jsonb,
  created_at          timestamptz default now()
);

alter table public.jobs enable row level security;

drop policy if exists "Users can insert own jobs" on public.jobs;
create policy "Users can insert own jobs" on public.jobs
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users can read own jobs" on public.jobs;
create policy "Users can read own jobs" on public.jobs
  for select using (auth.uid() = user_id);

drop policy if exists "jobs_own" on public.jobs;
create policy "jobs_own" on public.jobs
  for all using (auth.uid() = user_id);

-- ── feedback ─────────────────────────────────────────────────
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references public.jobs(id),
  user_id     uuid not null references auth.users(id),
  rating      int,
  comments    text,
  corrections text,
  created_at  timestamptz not null default now()
);

alter table public.feedback enable row level security;

drop policy if exists "users insert own feedback" on public.feedback;
create policy "users insert own feedback" on public.feedback
  for insert with check (auth.uid() = user_id);

drop policy if exists "users read own feedback" on public.feedback;
create policy "users read own feedback" on public.feedback
  for select using (auth.uid() = user_id);

-- ── admin access ─────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from auth.users
    where id = auth.uid()
      and email in ('mattvincentwalker@gmail.com', 'mvw@mattvincentwalker.com', 'hello@6signal.co')
  );
$$;

drop policy if exists "profiles_admin" on public.profiles;
create policy "profiles_admin" on public.profiles
  for select using (is_admin());

drop policy if exists "jobs_admin" on public.jobs;
create policy "jobs_admin" on public.jobs
  for select using (is_admin());

drop policy if exists "feedback_admin" on public.feedback;
create policy "feedback_admin" on public.feedback
  for select using (is_admin());

-- ── materials ────────────────────────────────────────────────
create table if not exists public.materials (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  category     text not null,
  image_path   text not null,
  spec_summary text,
  aliases_json jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

alter table public.materials enable row level security;

drop policy if exists "materials readable by authenticated" on public.materials;
create policy "materials readable by authenticated" on public.materials
  for select using (auth.role() = 'authenticated' or auth.role() = 'service_role');

-- ── analysis_results (pipeline consolidated report) ──────────
create table if not exists public.analysis_results (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  job_id      uuid not null references public.processing_jobs(id) on delete cascade,
  result_json jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.analysis_results enable row level security;

drop policy if exists "users own analysis results" on public.analysis_results;
create policy "users own analysis results" on public.analysis_results
  for all using (
    project_id in (select id from public.projects where user_id = auth.uid())
  );

-- ── analysis_tiles (resumable pipeline tile cache) ───────────
-- RLS enabled with NO user policies on purpose: only the service
-- role (background functions) reads/writes tiles.
create table if not exists public.analysis_tiles (
  job_id      uuid not null references public.processing_jobs(id) on delete cascade,
  pass        text not null,
  tile_key    text not null,
  result_json jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (job_id, pass, tile_key)
);

alter table public.analysis_tiles enable row level security;

create index if not exists analysis_tiles_job_pass_idx
  on public.analysis_tiles (job_id, pass);

-- ── column drift on 001 tables ───────────────────────────────
alter table public.projects
  add column if not exists geotech_rock_depth_ft        numeric,
  add column if not exists geotech_groundwater_depth_ft numeric,
  add column if not exists geotech_summary              text,
  add column if not exists calibration_truth            jsonb;

alter table public.sheets
  add column if not exists included_in_analysis boolean not null default true,
  add column if not exists sheet_number         text,
  add column if not exists sheet_title          text;

alter table public.processing_jobs
  add column if not exists stage_detail text,
  add column if not exists kind         text not null default 'plan_processing',
  add column if not exists batch_state  jsonb,
  add column if not exists config       jsonb;

comment on table public.processing_jobs is
  'Pipeline tracking. kind=plan_processing stages: pending → uploaded → processing → triage_complete | error. kind=analysis stages: analysis_queued → analysis_pass_1..5 → complete | error';
