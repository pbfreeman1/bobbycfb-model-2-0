-- NFL v2: the scheduled cycle, manual refresh queue, read views, pg_cron jobs.

create or replace function nfl2_cycle(p_trigger text default 'schedule') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_run bigint; v_cur jsonb; s int; w int; wk int; v_err text;
  v_espn jsonb := '[]'; v_arch jsonb := '[]'; v_live jsonb := '[]'; v_comp jsonb := '[]';
  v_graded int := 0; v_n int; v_basis text;
begin
  insert into nfl2_runs (kind, status, trigger) values ('cycle', 'running', p_trigger) returning id into v_run;
  begin
    v_cur := nfl2_espn_current();
    s := (v_cur->>'season')::int; w := (v_cur->>'week')::int;
    for wk in select generate_series(1, least(w + 1, 23)) loop
      -- last week (finals), this week, next week; earlier weeks only if missing
      if wk >= w - 1 or not exists (select 1 from nfl_games where season = s and week = wk) then
        v_espn := v_espn || nfl2_sync_espn_week(s, wk);
      end if;
    end loop;
    perform nfl2_rest_days(s);
    perform nfl_classify_games(s);
  exception when others then v_err := 'espn: ' || sqlerrm; end;

  if s is null then
    s := coalesce((select max(season) from nfl_games), extract(year from now())::int);
    w := coalesce((select min(week) from nfl_games where season = s and not coalesce(completed, false)), 1);
  end if;

  begin
    v_arch := jsonb_build_array(nfl2_load_archive(s, 'spread'), nfl2_load_archive(s, 'total'));
  exception when others then v_err := concat_ws(' | ', v_err, 'archive: ' || sqlerrm); end;
  begin
    v_live := v_live || nfl2_ingest_live('spread', s);
  exception when others then v_err := concat_ws(' | ', v_err, 'live spread: ' || sqlerrm); end;
  begin
    v_live := v_live || nfl2_ingest_live('total', s);
  exception when others then v_err := concat_ws(' | ', v_err, 'live total: ' || sqlerrm); end;

  begin
    v_graded := nfl2_grade(s);
    for wk in
      select g.week from nfl_games g where g.season = s and g.week <= w + 1
      group by g.week
      having bool_or(g.game_date > now())
          or bool_or(g.spread_line is not null and not exists (select 1 from nfl2_signals x where x.game_id = g.id and x.market = 'spread'))
          or bool_or(g.total_line is not null and not exists (select 1 from nfl2_signals x where x.game_id = g.id and x.market = 'total'))
      order by 1
    loop
      v_basis := case when exists (select 1 from nfl_games where season = s and week = wk and game_date > now()) then 'current' else 'open' end;
      perform nfl2_recalibrate(s, wk, 'spread');
      perform nfl2_recalibrate(s, wk, 'total');
      v_n := nfl2_compute(s, wk, 'spread', v_basis);
      v_n := v_n + nfl2_compute(s, wk, 'total', v_basis);
      v_comp := v_comp || jsonb_build_object('week', wk, 'basis', v_basis, 'signals', v_n);
    end loop;
    v_graded := v_graded + nfl2_grade(s);
  exception when others then v_err := concat_ws(' | ', v_err, 'compute: ' || sqlerrm); end;

  update nfl2_runs set finished_at = now(), status = case when v_err is null then 'ok' else 'error' end,
    detail = jsonb_build_object('run_id', v_run, 'season', s, 'week', w, 'espn', v_espn, 'archive', v_arch,
                                'live', v_live, 'computed', v_comp, 'graded', v_graded, 'error', v_err)
  where id = v_run;
  return (select detail from nfl2_runs where id = v_run);
end $$;

create or replace function nfl2_request_refresh() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if exists (select 1 from nfl2_refresh_requests where picked_up_at is null) then
    return jsonb_build_object('status', 'pending', 'message', 'A refresh is already queued.');
  end if;
  if exists (select 1 from nfl2_runs where kind = 'cycle' and started_at > now() - interval '2 minutes') then
    return jsonb_build_object('status', 'throttled', 'message', 'A pull ran in the last 2 minutes. Try again shortly.');
  end if;
  insert into nfl2_refresh_requests default values returning id into v_id;
  return jsonb_build_object('status', 'queued', 'request_id', v_id);
