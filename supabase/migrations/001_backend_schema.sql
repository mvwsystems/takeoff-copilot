-- ============================================================
-- Takeoff Copilot — Backend Migration 001
-- Adds: storage bucket, projects, sheets, line_items, processing_jobs
-- ============================================================

-- Storage bucket (100 MB per-file limit)
insert into storage.buckets (id, name, public, file_size_limit)
values ('plan-uploads', 'plan-uploads', false, 104857600)
on conflict (id) do nothing;

-- Storage RLS: authenticated users can upload
create policy "auth users can upload plans"
  on storage.objects for insert
  with check (
    bucket_id = 'plan-uploads'
    and auth.role() = 'authenticated'
  );

-- Storage RLS: users can read files under their own user-id folder
create policy "users read own plan files"
  on storage.objects for select
  using (
    bucket_id = 'plan-uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Storage RLS: service role can read/write everything (for background functions)
create policy "service role full access to plans"
  on storage.objects for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── projects ─────────────────────────────────────────────────
create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users not null,
  name       text,
  status     text not null default 'active',
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create policy "users own projects"
  on public.projects for all
  using (auth.uid() = user_id);

-- ── sheets ───────────────────────────────────────────────────
-- One record per page after rasterization.
-- Before rasterization: one record per uploaded PDF (page_number = 1).
create table if not exists public.sheets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.projects on delete cascade not null,
  page_number   int not null default 1,
  classification text,
  dpi           int not null default 150,
  storage_path  text,   -- path in plan-uploads bucket (page image after rasterization)
  file_id       text,   -- Anthropic Files API file_id for the source PDF
  created_at    timestamptz not null default now()
);

alter table public.sheets enable row level security;

create policy "users own sheets"
  on public.sheets for all
  using (
    project_id in (
      select id from public.projects where user_id = auth.uid()
    )
  );

-- ── line_items ───────────────────────────────────────────────
-- Normalized per-analysis takeoff items (for future aggregation).
create table if not exists public.line_items (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid references public.projects on delete cascade not null,
  category          text,
  description       text,
  quantity          numeric,
  unit              text,
  confidence        text,
  confidence_note   text,
  depth_avg         numeric,
  depth_max         numeric,
  depth_bucket_json jsonb,
  source_sheet      uuid references public.sheets,
  status            text not null default 'active',
  created_at        timestamptz not null default now()
);

alter table public.line_items enable row level security;

create policy "users own line items"
  on public.line_items for all
  using (
    project_id in (
      select id from public.projects where user_id = auth.uid()
    )
  );

-- ── processing_jobs ──────────────────────────────────────────
-- Pipeline progress tracking. One record per uploaded PDF.
-- Stages: pending → uploaded → processing → ready | error
create table if not exists public.processing_jobs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects on delete cascade not null,
  stage       text not null default 'pending',
  progress    int not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.processing_jobs enable row level security;

create policy "users own processing jobs"
  on public.processing_jobs for all
  using (
    project_id in (
      select id from public.projects where user_id = auth.uid()
    )
  );

-- Auto-update updated_at on any row change
create or replace function public.set_updated_at()
returns trigger language plpgsql security definer as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists processing_jobs_set_updated_at on public.processing_jobs;
create trigger processing_jobs_set_updated_at
  before update on public.processing_jobs
  for each row execute function public.set_updated_at();

-- Enable realtime on processing_jobs so dashboard can subscribe
alter publication supabase_realtime add table public.processing_jobs;
