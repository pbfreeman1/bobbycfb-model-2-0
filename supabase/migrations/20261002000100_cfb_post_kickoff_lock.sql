-- CFB post-kickoff lock, per game.
--
-- WHAT WAS WRONG. cfb_compute upserts `on conflict (game_id) do update set ...`
-- over tier, units, pick_side, flags, edge and coverage, with no reference to
-- kickoff anywhere in cfb_compute, cfb_grade, cfb_recalibrate or
-- cfb_compute_bobcat. Re-running a settled week silently rewrote picks that had
-- already been graded. The NFL side has had a lock since nfl_bobby_schema; CFB
-- had none. This brings CFB to parity.
--
-- THE STARTED TEST, and why it is not kickoff_at alone:
--
--   status = 'final' OR (kickoff_at IS NOT NULL AND kickoff_at <= now())
--
-- kickoff_at is NULL on 3,943 of 4,204 games (every game from 2021-2025) and
-- all 3,943 are status = 'final'. A kickoff-only test would read NULL as "not
-- started" and leave the entire archive rewritable -- the same defect that
-- 20260930150028 fixed on the NFL side, where a NULL game_date meant no
-- archive pick ever locked.
--
-- PER GAME, NOT PER WEEK. A week mid-slate still computes normally for the
-- games that have not kicked off. Only started games are frozen.
--
-- WEEK-RELATIVE COLUMNS, when a week is partly locked:
--   * vote_share, std_dev, conviction, edge, consensus are computed from one
--     game's own weighted pool. Unaffected by what else is locked.
--   * coverage is a game's predicting weight over the week's total system
--     weight. It depends on cfb_system_weights, not on which games are locked.
--   * rank_in_week IS week-relative. It is still ranked across the whole week,
--     so the ordering reflects the full slate, but only unlocked rows are
--     written. A locked row keeps the rank it was pre-registered with. The
--     consequence is deliberate and worth knowing: once part of a week is
--     locked, the week's rank_in_week values are no longer guaranteed to be a
--     clean 1..N permutation -- they can repeat or leave gaps, because frozen
--     rows and freshly ranked rows come from different passes.
--   * hit_home/hit_away/hit_count/hit_opp/hit_side ARE week-relative: top-k
--     membership is ranked across the week's whole slate. cfb_compute_bobcat
--     still reads the full slate (so open games get correct numbers) but only
--     writes unlocked rows, so a locked game's hit columns stay as they were at
--     lock time. A partly-locked week therefore holds hit columns of two
--     vintages. Freezing is the lesser evil: the alternative rewrites a
--     pre-registered row.
--
-- OVERRIDE. cfb_tracker_config key `allow_locked_recompute`, default 0 (off).
-- cfb_tracker_config.value is numeric, so this is 0/1 rather than 'off'/'on',
-- matching tiers_validated and use_historical_prior.

alter table cfb_game_signals add column if not exists locked_at timestamptz;

comment on column cfb_game_signals.locked_at is
  'Set once the game has started (status = final, or kickoff_at has passed). A stamped row is never rewritten by cfb_compute or cfb_compute_bobcat unless cfb_tracker_config.allow_locked_recompute = 1.';

create index if not exists cfb_game_signals_locked_idx
  on cfb_game_signals (season, week) where locked_at is not null;

