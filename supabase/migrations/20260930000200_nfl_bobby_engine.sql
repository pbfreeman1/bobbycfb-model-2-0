-- THE Bobby Model — NFL, Phase 1 engine.
--
-- nfl_recalibrate / nfl_compute / nfl_grade, ported from cfb_recalibrate /
-- cfb_compute / cfb_grade with `market` threaded through and every constant
-- read from nfl_bobby_config instead of being baked in.
--
-- Deliberate divergences from CFB, all documented at the point they happen:
--   1. Cold start. CFB shrinks toward 0.500 with k = 50 and has no prior
--      beyond the week-0 "use last season instead" case. NFL shrinks toward
--      each system's own 2021-2025 archive rate with k = prior_k = 32 (about
--      two NFL weeks). The formula collapses exactly to CFB's when the prior
--      mean is 0.500 and prior_k = shrink_k, so this is a generalization
--      rather than a different model. A 16-game NFL week cannot be allowed to
--      reorder the pool the way 15 games out of a 60-game CFB slate can't.
--   2. Seed records. Weeks whose per-game predictions are unrecoverable
--      contribute a season-to-date W-L-P and MAE from
--      nfl_bobby_system_seeds. Seeds are cumulative, so the engine takes the
--      latest seed at or before the target week and counts per-game grades
--      only for weeks after it. No double counting.
--   3. System eligibility uses nfl_source_models.is_active and not
--      is_aggregate, where CFB uses source_models.status = 'include'.
--   4. Key-number crossing flags, which CFB does not have.
--
-- Everything else — the weight blend, the weighted consensus, weighted std
-- dev, vote share, conviction, the four-threshold tier ladder, the near-miss
-- rule, grading every game at -110 with pushes at 0 — is the CFB logic.

begin;

-- ---------------------------------------------------------------------------
-- Config accessors
-- ---------------------------------------------------------------------------
create or replace function nfl_bobby_cfg(p_market text, p_key text)
returns numeric language sql stable set search_path to 'public' as $function$
  select value from nfl_bobby_config where market = p_market and key = p_key
$function$;

create or replace function nfl_bobby_cfg_text(p_market text, p_key text)
returns text language sql stable set search_path to 'public' as $function$
  select value_text from nfl_bobby_config where market = p_market and key = p_key
$function$;

-- A short fingerprint of the market's config, stamped onto every pick so a
-- historical pick records the thresholds it was scored under.
create or replace function nfl_bobby_config_version(p_market text)
returns text language sql stable set search_path to 'public' as $function$
  select substr(md5(string_agg(key || '=' || coalesce(value::text, value_text), ';'
                               order by key)), 1, 12)
  from nfl_bobby_config where market = p_market
$function$;

-- ---------------------------------------------------------------------------
-- One shape for both markets. A spread is home-relative; a total is raw
-- combined points. Everything downstream reads this and never branches again.
-- ---------------------------------------------------------------------------
create or replace view nfl_bobby_game_lines
with (security_invoker = true) as
  select id as game_id, season, week, season_type, game_date, completed,
         'spread'::text as market,
         spread_line as line, spread_open as open_line,
         case when home_score is not null and away_score is not null
              then (home_score - away_score)::numeric end as actual
    from nfl_games
  union all
  select id, season, week, season_type, game_date, completed,
         'total'::text,
         total_line, total_open,
         case when home_score is not null and away_score is not null
              then (home_score + away_score)::numeric end
    from nfl_games;

