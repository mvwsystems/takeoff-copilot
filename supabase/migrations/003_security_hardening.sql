-- ============================================================
-- Takeoff Copilot — Migration 003: security hardening
-- Fixes Supabase security-advisor findings:
--  - mutable search_path on SECURITY DEFINER functions
--  - anon-executable SECURITY DEFINER functions
-- ============================================================

-- Pin search_path so a malicious schema earlier in the path can't
-- shadow the tables these definer functions touch.
alter function public.handle_new_user() set search_path = public, pg_temp;
alter function public.set_updated_at()  set search_path = public, pg_temp;
alter function public.is_admin()        set search_path = public, pg_temp;

-- Trigger functions should not be callable via the REST RPC surface.
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.set_updated_at()  from anon, authenticated;

-- is_admin() must stay executable by authenticated (it runs inside
-- RLS policy expressions as the querying role), but anon has no use for it.
revoke execute on function public.is_admin() from anon;
