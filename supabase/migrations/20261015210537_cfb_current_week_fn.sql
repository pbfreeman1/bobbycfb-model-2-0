create or replace function cfb_current_week(p_season int)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'season', p_season,
    'current_week', (select min(week) from games where season = p_season and kickoff_at > now()),
    'previous_week', (select min(week) - 1 from games where season = p_season and kickoff_at > now()),
    'ungraded_started', (select count(*) from games where season = p_season and kickoff_at <= now() and actual_margin is null)
  )
$$;
revoke execute on function cfb_current_week(int) from public, anon, authenticated;
grant execute on function cfb_current_week(int) to service_role;;
