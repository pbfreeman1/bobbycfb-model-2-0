-- THE Bobby Model — NFL v2 engine: weights, consensus, key-number edge, tiers, grading.
--
-- WEIGHTS (per season, week, market; built only from games before that week)
--   For every graded game, each system's error is compared with the median
--   system's error on that same game ("excess error", in points). Comparing
--   game by game removes how hard the game was and which systems happened to
--   post that week. A system's score is its average excess error this season,
--   shrunk toward last season's average with a pseudo-count of prior_k games
--   (toward 0, the median, if it has no prior season). Weight = how much better
--   than the median it is; systems at or worse than the median get no weight.
--
-- KEY-NUMBER EDGE
--   NFL results bunch on certain numbers (a margin of 3 is about three times as
--   common as a typical number, 7 about twice). The key-adjusted edge counts
--   each whole number between the line and the consensus by how often games
--   land there, in units of a typical number, half for landing exactly on one.
--   2.5 -> 3.5 crosses 3 and is worth ~3 points; 4.5 -> 5.5 is worth ~1.
--   Totals use the same idea with the distribution of total points.

create or replace function nfl2_cfg_text(p_market text, p_key text) returns text
language sql stable set search_path = public as $$
  select coalesce(
    (select value from nfl2_config where market = p_market and key = p_key),
    (select value from nfl2_config where market = 'all' and key = p_key))
$$;

insert into nfl2_config (market, key, value, note) values
  ('all', 'prior_k', '48', 'Pseudo-games of last season blended into this season''s system score'),
  ('all', 'min_games', '32', 'Graded games (this season + last) a system needs to earn weight'),
  ('all', 'weight_mode', 'excess', 'excess | top_half | equal'),
  ('all', 'min_voters', '5', 'Weighted systems needed for a tier'),
  ('all', 'min_coverage', '0.7', 'Share of total system weight that must be present on the game'),
  ('all', 'sd_floor', '1.0', 'Floor on system spread in the rank score'),
  ('all', 'top_n', '3', 'Top spots per week per market'),
  ('spread', 'play_kedge', '2.0', 'Key-adjusted edge for a Play'),
  ('spread', 'play_vote', '0.70', 'Weight share on the pick side for a Play'),
  ('spread', 'lean_kedge', '1.0', 'Key-adjusted edge for a Lean'),
  ('spread', 'lean_vote', '0.60', 'Weight share for a Lean'),
  ('spread', 'max_edge', '4.0', 'Raw edges above this are flagged and never a Play'),
  ('spread', 'kcap', '4.0', 'Cap on key-adjusted edge in the rank score'),
  ('spread', 'move_flag', '1.0', 'Points of line movement from the opener to flag'),
  ('total', 'play_kedge', '2.0', 'Key-adjusted edge for a Play'),
  ('total', 'play_vote', '0.70', 'Weight share on the pick side for a Play'),
  ('total', 'lean_kedge', '1.0', 'Key-adjusted edge for a Lean'),
  ('total', 'lean_vote', '0.60', 'Weight share for a Lean'),
  ('total', 'max_edge', '5.0', 'Raw edges above this are flagged and never a Play'),
  ('total', 'kcap', '4.0', 'Cap on key-adjusted edge in the rank score'),
  ('total', 'move_flag', '1.5', 'Points of line movement from the opener to flag')
on conflict (market, key) do nothing;

-- Distribution of results, 2021-2025.
create or replace function nfl2_build_key_freq() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  delete from nfl2_key_freq;
  with s as (select abs(home_score - away_score) v from nfl_games where season between 2021 and 2025 and home_score is not null),
  c as (select v, count(*) n from s group by v),
  t as (select sum(n) tot from c),
  f as (select v, n, n::numeric / t.tot fr from c, t),
  base as (select avg(coalesce(f.fr, 0)) b from generate_series(1, 17) g left join f on f.v = g)
  insert into nfl2_key_freq select 'spread', v, n, fr, fr / b from f, base;
  -- totals: lightly smoothed (half raw, half 3-point average) because each value has ~35 games
  with s as (select home_score + away_score v from nfl_games where season between 2021 and 2025 and home_score is not null),
  t as (select count(*) tot from s),
  g as (select gs v, (select count(*) from s where s.v = gs) n from generate_series(0, 110) gs),
  f as (select v, n, n::numeric / t.tot fr from g, t),
  sm as (select v, n, 0.5 * fr + 0.5 * avg(fr) over (order by v rows between 1 preceding and 1 following) fr from f),
  base as (select avg(fr) b from sm where v between 30 and 60)
  insert into nfl2_key_freq select 'total', v, n, fr, fr / b from sm, base where n > 0 or v between 20 and 80;
  select count(*) into v_n from nfl2_key_freq;
  return v_n;
end $$;
select nfl2_build_key_freq();

-- Key-adjusted points between two numbers on the market's scale.
create or replace function nfl2_key_edge(p_market text, a numeric, b numeric) returns numeric
language sql stable set search_path = public as $$
  select case when a is null or b is null or a = b then 0 else coalesce((
    select sum(case when k = least(a, b) or k = greatest(a, b) then 0.5 else 1 end * coalesce(f.rel, 0.2))
    from generate_series(ceil(least(a, b))::int, floor(greatest(a, b))::int) k
    left join nfl2_key_freq f on f.market = p_market and f.value = case when p_market = 'spread' then abs(k) else k end
  ), 0) end
