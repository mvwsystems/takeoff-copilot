-- ============================================================
-- Takeoff Copilot — Migration 007: correction feedback loop + accuracy
--
-- Every estimator correction (inline edit, clarification answer, chat edit)
-- is recorded structurally — not just buried in a result_json blob — so
-- accuracy is measurable and the corrections become the raw material for
-- versioned Brain rules. accuracy_stats() rolls it up for the admin dashboard.
-- ============================================================

create table if not exists public.corrections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  project_id     uuid references public.projects(id) on delete set null,
  job_id         uuid references public.jobs(id) on delete set null,
  item_no        int,
  description    text,
  field          text,     -- 'quantity' | 'unit' | 'description' | 'depth' | 'added' | 'removed' | 'note'
  original_value text,
  corrected_value text,
  source         text,     -- 'inline_edit' | 'clarification' | 'chat'
  screening_grade text,
  created_at     timestamptz not null default now()
);

alter table public.corrections enable row level security;

drop policy if exists "users insert own corrections" on public.corrections;
create policy "users insert own corrections" on public.corrections
  for insert with check (auth.uid() = user_id);

drop policy if exists "users read own corrections" on public.corrections;
create policy "users read own corrections" on public.corrections
  for select using (auth.uid() = user_id);

drop policy if exists "corrections_admin" on public.corrections;
create policy "corrections_admin" on public.corrections
  for select using (is_admin());

create index if not exists corrections_created_idx on public.corrections (created_at desc);

-- House accuracy rollup (admin only). Agreement rate = share of AI line items
-- the estimator did NOT have to correct. Also rolls up engineer-table variance
-- (how often our quantity landed within 5% / 15% of the engineer's printed table).
create or replace function public.accuracy_stats()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  res jsonb;
begin
  if not is_admin() then
    return jsonb_build_object('error', 'forbidden');
  end if;

  with items as (
    select j.id, coalesce(j.screening_grade, '?') as grade,
           jsonb_array_elements(coalesce(j.result_json->'items', '[]'::jsonb)) as it
    from public.jobs j
    where jsonb_typeof(j.result_json->'items') = 'array'
  ),
  per_item as (
    select id, grade, (it->>'edited') = 'true' as edited from items
  ),
  agg as (
    select count(*)::int as total, count(*) filter (where edited)::int as edited from per_item
  ),
  by_grade as (
    select grade, count(*)::int as total, count(*) filter (where edited)::int as edited
    from per_item group by grade
  ),
  variance as (
    select
      coalesce(sum((ar.result_json->'calibration_score'->'vs_engineer'->>'matched')::int), 0)   as matched,
      coalesce(sum((ar.result_json->'calibration_score'->'vs_engineer'->>'within_5')::int), 0)  as within_5,
      coalesce(sum((ar.result_json->'calibration_score'->'vs_engineer'->>'within_15')::int), 0) as within_15
    from public.analysis_results ar
    where jsonb_typeof(ar.result_json->'calibration_score'->'vs_engineer') = 'object'
  )
  select jsonb_build_object(
    'takeoffs', (select count(distinct id) from items),
    'line_items', (select total from agg),
    'edited_items', (select edited from agg),
    'agreement_rate', (select case when total > 0 then round((1 - edited::numeric / total) * 100, 1) end from agg),
    'by_grade', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'grade', grade, 'total', total, 'edited', edited,
        'agreement', case when total > 0 then round((1 - edited::numeric / total) * 100, 1) end
      ) order by grade), '[]'::jsonb) from by_grade
    ),
    'engineer_matched', (select matched from variance),
    'engineer_within_5', (select within_5 from variance),
    'engineer_within_15', (select within_15 from variance),
    'corrections', (select count(*)::int from public.corrections)
  ) into res;

  return res;
end;
$$;

revoke execute on function public.accuracy_stats() from anon;
