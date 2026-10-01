-- Keep the anon key out of cfb_compute_bobcat.
--
-- `revoke all ... from public` does not remove the explicit EXECUTE that
-- Supabase's default privileges hand to anon and authenticated, so the write
-- function was still callable over the REST rpc endpoint with the publishable
-- key — verified by calling it. cfb_compute and cfb_grade end up with
-- postgres + service_role only; this matches that exactly.
--
-- It is SECURITY DEFINER, so an anon caller could rewrite a week's Bobcat flags.
-- That is also the one thing the forward test cannot survive: a flag rewritten
-- after kickoff is no longer pre-registered.

revoke all on function cfb_compute_bobcat(int, int) from public, anon, authenticated;
grant execute on function cfb_compute_bobcat(int, int) to service_role;
