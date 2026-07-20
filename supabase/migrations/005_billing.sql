-- ============================================================
-- Takeoff Copilot — Migration 005: pay-per-takeoff billing
--
-- Model: free account + free history + free upload/triage/sheet-map.
-- $97 is charged the FIRST time a plan set (project) runs the multi-pass
-- analysis. Re-runs / retries of that same project are free (projects.paid_at).
-- A credit = one paid takeoff. Stripe Checkout grants credits; starting a
-- new project's analysis consumes one.
-- ============================================================

-- Per-project paid marker — charged once, then re-runs are free.
alter table public.projects
  add column if not exists paid_at timestamptz;

-- Credit balance per user (source of truth is the ledger; this is the fast read).
create table if not exists public.user_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_credits enable row level security;

drop policy if exists "users read own credits" on public.user_credits;
create policy "users read own credits" on public.user_credits
  for select using (auth.uid() = user_id);

-- Immutable ledger — every grant (+) and consumption (-). stripe_session_id is
-- unique so a replayed webhook can never double-grant.
create table if not exists public.credit_ledger (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  delta             int not null,
  reason            text not null,          -- 'purchase' | 'analysis' | 'grant' | 'refund'
  project_id        uuid references public.projects(id) on delete set null,
  stripe_session_id text unique,
  created_at        timestamptz not null default now()
);

alter table public.credit_ledger enable row level security;

drop policy if exists "users read own ledger" on public.credit_ledger;
create policy "users read own ledger" on public.credit_ledger
  for select using (auth.uid() = user_id);

drop policy if exists "ledger_admin" on public.credit_ledger;
create policy "ledger_admin" on public.credit_ledger
  for select using (is_admin());

-- Atomically charge a project for its first analysis.
-- Returns: 'already_paid' | 'admin_free' | 'charged' | 'insufficient'.
-- SECURITY DEFINER so it can touch user_credits/credit_ledger (no user-write
-- policies); locks the project row to serialize concurrent start-analysis calls.
create or replace function public.charge_project(p_project uuid, p_user uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paid    timestamptz;
  v_owner   uuid;
  v_balance int;
begin
  select paid_at, user_id into v_paid, v_owner
  from public.projects where id = p_project for update;

  if not found or v_owner <> p_user then
    return 'insufficient';               -- not the caller's project → deny
  end if;
  if v_paid is not null then
    return 'already_paid';               -- re-run / retry → free
  end if;

  if public.is_admin() then
    update public.projects set paid_at = now() where id = p_project;
    return 'admin_free';
  end if;

  select balance into v_balance from public.user_credits
    where user_id = p_user for update;
  if coalesce(v_balance, 0) < 1 then
    return 'insufficient';
  end if;

  update public.user_credits set balance = balance - 1, updated_at = now()
    where user_id = p_user;
  insert into public.credit_ledger (user_id, delta, reason, project_id)
    values (p_user, -1, 'analysis', p_project);
  update public.projects set paid_at = now() where id = p_project;
  return 'charged';
end;
$$;

-- Idempotent credit grant from a completed Stripe Checkout session.
-- Returns the number of credits granted (0 if the session was already applied).
create or replace function public.grant_credits(p_user uuid, p_qty int, p_session text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_qty int := greatest(p_qty, 0);
begin
  if v_qty = 0 then return 0; end if;
  begin
    insert into public.credit_ledger (user_id, delta, reason, stripe_session_id)
      values (p_user, v_qty, 'purchase', p_session);
  exception when unique_violation then
    return 0;                            -- webhook replay → no-op
  end;
  insert into public.user_credits (user_id, balance)
    values (p_user, v_qty)
    on conflict (user_id) do update set balance = public.user_credits.balance + v_qty, updated_at = now();
  return v_qty;
end;
$$;

-- Only the service role (edge/webhook functions) may invoke the mutating RPCs.
revoke execute on function public.charge_project(uuid, uuid) from anon, authenticated;
revoke execute on function public.grant_credits(uuid, int, text) from anon, authenticated;
