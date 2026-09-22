-- ── Jurisdiction spec library ────────────────────────────────────
-- One row per municipality. rules_text is the PRE-DIGESTED estimating
-- ruleset for that city (bedding, testing, casing, concrete structure
-- requirements, inspection quirks) — injected into the analysis brain
-- whenever a job's plans are detected as that jurisdiction. The customer
-- never uploads a city spec the library already knows.
--
-- Seeding is service-role only (SQL editor / admin tooling):
--   insert into jurisdiction_specs (slug, display_name, rules_text, source_url, effective_date)
--   values ('fort-worth-tx', 'City of Fort Worth, TX', '- All PVC gravity sewer requires mandrel + air test ...', 'https://...', '2025-01-01');
--
-- The analysis worker reads with the service role and FAILS OPEN — a
-- missing row (or this table not yet migrated) never blocks a run.

create table if not exists jurisdiction_specs (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,             -- normalized key, e.g. 'baytown-tx'
  display_name text not null,            -- e.g. 'City of Baytown, TX'
  state text not null default 'TX',
  rules_text text,                       -- digested rules injected into the brain
  spec_storage_path text,                -- optional: source spec PDF in plan-uploads
  source_url text,                       -- where the city publishes the standard
  effective_date date,                   -- spec revision date (cities revise!)
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table jurisdiction_specs enable row level security;
-- No RLS policies on purpose: only the service role (worker + admin seeding)
-- touches this table. End users see the applied rules through the report.
