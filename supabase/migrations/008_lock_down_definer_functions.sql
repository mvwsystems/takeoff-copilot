-- ============================================================
-- Takeoff Copilot — Migration 008: lock down SECURITY DEFINER functions
--
-- SECURITY FIX (found in pre-launch testing): migrations 005/007 revoked
-- these functions from anon/authenticated, but Postgres grants EXECUTE to
-- PUBLIC by default and that grant survived — so PostgREST still exposed them.
-- A signed-in user could call grant_credits() to hand themselves unlimited
-- credits (full billing bypass) or charge_project() to mark a project paid.
--
-- Revoke the PUBLIC grant and re-grant only to service_role (the edge
-- functions / Stripe webhook), which is the only caller that should ever run
-- the mutating billing functions. Verified: an authenticated JWT now gets
-- "permission denied for function", while the service-role path is intact.
-- ============================================================

revoke execute on function public.grant_credits(uuid, int, text)  from public, anon, authenticated;
revoke execute on function public.charge_project(uuid, uuid)      from public, anon, authenticated;
grant  execute on function public.grant_credits(uuid, int, text)  to service_role;
grant  execute on function public.charge_project(uuid, uuid)      to service_role;

-- accuracy_stats gates on is_admin() internally; keep it off the anon surface.
revoke execute on function public.accuracy_stats()                from public, anon;

-- Trigger-only functions must never be RPC-callable.
revoke execute on function public.handle_new_user()               from public, anon, authenticated;
revoke execute on function public.set_updated_at()                from public, anon, authenticated;

-- is_admin() is used inside RLS policy expressions, so authenticated must keep
-- EXECUTE — but anon has no use for it.
revoke execute on function public.is_admin()                      from public, anon;
grant  execute on function public.is_admin()                      to authenticated;
