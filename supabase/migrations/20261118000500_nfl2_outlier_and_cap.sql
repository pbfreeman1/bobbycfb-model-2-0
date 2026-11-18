-- NFL v2 robustness, after a bad PredictionTracker entry (a 2.62 total) dragged
-- a Week 11 consensus to 24: predictions more than outlier_pts from the median
-- system on that game get no weight, and no system may hold more than
-- max_share of the pool (one totals system held 37%).

insert into nfl2_config (market, key, value, note) values
  ('all', 'max_share', '0.25', 'Most of the pool one system may hold'),
  ('spread', 'outlier_pts', '12', 'Predictions this far from the median system are ignored on that game'),
  ('total', 'outlier_pts', '12', 'Predictions this far from the median system are ignored on that game')
on conflict (market, key) do nothing;

create or replace function nfl2_recalibrate(p_season int, p_week int, p_market text) returns int
language plpgsql security definer set search_path = public as $$
declare k numeric := nfl2_cfg(p_market, 'prior_k'); v_min numeric := nfl2_cfg(p_market, 'min_games');
  v_mode text := nfl2_cfg_text(p_market, 'weight_mode'); v_n int;
  v_cap numeric := coalesce(nfl2_cfg(p_market, 'max_share'), 1);
begin
  delete from nfl2_system_weights where season = p_season and week = p_week and market = p_market;
  with g as (
    select id, season = p_season cur,
           case when p_market = 'spread' then home_score - away_score else home_score + away_score end act,
           case when p_market = 'spread' then spread_line else total_line end line
    from nfl_games
    where home_score is not null and away_score is not null
      and ((season = p_season and week < p_week) or season = p_season - 1)),
  e as (
    select r.model_id, g.id gid, g.cur, r.predicted_line pred, g.act, g.line, abs(r.predicted_line - g.act) err
    from nfl_raw_predictions r join g on g.id = r.game_id join nfl_source_models m on m.id = r.model_id
    where r.market = p_market and m.is_active and not m.is_aggregate),
  gm as (select gid, percentile_cont(0.5) within group (order by err) med from e group by gid having count(*) >= 5),
  x as (select e.*, e.err - gm.med ex from e join gm using (gid)),
  agg as (
    select model_id,
      count(*) filter (where cur) cur_n, count(*) filter (where not cur) prior_n,
      avg(ex) filter (where cur) cur_ex, avg(ex) filter (where not cur) prior_ex,
      avg(err) filter (where cur) mae, avg(pred - act) filter (where cur) bias,
      count(*) filter (where cur and line is not null and pred <> line and act <> line and (pred > line) = (act > line)) w,
      count(*) filter (where cur and line is not null and pred <> line and act <> line and (pred > line) <> (act > line)) l,
      count(*) filter (where cur and line is not null and pred <> line and act = line) p
    from x group by model_id),
  sc as (
    select *, (cur_n * coalesce(cur_ex, 0) + k * coalesce(prior_ex, 0)) / (cur_n + k) score,
           (cur_n + prior_n) >= v_min eligible
    from agg),
  med as (select percentile_cont(0.5) within group (order by score) m from sc where eligible)
  insert into nfl2_system_weights (season, week, market, model_id, cur_games, prior_games, wins, losses, pushes,
                                   mae, bias, cur_excess, prior_excess, score, weight, rank)
  select p_season, p_week, p_market, model_id, cur_n, prior_n, w, l, p, mae, bias, cur_ex, prior_ex, score,
    case when not eligible then 0
         when v_mode = 'equal' then 1
         when v_mode = 'top_half' then case when score < med.m then 1 else 0 end
         else greatest(0, -score) end,
    rank() over (order by eligible desc, score)
  from sc, med;
  get diagnostics v_n = row_count;
  -- no single system may carry more than max_share of the pool
  update nfl2_system_weights w set weight = least(w.weight, v_cap * t.s)
  from (select sum(weight) s from nfl2_system_weights where season = p_season and week = p_week and market = p_market) t
  where w.season = p_season and w.week = p_week and w.market = p_market and w.weight > v_cap * t.s;
  return v_n;
end $$;