grant select on nfl_bobby_game_lines to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Archive priors. Stamped with through_season so recalibrating season S reads
-- through_season = S - 1 and a walk-forward backtest cannot leak the season
-- it is evaluating.
-- ---------------------------------------------------------------------------
create or replace function nfl_bobby_build_priors(
  p_market text, p_from_season integer, p_through_season integer)
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare v_rows integer;
begin
  delete from nfl_bobby_system_priors
   where market = p_market and through_season = p_through_season;

  with y as (
    select rp.model_id, rp.predicted_line pl, gl.line, gl.actual
      from nfl_raw_predictions rp
      join nfl_bobby_game_lines gl
        on gl.game_id = rp.game_id and gl.market = rp.market
      join nfl_source_models sm on sm.id = rp.model_id
     where rp.market = p_market
       and gl.season between p_from_season and p_through_season
       and gl.actual is not null and gl.line is not null
       and rp.predicted_line is not null
       and sm.is_active and not sm.is_aggregate
  )
  insert into nfl_bobby_system_priors
    (model_id, market, through_season, from_season, wins, losses, pushes, hist_ats, hist_mae)
  select model_id, p_market, p_through_season, p_from_season,
    count(*) filter (where pl <> line and actual <> line and sign(pl - line) = sign(actual - line)),
    count(*) filter (where pl <> line and actual <> line and sign(pl - line) <> sign(actual - line)),
    count(*) filter (where actual = line),
    nullif(count(*) filter (where pl <> line and actual <> line and sign(pl - line) = sign(actual - line)), 0)::numeric
      / nullif(count(*) filter (where pl <> line and actual <> line), 0),
    avg(abs(pl - actual))
  from y group by model_id;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- nfl_recalibrate(season, week, market) — how a system earns its vote.
-- Writes weights stamped week + 1: recalibrating week N produces the weights
-- that computing week N + 1 will use, exactly as in CFB.
-- ---------------------------------------------------------------------------
create or replace function nfl_recalibrate(
  p_season integer, p_week integer, p_market text default 'spread')
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_min      numeric := nfl_bobby_cfg(p_market, 'min_games');
  v_priork   numeric := nfl_bobby_cfg(p_market, 'prior_k');
  v_priormu  numeric := nfl_bobby_cfg(p_market, 'prior_mean');
  v_usehist  boolean := coalesce(nfl_bobby_cfg(p_market, 'use_historical_prior'), 0) = 1;
  v_wa       numeric := nfl_bobby_cfg(p_market, 'w_ats');
  v_wm       numeric := nfl_bobby_cfg(p_market, 'w_mae');
  v_scale    numeric := nfl_bobby_cfg(p_market, 'mae_scale');
  v_pool     integer := coalesce(nfl_bobby_cfg(p_market, 'pool_size'), 0)::int;
  -- Same pre-season convention as cfb_recalibrate: week 0 reads last season
  -- whole, any other week reads this season to date.
  v_src      integer := case when p_week = 0 then p_season - 1 else p_season end;
  v_max      integer := case when p_week = 0 then 99 else p_week end;
  v_rows     integer;
  v_run      bigint;
