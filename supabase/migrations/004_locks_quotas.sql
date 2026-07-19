-- ============================================================
-- Takeoff Copilot — Migration 004: pipeline locks + usage quotas
--
-- lease_until: cooperative lock so two invocations of the analysis
--   background function can never run the same job concurrently
--   (double Anthropic spend + duplicated line_items).
-- sheets unique index: re-running triage upserts pages instead of
--   inserting duplicates that double every downstream quantity.
-- usage_events: server-side record of AI spend per user, the basis
--   for per-user quota enforcement in the edge functions.
-- ============================================================

alter table public.processing_jobs
  add column if not exists lease_until timestamptz;

create unique index if not exists sheets_project_page_uidx
  on public.sheets (project_id, page_number);

create table if not exists public.usage_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,            -- 'analysis_job' | 'single_call' | 'chat' | 'doc_parse'
  project_id uuid references public.projects(id) on delete set null,
  est_usd    numeric,
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

-- Users may see their own usage; only the service role / edge functions
-- write rows (no user INSERT policy on purpose).
drop policy if exists "users read own usage" on public.usage_events;
create policy "users read own usage" on public.usage_events
  for select using (auth.uid() = user_id);

drop policy if exists "usage_admin" on public.usage_events;
create policy "usage_admin" on public.usage_events
  for select using (is_admin());

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);