insert into cfb_tracker_config (key, value, note) values
  ('allow_locked_recompute', 0,
   '0 = a signal whose game has started is never rewritten (default). 1 = allow recompute of locked signals; only for a deliberate, logged correction, because it rewrites pre-registered picks.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- cfb_compute: stamp the lock, never rewrite a stamped row, freeze its rank.
-- ---------------------------------------------------------------------------
create or replace function public.cfb_compute(p_season integer, p_week integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows int;
  -- Off by default. cfb_tracker_config.value is numeric, so the flag is
  -- 0/1 like tiers_validated, not the text 'off'.
  v_override boolean := coalesce(cfb_cfg('allow_locked_recompute'), 0) = 1;
begin
  if not exists (select 1 from cfb_system_weights where season = p_season and as_of_week = p_week and weight > 0) then
    raise exception 'No system weights for season % week %. Run Recalibrate for week % first.', p_season, p_week, p_week - 1;
  end if;

  -- Stamp the lock on any signal whose game has started but which was written
  -- before kickoff. This runs BEFORE the upsert because the upsert's own guard
  -- keys off locked_at: without this pass, a row inserted pre-kickoff would
  -- still read locked_at IS NULL after the game started, and the first compute
  -- afterwards would get one free rewrite of a settled pick.
  --
  -- status = 'final' is checked as well as kickoff_at, never kickoff_at alone:
  -- kickoff_at is NULL on all 3,943 games from 2021-2025 and every one of them
  -- is final, so a kickoff-only test would leave the whole archive rewritable.
  update cfb_game_signals s
     set locked_at = now()
    from games g
   where g.id = s.game_id
     and s.season = p_season and s.week = p_week
     and s.locked_at is null
     and (g.status = 'final' or (g.kickoff_at is not null and g.kickoff_at <= now()));

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
  ),
  -- Per game, not per week: a week part-way through its slate computes
  -- normally for the games that have not started yet.
  lk as (
    select g.id gid, (g.status = 'final' or (g.kickoff_at is not null and g.kickoff_at <= now())) started
    from games g where g.season = p_season and g.week = p_week
  )
  insert into cfb_game_signals (game_id, season, week, snapshot_week, vegas_line, opening_line, consensus, edge,
    pick_side, vote_share, std_dev, conviction, voters, tier, units, flags, eq_edge, coverage, computed_at,
    locked_at)
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
    eq_edge, coverage, now(),                                                            -- bobcat: store coverage
    -- A game already started when its signal is FIRST written is backfill and
    -- locks immediately, exactly as nfl_compute does.
    case when lk.started then now() end
  from tg join lk using (gid)                                                            -- bobcat: was `from t`
  on conflict (game_id) do update set
    snapshot_week = excluded.snapshot_week, vegas_line = excluded.vegas_line, opening_line = excluded.opening_line,
    consensus = excluded.consensus, edge = excluded.edge, pick_side = excluded.pick_side,
    vote_share = excluded.vote_share, std_dev = excluded.std_dev, conviction = excluded.conviction,
    voters = excluded.voters, tier = excluded.tier, units = excluded.units, flags = excluded.flags,
    eq_edge = excluded.eq_edge, coverage = excluded.coverage, computed_at = excluded.computed_at,  -- bobcat: coverage
    -- coalesce, not excluded.locked_at: under the override a started game must
    -- keep the stamp it already has rather than have it reset, and a row that
    -- has just started gains one.
    locked_at = coalesce(cfb_game_signals.locked_at, excluded.locked_at)
  where v_override or cfb_game_signals.locked_at is null;

  get diagnostics v_rows = row_count;

  update cfb_game_signals s set rank_in_week = r.rk
  from (
    select id, row_number() over (order by conviction desc, vote_share desc, abs(edge) desc) rk
    from cfb_game_signals where season = p_season and week = p_week
  ) r
  -- Ranked over the WHOLE week so the ordering still reflects the full slate,
  -- but only unlocked rows are written: rank_in_week is part of the stored
  -- signal, so a locked row keeps the rank it was pre-registered with. See the
  -- migration header for what that means when a week is partly locked.
  where s.id = r.id
    and (v_override or s.locked_at is null);

  perform cfb_compute_bobcat(p_season, p_week);  -- bobcat: hit columns + flags

  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- cfb_compute_bobcat: read the whole slate, write only unlocked rows.
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
  v_override boolean := coalesce(cfb_cfg('allow_locked_recompute'), 0) = 1;
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
  -- The slate above is still the whole week on purpose. Top-k membership is
  -- ranked across every game in the slate, so excluding locked games would
  -- move the denominator and silently change hit_count for the games that are
  -- still open. Only the WRITE is restricted.
  where s.id = calc.id
    and (v_override or s.locked_at is null);

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- cfb_recalibrate: refuse to move the weights behind a locked week.
-- ---------------------------------------------------------------------------
create or replace function cfb_recalibrate(p_season int, p_week int)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_min numeric := cfb_cfg('min_games');
  v_k numeric := cfb_cfg('shrink_k');
  v_wa numeric := cfb_cfg('w_ats');
  v_wm numeric := cfb_cfg('w_mae');
  v_scale numeric := cfb_cfg('mae_scale');
  v_src int := case when p_week = 0 then p_season - 1 else p_season end;
  v_max int := case when p_week = 0 then 99 else p_week end;
  v_rows int;
  v_override boolean := coalesce(cfb_cfg('allow_locked_recompute'), 0) = 1;
  v_locked int;
begin
  -- Refuse if the week these weights govern already holds locked signals.
  -- cfb_recalibrate(p_season, p_week) writes as_of_week = p_week + 1, and
  -- cfb_compute(p_season, p_week + 1) is what consumes them, so week p_week + 1
  -- is the one whose stored picks would stop matching the weights they were
  -- computed from. Recalibrate touches no signal itself; this guard exists so
  -- the weights behind a settled week cannot be moved out from under it.
  if not v_override then
    select count(*) into v_locked
      from cfb_game_signals
     where season = p_season and week = p_week + 1 and locked_at is not null;
    if v_locked > 0 then
      raise exception
        'Season % week % already has % locked signal(s); its weights are what those picks were computed from. Set cfb_tracker_config.allow_locked_recompute = 1 to override deliberately.',
        p_season, p_week + 1, v_locked;
    end if;
  end if;

  delete from cfb_system_weights where season = p_season and as_of_week = p_week + 1;

  with y as (
    select r.model_id, r.predicted_margin pm, g.current_line vl, g.actual_margin am
    from raw_predictions r
    join games g on g.id = r.game_id
    join source_models sm on sm.id = r.model_id
    where g.season = v_src and g.week <= v_max
      and g.actual_margin is not null and g.current_line is not null
      and r.predicted_margin is not null and sm.status = 'include'
  ),
  st as (
    select model_id,
      count(*) filter (where pm <> vl and am <> vl and sign(pm - vl) = sign(am - vl)) w,
      count(*) filter (where pm <> vl and am <> vl and sign(pm - vl) <> sign(am - vl)) l,
      count(*) filter (where am = vl) p,
      avg(abs(pm - am)) mae,
      avg(pm - am) bias
    from y group by model_id
  ),
  med as (select percentile_cont(0.5) within group (order by mae) m from st where w + l >= v_min),
  f as (
    select st.*, (w + v_k / 2) / (w + l + v_k) shr,
      (w + v_k / 2) / (w + l + v_k) - 0.5 ats_s,
      case when med.m > 0 then (med.m - mae) / med.m * v_scale end mae_s
    from st cross join med
  ),
  g as (
    select f.*, case when w + l >= v_min then greatest(0, v_wa * ats_s + v_wm * coalesce(mae_s, 0)) else 0 end wt
    from f
  )
  insert into cfb_system_weights (model_id, season, as_of_week, source_season, wins, losses, pushes,
    shrunk_ats, mae, bias, ats_score, mae_score, weight, rank)
  select model_id, p_season, p_week + 1, v_src, w, l, p, shr, mae, bias, ats_s, mae_s, wt,
    rank() over (order by wt desc, mae asc)
  from g;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- create or replace preserves ACLs, but re-asserted so the audit is explicit
-- and a future signature change cannot quietly reopen these.
revoke all on function cfb_compute(int, int)        from public, anon, authenticated;
revoke all on function cfb_compute_bobcat(int, int) from public, anon, authenticated;
revoke all on function cfb_recalibrate(int, int)    from public, anon, authenticated;
grant execute on function cfb_compute(int, int)        to service_role;
grant execute on function cfb_compute_bobcat(int, int) to service_role;
grant execute on function cfb_recalibrate(int, int)    to service_role;
