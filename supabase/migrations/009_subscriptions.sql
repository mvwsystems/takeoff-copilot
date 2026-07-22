-- ============================================================
-- Takeoff Copilot — Migration 009: subscription billing
--
-- Moves from per-takeoff credits to monthly subscription tiers, metered in
-- TAKEOFFS (plan sets), not sheets. A takeoff is charged once per project
-- (re-runs free). Charge order: active subscription quota → pay-as-you-go
-- credits (overage) → 2 lifetime free-trial takeoffs → blocked.
--   solo   $197/mo · 1 seat · 20 takeoffs
--   growth $497/mo · 3 seats · 100 takeoffs
--   enterprise — custom (no self-serve)
-- Quota resets automatically: usage is counted since current_period_start,
-- which Stripe advances each billing cycle.
-- ============================================================

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  plan                   text not null,                 -- 'solo' | 'growth' | 'enterprise'
  status                 text not null default 'active',-- active | trialing | past_due | canceled
  seats                  int  not null default 1,
  takeoffs_quota         int  not null default 0,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists "users read own subscription" on public.subscriptions;
create policy "users read own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "subscriptions_admin" on public.subscriptions;
create policy "subscriptions_admin" on public.subscriptions
  for select using (is_admin());

-- ── charge_project v2 ─────────────────────────────────────────
-- Returns: already_paid | admin_free | subscription | credit | trial | insufficient
create or replace function public.charge_project(p_project uuid, p_user uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paid    timestamptz;
  v_owner   uuid;
  v_sub     public.subscriptions%rowtype;
  v_used    int;
  v_balance int;
  v_trial   int;
begin
  select paid_at, user_id into v_paid, v_owner
  from public.projects where id = p_project for update;
  if not found or v_owner <> p_user then return 'insufficient'; end if;
  if v_paid is not null then return 'already_paid'; end if;
  if public.is_admin() then
    update public.projects set paid_at = now() where id = p_project;
    return 'admin_free';
  end if;

  -- 1) Active subscription with monthly quota remaining
  select * into v_sub from public.subscriptions
    where user_id = p_user
      and status in ('active', 'trialing')
      and (current_period_end is null or now() < current_period_end)
    limit 1;
  if found then
    select count(*) into v_used from public.credit_ledger
      where user_id = p_user and reason = 'subscription_use'
        and created_at >= coalesce(v_sub.current_period_start, now() - interval '31 days');
    if v_used < v_sub.takeoffs_quota then
      insert into public.credit_ledger (user_id, delta, reason, project_id)
        values (p_user, 0, 'subscription_use', p_project);
      update public.projects set paid_at = now() where id = p_project;
      return 'subscription';
    end if;
    -- Over quota: only pay-as-you-go credits (overage) can cover it now.
    select balance into v_balance from public.user_credits where user_id = p_user for update;
    if coalesce(v_balance, 0) >= 1 then
      update public.user_credits set balance = balance - 1, updated_at = now() where user_id = p_user;
      insert into public.credit_ledger (user_id, delta, reason, project_id) values (p_user, -1, 'analysis', p_project);
      update public.projects set paid_at = now() where id = p_project;
      return 'credit';
    end if;
    return 'insufficient';
  end if;

  -- 2) No subscription → pay-as-you-go credits
  select balance into v_balance from public.user_credits where user_id = p_user for update;
  if coalesce(v_balance, 0) >= 1 then
    update public.user_credits set balance = balance - 1, updated_at = now() where user_id = p_user;
    insert into public.credit_ledger (user_id, delta, reason, project_id) values (p_user, -1, 'analysis', p_project);
    update public.projects set paid_at = now() where id = p_project;
    return 'credit';
  end if;

  -- 3) Free trial — 2 lifetime takeoffs
  select count(*) into v_trial from public.credit_ledger where user_id = p_user and reason = 'trial';
  if v_trial < 2 then
    insert into public.credit_ledger (user_id, delta, reason, project_id) values (p_user, 0, 'trial', p_project);
    update public.projects set paid_at = now() where id = p_project;
    return 'trial';
  end if;

  return 'insufficient';
end;
$$;

revoke execute on function public.charge_project(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.charge_project(uuid, uuid) to service_role;

-- Upsert a subscription from a Stripe event (service role / webhook only).
create or replace function public.upsert_subscription(
  p_user uuid, p_customer text, p_sub text, p_plan text, p_status text,
  p_seats int, p_quota int, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.subscriptions
    (user_id, stripe_customer_id, stripe_subscription_id, plan, status, seats, takeoffs_quota, current_period_start, current_period_end, updated_at)
  values (p_user, p_customer, p_sub, p_plan, p_status, p_seats, p_quota, p_start, p_end, now())
  on conflict (user_id) do update set
    stripe_customer_id     = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    plan                   = excluded.plan,
    status                 = excluded.status,
    seats                  = excluded.seats,
    takeoffs_quota         = excluded.takeoffs_quota,
    current_period_start   = excluded.current_period_start,
    current_period_end     = excluded.current_period_end,
    updated_at             = now();
end;
$$;

revoke execute on function public.upsert_subscription(uuid, text, text, text, text, int, int, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function public.upsert_subscription(uuid, text, text, text, text, int, int, timestamptz, timestamptz) to service_role;

-- Convenience read: current-period takeoff usage for the signed-in user.
create or replace function public.my_takeoff_usage()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub   public.subscriptions%rowtype;
  v_used  int;
  v_trial int;
  v_bal   int;
begin
  select * into v_sub from public.subscriptions where user_id = auth.uid();
  select count(*) into v_trial from public.credit_ledger where user_id = auth.uid() and reason = 'trial';
  select coalesce(balance, 0) into v_bal from public.user_credits where user_id = auth.uid();
  if found then
    select count(*) into v_used from public.credit_ledger
      where user_id = auth.uid() and reason = 'subscription_use'
        and created_at >= coalesce(v_sub.current_period_start, now() - interval '31 days');
    return jsonb_build_object(
      'plan', v_sub.plan, 'status', v_sub.status, 'seats', v_sub.seats,
      'quota', v_sub.takeoffs_quota, 'used', coalesce(v_used, 0),
      'period_end', v_sub.current_period_end, 'credits', v_bal, 'trial_used', coalesce(v_trial, 0));
  end if;
  return jsonb_build_object('plan', null, 'credits', v_bal, 'trial_used', coalesce(v_trial, 0), 'trial_total', 2);
end;
$$;

grant execute on function public.my_takeoff_usage() to authenticated;
revoke execute on function public.my_takeoff_usage() from anon, public;
