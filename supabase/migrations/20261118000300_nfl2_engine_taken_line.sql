-- NFL v2 engine, revised after the 2022-2026 walk-forward.
--
-- What the backtest showed (consensus built only from earlier weeks):
--   * Against the CLOSING line nothing separates: consensus side 49.4% ATS and
--     50.0% on totals over ~1,250 games each, with higher error than the line.
--   * Against the OPENING line, when the consensus disagrees by 3+ the line
--     moved toward it in 126 of 143 spread games that moved, and the consensus
--     side beat the opener 56.9% (spreads) and 58.8% (totals).
--   * Play rule chosen on 2022-23 and checked on 2024-26, graded at the opener:
--       key-adjusted edge >= 2 and 85%+ of system weight on the side
--       spreads 61-47 (56.5%) train, 95-65 (59.4%) test
--       totals  76-54 (58.5%) train, 96-75 (56.1%) test
--     Caveat: archive predictions are each system's final number for the week,
--     so a system that drifts with the market flatters this. The forward record
--     is the real test.
--
-- So the value is early in the week, before the line moves. A game becomes a
-- Play the first time it qualifies on a pull and is TAKEN at that pull's line;
-- Plays are graded at the taken line. Closing-line value (how far the line
-- then moved toward the pick) is recorded as the early read on whether it works.
-- Backfill weeks are computed against the opener to stand in for an early pull.

alter table nfl2_signals add column if not exists taken_side text;
alter table nfl2_signals add column if not exists taken_line numeric;
alter table nfl2_signals add column if not exists taken_at timestamptz;
alter table nfl2_signals add column if not exists close_line numeric;
alter table nfl2_signals add column if not exists clv numeric;
alter table nfl2_signals add column if not exists line_basis text;

update nfl2_config set value = '0.85' where key = 'play_vote';
update nfl2_config set value = '1.5' where key = 'lean_kedge';
update nfl2_config set value = '0.70' where key = 'lean_vote';
update nfl2_config set value = '6.0', note = 'Raw edge above this is flagged (often news the systems have not priced)' where market = 'total' and key = 'max_edge';
update nfl2_config set note = 'Raw edge above this is flagged (often news the systems have not priced)' where market = 'spread' and key = 'max_edge';
insert into nfl2_config (market, key, value, note) values
  ('spread', 'key_flag_rel', '1.6', 'Numbers at least this much more common than average are called key numbers'),
  ('total', 'key_flag_rel', '1.3', 'Totals keys are flatter than spread keys')
on conflict (market, key) do nothing;

create or replace function nfl2_keys_crossed(p_market text, a numeric, b numeric) returns int[]
language sql stable set search_path = public as $$
  select coalesce(array_agg(distinct case when p_market = 'spread' then abs(k) else k end), '{}')
  from generate_series(ceil(least(a, b))::int, floor(greatest(a, b))::int) k
  join nfl2_key_freq f on f.market = p_market and f.value = case when p_market = 'spread' then abs(k) else k end
  where f.rel >= nfl2_cfg(p_market, 'key_flag_rel') and a is not null and b is not null and a <> b
$$;

-- p_basis: 'current' (live: the line at this pull) or 'open' (backfill: the opener)
create or replace function nfl2_compute(p_season int, p_week int, p_market text, p_basis text default 'current') returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; v_tw numeric;
  c_pk numeric := nfl2_cfg(p_market, 'play_kedge'); c_pv numeric := nfl2_cfg(p_market, 'play_vote');
  c_lk numeric := nfl2_cfg(p_market, 'lean_kedge'); c_lv numeric := nfl2_cfg(p_market, 'lean_vote');
  c_max numeric := nfl2_cfg(p_market, 'max_edge'); c_kcap numeric := nfl2_cfg(p_market, 'kcap');
  c_mv numeric := nfl2_cfg(p_market, 'move_flag'); c_vot numeric := nfl2_cfg(p_market, 'min_voters');
  c_cov numeric := nfl2_cfg(p_market, 'min_coverage');
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
        'rank', p.rank, 'score', round(p.score, 3), 'w', p.wins, 'l', p.losses, 'p', p.pushes, 'mae', round(p.mae, 2))
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

-- Taken Plays grade at the taken line and side; everything else at the closing
-- line on the consensus side (record only).
create or replace function nfl2_grade(p_season int) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with x as (
    select s.game_id, s.market,
      coalesce(s.taken_side, s.pick_side) side,
      case when s.taken_side is not null then s.taken_line
           when s.market = 'spread' then g.spread_line else g.total_line end gl,
      case when s.market = 'spread' then g.spread_line else g.total_line end cl,
      case when s.market = 'spread' then g.home_score - g.away_score else g.home_score + g.away_score end act,
      s.taken_side is not null taken
    from nfl2_signals s join nfl_games g on g.id = s.game_id
    where s.season = p_season and g.home_score is not null and g.away_score is not null
      and coalesce(s.taken_side, s.pick_side) is not null),
  y as (
    select x.*, case when side in ('home', 'over') then act - gl else gl - act end cb,
      case when taken then case when side in ('home', 'over') then cl - gl else gl - cl end end clv
    from x)
  update nfl2_signals s set cover_by = y.cb, close_line = y.cl, clv = y.clv,
    result = case when y.cb > 0 then 'W' when y.cb < 0 then 'L' else 'P' end,
    units_result = case when not y.taken then 0 when y.cb > 0 then 1 when y.cb < 0 then -1.1 else 0 end,
    graded_at = now()
  from y where s.game_id = y.game_id and s.market = y.market
    and (s.result is distinct from case when y.cb > 0 then 'W' when y.cb < 0 then 'L' else 'P' end
         or s.cover_by is distinct from y.cb or s.clv is distinct from y.clv or s.close_line is distinct from y.cl);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

drop function if exists nfl2_compute(int, int, text);
revoke execute on function nfl2_compute(int, int, text, text), nfl2_grade(int) from public, anon, authenticated;
