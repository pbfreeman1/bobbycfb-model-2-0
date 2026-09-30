# THE Bobby Model — NFL: Phase 0 discovery

Branch: `nfl-bobby-model`. Nothing implemented yet; this is the spec and the
open questions. Written 2026-09-30 against Supabase project
`zpmdrazbqgzheqkvfltv` and repo `bobbycfb-model-2-0` @ `41c1bb9`.

---

## (a) The CFB logic, in plain English

Three functions, all `SECURITY DEFINER`, all driven by numbers in
`cfb_tracker_config` read through `cfb_cfg(key)`. There is **no migration file
in the repo** — `supabase/migrations/` is empty and `bobby_model_core`
(`20260924011525`) exists only in `supabase_migrations.schema_migrations`.
Everything below is read from the live function definitions.

### `cfb_recalibrate(season, week)` — how a system earns its vote

Writes `cfb_system_weights` rows stamped `as_of_week = week + 1`, after
deleting any existing rows for that week. So "recalibrate week 4" produces the
weights that "compute week 5" will use. `week = 0` is the pre-season case: it
reads the *previous* season, all weeks.

Sample for each system: every graded game in the source season up to and
including `week`, where the game has both `actual_margin` and `current_line`,
the system has a prediction, and `source_models.status = 'include'`.

- **wins** = games where `sign(pred − line) = sign(actual_margin − line)`,
  excluding pushes on either side
- **losses** = same test, opposite sign
- **pushes** = `actual_margin = line`
- **mae** = mean absolute error of prediction vs actual margin
- **bias** = mean signed error (stored, never used in the weight)

Then:

- `shrunk_ats = (w + k/2) / (w + l + k)` with `k = shrink_k = 50`. That is
  25 phantom wins in 50 phantom games at exactly 50%, so a system needs real
  volume before its record moves the number much.
- `ats_score = shrunk_ats − 0.5`
- `mae_score = (median_mae − mae) / median_mae × mae_scale`, where
  `median_mae` is the median across systems that have at least
  `min_games = 15` decided games, and `mae_scale = 0.25`. Being 10% more
  accurate than the median is worth about the same as +2.5 points of ATS.
- `weight = max(0, w_ats × ats_score + w_mae × mae_score)`, both weights 0.5,
  and forced to 0 if the system has fewer than 15 decided games.
- `rank` = weight desc, then mae asc.

**Pool selection and size:** there is no top-N pool. A system votes if and
only if its weight is greater than zero — that is, if its blend of shrunk ATS
and relative accuracy lands above average. Everything at or below average gets
weight 0 and is silently dropped. The pool size is whatever that produces,
typically a few dozen. (This is the single biggest difference from the existing
NFL Strong-Agreement code, which takes a fixed top 5.)

**Recency / blend:** none. The weight is a flat season-to-date number. There is
no last-4-weeks term, no decay, and no blending of the previous season into the
current one except in the `week = 0` cold-start case, which uses last season
*instead of* this one.

### `cfb_compute(season, week)` — building the consensus

Refuses to run unless `cfb_system_weights` already has `weight > 0` rows for
`(season, as_of_week = week)`, and the error message tells you to recalibrate
`week − 1` first.

Inputs: every game in the week with a non-null `current_line`, joined to every
weighted prediction. Per game, with `w` = system weight and `p` = prediction:

- **consensus** `= Σ(w·p) / Σw`
- **edge** `= consensus − current_line`. Positive edge means the model likes
  the home team relative to the market. `pick_side` is `home` when edge > 0,
  `away` when edge < 0, and null at exactly 0.
- **std dev** `= sqrt( Σ w·(p − consensus)² / Σw )` — weight-weighted, divided
  by total weight rather than n−1.
- **vote share** `=` share of total weight whose prediction falls on the same
  side of the line as the consensus does. Zero when consensus equals the line.
