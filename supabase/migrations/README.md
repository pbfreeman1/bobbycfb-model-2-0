# Migrations

Note that `supabase/migrations/` was empty before this branch — every earlier
migration, including `bobby_model_core`, exists only in the live database's
`supabase_migrations.schema_migrations`. The two NFL files here are the first
to be tracked in the repo.

## Applied to zpmdrazbqgzheqkvfltv on 2026-09-30

| version | name | in repo as |
|---|---|---|
| 20260930145410 | `nfl_bobby_schema` | `20260930000100_nfl_bobby_schema.sql` |
| 20260930145616 | `nfl_bobby_engine` | `20260930000200_nfl_bobby_engine.sql` |
| 20260930145754 | `nfl_bobby_fix_near_miss_voters_cast` | folded into `…000200` |
| 20260930145837 | `nfl_bobby_fix_near_miss_array_append` | folded into `…000200` |
| 20260930150028 | `nfl_bobby_lock_and_classify_null_game_date` | folded into `…000100` and `…000200` |
| 20260930…  | `nfl_bobby_clv_first_and_backtest_clv_open` | `20260930000300_nfl_bobby_clv_first.sql` |
| 20260930…  | `nfl_games_add_tv_network` | `20260930000400_nfl_games_tv_network.sql` |
| 20260930…  | `nfl_espn_staging_transient` + `nfl_espn_staging_drop` | `20260930000500_nfl_espn_staging.sql` |
| 20260930…  | `nfl_classify_primetime_by_kickoff_hour` | folded into `…000100` |

Migrations that only did `create or replace function` are **not** separate
files — the fix is folded back into the file that first defined the function, so
the files here replay to the same end state the live database is in, in one
pass. The live history keeps every step because that is what actually happened.
That covers the three engine fixes below and the primetime rule correction.

### What the three engine fixes were, and why they were needed

A `BEGIN … ROLLBACK` dry run of both files passed clean, and both applied
without error — but **Postgres does not plan the SQL inside a plpgsql function
body at `CREATE` time**, only at first execution. So neither the dry run nor
the apply could catch anything inside `nfl_recalibrate` / `nfl_compute` /
`nfl_grade`. All three bugs below were found by actually executing the engine
against real 2025 rows inside a transaction that was then rolled back. Do that
after any future engine change; applying cleanly proves very little.

1. **`42883` function does not exist.** `nfl_compute` passed `nv`
   (`count(*)`, so `bigint`) into `nfl_bobby_near_miss(… p_voters integer)`.
   `bigint` → `integer` is not an implicit cast for function resolution. Fixed
   by casting at the call site (`nv::int`) rather than widening the signature.

2. **`22P02` malformed array literal.** `v_fails := v_fails || 'Conv'` with
   `v_fails text[]` resolves to the `array || array` operator, so `'Conv'` was
   parsed as an array literal. Fixed with `|| 'Conv'::text`, which selects
   `array || element`. All four branches had it.

3. **`game_date` was NULL on all 1,424 archive rows** (since backfilled from
   ESPN). Two consequences:
   - `nfl_compute`'s kickoff lock tested `game_date <= now()`, so a NULL
     kickoff read as "not started" and **no archive pick ever locked**,
     leaving settled historical picks rewritable — the exact thing the lock
     exists to prevent. A final score now also counts as started.
   - `nfl_classify_games` required `game_date is not null`, so it would have
     classified zero games and `is_divisional` — which needs no kickoff time —
     would have stayed false across the whole archive. Split, so divisional is
     always set and primetime is left untouched (not forced false) where
     kickoff is unknown.

## Verified after applying

- 14 new tables, each with an explicit `FOR SELECT USING (true)` policy; the
  three My Card tables additionally carry the anon insert/update/delete
  policies the dashboard needs.
- 32 teams, 8 divisions of 4. `nfl_classify_games(2025)` sets 99 divisional
  games, which matches 32 × 6 ÷ 2 = 96 regular-season plus playoff rematches.
