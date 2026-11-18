# NFL model (CBB-style build): how it works

Built Nov 18, 2026. Everything runs inside Supabase (project `zpmdrazbqgzheqkvfltv`); the app only reads.
Every new object is prefixed `nfl2_`. It reuses `nfl_games`, `nfl_raw_predictions`, `nfl_source_models`
and `nfl_teams` (and their 2021-2025 history). The older `nfl_bobby_*` engine is untouched; its pages
moved to `/nfl/legacy/*`.

## Data sources
| What | URL | Used for |
|---|---|---|
| ESPN scoreboard | `site.api.espn.com/.../nfl/scoreboard` | Schedule, kickoff (the per-game lock), TV, finals |
| Live spreads | `thepredictiontracker.com/nflpredictions.csv` | This week: opener, line, every system (no week column) |
| Live totals | `thepredictiontracker.com/nfltotals.csv` | This week's totals |
| Season spreads | `thepredictiontracker.com/nflYY.csv` | Backfill of missed predictions, lines and scores |
| Season totals | `thepredictiontracker.com/nfltotalsYY.csv` | Backfill of totals (2021-2026 now loaded) |

PT spreads are home-relative: +3 = home favored by 3. New PT columns register themselves in
`nfl_source_models` (a new `totFOO` joins an existing `lineFOO` system).

## Schedule (pg_cron, UTC)
`select public.nfl2_cycle()` at 13:15 and 17:15 daily, 21:45 daily, plus 17:35 and 20:40 on Sundays
(8:15 AM, 12:15 PM, 4:45 PM ET; Sunday 12:35 and 3:40 PM ET in winter). Each run, in order:
1. ESPN sync for last week, this week and next week (and any missing earlier week); rest days; divisional/primetime.
2. PT season files for spreads and totals (fills anything missed, adds scores).
3. PT live files: lines and predictions for games not yet kicked off. Changes are logged in
   `nfl2_line_history` and `nfl2_prediction_history`.
4. Grade, then for each open week: recalibrate weights and compute signals for both markets, then grade again.

Every run is logged in `nfl2_runs` (view `nfl2_run_log`, page `/nfl/log`). "Refresh now" calls
`nfl2_request_refresh()`; the `nfl-run-pending` job runs it within a minute (refused if a pull ran in the
last 2 minutes). **Lock:** a game's signal freezes at its ESPN kickoff time.

## The calculation
- **Weights** (per season, week, market, from games before that week only): for each graded game, each
  system's absolute error minus the median system's error on that game ("excess error"). Score = this
  season's average excess, shrunk toward last season's with `prior_k` = 48 pseudo-games (toward 0 if no
  prior season). Weight = max(0, −score); needs 32 graded games (this + last season). One-pass cap of
  `max_share` 25% of the pool. Beat equal weights on error in both markets.
- **Outliers:** a prediction more than 12 points from the median system on that game gets no weight
  (a 2.62 total from one system on Nov 18 is why).
- **Consensus** = weighted average. **Edge** = consensus − line. **Agreement** = share of weight on the
  consensus side. **Top 5** = how many of the five heaviest systems agree. **Coverage** = weight present / total.
- **Key-adjusted edge:** each whole number between line and consensus counts by how often NFL results land
  there (`nfl2_key_freq`, 2021-2025), in units of a typical number; half for landing on one. Spread: 3 is
  3.4x, 7 is 1.7x. Totals keys are flat (44, 37, 43, 51, 47, 41 at 1.3-1.5x).
- **Tiers:** Play = key-adjusted edge ≥ 2.0, agreement ≥ 85%, 5+ weighted systems, coverage ≥ 70%.
  Lean = key-adjusted edge ≥ 1.5, agreement ≥ 70% (record only).
- **Taken line:** a game becomes a Play the first time it qualifies on a pull and is **taken at that pull's
  line**. It keeps that side and line even if the line moves or a later pull drops it, and is graded there
  (flat 1u: +1.0 / −1.1). Closing-line value (CLV) = how far the close moved toward the taken side.
- **Rank** = min(key edge, 4) × agreement; taken Plays rank first. Top spots = top 3 taken Plays.
- **Flags:** Big edge (raw > 4 spread / 6 total), Low coverage, Thin pool, Top systems split,
  Line moving with/against pick (1.0 spread / 1.5 total from the opener), Crosses N.

All thresholds live in `nfl2_config` (market `spread`, `total` or `all`) and change with one `update`.

## What the backtest says (walk-forward, 2022-2026)
- Against the **closing** line nothing separates: consensus side 49.4% ATS and 50.0% O/U over ~1,250
  games each, and the line has lower error than the consensus. Edge size, agreement, spread of systems
  and rank all sit near 50% on their own.
- Against the **opening** line: when the consensus disagreed with the opener by 3+, the line moved toward
  it in 126 of 143 spread games that moved (117 of 154 totals), and the consensus side beat the opener
  56.9% (spreads) and 58.8% (totals).
- Play rule chosen on 2022-23, checked on 2024-26, scored at the opener:
  spreads 157-113 (58.1%, +32.7u), totals 161-122 (56.9%, +26.8u); average CLV about +2 points.
- **Caveat:** PT's season files hold each system's *final* number for the week, so a system that drifts
  with the market flatters the backfill. The forward record (source `live`) is the real test.
- Leans run about 50% in both markets.

## Tables, views, functions
Tables: `nfl2_config`, `nfl2_runs`, `nfl2_refresh_requests`, `nfl2_line_history`, `nfl2_prediction_history`,
`nfl2_key_freq`, `nfl2_system_weights`, `nfl2_signals`. RLS with public read.
Views: `nfl2_board`, `nfl2_results_weekly`, `nfl2_results_all_games`, `nfl2_system_board`,
`nfl2_bucket_stats`, `nfl2_run_log`.
Functions (not callable with the anon key except `nfl2_request_refresh`): `nfl2_cycle`, `nfl2_sync_espn_week`,
`nfl2_load_archive`, `nfl2_ingest_live`, `nfl2_recalibrate`, `nfl2_compute`, `nfl2_grade`, `nfl2_run_pending`.
Migrations: `nfl2_core_ingest`, `nfl2_engine`, `nfl2_engine_taken_line`, `nfl2_cycle_views_cron`,
`nfl2_ingest_round_fix`, `nfl2_outlier_and_cap` (copies in `supabase/migrations/20261118*`).

## Handy SQL
```sql
select id, started_at, status, error, signals from nfl2_run_log order by id desc limit 10;  -- did the pulls run?
select public.nfl2_cycle('manual');                                                          -- run one now
update nfl2_config set value = '0.80' where market = 'spread' and key = 'play_vote';         -- tune a threshold
update nfl_source_models set is_active = false where model_key = 'linefoo';                  -- drop a system
```

## App pages
`/nfl/dashboard` (ATS / O/U tabs, top spots, all games, tap a game for the full breakdown),
`/nfl/results`, `/nfl/log`. `/nfl/ats` and `/nfl/totals` redirect to the dashboard tabs.
