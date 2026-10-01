-- Bobcat Formula + coverage guardrail
--
-- Two separable things ship here:
--
--   (A) Coverage guardrail. A game whose predictions come from systems
--       carrying less than min_coverage of the week's total system weight can
--       no longer be a 2U or 3U play; it is capped at 1U and flagged
--       'Low coverage'. Coverage is stored on every signal.
--
--   (B) Bobcat Formula. An experimental flag: the consensus edge sits in a
--       narrow band AND enough individual systems independently rank this game
--       among their own biggest-edge games on the same side. Forward-tracked
--       only; see docs/bobcat-formula.md for why the backtest is not evidence.
--
-- Conventions this file relies on: lines are home-positive, edge = consensus -
-- vegas_line (positive = home), pick_side is 'home'/'away',
-- cfb_signal_grades.ats_result is lowercase 'win'/'loss'/'push', and flat units
-- are +1.0 on a win / -1.1 on a loss.

-- ---------------------------------------------------------------------------
-- 1a. Config. Insert-only: never overwrite a value already tuned in place.
-- ---------------------------------------------------------------------------
insert into cfb_tracker_config (key, value, note)
select v.key, v.value, v.note
from (values
  ('min_coverage',       0.70, 'Share of the week''s total system weight that must have a prediction for a game to be 2U/3U or Bobcat'),
  ('bobcat_edge_min',    1.5,  'Bobcat: minimum abs(edge)'),
  ('bobcat_edge_max',    3.0,  'Bobcat: abs(edge) must be strictly under this'),
  ('bobcat_hits_min',    10,   'Bobcat: minimum systems flagging the pick side in their own top-10% edges'),
  ('bobcat_topk_pct',    0.10, 'Bobcat: share of each system''s own slate that counts as its biggest edges'),
  ('bobcat_forward_week', 5,   'First week of the pre-registered forward test; earlier weeks are backfill'),
  ('bobcat_opp_conflict', 3,   'Show the Split badge when this many systems flag the opposite side')
) as v(key, value, note)
where not exists (select 1 from cfb_tracker_config c where c.key = v.key);

-- ---------------------------------------------------------------------------
-- 1b. Signal columns.
-- ---------------------------------------------------------------------------
alter table cfb_game_signals
  add column if not exists coverage  numeric,
  add column if not exists models_n  integer,
  add column if not exists hit_home  integer,
  add column if not exists hit_away  integer,
  add column if not exists hit_count integer,
  add column if not exists hit_opp   integer,
  add column if not exists hit_side  text,
  add column if not exists bobcat    boolean not null default false,
  add column if not exists bobcat_eq boolean not null default false;

