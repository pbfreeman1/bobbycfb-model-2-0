-- College basketball: historical records for the game detail panel.
--
-- Every graded game since 2025-26 (backfill + live), bucketed two ways:
--   kind 'ev'  edge x vote share, graded at the line the signal used
--   kind 'og'  how far the consensus sat from the OPENING line on the pick
--              side, with how often the line then moved toward / away from
--              the consensus, and the consensus side's record against the
--              opener and against the line the signal used.
-- The opener rows are the pattern the CBB backtest found (the line tends to
-- move toward the consensus), so the panel can say how strong it has been.

create or replace view cbb_spot_stats as
with x as (
  select b.season, b.edge, b.vote_share, b.line, b.open_line, b.consensus, b.actual_margin m,
         sign(b.edge) sg
  from cbb_board b
  where b.actual_margin is not null and b.pick_side is not null and b.edge is not null and b.edge <> 0
),
y as (
  select x.*,
    sg * (m - line) cb,
    case when open_line is not null then sg * (consensus - open_line) end og,
    case when open_line is not null then sg * (line - open_line) end mv,
    case when open_line is not null then sg * (m - open_line) end cbo
  from x
)
select 'ev'::text kind,
  case when abs(edge) < 1 then 1 when abs(edge) < 1.5 then 2 when abs(edge) < 2.5 then 3 when abs(edge) < 4 then 4 else 5 end b1,
  case when vote_share < 0.6 then 1 when vote_share < 0.7 then 2 when vote_share < 0.85 then 3 else 4 end b2,
  count(*) filter (where cb > 0) w, count(*) filter (where cb < 0) l, count(*) filter (where cb = 0) p,
  null::bigint toward, null::bigint away, null::bigint ow, null::bigint ol
from y group by 2, 3
union all
select 'og',
  case when og < 0 then 0 when og < 1 then 1 when og < 2 then 2 when og < 3 then 3 else 4 end, 0,
  count(*) filter (where cb > 0), count(*) filter (where cb < 0), count(*) filter (where cb = 0),
  count(*) filter (where mv > 0), count(*) filter (where mv < 0),
  count(*) filter (where cbo > 0), count(*) filter (where cbo < 0)
from y where og is not null group by 2;

grant select on cbb_spot_stats to anon, authenticated;