begin
  insert into nfl_bobby_runs (kind, market, season, week, config_version)
    values ('recalibrate', p_market, p_season, p_week,
            nfl_bobby_config_version(p_market))
    returning id into v_run;

  delete from nfl_bobby_system_grades
   where market = p_market and season = p_season and week = p_week + 1;

  with
  -- The latest cumulative seed at or before the target week, if any.
  seed as (
    select distinct on (model_id) model_id, through_week, wins, losses, pushes, mae
      from nfl_bobby_system_seeds
     where market = p_market and season = v_src and through_week <= v_max
     order by model_id, through_week desc
  ),
  -- Per-game grades, but only for weeks the seed does not already cover.
  y as (
    select rp.model_id, rp.predicted_line pl, gl.line, gl.actual
      from nfl_raw_predictions rp
      join nfl_bobby_game_lines gl
        on gl.game_id = rp.game_id and gl.market = rp.market
      join nfl_source_models sm on sm.id = rp.model_id
      left join seed s on s.model_id = rp.model_id
     where rp.market = p_market
       and gl.season = v_src and gl.week <= v_max
       and gl.week > coalesce(s.through_week, 0)
       and gl.actual is not null and gl.line is not null
       and rp.predicted_line is not null
       and sm.is_active and not sm.is_aggregate
  ),
  live as (
    select model_id,
      count(*) filter (where pl <> line and actual <> line and sign(pl - line) = sign(actual - line)) w,
      count(*) filter (where pl <> line and actual <> line and sign(pl - line) <> sign(actual - line)) l,
      count(*) filter (where actual = line) p,
      count(*) n,
      avg(abs(pl - actual)) mae,
      avg(pl - actual) bias
    from y group by model_id
  ),
  -- Seed plus live. MAE is pooled by game count, since the seed's MAE is an
  -- average over its own games.
  st as (
    select
      coalesce(live.model_id, seed.model_id) model_id,
      coalesce(live.w, 0) + coalesce(seed.wins, 0) w,
      coalesce(live.l, 0) + coalesce(seed.losses, 0) l,
      coalesce(live.p, 0) + coalesce(seed.pushes, 0) p,
      coalesce(seed.wins, 0) + coalesce(seed.losses, 0) + coalesce(seed.pushes, 0) seed_games,
      case
        when live.mae is not null and seed.mae is not null then
          (live.mae * live.n + seed.mae * (seed.wins + seed.losses + seed.pushes))
            / nullif(live.n + seed.wins + seed.losses + seed.pushes, 0)
        else coalesce(live.mae, seed.mae)
      end mae,
      live.bias
    from live full outer join seed on seed.model_id = live.model_id
  ),
  pri as (
    select model_id, hist_ats from nfl_bobby_system_priors
     where market = p_market and through_season = v_src - 1
  ),
  med as (
    select percentile_cont(0.5) within group (order by mae) m
      from st where w + l >= v_min and mae is not null
  ),
  f as (
    select st.*,
      case when v_usehist then coalesce(pri.hist_ats, v_priormu) else v_priormu end mu,
      pri.hist_ats
    from st left join pri using (model_id)
  ),
  -- Beta prior of strength prior_k centred on mu. With mu = 0.5 and
  -- prior_k = 50 this is character-for-character cfb_recalibrate's
  -- (w + k/2) / (w + l + k).
  g as (
    select f.*,
      -- Denominator is always at least prior_k, so this is safe at w + l = 0.
      (f.w + v_priork * f.mu) / (f.w + f.l + v_priork) shr,
      f.w::numeric / nullif(f.w + f.l, 0) raw_ats,
      case when med.m > 0 and f.mae is not null
           then (med.m - f.mae) / med.m * v_scale end mae_s
    from f cross join med
  ),
  h as (
    select g.*, g.shr - 0.5 ats_s,
      case when g.w + g.l >= v_min
           then greatest(0, v_wa * (g.shr - 0.5) + v_wm * coalesce(g.mae_s, 0))
           else 0 end wt
    from g
  ),
  ranked as (
    select h.*, rank() over (order by wt desc, mae asc nulls last) rk from h
  )
  insert into nfl_bobby_system_grades
    (model_id, market, season, week, source_season, games_graded, wins, losses,
     pushes, seed_games, raw_ats, hist_ats, shrunk_ats, mae, bias, ats_score,
     mae_score, weight, rank)
  select model_id, p_market, p_season, p_week + 1, v_src,
    w + l + p, w, l, p, seed_games, raw_ats, hist_ats, shr, mae, bias, ats_s, mae_s,
    -- pool_size 0 means uncapped, matching CFB: anyone above average votes.
    case when v_pool > 0 and rk > v_pool then 0 else wt end,
    rk
  from ranked;

  get diagnostics v_rows = row_count;

  update nfl_bobby_runs
     set rows_written = v_rows, finished_at = now(), ok = true
   where id = v_run;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- Near-miss: missed the next tier up on exactly one threshold, by no more
-- than near_miss_pct of that cutoff. Identical rule to lib/bobby-model.js's
-- nearMiss(), lifted into SQL so a stored pick explains itself later.
-- ---------------------------------------------------------------------------
create or replace function nfl_bobby_near_miss(
  p_market text, p_tier text, p_vs numeric, p_edge numeric,
  p_sd numeric, p_conv numeric, p_voters integer)