- 68 config rows, 34 per market. `nfl_bobby_game_lines` = 2,848 = 1,424 × 2.
- Full engine round trip on 2025 week 5: 43 systems graded, 13 with weight,
  14 picks, 8 tiered across 1U/2U/Lean, 14 graded 5-9-0 at −1.20u, pool JSON
  length equals `voters` on all 14.
- **Kickoff lock holds**: a second `nfl_compute` on the same week wrote 0 rows.
- Anon `GET` returns 200 on all 14 tables and the view. Anon `POST` to
  `nfl_user_picks` returns `23503` (foreign key), not `42501` (RLS), proving
  the write policy passes; a totals pick with a team side returns `23514`.

All of the above ran inside `BEGIN … ROLLBACK`, so no engine output persisted.
`nfl_bobby_picks`, `_pick_grades`, `_system_grades`, `_lines`, `_runs`,
`_system_priors` and `_system_seeds` are all empty by design at this point.


## Engine smoke test — REQUIRED after any engine change

`supabase/tests/nfl_engine_smoke.sql` must pass after any change to
`nfl_recalibrate`, `nfl_compute`, `nfl_grade`, `nfl_bobby_near_miss`,
`nfl_bobby_track_first_snapshot`, or the tables and config they read.

It runs the full round trip on 2025 week 5 inside `BEGIN … ROLLBACK` and
**asserts** — a failure raises rather than printing something skimmable. It
covers the kickoff lock (including the "a final score counts as started"
fallback that the NULL `game_date` archive depends on), the pool-snapshot
length invariant, the `first_line` trigger, and that a totals compute refuses
cleanly when no weights exist.

This exists because applying a migration cleanly proves almost nothing here:
Postgres does not plan SQL inside a plpgsql body until first execution. Three
real bugs passed both a clean `CREATE` and a clean rollback-wrapped dry run.

## RLS parity with CFB — confirmed

Checked rather than assumed. The CFB tables all use `USING (true)` /
`WITH CHECK (true)` granted to PUBLIC:

| table | CFB | NFL equivalent |
|---|---|---|
| `user_picks` | select, insert, update, delete | `nfl_user_picks` — same four |
| `research_picks` | select, insert, delete | `nfl_research_picks` — same three |
| `team_logos` | select only | `nfl_team_logos` — select only |

The NFL policies mirror CFB exactly and are not looser. CFB's `user_picks`
carries two functionally identical insert policies (`public insert user_picks`
and `public write user_picks`); the NFL side has one, which is the same
effective permission.

## Later todo — baseline snapshot of the pre-branch schema

**Not done, deliberately.** `supabase/migrations/` was empty before this
branch, so everything up to and including `bobby_model_core` (the CFB engine,
the PSS tables, the original `nfl_*` tables, `nfl_strong_agreement_plays`)
exists only in the live database's `supabase_migrations.schema_migrations`. A
fresh environment cannot currently be rebuilt from this repo.

Worth dumping those 29 earlier migrations into files as a baseline so the repo
is self-sufficient. Left for a separate pass because it touches nothing on this
branch and would bury the NFL work in a very large diff.

## ESPN backfill results

| season | games | kickoff | network | ESPN id | divisional | primetime (REG) | neutral |
|---|---|---|---|---|---|---|---|
| 2021 | 285 | 285 | 285 | 285 | 99 | 56 | 3 |
| 2022 | 284 | 284 | 284 | 284 | 100 | 55 | 7 |
| 2023 | 285 | 285 | 285 | 285 | 96 | 58 | 6 |
| 2024 | 285 | 285 | 285 | 285 | 98 | 59 | 6 |
| 2025 | 285 | 285 | 285 | 285 | 99 | 60 | 8 |
| 2026 | 64 | 64 | 64 | 64 | 17 | 13 | 3 |

100% coverage, zero unresolved team names, zero home/away disagreements. 2026 is
weeks 1-4 only, inserted fresh; 2021-2025 were update-only against the
predictiontracker spine.

2025 regular-season primetime breaks down as 18 SNF + 21 MNF + 17 TNF + 1 Friday
+ 3 Saturday = 60, every one at or after 7pm ET.