end $$;

create or replace function nfl2_run_pending() returns bigint
language plpgsql security definer set search_path = public as $$
declare v_req bigint; v_detail jsonb;
begin
  select id into v_req from nfl2_refresh_requests where picked_up_at is null order by id limit 1 for update skip locked;
  if v_req is null then return null; end if;
  update nfl2_refresh_requests set picked_up_at = now() where picked_up_at is null;
  v_detail := nfl2_cycle('manual');
  update nfl2_refresh_requests set run_id = (v_detail->>'run_id')::bigint where id = v_req;
  return v_req;
end $$;

revoke execute on function nfl2_cycle(text), nfl2_run_pending() from public, anon, authenticated;
grant execute on function nfl2_request_refresh() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Views read by the app
-- ---------------------------------------------------------------------------
create or replace view nfl2_board as
select s.*,
  g.home_team home, g.away_team away, ht.abbr home_abbr, awt.abbr away_abbr,
  g.game_date kickoff, g.tv_network, g.neutral_site, g.is_divisional, g.is_primetime,
  g.home_rest_days, g.away_rest_days, g.home_score, g.away_score, g.completed,
  case when s.market = 'spread' then g.spread_line else g.total_line end line_now,
  case when s.market = 'spread' then g.home_score - g.away_score else g.home_score + g.away_score end actual
from nfl2_signals s
join nfl_games g on g.id = s.game_id
left join nfl_teams ht on ht.name = g.home_team
left join nfl_teams awt on awt.name = g.away_team;

create or replace view nfl2_results_weekly as
select s.season, s.week, s.market, s.source,
  count(*) filter (where s.result is not null) games,
  count(*) filter (where s.taken_side is null and s.result = 'W') w,
  count(*) filter (where s.taken_side is null and s.result = 'L') l,
  count(*) filter (where s.taken_side is not null and s.result = 'W') play_w,
  count(*) filter (where s.taken_side is not null and s.result = 'L') play_l,
  count(*) filter (where s.taken_side is not null and s.result = 'P') play_p,
  coalesce(sum(s.units_result) filter (where s.taken_side is not null), 0) play_units,
  count(*) filter (where s.taken_side is not null and s.rank_in_week <= nfl2_cfg(s.market, 'top_n') and s.result = 'W') top_w,
  count(*) filter (where s.taken_side is not null and s.rank_in_week <= nfl2_cfg(s.market, 'top_n') and s.result = 'L') top_l,
  coalesce(sum(s.units_result) filter (where s.taken_side is not null and s.rank_in_week <= nfl2_cfg(s.market, 'top_n')), 0) top_units,
  count(*) filter (where s.tier = 'Lean' and s.taken_side is null and s.result = 'W') lean_w,
  count(*) filter (where s.tier = 'Lean' and s.taken_side is null and s.result = 'L') lean_l,
  count(*) filter (where s.taken_side is not null and s.clv is not null) clv_n,
  coalesce(sum(s.clv) filter (where s.taken_side is not null), 0) clv_sum,
  count(*) filter (where s.taken_side is not null and s.clv > 0) clv_beat
from nfl2_signals s
group by s.season, s.week, s.market, s.source;

-- Model side on every game (taken Plays included at their taken line).
create or replace view nfl2_results_all_games as
select season, week, market,
  count(*) filter (where result = 'W') w, count(*) filter (where result = 'L') l, count(*) filter (where result = 'P') p
from nfl2_signals group by season, week, market;

create or replace view nfl2_system_board as
with latest as (
  select market, max(season * 100 + week) k from nfl2_system_weights
  where season = (select max(season) from nfl2_system_weights) group by market)
select w.market, w.season, w.week as as_of_week, m.display_name name, m.model_key col, w.cur_games games, w.prior_games,
  w.wins, w.losses, w.pushes,
  case when w.wins + w.losses > 0 then round(w.wins::numeric / (w.wins + w.losses), 4) end ats_pct,
  round(w.mae, 2) mae, round(w.bias, 2) bias, round(w.score, 3) score, w.weight,
  round(100 * w.weight / nullif(sum(w.weight) over (partition by w.market), 0), 2) share, w.rank
