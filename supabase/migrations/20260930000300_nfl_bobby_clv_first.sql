-- clv_first: the pick's side priced at the FIRST ingest snapshot that produced
-- that side, versus the final pre-kickoff snapshot.
--
-- Why three CLV columns exist:
--   clv       — scored line vs close, AS SPECIFIED. Structurally ~0 under the
--               kickoff lock, because line_used already IS the last snapshot
--               before kickoff. Kept for completeness, never displayed.
--   clv_open  — the opening number to the close. Computable for the whole
--               2021-2025 archive, which has spread_open on all rows.
--   clv_first — the number available when the model first produced this side.
--               The one that answers "did the pick beat the market".
--
-- "First snapshot that produced this side" is tracked forward in time by a
-- trigger rather than threaded through nfl_compute. A trigger is the right home:
-- the rule is about how a pick row EVOLVES across ingests, it stays in one
-- readable place, and it applies to every write path (compute, the archive
-- loader, a manual correction) instead of only the one that remembered it.
--
-- Rule: on insert, first_* = the snapshot being used. On update, carry the
-- existing first_* forward while the side is unchanged; reset to the current
-- snapshot the moment the model flips sides, because an Over that became an
-- Under has not been "held since Tuesday" in any meaningful sense.

alter table nfl_bobby_picks
  add column if not exists first_snapshot_id bigint
    references nfl_bobby_lines(id) on delete set null,
  add column if not exists first_line numeric;

comment on column nfl_bobby_picks.first_snapshot_id is
  'Line snapshot at which the current pick_side was first produced. Reset when the side flips. Maintained by nfl_bobby_picks_track_first.';

create or replace function nfl_bobby_track_first_snapshot()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  if tg_op = 'INSERT' then
    new.first_snapshot_id := new.line_snapshot_id;
    new.first_line := new.line_used;
  elsif new.pick_side is not distinct from old.pick_side
        and old.first_line is not null then
    -- Same side as before: this pick has been held since old.first_*.
    new.first_snapshot_id := old.first_snapshot_id;
    new.first_line := old.first_line;
  else
    -- Side flipped (or we never recorded a first line): start the clock again.
    new.first_snapshot_id := new.line_snapshot_id;
    new.first_line := new.line_used;
  end if;
  return new;
end $function$;

drop trigger if exists nfl_bobby_picks_track_first on nfl_bobby_picks;
create trigger nfl_bobby_picks_track_first
  before insert or update on nfl_bobby_picks
  for each row execute function nfl_bobby_track_first_snapshot();

-- Backfill for any rows that predate the trigger.
update nfl_bobby_picks
   set first_snapshot_id = line_snapshot_id, first_line = line_used
 where first_line is null;

-- clv_open applies to the backtest too: the archive has spread_open on all
-- 1,424 rows, so open-to-close is computable there.
alter table nfl_bobby_backtest_picks
  add column if not exists clv_open numeric;

alter table nfl_bobby_pick_grades
  add column if not exists clv_first numeric;

comment on column nfl_bobby_pick_grades.clv is
  'Scored line vs close. Structurally ~0 under the kickoff lock — not displayed anywhere. Use clv_open or clv_first.';
comment on column nfl_bobby_pick_grades.clv_first is
  'The side priced at the first snapshot that produced it, vs the close.';

-- nfl_grade's clv_first arm is folded into 20260930000200_nfl_bobby_engine.sql,
-- which is the canonical definition of that function.