returns text
language plpgsql stable set search_path to 'public' as $function$
declare
  v_next text := case p_tier when '2U' then '3U' when '1U' then '2U'
                             when 'Lean' then '1U' when 'No tier' then '1U' end;
  v_pfx  text;
  v_tol  numeric := coalesce(nfl_bobby_cfg(p_market, 'near_miss_pct'), 0.05);
  v_ae   numeric := abs(p_edge);
  v_fails text[] := '{}';
  v_miss  numeric;
  v_label text;
  c_vs numeric; c_edge numeric; c_sd numeric; c_conv numeric;
begin
  if v_next is null then return null; end if;
  if p_voters < coalesce(nfl_bobby_cfg(p_market, 'min_voters'), 5) then return null; end if;

  v_pfx := case v_next when '3U' then 't3' when '2U' then 't2' else 't1' end;
  c_vs   := nfl_bobby_cfg(p_market, v_pfx || '_vs');
  c_edge := nfl_bobby_cfg(p_market, v_pfx || '_edge');
  c_sd   := nfl_bobby_cfg(p_market, v_pfx || '_sd');
  c_conv := nfl_bobby_cfg(p_market, v_pfx || '_conv');

  if p_vs   < c_vs   then v_fails := v_fails || 'Vote'::text; v_miss := c_vs - p_vs;
    v_label := 'Vote ' || round((c_vs - p_vs) * 100, 1) || '%'; end if;
  if v_ae   < c_edge then v_fails := v_fails || 'Edge'::text; v_miss := c_edge - v_ae;
    v_label := 'Edge ' || round(c_edge - v_ae, 2); end if;
  if p_sd   > c_sd   then v_fails := v_fails || 'STD'::text;  v_miss := p_sd - c_sd;
    v_label := 'STD ' || round(p_sd - c_sd, 2); end if;
  if p_conv < c_conv then v_fails := v_fails || 'Conv'::text; v_miss := c_conv - p_conv;
    v_label := 'Conv ' || round(c_conv - p_conv, 2); end if;

  -- Exactly one threshold missed, and the miss is within tolerance of the
  -- cutoff's own magnitude (relative, not absolute).
  if array_length(v_fails, 1) <> 1 then return null; end if;
  if v_miss / nullif(case v_fails[1] when 'Vote' then c_vs when 'Edge' then c_edge
                                     when 'STD' then c_sd else c_conv end, 0) > v_tol
  then return null; end if;

  return v_label || ' from ' || v_next;
end $function$;

-- ---------------------------------------------------------------------------
-- nfl_compute(season, week, market) — build the consensus and assign tiers.
-- ---------------------------------------------------------------------------
create or replace function nfl_compute(
  p_season integer, p_week integer, p_market text default 'spread')
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_rows integer;
  v_run  bigint;
  v_ver  text := nfl_bobby_config_version(p_market);
  v_keys numeric[] := (
    select array_agg(k::numeric)
    from unnest(string_to_array(coalesce(nfl_bobby_cfg_text(p_market, 'key_numbers'), ''), ',')) k
    where k <> ''
  );
