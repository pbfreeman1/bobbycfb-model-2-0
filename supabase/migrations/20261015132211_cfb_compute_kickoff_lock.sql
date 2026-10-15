create or replace function cfb_compute_bobcat(p_season integer, p_week integer)
returns integer language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_rows int;
  v_force boolean := coalesce(current_setting('cfb.force', true), '') = 'on';
  v_topk numeric := cfb_cfg('bobcat_topk_pct');
  v_emin numeric := cfb_cfg('bobcat_edge_min');
  v_emax numeric := cfb_cfg('bobcat_edge_max');
  v_hmin numeric := cfb_cfg('bobcat_hits_min');
  v_mincov numeric := cfb_cfg('min_coverage');
begin
  with slate as (
    select s.id, s.game_id, s.vegas_line, s.edge, s.eq_edge, s.pick_side
    from cfb_game_signals s
    where s.season = p_season and s.week = p_week and s.vegas_line is not null
  ),
  preds as (
    select sl.game_id, r.model_id, r.predicted_margin - sl.vegas_line me
    from slate sl join raw_predictions r on r.game_id = sl.game_id
    where r.predicted_margin is not null
  ),
  ranked as (
    select p.game_id, p.me,
      count(*) over (partition by p.model_id) n,
      row_number() over (partition by p.model_id order by abs(p.me) desc, p.game_id) rn
    from preds p
  ),
  agg as (
    select r.game_id, count(*) models_n,
      count(*) filter (where r.rn <= ceil(v_topk * r.n) and r.me > 0) hh,
      count(*) filter (where r.rn <= ceil(v_topk * r.n) and r.me < 0) ha
    from ranked r group by r.game_id
  ),
  cov as (select c.game_id, c.coverage from cfb_game_coverage(p_season, p_week) c),
  calc as (
    select sl.id, sl.edge, sl.eq_edge, sl.pick_side, c.coverage,
      coalesce(a.models_n, 0) models_n, coalesce(a.hh, 0) hit_home, coalesce(a.ha, 0) hit_away,
      case when coalesce(a.hh, 0) > coalesce(a.ha, 0) then 'home' when coalesce(a.ha, 0) > coalesce(a.hh, 0) then 'away' end hit_side,
      greatest(coalesce(a.hh, 0), coalesce(a.ha, 0)) hit_count, least(coalesce(a.hh, 0), coalesce(a.ha, 0)) hit_opp
    from slate sl left join agg a on a.game_id = sl.game_id left join cov c on c.game_id = sl.game_id
  )
  update cfb_game_signals s set
    coverage = calc.coverage, models_n = calc.models_n, hit_home = calc.hit_home, hit_away = calc.hit_away,
    hit_count = calc.hit_count, hit_opp = calc.hit_opp, hit_side = calc.hit_side,
    bobcat = (calc.hit_side is not null and calc.hit_side = calc.pick_side and abs(calc.edge) >= v_emin and abs(calc.edge) < v_emax
      and calc.hit_count >= v_hmin and calc.coverage is not null and calc.coverage >= v_mincov),
    bobcat_eq = (calc.hit_side is not null and calc.eq_edge is not null
      and sign(calc.eq_edge) = case calc.hit_side when 'home' then 1 else -1 end
      and abs(calc.eq_edge) >= v_emin and abs(calc.eq_edge) < v_emax
      and calc.hit_count >= v_hmin and calc.coverage is not null and calc.coverage >= v_mincov)
  from calc
  where s.id = calc.id
    and (v_force or s.game_id in (select g.id from games g where g.season = p_season and g.week = p_week and (g.kickoff_at is null or g.kickoff_at > now())));

  get diagnostics v_rows = row_count;
  return v_rows;
end $fn$;

create or replace function cfb_compute(p_season integer, p_week integer)
returns integer language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_rows int;
  v_force boolean := coalesce(current_setting('cfb.force', true), '') = 'on';