-- ---------------------------------------------------------------------------
-- 1c. Coverage per game: weight of systems that actually predicted it, over
--     the week's total weight. Keyed off `games` rather than cfb_game_signals
--     so cfb_compute can call it before its own rows exist.
-- ---------------------------------------------------------------------------
create or replace function cfb_game_coverage(p_season int, p_week int)
returns table (game_id uuid, coverage numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with tot as (
    select sum(w.weight) t
    from cfb_system_weights w
    where w.season = p_season and w.as_of_week = p_week and w.weight > 0
  )
  select g.id,
    case when tot.t is null or tot.t = 0 then null else
      coalesce((
        select sum(w.weight)
        from raw_predictions r
        join cfb_system_weights w
          on w.model_id = r.model_id
         and w.season = p_season and w.as_of_week = p_week and w.weight > 0
        where r.game_id = g.id and r.predicted_margin is not null
      ), 0) / tot.t
    end
  from games g cross join tot
  where g.season = p_season and g.week = p_week
$function$;

-- ---------------------------------------------------------------------------
-- 1d. Bobcat + hit columns. Set-based, idempotent, and it clears the flags on
--     games that no longer qualify.
--
--     "Top-10% hits": rank every system's own slate by abs(model_edge) and take
--     its top bobcat_topk_pct. A flagged system votes home if its model_edge is
--     positive, away if negative; exactly 0 votes for neither side. The pool is
--     EVERY system with a prediction, not just the weighted ones.
-- ---------------------------------------------------------------------------
create or replace function cfb_compute_bobcat(p_season int, p_week int)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows   int;
  v_topk   numeric := cfb_cfg('bobcat_topk_pct');
  v_emin   numeric := cfb_cfg('bobcat_edge_min');
  v_emax   numeric := cfb_cfg('bobcat_edge_max');
  v_hmin   numeric := cfb_cfg('bobcat_hits_min');
  v_mincov numeric := cfb_cfg('min_coverage');
begin
  with slate as (
    select s.id, s.game_id, s.vegas_line, s.edge, s.eq_edge, s.pick_side
    from cfb_game_signals s
    where s.season = p_season and s.week = p_week and s.vegas_line is not null
  ),
  preds as (
    select sl.game_id, r.model_id, r.predicted_margin - sl.vegas_line me
    from slate sl
    join raw_predictions r on r.game_id = sl.game_id
    where r.predicted_margin is not null
  ),
  ranked as (
    select p.game_id, p.me,
      count(*) over (partition by p.model_id) n,
      row_number() over (partition by p.model_id order by abs(p.me) desc, p.game_id) rn
    from preds p
  ),
  agg as (
    select r.game_id,
      count(*) models_n,
      count(*) filter (where r.rn <= ceil(v_topk * r.n) and r.me > 0) hh,
      count(*) filter (where r.rn <= ceil(v_topk * r.n) and r.me < 0) ha
    from ranked r
    group by r.game_id
  ),
  cov as (
    select c.game_id, c.coverage from cfb_game_coverage(p_season, p_week) c
  ),
  calc as (
    select sl.id, sl.edge, sl.eq_edge, sl.pick_side, c.coverage,
      coalesce(a.models_n, 0) models_n,
      coalesce(a.hh, 0) hit_home,
      coalesce(a.ha, 0) hit_away,
      case when coalesce(a.hh, 0) > coalesce(a.ha, 0) then 'home'
           when coalesce(a.ha, 0) > coalesce(a.hh, 0) then 'away' end hit_side,
      greatest(coalesce(a.hh, 0), coalesce(a.ha, 0)) hit_count,
      least(coalesce(a.hh, 0), coalesce(a.ha, 0)) hit_opp
    from slate sl
    left join agg a on a.game_id = sl.game_id
    left join cov c on c.game_id = sl.game_id
  )
  update cfb_game_signals s set
    coverage  = calc.coverage,
    models_n  = calc.models_n,
    hit_home  = calc.hit_home,
    hit_away  = calc.hit_away,
    hit_count = calc.hit_count,
    hit_opp   = calc.hit_opp,
    hit_side  = calc.hit_side,
    bobcat = (
      calc.hit_side is not null
      and calc.hit_side = calc.pick_side
      and abs(calc.edge) >= v_emin
      and abs(calc.edge) <  v_emax
      and calc.hit_count >= v_hmin
      and calc.coverage is not null
      and calc.coverage >= v_mincov
    ),
    -- Shadow variant: same test, but judged on the equal-weight consensus edge.
    bobcat_eq = (
      calc.hit_side is not null
      and calc.eq_edge is not null
      and sign(calc.eq_edge) = case calc.hit_side when 'home' then 1 else -1 end
      and abs(calc.eq_edge) >= v_emin
      and abs(calc.eq_edge) <  v_emax
      and calc.hit_count >= v_hmin
      and calc.coverage is not null
      and calc.coverage >= v_mincov
    )
  from calc
  where s.id = calc.id;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- 1f. Per-system detail behind one game's hit count. Same ranking as 1d,
--     computed across that game's whole season/week slate. ~38 rows.
-- ---------------------------------------------------------------------------
create or replace function cfb_topk_detail(p_game_id uuid)
returns table (
  model_id uuid, colname text, system_name text, predicted_margin numeric,
  model_edge numeric, side text, rn bigint, k integer, n bigint,
  flagged boolean, weight numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with g as (
    select s.season, s.week from cfb_game_signals s where s.game_id = p_game_id limit 1
  ),
  slate as (
    select s.game_id, s.vegas_line
    from cfb_game_signals s cross join g
    where s.season = g.season and s.week = g.week and s.vegas_line is not null
  ),
  ranked as (
    select r.game_id, r.model_id, r.predicted_margin,
      r.predicted_margin - sl.vegas_line me,
      count(*) over (partition by r.model_id) n,
      row_number() over (partition by r.model_id
        order by abs(r.predicted_margin - sl.vegas_line) desc, r.game_id) rn
    from slate sl
    join raw_predictions r on r.game_id = sl.game_id
    where r.predicted_margin is not null
  )
  select r.model_id, sm.colname, sm.system_name, r.predicted_margin, r.me,
    case when r.me > 0 then 'home' when r.me < 0 then 'away' end,
    r.rn,
    ceil(cfb_cfg('bobcat_topk_pct') * r.n)::int,
    r.n,
    (r.rn <= ceil(cfb_cfg('bobcat_topk_pct') * r.n)),
    w.weight
  from ranked r
  cross join g
  join source_models sm on sm.id = r.model_id
  left join cfb_system_weights w
    on w.model_id = r.model_id
   and w.season = g.season and w.as_of_week = g.week and w.weight > 0
  where r.game_id = p_game_id
  order by (r.rn <= ceil(cfb_cfg('bobcat_topk_pct') * r.n)) desc, r.rn, sm.colname
$function$;

-- ---------------------------------------------------------------------------
-- 1e. Coverage guardrail inside cfb_compute, plus the Bobcat call at the end.
--     TARGETED changes only, all marked `-- bobcat:`; every other line is the
--     function as it stood.
-- ---------------------------------------------------------------------------
create or replace function public.cfb_compute(p_season integer, p_week integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows int;
begin
  if not exists (select 1 from cfb_system_weights where season = p_season and as_of_week = p_week and weight > 0) then
    raise exception 'No system weights for season % week %. Run Recalibrate for week % first.', p_season, p_week, p_week - 1;
  end if;

  with v as (
    select g.id gid, g.current_line vl, g.opening_line ol, r.predicted_margin pm, w.weight wt
    from games g
    join raw_predictions r on r.game_id = g.id
    join cfb_system_weights w on w.model_id = r.model_id and w.season = p_season and w.as_of_week = p_week
    where g.season = p_season and g.week = p_week and g.current_line is not null
      and r.predicted_margin is not null and w.weight > 0
  ),
  g1 as (
    select gid, max(vl) vl, max(ol) ol, sum(wt * pm) / sum(wt) cons, sum(wt) sw, count(*) nv
    from v group by gid
  ),
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
  -- bobcat: coverage joined in after tier/units are decided, so a thinly
  -- covered game cannot carry a 2U/3U stake.
  cov as (
    select c.game_id gid, c.coverage from cfb_game_coverage(p_season, p_week) c
  ),
  tg as (
    select t.*, cov.coverage,
      (cov.coverage is not null and cov.coverage < cfb_cfg('min_coverage')) low_cov
    from t left join cov using (gid)
  )
  insert into cfb_game_signals (game_id, season, week, snapshot_week, vegas_line, opening_line, consensus, edge,
    pick_side, vote_share, std_dev, conviction, voters, tier, units, flags, eq_edge, coverage, computed_at)
  select gid, p_season, p_week, p_week, vl, ol, cons, edge,
    case when edge > 0 then 'home' when edge < 0 then 'away' end,
    vs, sd, conv, nv,
    case when low_cov and tier in ('2U', '3U') then '1U' else tier end,                 -- bobcat: cap tier
    case when low_cov and tier in ('2U', '3U') then 1                                    -- bobcat: cap units
         else case tier when '3U' then 3 when '2U' then 2 when '1U' then 1 else 0 end
    end,
    array_remove(array[
      case when ae >= cfb_cfg('edge_flag') then '6+ edge' end,
      case when nv < cfb_cfg('thin_pool') then 'Thin pool' end,
      case when d[1] * d[2] < 0 then 'Split top' end,
      case when abs(eq_edge) >= cfb_cfg('fade_edge') then 'Fade watch' end,
      case when low_cov then 'Low coverage' end                                          -- bobcat: new flag
    ], null),
    eq_edge, coverage, now()                                                             -- bobcat: store coverage
  from tg                                                                                -- bobcat: was `from t`
  on conflict (game_id) do update set
    snapshot_week = excluded.snapshot_week, vegas_line = excluded.vegas_line, opening_line = excluded.opening_line,
    consensus = excluded.consensus, edge = excluded.edge, pick_side = excluded.pick_side,
    vote_share = excluded.vote_share, std_dev = excluded.std_dev, conviction = excluded.conviction,
    voters = excluded.voters, tier = excluded.tier, units = excluded.units, flags = excluded.flags,
    eq_edge = excluded.eq_edge, coverage = excluded.coverage, computed_at = excluded.computed_at;  -- bobcat: coverage

  get diagnostics v_rows = row_count;

  update cfb_game_signals s set rank_in_week = r.rk
  from (
    select id, row_number() over (order by conviction desc, vote_share desc, abs(edge) desc) rk
    from cfb_game_signals where season = p_season and week = p_week
  ) r
  where s.id = r.id;

  perform cfb_compute_bobcat(p_season, p_week);  -- bobcat: hit columns + flags

  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- 1g. One row per flagged signal, with its grade.
-- ---------------------------------------------------------------------------
create or replace view cfb_bobcat_log with (security_invoker = true) as
select
  s.id signal_id, s.season, s.week, s.game_id,
  g.away_team || ' @ ' || g.home_team teams,
  g.home_team, g.away_team,
  s.pick_side, s.vegas_line, s.edge, s.eq_edge,
  s.hit_side, s.hit_count, s.hit_opp, s.models_n, s.coverage,
  s.tier, s.units,
  s.bobcat, s.bobcat_eq,
  case when s.week >= cfb_cfg('bobcat_forward_week') then 'forward' else 'backfill' end cohort,
  gr.ats_result,
  case gr.ats_result when 'win' then 1.0 when 'loss' then -1.1 when 'push' then 0 end flat_pl
from cfb_game_signals s
join games g on g.id = s.game_id
left join cfb_signal_grades gr on gr.signal_id = s.id
where s.bobcat or s.bobcat_eq;

-- ---------------------------------------------------------------------------
-- 1h. Summary. `control` is the same edge band on the same side as the hits,
--     but without clearing the hit-count/coverage bar — it is what the Bobcat
--     result has to beat to mean anything.
-- ---------------------------------------------------------------------------
create or replace view cfb_bobcat_variants with (security_invoker = true) as
with base as (
  select s.id signal_id, s.season, s.week,
    case when s.week >= cfb_cfg('bobcat_forward_week') then 'forward' else 'backfill' end cohort,
    s.bobcat, s.bobcat_eq,
    (abs(s.edge) >= cfb_cfg('bobcat_edge_min')
      and abs(s.edge) < cfb_cfg('bobcat_edge_max')
      and s.hit_side is not null
      and s.hit_side = s.pick_side
      and not s.bobcat) is_control,
    gr.ats_result,
    case gr.ats_result when 'win' then 1.0 when 'loss' then -1.1 when 'push' then 0 end flat_pl
  from cfb_game_signals s
  left join cfb_signal_grades gr on gr.signal_id = s.id
)
select signal_id, season, week, cohort, 'bobcat' variant, ats_result, flat_pl from base where bobcat
union all
select signal_id, season, week, cohort, 'bobcat_eq' variant, ats_result, flat_pl from base where bobcat_eq
union all
select signal_id, season, week, cohort, 'control' variant, ats_result, flat_pl from base where is_control;

create or replace view cfb_bobcat_summary with (security_invoker = true) as
select season, cohort, variant,
  count(*) flagged_n,
  count(ats_result) n,
  count(*) filter (where ats_result = 'win') wins,
  count(*) filter (where ats_result = 'loss') losses,
  count(*) filter (where ats_result = 'push') pushes,
  case when count(*) filter (where ats_result in ('win', 'loss')) > 0
    then round(count(*) filter (where ats_result = 'win')::numeric
             / count(*) filter (where ats_result in ('win', 'loss')), 4) end ats_pct,
  round(coalesce(sum(flat_pl), 0), 2) flat_units
from cfb_bobcat_variants
group by season, cohort, variant;

create or replace view cfb_bobcat_summary_by_week with (security_invoker = true) as
select season, week, cohort, variant,
  count(*) flagged_n,
  count(ats_result) n,
  count(*) filter (where ats_result = 'win') wins,
  count(*) filter (where ats_result = 'loss') losses,
  count(*) filter (where ats_result = 'push') pushes,
  case when count(*) filter (where ats_result in ('win', 'loss')) > 0
    then round(count(*) filter (where ats_result = 'win')::numeric
             / count(*) filter (where ats_result in ('win', 'loss')), 4) end ats_pct,
  round(coalesce(sum(flat_pl), 0), 2) flat_units
from cfb_bobcat_variants
group by season, week, cohort, variant;

-- ---------------------------------------------------------------------------
-- 1i. Grants, matching the existing cfb_* pattern: read helpers and views are
--     readable with the anon key; write functions stay service_role only.
-- ---------------------------------------------------------------------------
grant select on cfb_bobcat_log, cfb_bobcat_variants, cfb_bobcat_summary, cfb_bobcat_summary_by_week
  to anon, authenticated;

grant execute on function cfb_game_coverage(int, int) to anon, authenticated, service_role;
grant execute on function cfb_topk_detail(uuid)       to anon, authenticated, service_role;

revoke all on function cfb_compute_bobcat(int, int) from public;
grant execute on function cfb_compute_bobcat(int, int) to service_role;