$$;

-- Key numbers (rel >= 1.6) strictly crossed or landed on between line and consensus.
create or replace function nfl2_keys_crossed(p_market text, a numeric, b numeric) returns int[]
language sql stable set search_path = public as $$
  select coalesce(array_agg(distinct case when p_market = 'spread' then abs(k) else k end), '{}')
  from generate_series(ceil(least(a, b))::int, floor(greatest(a, b))::int) k
  join nfl2_key_freq f on f.market = p_market and f.value = case when p_market = 'spread' then abs(k) else k end
  where f.rel >= 1.6 and a is not null and b is not null and a <> b
$$;

create table if not exists nfl2_system_weights (
  season int not null, week int not null, market text not null, model_id bigint not null,
  cur_games int, prior_games int, wins int, losses int, pushes int, mae numeric, bias numeric,
  cur_excess numeric, prior_excess numeric, score numeric, weight numeric, rank int,
  computed_at timestamptz not null default now(),
  primary key (season, week, market, model_id)
);
alter table nfl2_system_weights enable row level security;
create policy nfl2_system_weights_read on nfl2_system_weights for select using (true);

create table if not exists nfl2_signals (
  game_id bigint not null references nfl_games(id) on delete cascade,
  market text not null,
  season int not null, week int not null,
  line numeric, open_line numeric, consensus numeric, edge numeric, kedge numeric,
  pick_side text, vote_share numeric, std_dev numeric, voters int, coverage numeric,
  top5_side_share numeric,
  tier text, units numeric, score numeric, rank_in_week int,
  flags text[] not null default '{}', keys_crossed int[] not null default '{}',
  systems jsonb,
  source text not null, computed_at timestamptz not null default now(),
  result text, units_result numeric, cover_by numeric, graded_at timestamptz,
  primary key (game_id, market)
);
create index if not exists nfl2_signals_week on nfl2_signals (season, week, market);
alter table nfl2_signals enable row level security;
create policy nfl2_signals_read on nfl2_signals for select using (true);

create or replace function nfl2_recalibrate(p_season int, p_week int, p_market text) returns int
language plpgsql security definer set search_path = public as $$
declare k numeric := nfl2_cfg(p_market, 'prior_k'); v_min numeric := nfl2_cfg(p_market, 'min_games');
  v_mode text := nfl2_cfg_text(p_market, 'weight_mode'); v_n int;
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
  return v_n;
end $$;

create or replace function nfl2_compute(p_season int, p_week int, p_market text) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; v_tw numeric;
  c_pk numeric := nfl2_cfg(p_market, 'play_kedge'); c_pv numeric := nfl2_cfg(p_market, 'play_vote');
  c_lk numeric := nfl2_cfg(p_market, 'lean_kedge'); c_lv numeric := nfl2_cfg(p_market, 'lean_vote');
  c_max numeric := nfl2_cfg(p_market, 'max_edge'); c_kcap numeric := nfl2_cfg(p_market, 'kcap');
  c_mv numeric := nfl2_cfg(p_market, 'move_flag'); c_vot numeric := nfl2_cfg(p_market, 'min_voters');
  c_cov numeric := nfl2_cfg(p_market, 'min_coverage'); c_sd numeric := nfl2_cfg(p_market, 'sd_floor');