begin
  if not exists (select 1 from cfb_system_weights where season = p_season and as_of_week = p_week and weight > 0) then
    raise exception 'No system weights for season % week %. Run Recalibrate for week % first.', p_season, p_week, p_week - 1;
  end if;

  with open_games as (
    select g.id from games g where g.season = p_season and g.week = p_week and (v_force or g.kickoff_at is null or g.kickoff_at > now())
  ),
  v as (
    select g.id gid, g.current_line vl, g.opening_line ol, r.predicted_margin pm, w.weight wt
    from games g
    join open_games og on og.id = g.id
    join raw_predictions r on r.game_id = g.id
    join cfb_system_weights w on w.model_id = r.model_id and w.season = p_season and w.as_of_week = p_week
    where g.season = p_season and g.week = p_week and g.current_line is not null
      and r.predicted_margin is not null and w.weight > 0
  ),
  g1 as (select gid, max(vl) vl, max(ol) ol, sum(wt * pm) / sum(wt) cons, sum(wt) sw, count(*) nv from v group by gid),
  g2 as (
    select g1.gid, g1.vl, g1.ol, g1.cons, g1.nv, g1.cons - g1.vl edge,
      sqrt(sum(v.wt * (v.pm - g1.cons) ^ 2) / g1.sw) sd,
      coalesce(sum(v.wt) filter (where sign(v.pm - g1.vl) = sign(g1.cons - g1.vl) and g1.cons <> g1.vl), 0) / g1.sw vs
    from g1 join v on v.gid = g1.gid
    group by g1.gid, g1.vl, g1.ol, g1.cons, g1.sw, g1.nv
  ),
  top2 as (
    select gid, array_agg(pm - vl order by wt desc) d
    from (select v.*, row_number() over (partition by gid order by wt desc) rn from v) x
    where rn <= 2 group by gid
  ),
  eq as (
    select g.id gid, avg(r.predicted_margin) - max(g.current_line) eq_edge
    from games g
    join open_games og on og.id = g.id
    join raw_predictions r on r.game_id = g.id
    join source_models sm on sm.id = r.model_id
    where g.season = p_season and g.week = p_week and g.current_line is not null
      and r.predicted_margin is not null and sm.status = 'include'
    group by g.id
  ),
  m as (
    select g2.*, abs(edge) ae, abs(edge) / greatest(sd, cfb_cfg('sd_floor')) conv, top2.d, eq.eq_edge
    from g2 left join top2 using (gid) left join eq using (gid)
  ),
  t as (
    select m.*,
      case
        when nv < cfb_cfg('min_voters') then 'No tier'
        when vs >= cfb_cfg('t3_vs') and ae >= cfb_cfg('t3_edge') and sd <= cfb_cfg('t3_sd') and conv >= cfb_cfg('t3_conv') then '3U'
        when vs >= cfb_cfg('t2_vs') and ae >= cfb_cfg('t2_edge') and sd <= cfb_cfg('t2_sd') and conv >= cfb_cfg('t2_conv') then '2U'
        when vs >= cfb_cfg('t1_vs') and ae >= cfb_cfg('t1_edge') and sd <= cfb_cfg('t1_sd') and conv >= cfb_cfg('t1_conv') then '1U'
        when vs >= cfb_cfg('lean_vs') and ae >= cfb_cfg('lean_edge') then 'Lean'
        else 'No tier'
      end tier
    from m
  ),
  cov as (select c.game_id gid, c.coverage from cfb_game_coverage(p_season, p_week) c),
  tg as (
    select t.*, cov.coverage, (cov.coverage is not null and cov.coverage < cfb_cfg('min_coverage')) low_cov
    from t left join cov using (gid)
  )
  insert into cfb_game_signals (game_id, season, week, snapshot_week, vegas_line, opening_line, consensus, edge,
    pick_side, vote_share, std_dev, conviction, voters, tier, units, flags, eq_edge, coverage, computed_at)
  select gid, p_season, p_week, p_week, vl, ol, cons, edge,
    case when edge > 0 then 'home' when edge < 0 then 'away' end,
    vs, sd, conv, nv,
    case when low_cov and tier in ('2U', '3U') then '1U' else tier end,
    case when low_cov and tier in ('2U', '3U') then 1
         else case tier when '3U' then 3 when '2U' then 2 when '1U' then 1 else 0 end end,
    array_remove(array[
      case when ae >= cfb_cfg('edge_flag') then '6+ edge' end,
      case when nv < cfb_cfg('thin_pool') then 'Thin pool' end,
      case when d[1] * d[2] < 0 then 'Split top' end,
      case when abs(eq_edge) >= cfb_cfg('fade_edge') then 'Fade watch' end,
      case when low_cov then 'Low coverage' end
    ], null),
    eq_edge, coverage, now()
  from tg
  on conflict (game_id) do update set
    snapshot_week = excluded.snapshot_week, vegas_line = excluded.vegas_line, opening_line = excluded.opening_line,
    consensus = excluded.consensus, edge = excluded.edge, pick_side = excluded.pick_side,
    vote_share = excluded.vote_share, std_dev = excluded.std_dev, conviction = excluded.conviction,
    voters = excluded.voters, tier = excluded.tier, units = excluded.units, flags = excluded.flags,
    eq_edge = excluded.eq_edge, coverage = excluded.coverage, computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;

  update cfb_game_signals s set rank_in_week = r.rk
  from (
    select id, row_number() over (order by conviction desc, vote_share desc, abs(edge) desc) rk
    from cfb_game_signals where season = p_season and week = p_week
  ) r
  where s.id = r.id
    and (v_force or s.game_id in (select g.id from games g where g.season = p_season and g.week = p_week and (g.kickoff_at is null or g.kickoff_at > now())));

  perform cfb_compute_bobcat(p_season, p_week);
  return v_rows;
end $fn$;

create or replace function cfb_refresh(p_season int, p_recalibrate boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_w int; v_weights int := 0; v_signals int;
begin
  select min(week) into v_w from games where season = p_season and kickoff_at > now();
  if v_w is null then return jsonb_build_object('status', 'no_upcoming_games'); end if;
  if p_recalibrate and v_w >= 1 then
    v_weights := cfb_recalibrate(p_season, v_w - 1);
  end if;
  v_signals := cfb_compute(p_season, v_w);
  return jsonb_build_object('status', 'ok', 'week', v_w, 'weights_rows', v_weights, 'signals_written', v_signals);
end $fn$;

revoke execute on function cfb_refresh(int, boolean) from public, anon, authenticated;
grant execute on function cfb_refresh(int, boolean) to service_role;;