begin
  if not exists (select 1 from nfl_bobby_system_grades
                  where market = p_market and season = p_season
                    and week = p_week and weight > 0) then
    raise exception 'No % weights for season % week %. Run Recalibrate for week % first.',
      p_market, p_season, p_week, p_week - 1;
  end if;

  insert into nfl_bobby_runs (kind, market, season, week, config_version)
    values ('compute', p_market, p_season, p_week, v_ver) returning id into v_run;

  with
  -- Kickoff lock, half one: the operative line is the latest ingest snapshot
  -- captured strictly BEFORE this game's kickoff. A pull taken after kickoff
  -- can never become the line a pick was scored against.
  snap as (
    select distinct on (l.game_id) l.game_id, l.id snap_id, l.line
      from nfl_bobby_lines l
      join nfl_games g on g.id = l.game_id
     where l.market = p_market
       and l.phase in ('ingest','close')
       and (g.game_date is null or l.captured_at < g.game_date)
     order by l.game_id, l.captured_at desc
  ),
  gm as (
    select gl.game_id, gl.game_date, gl.open_line, gl.actual,
           coalesce(s.line, gl.line) line, s.snap_id
      from nfl_bobby_game_lines gl
      left join snap s on s.game_id = gl.game_id
     where gl.market = p_market and gl.season = p_season and gl.week = p_week
       and coalesce(s.line, gl.line) is not null
  ),
  v as (
    select gm.game_id gid, gm.line, gm.open_line, rp.predicted_line pl,
           sg.weight wt, sg.rank, sg.wins, sg.losses, sg.pushes,
           sg.model_id, sm.display_name
      from gm
      join nfl_raw_predictions rp
        on rp.game_id = gm.game_id and rp.market = p_market
      join nfl_bobby_system_grades sg
        on sg.model_id = rp.model_id and sg.market = p_market
       and sg.season = p_season and sg.week = p_week
      join nfl_source_models sm on sm.id = sg.model_id
     where rp.predicted_line is not null and sg.weight > 0
  ),
  g1 as (
    select v.gid, max(v.line) line, max(v.open_line) open_line,
           max(gm.snap_id) snap_id, max(gm.game_date) game_date,
           count(gm.actual) has_final,
           sum(v.wt * v.pl) / sum(v.wt) cons, sum(v.wt) sw, count(*) nv
      from v join gm on gm.game_id = v.gid group by v.gid
  ),
  g2 as (
    select g1.gid, g1.line, g1.open_line, g1.snap_id, g1.game_date,
           g1.has_final, g1.cons, g1.nv, g1.sw,
      g1.cons - g1.line edge,
      -- Weight-weighted, divided by total weight, as in cfb_compute.
      sqrt(sum(v.wt * (v.pl - g1.cons) ^ 2) / g1.sw) sd,
      coalesce(sum(v.wt) filter (
        where sign(v.pl - g1.line) = sign(g1.cons - g1.line) and g1.cons <> g1.line
      ), 0) / g1.sw vs
    from g1 join v on v.gid = g1.gid
    group by g1.gid, g1.line, g1.open_line, g1.snap_id, g1.game_date,
             g1.has_final, g1.cons, g1.sw, g1.nv
  ),
  top2 as (
    select gid, array_agg(pl - line order by wt desc) d
      from (select v.*, row_number() over (partition by gid order by wt desc) rn from v) x
     where rn <= 2 group by gid
  ),
  -- Unweighted consensus over every eligible system, weighted or not. Drives
  -- the Fade watch flag only, and reads the same locked line as the weighted
  -- consensus so the two compare like with like.
  eq as (
    select gm.game_id gid, avg(rp.predicted_line) eqc,
           avg(rp.predicted_line) - max(gm.line) eq_edge
      from gm
      join nfl_raw_predictions rp
        on rp.game_id = gm.game_id and rp.market = p_market
      join nfl_source_models sm on sm.id = rp.model_id
     where rp.predicted_line is not null
       and sm.is_active and not sm.is_aggregate
     group by gm.game_id
  ),
  -- The weight share has to be windowed BEFORE the jsonb_agg: a window
  -- function cannot be an argument to an aggregate in the same query level.
  vw as (
    select v.*, sum(v.wt) over (partition by v.gid) swg from v
  ),
  pool as (
    select vw.gid, jsonb_agg(jsonb_build_object(
      'model_id', vw.model_id, 'name', vw.display_name, 'rank', vw.rank,
      'record', vw.wins || '-' || vw.losses || case when vw.pushes > 0 then '-' || vw.pushes else '' end,
      'weight', round(vw.wt, 6),
      'share', round(vw.wt / nullif(vw.swg, 0) * 100, 2),
      'prediction', round(vw.pl, 2),
      'edge', round(vw.pl - vw.line, 2),
      'side', case
        when p_market = 'total' then case when vw.pl > vw.line then 'over' else 'under' end
        else case when vw.pl > vw.line then 'home' else 'away' end end
    ) order by vw.wt desc) pool
    from vw group by vw.gid
  ),
  m as (
    select g2.*, abs(g2.edge) ae,
      abs(g2.edge) / greatest(g2.sd, nfl_bobby_cfg(p_market, 'sd_floor')) conv,
      top2.d, eq.eq_edge, eq.eqc, pool.pool
    from g2
    left join top2 using (gid) left join eq using (gid) left join pool using (gid)
  ),
  t as (
    select m.*,
      case
        when nv < nfl_bobby_cfg(p_market, 'min_voters') then 'No tier'
        when vs >= nfl_bobby_cfg(p_market,'t3_vs') and ae >= nfl_bobby_cfg(p_market,'t3_edge')
         and sd <= nfl_bobby_cfg(p_market,'t3_sd') and conv >= nfl_bobby_cfg(p_market,'t3_conv') then '3U'
        when vs >= nfl_bobby_cfg(p_market,'t2_vs') and ae >= nfl_bobby_cfg(p_market,'t2_edge')
         and sd <= nfl_bobby_cfg(p_market,'t2_sd') and conv >= nfl_bobby_cfg(p_market,'t2_conv') then '2U'
        when vs >= nfl_bobby_cfg(p_market,'t1_vs') and ae >= nfl_bobby_cfg(p_market,'t1_edge')
         and sd <= nfl_bobby_cfg(p_market,'t1_sd') and conv >= nfl_bobby_cfg(p_market,'t1_conv') then '1U'
        when vs >= nfl_bobby_cfg(p_market,'lean_vs') and ae >= nfl_bobby_cfg(p_market,'lean_edge') then 'Lean'
        else 'No tier'
      end tier
    from m
  )
  insert into nfl_bobby_picks
    (game_id, market, season, week, snapshot_week, line_used, line_snapshot_id,
     locked_at, open_line,
     consensus, eq_consensus, edge, eq_edge, std_dev, agreement, conviction,
     voters, pool_weight, pick_side, tier, units, near_miss, flags,
     keys_crossed, pool, config_version, run_id, computed_at)
  select gid, p_market, p_season, p_week, p_week, line, snap_id,
    -- Kickoff lock, half two: a game that has already started locks on this
    -- compute and is never rewritten again. A final score counts as started:
    -- game_date is NULL on the whole archive, and treating "kickoff unknown"
    -- as "not yet kicked off" would leave settled historical picks rewritable.
    case when has_final > 0 or (game_date is not null and game_date <= now())
         then now() end,
    open_line,
    cons, eqc, edge, eq_edge, sd, vs, conv, nv, sw,
    case
      when edge = 0 then null
      when p_market = 'total' then case when edge > 0 then 'over' else 'under' end
      else case when edge > 0 then 'home' else 'away' end
    end,
    tier,
    case tier when '3U' then 3 when '2U' then 2 when '1U' then 1 else 0 end,
    nfl_bobby_near_miss(p_market, tier, vs, edge, sd, conv, nv::int),
    array_remove(array[
      case when ae >= nfl_bobby_cfg(p_market,'edge_flag') then 'Big edge' end,
      case when nv < nfl_bobby_cfg(p_market,'thin_pool') then 'Thin pool' end,
      case when d[1] * d[2] < 0 then 'Split top' end,
      case when abs(eq_edge) >= nfl_bobby_cfg(p_market,'fade_edge') then 'Fade watch' end
    ], null),
    -- Key numbers the consensus crosses relative to the line. Spreads are
    -- mirrored (a 3 matters on either side of pick'em); totals are absolute.
    coalesce((
      select array_agg(k::text order by k) from unnest(v_keys) k
       where (least(cons, line) < k and greatest(cons, line) >= k)
          or (p_market = 'spread'
              and least(-cons, -line) < k and greatest(-cons, -line) >= k)
    ), '{}'),
    coalesce(pool, '[]'::jsonb), v_ver, v_run, now()
  from t
  on conflict (game_id, market) do update set
    season = excluded.season, week = excluded.week,
    snapshot_week = excluded.snapshot_week, line_used = excluded.line_used,
    line_snapshot_id = excluded.line_snapshot_id,
    locked_at = excluded.locked_at,
    open_line = excluded.open_line, consensus = excluded.consensus,
    eq_consensus = excluded.eq_consensus, edge = excluded.edge,
    eq_edge = excluded.eq_edge, std_dev = excluded.std_dev,
    agreement = excluded.agreement, conviction = excluded.conviction,
    voters = excluded.voters, pool_weight = excluded.pool_weight,
    pick_side = excluded.pick_side, tier = excluded.tier, units = excluded.units,
    near_miss = excluded.near_miss, flags = excluded.flags,
    keys_crossed = excluded.keys_crossed, pool = excluded.pool,
    config_version = excluded.config_version, run_id = excluded.run_id,
    computed_at = excluded.computed_at
  -- The lock. An already-locked pick is skipped entirely, so a re-pull after
  -- kickoff cannot revise a game that has started.
  where nfl_bobby_picks.locked_at is null;

  get diagnostics v_rows = row_count;
  update nfl_bobby_runs set rows_written = v_rows, finished_at = now(), ok = true
   where id = v_run;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- nfl_grade(season, week, market) — settle every computed game, not just the
-- tiered ones, and record CLV against the last line before kickoff.
-- ---------------------------------------------------------------------------
create or replace function nfl_grade(
  p_season integer, p_week integer, p_market text default 'spread')
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_juice numeric := nfl_bobby_cfg(p_market, 'juice');
  v_rows  integer;
  v_run   bigint;
begin
  insert into nfl_bobby_runs (kind, market, season, week, config_version)
    values ('grade', p_market, p_season, p_week,
            nfl_bobby_config_version(p_market)) returning id into v_run;

  with cl as (
    -- An explicit 'close' snapshot if we captured one, otherwise the last
    -- ingest before kickoff. The UI labels this "closing (last ingest)".
    select distinct on (l.game_id) l.game_id, l.line
      from nfl_bobby_lines l
      join nfl_games g on g.id = l.game_id
     where l.market = p_market
       and (l.phase = 'close' or (l.phase = 'ingest' and l.captured_at < g.game_date))
     order by l.game_id, (l.phase = 'close') desc, l.captured_at desc
  )
  insert into nfl_bobby_pick_grades
    (pick_id, result, margin_vs_line, units_pl, closing_line, clv, clv_open,
     clv_first, beat_close, graded_at)
  select p.id,
    case when gl.actual = p.line_used then 'push'
         when sign(p.edge) * (gl.actual - p.line_used) > 0 then 'win'
         else 'loss' end,
    sign(p.edge) * (gl.actual - p.line_used),
    case when gl.actual = p.line_used or p.units = 0 then 0
         when sign(p.edge) * (gl.actual - p.line_used) > 0 then p.units
         else -v_juice * p.units end,
    c.line,
    -- Stored but never displayed: under the kickoff lock line_used already IS
    -- the last snapshot before kickoff, so this is ~0 by construction.
    case when c.line is not null then sign(p.edge) * (c.line - p.line_used) end,
    -- Open to close, on the pick's side.
    case when c.line is not null and p.open_line is not null
         then sign(p.edge) * (c.line - p.open_line) end,
    -- First snapshot that produced this side, to close.
    case when c.line is not null and p.first_line is not null
         then sign(p.edge) * (c.line - p.first_line) end,
    -- beat_close tracks the informative measure, not the structural zero.
    case when c.line is not null and p.open_line is not null
         then sign(p.edge) * (c.line - p.open_line) > 0 end,
    now()
  from nfl_bobby_picks p
  join nfl_bobby_game_lines gl on gl.game_id = p.game_id and gl.market = p.market
  left join cl c on c.game_id = p.game_id
  where p.market = p_market and p.season = p_season and p.week = p_week
    and gl.actual is not null and p.edge <> 0
  on conflict (pick_id) do update set
    result = excluded.result, margin_vs_line = excluded.margin_vs_line,
    units_pl = excluded.units_pl, closing_line = excluded.closing_line,
    clv = excluded.clv, clv_open = excluded.clv_open,
    clv_first = excluded.clv_first,
    beat_close = excluded.beat_close, graded_at = excluded.graded_at;

  get diagnostics v_rows = row_count;
  update nfl_bobby_runs set rows_written = v_rows, finished_at = now(), ok = true
   where id = v_run;
  return v_rows;
end $function$;

commit;
