# Research tag process

## Logging (Quick Tag, `/cfb/research`, or the dashboard tag button)
1. Pick the game, side (spread shows the line) and type.
2. Pick the source from the dropdown. Missing one? Choose **+ New source…**, type the name, Add. It is selected immediately and is in the list from then on.
3. KAM: enter its rank (1-50) or tap Top / Topish. Rank 1-5 is stored as `top`, 6-15 as `topish`. After a save the next rank is pre-filled.
4. The last source used is remembered. Line and total at tag time are stored by the database.

One tag per source per side. Two sources on the same play are two tags.

## Selecting plays (Play Finder, `/cfb/play-finder`)
| Bucket | Meaning |
|---|---|
| A | Model 1U/2U/3U + research on the same side |
| B | Research agrees with a Lean / no-tier model side |
| M | Model 1U/2U/3U, no tag |
| X | Research on the side the model is against (information only) |
| N | Tagged, no model signal yet |

Badges: `Line moved` (3+ points or sign flip since tag/signal), `Low coverage` (signal coverage under 0.90, re-pull before the noon ET kickoffs). Totals tags are not bucketed (net loser in weeks 1-10).

The scoreboard uses 1u flat paper units (win +1, loss -1.1) and splits **forward** (week 11+) from **backfill** (weeks 1-10). The bucket rules were found by slicing weeks 1-10, so treat backfill as a hypothesis and trust forward results.
