# College basketball model (CBB): how it works

Built Nov 16, 2026. Everything runs inside Supabase (project `zpmdrazbqgzheqkvfltv`); the app only reads.

## Data sources (all PredictionTracker, no team-name matching needed)
| What | URL | Used for |
|---|---|---|
| Dated slate page | `thepredictiontracker.com/predbb.html` | The "Games of MM/DD/YYYY" stamp (the CSV has no date) |
| Live predictions | `thepredictiontracker.com/ncaabbpreds.csv` | Today's games, opening line, current line, every system |
| Season file | `thepredictiontracker.com/ncaabb26.csv` | Final scores for grading, plus backfill of games not captured live |

PT lines are home-relative: +3 = home favored by 3. `lineca` (Computer Adjusted Line) is tracked but never weighted. `lineavg`, `std`, `line_avgdiff` are skipped.

## Schedule (pg_cron, UTC)
`select public.cbb_cycle()` runs at 13:20, 14:20, 15:20, 16:20, 16:50 and 20:20 UTC (8:20, 9:20, 10:20, 11:20, 11:50 AM and 3:20 PM ET in winter). Each run is idempotent and does, in order:
1. `cbb_load_archive` — pull the season file, add scores.
2. `cbb_grade` — grade the last 14 days of signals.
3. `cbb_recalibrate` — rebuild system weights if new scores arrived.
4. `cbb_ingest_live` — pull today's slate. If PT still shows yesterday, the run logs `stale` and changes nothing.
5. `cbb_compute` — consensus, edge, tiers, rank.

Every run is logged in `cbb_runs` (status + detail JSON). Line and prediction changes are logged in `cbb_line_history` and `cbb_prediction_history`.

**Lock:** PT publishes no tip times, so lines, predictions and signals freeze at noon ET on game day (`lock_hour_et` in `cbb_config`). Games that first appear after the lock are added and computed once.

## The calculation
- **Weights** (same as football model B): each system's mean absolute error this season vs the median system. Weight = `max(0, (median - mae) / median)`, so only the better half carry weight. A system needs 50 graded games. If fewer than 3 systems qualify (season start), last season is blended in.
- **Consensus** = weighted average of the weighted systems. **Edge** = consensus − line. **Vote share** = share of weight on the consensus side. **SD** = weighted spread of the systems. **Coverage** = share of total weight present on the game.
- **Tiers:** Play = edge ≥ 1.5, vote share ≥ 70%, 3+ weighted systems, coverage ≥ 70%. Lean = edge ≥ 1.0, vote share ≥ 60%. Flat 1u on Plays (win +1.0, lose −1.1). Leans are record-only.
- **Rank** (for Top Spots): `min(edge, 4) / max(SD, 1.5) × vote share`. A sorting aid, not a proven predictor.
- **Flags:** Big edge (5+), Low coverage, Thin pool, Line moving with pick / against (1.5+ from the opener).

All thresholds live in `cbb_config` and can be changed with one `update`, no redeploy.

## What the backtest says (read before betting)
Walk-forward on 2025-26 (5,636 games, weights built only from earlier games), then checked on 2026-27 through Nov 15.
- No single system beats the closing line: all sit between 48% and 51% ATS over ~5,500 games.
- Consensus vs the final line, all games: 2,817-2,711 (51.0%). The line has lower error than the consensus (8.97 vs 9.03).
- Games meeting the Play rule in 2025-26: 977-922 (51.4%). Breakeven at −110 is 52.4%.
- Edge size, vote share, SD and rank did not separate winners from losers. Top-3-per-day by any ranking: 51-53%.
- The one consistent pattern: when the consensus disagrees with the **opening** line by 1+, the line later moved toward the consensus about 61% of the time (1,334 vs 845), and the consensus side went 1,341-1,209 (52.6%) against the opener. So if there is value, it is in betting early, before the line moves.
- MAE-median weighting beat equal weights and inverse-MSE weights on both error and ATS, which is why it was chosen.
- 2026-27 so far (backfilled, Nov 1-15): Plays 148-132-5, +2.8u.

Treat this as a tracker with paper units until the forward record says otherwise.

## Tables, views, functions
Tables: `cbb_config`, `cbb_systems`, `cbb_header_alias`, `cbb_games`, `cbb_predictions`, `cbb_prediction_history`, `cbb_line_history`, `cbb_system_weights`, `cbb_signals`, `cbb_signal_grades`, `cbb_runs`. All have RLS with public read.
Views (read by the app): `cbb_board`, `cbb_results_daily`, `cbb_system_board`.
Functions (not callable with the anon key): `cbb_cycle`, `cbb_ingest_live`, `cbb_load_archive`, `cbb_recalibrate`, `cbb_compute`, `cbb_grade`.
Migrations in Supabase history: `cbb_enable_http_cron`, `cbb_core_schema`, `cbb_load_archive_fn`, `cbb_engine`, `cbb_ingest_cycle`, `cbb_views`.

## Handy SQL
```sql
select id, started_at, status, detail from cbb_runs order by id desc limit 10;   -- did the pulls run?
select public.cbb_cycle();                                                        -- run one now
select * from cron.job;                                                           -- schedule
update cbb_config set value = '2.0' where key = 'play_edge';                      -- tune a threshold
update cbb_systems set status = 'include' where col = 'linenew';                  -- approve a new PT system (arrives as 'verify')
```

## Known limits
- New systems (agatha.gg, Sharp Edge, Model Edge Sports) are not in PT's season file, so they only start earning weight from live captures (50 games, a few days).
- Postponed games never get a score and stay ungraded.
- The backfilled record uses PT's final line; the forward record uses the line frozen at noon ET.
- App pages: `/cbb/dashboard`, `/cbb/results`.
