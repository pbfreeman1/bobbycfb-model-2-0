-- Keep the anon and authenticated keys out of the NFL engine writers.
--
-- Same defect, and same fix, as 20261001000300 did for cfb_compute_bobcat:
-- `revoke all ... from public` does NOT remove the explicit EXECUTE that
-- Supabase's default privileges hand to anon and authenticated, so all five
-- NFL write functions were callable over the REST /rpc endpoint with the
-- publishable key. Verified by audit:
--
--   has_function_privilege('anon', oid, 'execute') = true on all five.
--
-- All five are SECURITY DEFINER, so an anon caller could recompute or regrade
-- any week, rewrite the system weights, or rebuild the priors. nfl_compute's
-- kickoff lock is the only thing standing between that and a settled pick
-- being rewritten after the fact, and a rewritten pick is no longer
-- pre-registered -- which is the whole point of the forward test.
--
-- Nothing in the app loses access: /api/nfl/engine and /api/nfl/espn-sync both
-- build their Supabase client with SUPABASE_SERVICE_ROLE_KEY server-side, and
-- service_role keeps EXECUTE below. The Ingest page calls those routes, never
-- the rpc endpoint directly.
--
-- Signatures are spelled out in full because nfl_recalibrate was redefined
-- with a 4th argument (p_mode) by 20260930155230; the 3-arg version was
-- dropped there and must not be referenced here.

revoke all on function nfl_compute(integer, integer, text)
  from public, anon, authenticated;
revoke all on function nfl_grade(integer, integer, text)
  from public, anon, authenticated;
revoke all on function nfl_recalibrate(integer, integer, text, text)
  from public, anon, authenticated;
revoke all on function nfl_classify_games(integer)
  from public, anon, authenticated;
revoke all on function nfl_bobby_build_priors(text, integer, integer)
  from public, anon, authenticated;

grant execute on function nfl_compute(integer, integer, text) to service_role;
grant execute on function nfl_grade(integer, integer, text) to service_role;
grant execute on function nfl_recalibrate(integer, integer, text, text) to service_role;
grant execute on function nfl_classify_games(integer) to service_role;
grant execute on function nfl_bobby_build_priors(text, integer, integer) to service_role;
