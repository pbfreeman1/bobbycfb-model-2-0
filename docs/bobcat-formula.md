# The Bobcat Formula

A frozen definition and an honest record of where it came from. This is a
tracking experiment, not a card. Nothing here is a recommendation to wager.

## Status

Experimental. Forward-tracked from **2026 Week 5** (`bobcat_forward_week` in
`cfb_tracker_config`; the UI and this document read the week from that row rather
than hardcoding it). Week 5 qualifies as forward because the flag was written
before any of its games kicked off.

**The rule: no threshold changes during the forward test.** Not the edge band,
not the hit minimum, not the coverage floor, not the top-k share. If a threshold
is wrong, that is a finding to record, not a dial to turn. Retuning mid-test
converts the forward sample back into a backtest and destroys the only thing it
was for.

## Definition (frozen)

A signal is flagged `bobcat` when **all** of the following hold:

| Condition | Config key | Value |
|---|---|---|
| `abs(edge) >=` | `bobcat_edge_min` | 1.5 |
| `abs(edge) <` (exclusive) | `bobcat_edge_max` | 3.0 |
| `hit_side = pick_side` | — | — |
| `hit_count >=` | `bobcat_hits_min` | 10 |
| `coverage >=` | `min_coverage` | 0.70 |

Where:

- `edge = consensus - vegas_line`, home-positive, so a positive edge favors the
  home team. `pick_side` is `'home'` or `'away'`.
- **Top-k hits.** Rank every system's *own* slate for that week by
  `abs(model_edge)`, where `model_edge = predicted_margin - vegas_line`, and take
  its biggest `bobcat_topk_pct` (10%), rounded up. A flagged system votes `home`
  when its `model_edge > 0` and `away` when `< 0`; a `model_edge` of exactly 0
  votes for neither side. The pool is **every** system with a prediction (~38),
  not only the weighted ones.
- `hit_side` is the side with more flags (a tie gives `null`), `hit_count` is the
  flags on that side, `hit_opp` the flags on the other.
- `coverage` is the share of the week's total system weight held by systems that
  actually have a prediction for the game.

`bobcat_eq` is a **shadow variant**: identical, except the magnitude test uses
`eq_edge` (the equal-weight consensus edge) and `sign(eq_edge)` must match
`hit_side`, in place of `edge`/`pick_side`.

### The shadow variant is graded on its own side

`cfb_signal_grades.ats_result` grades `sign(edge)` — the `pick_side` play. The
shadow variant is judged on `eq_edge`, and the two can point at opposite teams.
2026 Week 4 Tulsa @ Arkansas is the live example: `edge +5.66` (home) against
`eq_edge -2.77` (away). Arkansas covered, so the stored grade reads `win`, while
the shadow variant's actual Tulsa +7 play lost. Reusing `ats_result` there would
have recorded the shadow variant 1-0 when it was truly 0-1. So
`cfb_bobcat_log` carries `eq_ats_result` / `eq_flat_pl`, derived from the final
margin against `sign(eq_edge)`, and the summary aggregates those for that
variant. On a sample this small one sign error is the difference between 100% and
0%.

## Where the idea came from, and why it is weak evidence

A 2022-2025 backtest of this slice, using the **old top-7 pool consensus**, went:

- **40-23, 63.5%** overall
- By season: **64.7% / 45.5% / 71.4% / 64.3%**
- At 12+ hits instead of 10, it fell to **50.0%**
- Using an **equal-weight** consensus instead, it was **52.4% on 21 plays**

Four reasons to distrust all of that:

1. **One season is a coin flip against the others.** 45.5% sits inside the
   spread of the other three. A rule whose by-season results range from 45% to
   71% has not demonstrated a stable effect.
2. **It breaks under a small threshold nudge.** Moving the hit minimum from 10 to
   12 — tightening what should be the *stronger* signal — drops it to 50%. A real
   edge usually strengthens as its condition tightens. This behaves like a
   threshold fitted to the sample.
3. **It breaks under a reasonable change of consensus.** The same slice on an
   equal-weight consensus is 52.4%, essentially break-even after juice.
4. **The dashboard edge is a third, untested definition.** The backtest used the
   top-7 pool consensus. The current engine uses a weighted consensus over all
   qualifying systems. The number the flag is computed from today is not the
   number the 63.5% was measured on, so that figure does not transfer.

Treat 40-23 as the reason this is worth measuring, not as evidence it works.

## Sample size

Expect roughly **15-20 flags per season**. At 20 plays, the standard error on a
win rate is about 11 points, so a 63% season and a 52% season are not
distinguishable. **A single season cannot confirm this.** Judge it in multiples of
seasons, and against the `control` cohort rather than against 50%.

`control` is the comparison that matters: signals in the same edge band, on the
same side as the hits, that did **not** clear the hit-count or coverage bar. If
Bobcat and control land in the same place, the hit filter is doing nothing.

Backfill rows (weeks before `bobcat_forward_week`) were scored after the fact and
were **never pre-registered**. They are labeled as such everywhere they appear
and cannot support the formula.

## Where it lives

| Thing | Name |
|---|---|
| Flag + hit columns | `cfb_game_signals.coverage, models_n, hit_home, hit_away, hit_count, hit_opp, hit_side, bobcat, bobcat_eq` |
| Compute | `cfb_compute_bobcat(season, week)`, called at the end of `cfb_compute` |
| Coverage | `cfb_game_coverage(season, week)` |
| Per-system detail | `cfb_topk_detail(game_id)` |
| Log / summary | `cfb_bobcat_log`, `cfb_bobcat_variants`, `cfb_bobcat_summary`, `cfb_bobcat_summary_by_week` |
| Page | `/cfb/bobcat-log` |
| Thresholds | `cfb_tracker_config` |

`cfb_compute_bobcat` is idempotent and set-based: re-running a week rewrites the
hit columns and clears flags on games that no longer qualify. Re-running it does
**not** touch tier, units or flags.

## Operating notes

- The flag that counts is the one from the **last compute before kickoff**.
  Re-uploading a week's CSV and recomputing before kickoff can legitimately
  change the flag; that final pre-kickoff version is the one to grade.
- **Do not recompute a week after kickoff.** That would rewrite a pre-registered
  flag with hindsight and silently invalidate the forward sample.

## Coverage guardrail (shipped alongside, separate feature)

Independent of the Bobcat flag: a game whose predicting systems carry less than
`min_coverage` (70%) of the week's total weight is capped at tier `1U` with 1
unit, and gains a `Low coverage` flag. Coverage is stored on every signal.

On 2026 weeks 1-5 the lowest coverage was 0.8387, so the guardrail changed
nothing retroactively — the backfill was verified byte-identical on tier, units
and flags.
