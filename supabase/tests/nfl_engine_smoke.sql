-- THE Bobby Model — NFL engine smoke test.
--
-- RUN THIS AFTER ANY CHANGE TO nfl_recalibrate / nfl_compute / nfl_grade /
-- nfl_bobby_near_miss / nfl_bobby_track_first_snapshot, or to the tables or
-- config they read. Applying a migration cleanly proves almost nothing about
-- these functions: Postgres does not plan the SQL inside a plpgsql body until
-- first execution, so a clean CREATE and even a clean BEGIN/ROLLBACK dry run
-- will happily accept a body full of type and column errors. Three real bugs
-- shipped through both gates and were only caught by executing the engine.
--
-- Everything runs inside BEGIN ... ROLLBACK, so it writes nothing. It asserts
-- rather than reports: a failure raises, so it cannot be skimmed past.
--
-- Fixture: 2025 week 5, which has 14 games with lines, finals and predictions.
--
--   Paste into the SQL editor, or hand the whole file to execute_sql.

begin;

do $smoke$
declare
  v_weights int; v_picks int; v_graded int; v_recompute int;
  v_voters int; v_tiers text; v_locked int; v_pool_ok int;
  v_first_ok int; v_units numeric; v_w int; v_l int; v_p int;
begin
  -- 1. Recalibrate week 4 -> weights stamped as-of week 5.
  v_weights := nfl_recalibrate(2025, 4, 'spread');
  if v_weights < 20 then
    raise exception 'SMOKE: recalibrate wrote only % system rows, expected 40+', v_weights;
  end if;

  select count(*) into v_voters
    from nfl_bobby_system_grades
   where market='spread' and season=2025 and week=5 and weight > 0;
  if v_voters < 5 then
    raise exception 'SMOKE: only % systems earned a weight, expected 5+', v_voters;
  end if;

  -- 2. Compute week 5.
  v_picks := nfl_compute(2025, 5, 'spread');
  if v_picks <> 14 then
    raise exception 'SMOKE: compute wrote % picks, expected 14', v_picks;
  end if;

  -- Consensus is graded on ALL games, so every game with a line gets a row.
  select count(*) filter (where locked_at is not null),
         count(*) filter (where jsonb_array_length(pool) = voters),
         count(*) filter (where first_line = line_used),
         string_agg(distinct tier, ',' order by tier)
    into v_locked, v_pool_ok, v_first_ok, v_tiers
    from nfl_bobby_picks where season=2025 and week=5;

  -- The kickoff lock: these games are long finished, so all must be locked.
  -- game_date is NULL across the archive, so this specifically exercises the
  -- "a final score counts as started" fallback.
  if v_locked <> 14 then
    raise exception 'SMOKE: % of 14 picks locked, expected 14 (kickoff lock broken)', v_locked;
  end if;

  -- The pool snapshot must name exactly as many systems as `voters` claims.
  if v_pool_ok <> 14 then
    raise exception 'SMOKE: pool JSON length != voters on % of 14 picks', 14 - v_pool_ok;
  end if;

  -- With one snapshot (or none), the first-seen line is the scored line.
  if v_first_ok <> 14 then
    raise exception 'SMOKE: first_line != line_used on % of 14 picks (trigger broken)', 14 - v_first_ok;
  end if;

  if v_tiers is null then
    raise exception 'SMOKE: no tier values written at all';
  end if;

  -- 3. Grade.
  v_graded := nfl_grade(2025, 5, 'spread');
  select count(*), count(*) filter (where result='win'), count(*) filter (where result='loss'),
         count(*) filter (where result='push'), sum(units_pl)
    into v_graded, v_w, v_l, v_p, v_units
    from nfl_bobby_pick_grades g join nfl_bobby_picks pk on pk.id = g.pick_id
   where pk.season=2025 and pk.week=5;

  if v_graded <> 14 then
    raise exception 'SMOKE: graded % picks, expected 14', v_graded;
  end if;
  if v_w + v_l + v_p <> 14 then
    raise exception 'SMOKE: W+L+P = %, expected 14', v_w + v_l + v_p;
  end if;
  -- Units must be consistent with the record: wins pay 1u, losses cost 1.1u,
  -- and only tiered games carry units at all, so |units| can never exceed 3*14.
  if v_units is null or abs(v_units) > 42 then
    raise exception 'SMOKE: units_pl of % is out of range', v_units;
  end if;

  -- 4. THE LOCK. A second compute over the same week must change nothing.
  v_recompute := nfl_compute(2025, 5, 'spread');
  if v_recompute <> 0 then
    raise exception 'SMOKE: recompute rewrote % locked picks, expected 0', v_recompute;
  end if;

  -- 5. Both markets must be callable. Totals have no 2025 data, so recalibrate
  -- returns rows with zero weight and compute must refuse rather than misfire.
  perform nfl_recalibrate(2025, 4, 'total');
  begin
    perform nfl_compute(2025, 5, 'total');
    raise exception 'SMOKE: totals compute should have refused with no weights';
  exception when others then
    if sqlerrm not like 'No total weights%' then raise; end if;
  end;

  raise notice 'SMOKE PASS: % systems / % voters / % picks [%] / % graded % W % L % P / % units / recompute %',
    v_weights, v_voters, v_picks, v_tiers, v_graded, v_w, v_l, v_p, round(v_units,2), v_recompute;
end $smoke$;

rollback;