- **conviction** `= |edge| / max(std_dev, sd_floor)`, `sd_floor = 1.0`.
- **voters** = count of weighted predictions on the game.
- **eq_edge** = *unweighted* mean of all `status='include'` systems minus the
  line. Used only for the Fade-watch flag and its separate grade.

**Tier cutoffs** — every condition must pass, checked richest first:

| Tier | vote share | \|edge\| | std dev | conviction |
|---|---|---|---|---|
| 3U | ≥ 0.90 | ≥ 3.0 | ≤ 2.5 | ≥ 1.5 |
| 2U | ≥ 0.80 | ≥ 2.0 | ≤ 3.5 | ≥ 1.0 |
| 1U | ≥ 0.70 | ≥ 1.5 | ≤ 4.5 | ≥ 0.6 |
| Lean | ≥ 0.60 | ≥ 1.0 | — | — |

Anything else is `No tier`, and a game with fewer than `min_voters = 5` voters
is `No tier` regardless. Units are 3 / 2 / 1 / 0 / 0.

**Flags** (array, never affect the tier, graded separately):
`6+ edge` when `|edge| ≥ 6`; `Thin pool` when voters < 8; `Split top` when the
two highest-weight systems sit on opposite sides of the line; `Fade watch`
when `|eq_edge| ≥ 4.5`.

`rank_in_week` is written by conviction desc, vote share desc, |edge| desc.
The dashboard ignores it (see Bobby Rank below).

The insert is `on conflict (game_id) do update` — **one row per game, ever**.
Recomputing a week overwrites the old numbers with no history, which is why
Phase 1 wants a pool snapshot column.

### `cfb_grade(season, week)` — settling it

Runs over every signal in the week with a final `actual_margin` and a non-zero
edge, so **all games are graded, not just tiered ones**.

- `push` when `actual_margin = vegas_line`
- `win` when `sign(edge) × (actual_margin − vegas_line) > 0`, else `loss`
- `ats_margin` = that same signed quantity, i.e. cover margin in points
- `units_pl` = 0 on a push or when units = 0 (Leans and No-tier games are
  graded W/L but carry no units); `+units` on a win; `−juice × units` on a
  loss, `juice = 1.1`
- `fade_result` is filled only on Fade-watch games: it grades the side
  *opposite* the equal-weight consensus.

Upsert on `signal_id`.

### Near-miss and Bobby Rank (client-side, not in SQL)

`lib/bobby-model.js → nearMiss()`: look at the next tier up; test all four
thresholds; the badge appears only if **exactly one** fails, the miss is within
`near_miss_pct = 0.05` *of the cutoff value* (relative, not absolute), and the
game has at least `min_voters` voters. The tier never changes — the badge just
says how close it came, e.g. "Edge 0.06 from 2U".

`tierChecklist()` renders the next tier's four thresholds plus the voter
minimum with this game's value and pass/miss, which is how the card answers
"why didn't this tier".

`lib/bobby-rank.js → attachBobbyRank()`: display order only, computed over
every game on the board before any filter or sort, so a card's `#N` is stable.
Group by tier (3U, 2U, 1U, Lean, near-miss, no-play, not-computed), then by
strength = `0.5 × rescaled vote share + 0.35 × tapered edge + 0.15 ×
tightness`, where the edge term counts the first 3 points in full, points 3→5
at 25%, and nothing past 5.

---

## (b) What the CFB dashboard is made of

Everything lives inline in `app/cfb/dashboard/page.js` (1,721 lines). There is
no `components/` directory in this repo.

- Primitives: `TeamMark`, `Modal`, `BottomSheet`, `Badge`, `TierBadge`,
  `InfoIcon`, `DefBox`, `FormShell`, `FieldLabel`, `NumField`, `BetTypeTabs`,
  `SearchField`, `useLockBodyScroll`, `useIsMobile`, `useFullNamesFit`