create or replace function nfl2_compute(p_season int, p_week int, p_market text, p_basis text default 'current') returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; v_tw numeric;
  c_pk numeric := nfl2_cfg(p_market, 'play_kedge'); c_pv numeric := nfl2_cfg(p_market, 'play_vote');
  c_lk numeric := nfl2_cfg(p_market, 'lean_kedge'); c_lv numeric := nfl2_cfg(p_market, 'lean_vote');
  c_max numeric := nfl2_cfg(p_market, 'max_edge'); c_kcap numeric := nfl2_cfg(p_market, 'kcap');
  c_mv numeric := nfl2_cfg(p_market, 'move_flag'); c_vot numeric := nfl2_cfg(p_market, 'min_voters');
  c_cov numeric := nfl2_cfg(p_market, 'min_coverage'); c_out numeric := coalesce(nfl2_cfg(p_market, 'outlier_pts'), 99);
begin
  select sum(weight) into v_tw from nfl2_system_weights where season = p_season and week = p_week and market = p_market;
  if coalesce(v_tw, 0) = 0 then return 0; end if;

  drop table if exists _cg;
  create temp table _cg on commit drop as
    select g.id, g.game_date,
      case when p_basis = 'open'
           then coalesce(case when p_market = 'spread' then g.spread_open else g.total_open end,
                         case when p_market = 'spread' then g.spread_line else g.total_line end)
           else case when p_market = 'spread' then g.spread_line else g.total_line end end line,
      case when p_market = 'spread' then g.spread_open else g.total_open end open_line,
      coalesce(g.game_date <= now(), true) started
    from nfl_games g
    where g.season = p_season and g.week = p_week
      and (case when p_market = 'spread' then g.spread_line else g.total_line end) is not null
      -- the lock: a signal for a game that has kicked off never changes
      and not exists (select 1 from nfl2_signals s where s.game_id = g.id and s.market = p_market
                        and coalesce(g.game_date <= now(), true));
  if not exists (select 1 from _cg) then return 0; end if;

  drop table if exists _cp;
  create temp table _cp on commit drop as
    select r.game_id, r.model_id, m.display_name name, r.predicted_line pred,
           coalesce(w.weight, 0) weight, w.rank, w.score, w.wins, w.losses, w.pushes, w.mae
    from nfl_raw_predictions r join _cg on _cg.id = r.game_id
    join nfl_source_models m on m.id = r.model_id and not m.is_aggregate and m.is_active
    left join nfl2_system_weights w on w.model_id = r.model_id and w.season = p_season and w.week = p_week and w.market = p_market
    where r.market = p_market;

  -- a prediction far from the median system is treated as a data error and gets no weight
  alter table _cp add column outlier boolean not null default false;
  update _cp p set outlier = true, weight = 0
  from (select game_id, percentile_cont(0.5) within group (order by pred) med from _cp group by game_id) m
  where p.game_id = m.game_id and abs(p.pred - m.med) > c_out;

  drop table if exists _cd;
  create temp table _cd on commit drop as
  with a as (
    select game_id, sum(weight * pred) / nullif(sum(weight), 0) cons, sum(weight) wsum, count(*) filter (where weight > 0) voters
    from _cp group by game_id),
  b as (
    select a.*, g.line, g.open_line, g.started,
      sqrt(greatest(0, sum(p.weight * (p.pred - a.cons) ^ 2) / nullif(a.wsum, 0))) sd,
      sum(p.weight) filter (where sign(p.pred - g.line) = sign(a.cons - g.line) and p.pred <> g.line) / nullif(a.wsum, 0) vote
    from a join _cg g on g.id = a.game_id join _cp p on p.game_id = a.game_id
    group by a.game_id, a.cons, a.wsum, a.voters, g.line, g.open_line, g.started),
  t5 as (
    select p.game_id, avg(case when sign(p.pred - b.line) = sign(b.cons - b.line) and p.pred <> b.line then 1.0 else 0 end) share
    from (select p.*, row_number() over (partition by p.game_id order by p.weight desc) rn from _cp p where p.weight > 0) p
    join b using (game_id) where rn <= 5 group by p.game_id),
  c as (
    select b.*, t5.share top5, b.cons - b.line edge, nfl2_key_edge(p_market, b.line, b.cons) kedge,
      case when b.cons is null or b.cons = b.line then null
           when p_market = 'spread' then case when b.cons > b.line then 'home' else 'away' end
           else case when b.cons > b.line then 'over' else 'under' end end side,
      b.wsum / v_tw cov
    from b left join t5 using (game_id))
  select c.*,
    case when side is null then 'No tier'
         when kedge >= c_pk and vote >= c_pv and voters >= c_vot and cov >= c_cov then 'Play'
         when kedge >= c_lk and vote >= c_lv and voters >= c_vot then 'Lean'
         else 'No tier' end tier,
    case when side is null then null else least(kedge, c_kcap) * coalesce(vote, 0) end sc,
    array_remove(array[
      case when abs(edge) > c_max then 'Big edge' end,
      case when cov < c_cov then 'Low coverage' end,
      case when voters < c_vot then 'Thin pool' end,
      case when top5 is not null and top5 <= 0.4 then 'Top systems split' end,
      case when p_basis = 'current' and open_line is not null and abs(line - open_line) >= c_mv and side is not null then
        case when sign(line - open_line) = sign(edge) then 'Line moving with pick' else 'Line moving against pick' end end
    ], null) flags
  from c;

  insert into nfl2_signals as s (game_id, market, season, week, line, open_line, consensus, edge, kedge, pick_side,
    vote_share, std_dev, voters, coverage, top5_side_share, tier, units, score, flags, keys_crossed, systems, source,
    line_basis, computed_at, taken_side, taken_line, taken_at, result, units_result, cover_by, graded_at)
  select d.game_id, p_market, p_season, p_week, d.line, d.open_line, round(d.cons, 2), round(d.edge, 2), round(d.kedge, 2), d.side,
    round(d.vote, 4), round(d.sd, 2), d.voters, round(d.cov, 4), d.top5, d.tier, case when d.tier = 'Play' then 1 else 0 end,
    round(d.sc, 4), d.flags, nfl2_keys_crossed(p_market, d.line, d.cons),
    (select jsonb_agg(jsonb_build_object('id', p.model_id, 'name', p.name, 'pred', p.pred, 'share', round(100 * p.weight / v_tw, 2),
        'rank', p.rank, 'score', round(p.score, 3), 'w', p.wins, 'l', p.losses, 'p', p.pushes, 'mae', round(p.mae, 2), 'out', p.outlier)
        order by p.weight desc, p.name) from _cp p where p.game_id = d.game_id),
    case when d.started then 'archive' else 'live' end, p_basis, now(),
    case when d.tier = 'Play' then d.side end, case when d.tier = 'Play' then d.line end,
    case when d.tier = 'Play' then now() end, null, null, null, null
  from _cd d
  on conflict (game_id, market) do update set
    line = excluded.line, open_line = excluded.open_line, consensus = excluded.consensus, edge = excluded.edge,
    kedge = excluded.kedge, pick_side = excluded.pick_side, vote_share = excluded.vote_share, std_dev = excluded.std_dev,
    voters = excluded.voters, coverage = excluded.coverage, top5_side_share = excluded.top5_side_share, tier = excluded.tier,
    units = excluded.units, score = excluded.score, flags = excluded.flags, keys_crossed = excluded.keys_crossed,
    systems = excluded.systems, source = excluded.source, line_basis = excluded.line_basis, computed_at = excluded.computed_at,
    -- once taken, a Play keeps its side and line even if later pulls drop it
    taken_side = coalesce(s.taken_side, excluded.taken_side),
    taken_line = case when s.taken_side is not null then s.taken_line else excluded.taken_line end,
    taken_at = coalesce(s.taken_at, excluded.taken_at),
    result = null, units_result = null, cover_by = null, graded_at = null;
  get diagnostics v_n = row_count;

  update nfl2_signals s set rank_in_week = r.rk
  from (select game_id, rank() over (order by (taken_side is not null) desc, score desc nulls last) rk
        from nfl2_signals where season = p_season and week = p_week and market = p_market) r
  where s.game_id = r.game_id and s.market = p_market and s.rank_in_week is distinct from r.rk;
  return v_n;
end $$;

revoke execute on function nfl2_recalibrate(int, int, text), nfl2_compute(int, int, text, text) from public, anon, authenticated;
