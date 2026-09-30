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

The three corrective migrations are **not** separate files. Each was a
`create or replace function`, so the fix is folded back into the file that
first defined the function and the two files here replay to the same end state
the live database is in, in one pass. The live history keeps the five steps
because that is what actually happened.

### What the three fixes were, and why they were needed

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

3. **`game_date` is NULL on all 1,424 archive rows.** Two consequences:
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