begin
  select sum(weight) into v_tw from nfl2_system_weights where season = p_season and week = p_week and market = p_market;
  if coalesce(v_tw, 0) = 0 then return 0; end if;

  drop table if exists _cg;
  create temp table _cg on commit drop as
    select g.id, g.game_date,
      case when p_market = 'spread' then g.spread_line else g.total_line end line,
      case when p_market = 'spread' then g.spread_open else g.total_open end open_line,
      coalesce(g.game_date <= now(), true) started
    from nfl_games g
    where g.season = p_season and g.week = p_week
      and (case when p_market = 'spread' then g.spread_line else g.total_line end) is not null
      -- the lock: a signal written for a game that has kicked off never changes
      and not exists (select 1 from nfl2_signals s where s.game_id = g.id and s.market = p_market
                        and coalesce(g.game_date <= now(), true));
  if not exists (select 1 from _cg) then return 0; end if;

  drop table if exists _cp;
  create temp table _cp on commit drop as
    select r.game_id, r.model_id, m.display_name name, r.predicted_line pred,
           coalesce(w.weight, 0) weight, w.rank, w.score, w.wins, w.losses, w.pushes, w.mae
    from nfl_raw_predictions r join _cg on _cg.id = r.game_id
    join nfl_source_models m on m.id = r.model_id and not m.is_aggregate
    left join nfl2_system_weights w on w.model_id = r.model_id and w.season = p_season and w.week = p_week and w.market = p_market
    where r.market = p_market;

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
    select game_id, avg(case when sign(pred - b.line) = sign(b.cons - b.line) and pred <> b.line then 1.0 else 0 end) share
    from (select p.*, row_number() over (partition by p.game_id order by p.weight desc) rn from _cp p where p.weight > 0) p
    join b using (game_id) where rn <= 5 group by game_id),
  c as (
    select b.*, t5.share top5, b.cons - b.line edge, nfl2_key_edge(p_market, b.line, b.cons) kedge,
      case when b.cons is null or b.cons = b.line then null
           when p_market = 'spread' then case when b.cons > b.line then 'home' else 'away' end
           else case when b.cons > b.line then 'over' else 'under' end end side,
      b.wsum / v_tw cov
    from b left join t5 using (game_id)),
  d as (
    select c.*,
      case when side is null then 'No tier'
           when kedge >= c_pk and vote >= c_pv and voters >= c_vot and cov >= c_cov and abs(edge) <= c_max then 'Play'
           when kedge >= c_lk and vote >= c_lv and voters >= c_vot then 'Lean'
           else 'No tier' end tier,
      case when side is null then null else least(kedge, c_kcap) / greatest(coalesce(sd, 0), c_sd) * coalesce(vote, 0) end sc,
      array_remove(array[
        case when abs(edge) > c_max then 'Big edge' end,
        case when cov < c_cov then 'Low coverage' end,
        case when voters < c_vot then 'Thin pool' end,
        case when open_line is not null and abs(line - open_line) >= c_mv and side is not null then
          case when sign(line - open_line) = sign(edge) then 'Line moving with pick' else 'Line moving against pick' end end
      ], null) flags
    from c)
  insert into nfl2_signals as s (game_id, market, season, week, line, open_line, consensus, edge, kedge, pick_side,
    vote_share, std_dev, voters, coverage, top5_side_share, tier, units, score, flags, keys_crossed, systems, source, computed_at,
    result, units_result, cover_by, graded_at)
  select d.game_id, p_market, p_season, p_week, d.line, d.open_line, round(d.cons, 2), round(d.edge, 2), round(d.kedge, 2), d.side,
    round(d.vote, 4), round(d.sd, 2), d.voters, round(d.cov, 4), d.top5, d.tier, case when d.tier = 'Play' then 1 else 0 end,
    round(d.sc, 4), d.flags, nfl2_keys_crossed(p_market, d.line, d.cons),
    (select jsonb_agg(jsonb_build_object('id', p.model_id, 'name', p.name, 'pred', p.pred, 'share', round(100 * p.weight / v_tw, 2),
        'rank', p.rank, 'score', round(p.score, 3), 'w', p.wins, 'l', p.losses, 'p', p.pushes, 'mae', round(p.mae, 2))
        order by p.weight desc, p.name) from _cp p where p.game_id = d.game_id),
    case when d.started then 'archive' else 'live' end, now(), null, null, null, null
  from d
  on conflict (game_id, market) do update set
    line = excluded.line, open_line = excluded.open_line, consensus = excluded.consensus, edge = excluded.edge,
    kedge = excluded.kedge, pick_side = excluded.pick_side, vote_share = excluded.vote_share, std_dev = excluded.std_dev,
    voters = excluded.voters, coverage = excluded.coverage, top5_side_share = excluded.top5_side_share, tier = excluded.tier,
    units = excluded.units, score = excluded.score, flags = excluded.flags, keys_crossed = excluded.keys_crossed,
    systems = excluded.systems, source = excluded.source, computed_at = excluded.computed_at,
    result = null, units_result = null, cover_by = null, graded_at = null;
  get diagnostics v_n = row_count;

  -- rank every game in the week by score; top spots are the best-ranked Plays
  update nfl2_signals s set rank_in_week = r.rk
  from (select game_id, rank() over (order by score desc nulls last) rk
        from nfl2_signals where season = p_season and week = p_week and market = p_market) r
  where s.game_id = r.game_id and s.market = p_market and s.rank_in_week is distinct from r.rk;
  return v_n;
end $$;

create or replace function nfl2_grade(p_season int) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with x as (
    select s.game_id, s.market, s.tier, s.units,
      case when s.market = 'spread' then
             case when s.pick_side = 'home' then (g.home_score - g.away_score) - s.line else s.line - (g.home_score - g.away_score) end
           else case when s.pick_side = 'over' then (g.home_score + g.away_score) - s.line else s.line - (g.home_score + g.away_score) end
      end cb
    from nfl2_signals s join nfl_games g on g.id = s.game_id
    where s.season = p_season and g.home_score is not null and g.away_score is not null and s.pick_side is not null
      and (s.graded_at is null or s.result is null))
  update nfl2_signals s set cover_by = x.cb,
    result = case when x.cb > 0 then 'W' when x.cb < 0 then 'L' else 'P' end,
    units_result = case when x.tier <> 'Play' then 0 when x.cb > 0 then x.units when x.cb < 0 then -1.1 * x.units else 0 end,
    graded_at = now()
  from x where s.game_id = x.game_id and s.market = x.market;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function nfl2_build_key_freq(), nfl2_recalibrate(int, int, text), nfl2_compute(int, int, text), nfl2_grade(int)
  from public, anon, authenticated;