from nfl2_system_weights w
join latest l on l.market = w.market and w.season * 100 + w.week = l.k
join nfl_source_models m on m.id = w.model_id;

-- How similar spots have done historically (graded at the line the signal used),
-- for the game detail panel.
create or replace view nfl2_bucket_stats as
with x as (
  select s.market,
    case when s.kedge < 1 then 1 when s.kedge < 2 then 2 when s.kedge < 3 then 3 when s.kedge < 4.5 then 4 else 5 end kb,
    case when s.vote_share < 0.7 then 1 when s.vote_share < 0.85 then 2 else 3 end vb,
    case when s.pick_side in ('home', 'over') then g_act - s.line else s.line - g_act end cb
  from (select s.*, case when s.market = 'spread' then g.home_score - g.away_score else g.home_score + g.away_score end g_act
        from nfl2_signals s join nfl_games g on g.id = s.game_id
        where s.season >= 2022 and g.home_score is not null and s.pick_side is not null) s)
select market, kb, vb, count(*) filter (where cb > 0) w, count(*) filter (where cb < 0) l, count(*) filter (where cb = 0) p
from x group by market, kb, vb;

create or replace view nfl2_run_log as
select r.id, r.started_at, r.finished_at, r.trigger, r.status,
  (r.detail->>'season')::int season, (r.detail->>'week')::int week,
  (select coalesce(sum((e->>'changed')::int), 0) from jsonb_array_elements(coalesce(r.detail->'espn', '[]')) e) espn_changed,
  (select coalesce(sum((e->>'preds_added')::int), 0) from jsonb_array_elements(coalesce(r.detail->'archive', '[]')) e) archive_preds,
  (select coalesce(sum((e->>'scores_added')::int), 0) from jsonb_array_elements(coalesce(r.detail->'archive', '[]')) e) archive_scores,
  (select e->>'rows' from jsonb_array_elements(coalesce(r.detail->'live', '[]')) e where e->>'market' = 'spread') ats_rows,
  (select e->>'rows' from jsonb_array_elements(coalesce(r.detail->'live', '[]')) e where e->>'market' = 'total') ou_rows,
  (select coalesce(sum((e->>'lines_changed')::int), 0) from jsonb_array_elements(coalesce(r.detail->'live', '[]')) e) lines_changed,
  (select coalesce(sum((e->>'preds_added')::int), 0) from jsonb_array_elements(coalesce(r.detail->'live', '[]')) e) preds_added,
  (select coalesce(sum((e->>'preds_changed')::int), 0) from jsonb_array_elements(coalesce(r.detail->'live', '[]')) e) preds_changed,
  (select coalesce(sum((e->>'signals')::int), 0) from jsonb_array_elements(coalesce(r.detail->'computed', '[]')) e) signals,
  (r.detail->>'graded')::int graded,
  (select string_agg(u, ', ') from jsonb_array_elements(coalesce(r.detail->'live', '[]')) e,
     jsonb_array_elements_text(case when jsonb_typeof(e->'unmatched') = 'array' then e->'unmatched' else '[]' end) u) unmatched,
  r.detail->>'error' error
from nfl2_runs r;

grant select on nfl2_board, nfl2_results_weekly, nfl2_results_all_games, nfl2_system_board, nfl2_bucket_stats, nfl2_run_log to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule (UTC). PredictionTracker updates about once a day, so the pulls are
-- spread through the day with extra runs before the Sunday windows.
--   13:15 and 17:15 daily   8:15 AM / 12:15 PM ET (winter)
--   21:45 daily             4:45 PM ET, ahead of Thursday and Monday night
--   17:35 and 20:40 Sunday  before the 1:00 and 4:05 PM ET kickoffs
-- ---------------------------------------------------------------------------
select cron.schedule('nfl-cycle-daily', '15 13,17 * * *', 'select public.nfl2_cycle()');
select cron.schedule('nfl-cycle-evening', '45 21 * * *', 'select public.nfl2_cycle()');
select cron.schedule('nfl-cycle-sunday', '35 17 * * 0', 'select public.nfl2_cycle()');
select cron.schedule('nfl-cycle-sunday-late', '40 20 * * 0', 'select public.nfl2_cycle()');
select cron.schedule('nfl-run-pending', '* * * * *', 'select public.nfl2_run_pending()');
