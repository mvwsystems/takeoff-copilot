-- ============================================================
-- Takeoff Copilot — Migration 010: vendor book + RFQ send/quote loop
--
-- vendors: the contractor's reusable supplier contacts. `preferred` pins a
-- vendor so future RFQs pre-select them.
--
-- rfqs: one row per RFQ email sent to one vendor. Carries a snapshot of the
-- items and contacts at send time (quotes must stay stable even if the
-- takeoff is re-run or the vendor is edited). `token` is the capability key
-- for the public quote-submission page — vendors have no accounts; the edge
-- function resolves tokens with the service role. When the vendor submits,
-- quote_json is filled, status flips to 'quoted', and the contractor is
-- notified by email naming the job.
-- ============================================================

create table if not exists public.vendors (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,             -- contact person
  company    text,                      -- e.g. Core & Main, Ferguson
  email      text not null,
  phone      text,
  preferred  boolean not null default false,
  notes      text,
  created_at timestamptz not null default now()
);

alter table public.vendors enable row level security;

drop policy if exists "users own vendors" on public.vendors;
create policy "users own vendors" on public.vendors
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists vendors_user_idx on public.vendors (user_id);

create table if not exists public.rfqs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  project_id      uuid references public.projects(id) on delete cascade,
  vendor_id       uuid references public.vendors(id) on delete set null,
  vendor_snapshot jsonb not null,       -- {name, company, email} at send time
  user_email      text not null,        -- reply-to + quote notifications
  user_name       text,
  user_company    text,
  project_name    text,
  token           text not null unique, -- public quote-page capability key
  message         text,                 -- the contractor's note to the vendor
  items_json      jsonb not null,       -- [{category, description, spec, quantity, unit}]
  status          text not null default 'sent',  -- sent | quoted
  quote_json      jsonb,                -- {lines:[{i, unit_price, note}], notes, lead_time, submitted_at}
  quoted_at       timestamptz,
  created_at      timestamptz not null default now()
);

alter table public.rfqs enable row level security;

-- Owner can read and delete their RFQs from the app. Inserts and quote
-- updates happen ONLY through the edge functions (service role): sending is
-- where email goes out, and the public quote page must not require a login.
drop policy if exists "users read own rfqs" on public.rfqs;
create policy "users read own rfqs" on public.rfqs
  for select using (auth.uid() = user_id);

drop policy if exists "users delete own rfqs" on public.rfqs;
create policy "users delete own rfqs" on public.rfqs
  for delete using (auth.uid() = user_id);

create index if not exists rfqs_user_idx    on public.rfqs (user_id);
create index if not exists rfqs_project_idx on public.rfqs (project_id);