- `LegendModal` — the how-to-read-it legend, driven by `DEFINITIONS` and
  `TIER_THRESHOLDS_DISPLAY` in `lib/bobby-model.js`
- `GameCard` — matchup row (full team names, falling back to short ones only
  when a hidden full-width probe says they don't fit), kickoff/TV/O-U meta,
  badge row (tier, near miss, flags, research tags, my-play tags), the single
  consolidated Bobby Pick line, `+ Bet` / `+ Research` actions, and the
  expandable breakdown: 9-stat grid with info icons, tier checklist, weight
  split bar, notes box, and the per-system table (system, predicts, side,
  weight bar and share, season ATS record)
- `PickModal` / `ResearchPickModal` — write `user_picks` / `research_picks`
- `MyCardModal` — This week / Season stats tabs
- Page shell: season and week selectors, unit-count summary cards that double
  as the multi-select tier filter, flags-only and my-picks-only toggles, team
  search, sort by rank / conviction / vote share / edge / std dev / tier /
  kickoff / team, and a mobile `BottomSheet` filter panel

Reads go straight to PostgREST via `sbFetch` / `sbFetchAll` with the anon key
from `lib/supabase.js`; writes to `user_picks` and `research_picks` go the same
way. Only the engine runs (`/api/bobby/*`) use the service role.

---

## (c) NFL inventory — and the two things that aren't there

### Data that exists

| Table | Rows | Notes |
|---|---|---|
| `nfl_games` | 1,424 | 2021–2025, REG + POST. `spread_line` and `spread_open` 100% populated |
| `nfl_raw_predictions` | 63,133 | `market` column, but **every row is `'spread'`** |
| `nfl_source_models` | 74 | 53 have predictions, 46 with 500+, 45 with near-full 2025 coverage, 8 inactive, 0 aggregates |
| `nfl_import_staging` | 1,425 | the wide predictiontracker CSV, 74 `line*` columns |
| `nfl_model_config` | 16 | PSS/Strong-Agreement knobs |
| `nfl_model_grades` | 50 | all stamped `season 2026, week 1` — see open questions |
| `nfl_game_metrics`, `nfl_pick_grades`, `nfl_model_pick_grades` | 0 | schema only, PSS-shaped, already have a `market` column |

Views: `nfl_model_leaderboard`, `nfl_weekly_results`, `nfl_situational_splits`,
`nfl_sample_health`, `nfl_strong_agreement_log`, `nfl_threshold_by_edge` /
`_agreement` / `_stddev` / `_key_number`.

Functions: `nfl_pool_as_of(season, week, pool_size)` (fixed top-N by `ats_pct`,
min 15 graded games, reads the latest `nfl_model_grades` row strictly *before*
the target week — properly walk-forward), `nfl_strong_agreement_plays(...)`
(unweighted mean of that pool, edge ≥ 1.5, unanimous agreement, ±3/7/10 key
crossings, JSONB pool detail, W/L/P), `nfl_model_columns()` (the CSV column
allow-list — already excludes `line`, `lineopen`, `linemidweek`, `lineavg`,
`linemed`, `linestd`, `lineca`), `nfl_resolve_model`,
`nfl_backfill_raw_predictions`.

Line convention is already normalized the way you specified: `spread_line` is
positive-means-home-favored, and `nfl_strong_agreement_plays` grades with
`(home_score − away_score) > spread_line`, matching `cfb_grade`. RLS is on with
a `FOR SELECT` policy everywhere except `nfl_import_staging`.

### Gap 1 — there is no totals data anywhere

`nfl_games.total_line` and `total_open`: **0 of 1,424 rows populated.**
`nfl_raw_predictions`: zero `market = 'total'` rows. `nfl_import_staging` has
no total-ish column at all — the 74 columns are all spread systems plus the
market/aggregate ones. So:

- A Totals **engine** can be built in Phase 1 on the schema alone.
- A Totals **backtest** (Phase 2) is impossible today. There is no historical
  NFL total, posted or predicted, to walk forward over.

I need the totals CSV sample from you (see open questions).

### Gap 2 — no NFL front-end exists in this repo

`app/layout.js` defines a 7-item `NFL_NAV` (`/nfl/dashboard`, `/nfl/pss`,
`/nfl/strong-agreement`, `/nfl/results`, `/nfl/bobby-results`,
`/nfl/research`, `/nfl/ingest`) and a CFB/NFL sport switcher. **None of those
routes exist.** There is no `app/nfl/` directory on `main`, on any other local
or remote branch, or anywhere in the git history — `git log --all
--diff-filter=A` finds zero NFL files. Every NFL nav link is currently a 404.

The Strong-Agreement page, the NFL ingest page and the ESPN scoreboard sync you
described are not in this codebase either — there is no ESPN reference in
`app/` or `lib/`, and `nfl_games.source_game_id` is populated by something
outside this repo. The likely explanation is that the NFL work lives in the
other repo (`bobbycfb-repo`) pointed at the same Supabase project. Confirming
that changes the plan materially, because the ESPN sync has to be ported here
before /nfl/dashboard can show a live 2026 week.

### Other gaps worth knowing now

- **No 2026 NFL games.** `nfl_games` stops at 2025. It is week 4–5 of the 2026
  season today. Nothing can render live until schedule ingest exists here.
- `is_divisional` and `is_primetime` are columns but **false on all 1,424
  rows** — never populated. Both are on your ATS/Results breakdown list, so
  they need a backfill (divisional is derivable from a team→division map;
  primetime from `game_date` in ET plus `season_type`).
- **No closing line and no snapshot history.** `spread_open` and `spread_line`
  only. `nfl_pick_grades` has `closing_line` and `clv` columns with nothing to
  fill them. CLV needs a snapshot table plus a post-kickoff capture step.
- **Picks, research tags and logos are CFB-only.** `user_picks`, `my_picks`,
  `research_picks` and `team_logos` all key on `games.id` (uuid).
  `nfl_games.id` is `bigint`. My Card and the Research tag on an NFL card need
  either parallel `nfl_*` tables or a sport-tagged redesign.
- `lib/team-match.js` is college-only ("Colorado St." → "colorado state",
  "Kent" → "kent state"). NFL needs its own normalizer; the CSV↔DB mapping is
  currently handled by `nfl_source_models.csv_aliases` and
  `nfl_resolve_model`, which is a good pattern to keep.
- Many `nfl_import_staging.line*` columns are typed `text`, not `double`
  (`linehanson`, `linenutshell`, `lineexcel`, `linedunk`, …), presumably
  because those columns carry non-numeric values in some rows.

---

## (d) Proposed schema

Keep the existing `nfl_*` PSS / Strong-Agreement tables untouched and add a
parallel `nfl_bobby_*` family, exactly as you laid out, reusing `nfl_games`,
`nfl_source_models` and `nfl_raw_predictions`.

```
nfl_bobby_config(market, key, value, note, updated_at)
  PK (market, key).  market in ('ats','total').
  Every cfb_tracker_config key, per market, plus:
    prior_weight_k, prior_source ('historical'|'none'), pool_size (0 = no cap),
    min_games, recency_weeks, recency_share.
  Read through nfl_bobby_cfg(market, key) — the analogue of cfb_cfg.

nfl_bobby_system_grades(id, model_id, market, season, week, source_season,
  wins, losses, pushes, games_graded, shrunk_ats, mae, bias,
  hist_ats, blended_ats, ats_score, mae_score, weight, rank, computed_at)
  UNIQUE (model_id, market, season, week)   -- week = as_of_week

nfl_bobby_lines(id, game_id, market, captured_at, phase, line, source)
  phase in ('open','ingest','current','close').  UNIQUE (game_id, market, phase)
  for open/close; 'ingest' rows accumulate.  Feeds line movement and CLV.

nfl_bobby_picks(id, game_id, market, season, week, snapshot_week,
  line_used, open_line, consensus, eq_consensus, edge, eq_edge, std_dev,
  agreement, conviction, voters, pick_side, tier, units,
  near_miss, near_miss_detail, flags[], key_numbers_crossed[],
  pool jsonb, config_version, run_id, computed_at)
  UNIQUE (game_id, market).  pool = [{model_id, name, pred, weight, share,
  side, record}] so any old pick explains itself.
  pick_side is 'home'/'away' for ats, 'over'/'under' for total.

nfl_bobby_pick_grades(id, pick_id, result, margin_vs_line, units_pl,
  closing_line, clv, beat_close, graded_at)
  UNIQUE (pick_id)

nfl_bobby_runs(id, kind, market, season, week, rows_written, config_version,
  actor, started_at, finished_at, ok, detail jsonb)

nfl_bobby_backtest_picks / _grades
  Same shape as the live tables plus (backtest_run_id, config_version),
  physically separate so live 2026 can never be blended with 2021–2025.
```

Functions `nfl_recalibrate(season, week, market)`,
`nfl_compute(season, week, market)`, `nfl_grade(season, week, market)`, ported
from the CFB versions with every constant read from `nfl_bobby_config` for that
market, plus `nfl_bobby_backtest(market, from_season, to_season)` for Phase 2.

Two deliberate departures from your outline, both recommendations rather than
decisions I've made:

1. **Totals raw predictions go in `nfl_raw_predictions` as `market = 'total'`,
   not a new `nfl_total_predictions` table.** The table already has a `market`
   column and `UNIQUE (game_id, model_id, market)`. A second table would fork
   every read and every ingest path for no benefit.
2. **Config is one row per (market, key)**, matching the `cfb_tracker_config`
   shape the CFB engine and the dashboard already read, rather than one wide
   row per market. That keeps the Ingest-page editor and the client-side
   `nearMiss` / `tierChecklist` code identical between sports.

**Cold-start prior — proposed default.** The CFB engine has no prior: weeks 1–3
of a new season either use last season wholesale (`week = 0`) or a 15-game
minimum that nobody meets. For NFL that is worse, because a week is 16 games,
not 60. I propose blending each system's current-season shrunk ATS toward its
own 2021–2025 archive ATS by games graded:

```
blended = (games × shrunk_current + prior_k × hist_ats) / (games + prior_k)
```

with `prior_k = 32` (two NFL weeks) and `hist_ats` being that system's
2021–2025 shrunk ATS. At week 2 (n≈16) the prior carries about two-thirds of
the weight; by week 8 (n≈128) it is down to a fifth; by the end of the season
it is noise. I picked 32 because it is the smallest value that stops a single
good or bad 16-game week from reordering the whole pool, while still letting a
genuinely hot system surface by midseason. A system with no archive history
falls back to 0.500 as its prior. `prior_k`, and turning the prior off
entirely, are both `nfl_bobby_config` values — and Phase 2 can tune `prior_k`
on the backtest rather than leaving my guess in place.

---

## (e) Shared vs copied components

Nothing is shared today — it is all one file. I'd extract only the pure,
presentational pieces, leaving CFB rendering byte-identical:

**Extract to `lib/ui/` and use from both sports (no behaviour change):**
`Modal`, `BottomSheet`, `Badge`, `TierBadge`, `InfoIcon`, `DefBox`,
`FormShell`, `FieldLabel`, `NumField`, `SearchField`, `TeamMark`,
`useLockBodyScroll`, `useIsMobile`, `useFullNamesFit`, `tally` / `recordStr` /
`fmtU` / `uColor`, and the colour tokens.

**Make sport-agnostic by parameterising:** `lib/bobby-model.js` — `nearMiss`,
`tierChecklist`, `TIER_COLOR`, `TIER_UNITS`, `DEFINITIONS`,
`TIER_THRESHOLDS_DISPLAY` all take a config object already; they need a market
argument so "Over 44.5" reads correctly and the definitions text can differ.
`lib/bobby-rank.js` works unchanged on any signal with vote share, edge and
std dev. `LegendModal` becomes a shell fed a definitions map.

**Copy and fork (they diverge too much to share):** `GameCard` — the NFL card
carries two markets per game, so the badge row, the pick line and the
breakdown all double. `MyCardModal` and `PickModal` — different pick table,
bigint game ids, over/under sides. The page shell — different filters (market,
divisional, primetime) and a different default week. `lib/team-short.js` and
`lib/team-match.js` — NFL names and abbreviations are a separate table.

**Existing NFL pages:** there are none, so nothing to keep, redirect or fold
in. `NFL_NAV` gets replaced with the five-item nav. My recommendation on the
two orphans: don't build `/nfl/pss` at all, and fold Strong Agreement into
`/nfl/ats` as a saved filter preset (unanimous pool + edge ≥ 1.5) rather than
its own page — the RPC can stay for reference, but a fixed top-5 unanimous
screen is a strictly narrower view of what `/nfl/ats` will already show.

---

## Open questions

1. **Totals data source.** There is no NFL total anywhere in the database. I
   need the predictiontracker NFL totals CSV sample to write the ingest, and I
   need to know whether historical totals exist for 2021–2025. If they don't,
   Totals ships as a live-2026-only feature with no backtest, and the Results
   page shows an explicit "no backtest available" state for that market. Is
   that acceptable, or should Totals wait?
2. **Where does the NFL front-end live?** Confirm the pages you described are
   in `bobbycfb-repo`, not here. If so, do you want me to port the ESPN
   scoreboard sync and NFL ingest into this repo (needed — nothing here can
   fetch an NFL schedule or score), or will that repo keep owning ingest while
   this one only reads?
3. **2026 games.** `nfl_games` has nothing past 2025 and we're in week 4–5.
   Should Phase 1 include a `/api/nfl-espn-sync` route to backfill 2026 weeks
   1–5 and the rest of the schedule?
4. **`nfl_model_grades` looks stale.** 50 rows stamped `season 2026, week 1`
   with `games_graded` up to 16, but there are no 2026 games. `nfl_pool_as_of`
   and therefore `nfl_strong_agreement_plays` read those rows, so Strong
   Agreement is currently running off phantom grades. Delete them, or is that
   a labelling convention I'm misreading?
5. **Closing lines.** Nothing captures them. CLV is on your Results list, so
   Phase 1 needs a capture step — a cron or an Ingest button run after the last
   kickoff of a week. Which do you want?
6. **Divisional and primetime** are unpopulated columns. I'll backfill both
   (division map; ET kickoff time plus `season_type`) unless you'd rather they
   come from ESPN.
7. **Indoor/outdoor** for `/nfl/totals` isn't in the schema at all. A static
   stadium roof table is easy; a per-game weather feed is not. Static roof
   flag only, or skip the column for now?
8. **Playoff games.** 65 POST rows across the archive. Include them in the
   backtest and in weighting, or regular season only? (Rest-day and line
   dynamics differ enough that I'd default to including them but tagging them
   so Results can split.)
9. **Pool size.** CFB uses "everyone with weight > 0" — no cap. Your Phase 1
   outline says pool size is a config value. I'd default `pool_size = 0`
   meaning uncapped, matching CFB, and let the backtest tell us whether a cap
   helps. Confirm?
10. **Tier cutoffs.** I'll seed both markets with the CFB numbers so the engine
    runs, but they are CFB-derived and Phase 2 exists to replace them. Until
    the backtest is reviewed, should the dashboard show tiers at all, or run in
    the `observe_mode` style the PSS config already has — compute and grade
    everything, publish no tier badges?
