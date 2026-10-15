# The daily CFB job

`GET /api/cron/cfb-daily` — the one scheduled route. Five steps, in this order:

| # | Step | Runs |
| --- | --- | --- |
| 1 | resolve the week | `cfb_current_week` |
| 2 | sync lines | `lib/cfb-lines.js` (the logic behind `/api/cfbd-sync`) |
| 3 | grade | `lib/cfb-grade.js` (the logic behind `/api/grade`) |
| 4 | ingest predictions | `cfb_ingest_predictions` |
| 5 | refresh | `cfb_refresh` |

**The order is the whole point.** `cfb_compute` reads `games.current_line` as its
line snapshot, and `cfb_recalibrate` weights systems from graded games. Ingesting
and refreshing without steps 2 and 3 first recomputes the week against a stale
line and stale weights.

Steps 2 and 3 call shared library functions, **not** this app's own HTTP routes.
A serverless function calling back into its own deployment would need the
credential, the absolute URL and a second cold start per step, and would fail
differently in local dev. The manual Ingest page still drives the same code
through `/api/cfbd-sync` and `/api/grade`.

Everything that matters is still owned by the database: team matching, header
aliases, the post-kickoff lock, and which systems carry weight. Both RPCs are
`service_role` only.

## Failure policy

| Failing step | Effect |
| --- | --- |
| 1 resolve week | run stops, **500** |
| 2 sync lines | step 5 skipped, **500** |
| 3 grade | **run continues**, `status: "degraded"`, 200 |
| 4 ingest | step 5 skipped, **500** |
| 5 refresh | **500** |

Grading is deliberately non-blocking: stale results make the *next*
recalibration stale, but they do not corrupt this week's compute, so a CFBD
scores outage should not also cost us the ingest. A degraded run still logs
`[cfb-daily <season>] DEGRADED` via `console.error`, because otherwise a week of
silent CFBD outages would show up only as weights that stopped moving.

Step 5 is skipped rather than attempted on a blocked run: recomputing off a
stale line, or off predictions that did not land, writes signals that look
current and are not.

When `cfb_current_week` returns `current_week: null` — season over, or no
schedule loaded — the run returns `status: "no_upcoming_games"` and 200 without
writing anything.

## Routes

```
GET /api/cron/cfb-daily           # all five steps        <- the cron
GET /api/cron/cfb-daily?dry=1     # plan only, writes nothing
GET /api/cron/cfb-daily?season=2026

GET /api/cron/pt-ingest           # step 4 + 5 alone, for manual use
GET /api/cron/pt-ingest?dry=1
```

`pt-ingest` is kept for manual use and `?dry=1` inspection. It deliberately does
**not** refresh lines or results first, so it is not what you want on a
schedule.

Both are GET because Vercel Cron only issues GET. Auth is
`Authorization: Bearer $CRON_SECRET` (what Cron sends) or admin Basic, so the
same URL can be run by hand from a browser. The credential check runs before any
fetch, so an unauthenticated GET writes nothing.

## Environment

| Variable | Notes |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | required; both RPCs are service-role only |
| `NEXT_PUBLIC_SUPABASE_URL` | optional locally — falls back to the project URL in `lib/supabase.js` |
| `CRON_SECRET` | required for Vercel Cron; any long random string |
| `ADMIN_USER`, `ADMIN_PASSWORD` | **also required.** `lib/admin-auth.js` fails closed: with either missing, every request is denied 503, including a correct `CRON_SECRET` |
| `PT_SEASON` | optional override; otherwise the season is derived (month ≥ July → this year, else last year) |

## Schedule

`vercel.json` ships the Hobby-safe schedule — one run a day, which fires
somewhere inside the hour:

```json
{ "crons": [{ "path": "/api/cron/cfb-daily", "schedule": "0 14 * * *" }] }
```

On **Pro**, add the late-week runs. predictiontracker refreshes once a day, but
several systems post late — `linecraig`, `linecfp`, `linepig`, `linel2`,
`linel2hf`, `linelog`, `lineborn` and `linenewbury` were all blank in a
mid-October Wednesday pull — so a second pass Thu–Sat picks them up:

```json
{ "crons": [
  { "path": "/api/cron/cfb-daily", "schedule": "0 14 * * *" },
  { "path": "/api/cron/cfb-daily", "schedule": "0 22 * * 4,5,6" }
] }
```

Re-running is safe: the second run of an unchanged file reports
`inserted: 0, updated: 0`.

## Timeout risk — the tightest constraint

`maxDuration = 60`, the Hobby ceiling. Grading walks each game in a week with
several sequential round trips apiece, and step 3 does **two** weeks. Because
grading runs before the ingest and refresh, a run that times out inside grading
loses steps 4 and 5 entirely — a slow CFBD day costs the day's *compute*, not
just the day's grades.

Nothing is corrupted by that: every step is idempotent and the next run repeats
the work. But if timeouts appear in the Vercel log, either raise `maxDuration`
to 300 (Pro) or split grading into its own cron ordered before this one.

## The User-Agent is deliberately NOT a browser

thepredictiontracker.com is behind Cloudflare bot management. Sending a Chrome
or Safari UA from a server makes it worse, not better: Cloudflare compares the
claimed browser against the TLS fingerprint and header order, Node's do not look
like Chrome's, and the mismatch is served a "Just a moment..." challenge as
HTTP 403.

Measured against the live site:

| User-Agent | Result |
| --- | --- |
| full Chrome 125 / Safari 17 string | **403** + Cloudflare challenge page |
| `bobbycfb-model/2.0 (+repo url)` | 200, 20,806 bytes (6/6 consecutive) |
| curl's UA, python-requests' UA, no UA | 200 |

So the route identifies itself honestly. If a 403 ever starts coming back from
Vercel while a local run still works, that is bot management on the egress
address — not a reason to start spoofing a browser.

## Sanity checks

Nothing reaches the database unless the file passes all of these. Each failure
returns 5xx so a bad run is visible in the Vercel log rather than looking like a
success that ingested nothing.

- non-200 from predictiontracker (Cloudflare challenges are named as such)
- unparseable CSV
- missing `home` / `road` columns
- fewer than 20 `line*` model columns
- zero data rows, or no row with a numeric prediction

A truncated or reshaped file that still parses is the case these exist for:
ingesting a handful of systems and recomputing the week off them would otherwise
look normal.

## What is excluded from `preds`

Every `line*` header is sent with its **raw** predictiontracker name — renaming
anything here would defeat `cfb_header_alias` — except these, which are not a
system's prediction:

`line`, `lineopen`, `linemidweek`, `lineavg`, `linemedian`, `linestd`,
`linecons`, `lineca`

`line` is not in the spec's omit list but is excluded for the same reason
`upload-predictions` and `lib/nfl-csv.js` already exclude it: it is the market
line, not a model. Sending it would auto-register Vegas as a system.

A current pull yields **59 rows / 49 model columns**. Blank cells are empty
strings — not `.`, not `nan` (596 empty, zero of either, in the verified pull).

## What the cron does NOT cover

`/api/pss-compute`, `/api/pss-grade`, `/api/bobby/*`, `/api/recalibrate` and
`/api/team-logos-sync` are still manual, from the Ingest page. Only the CFB
consensus path (lines → grades → predictions → compute) is scheduled.

## Manual fallback

The Ingest page (`/cfb/ingest` → `POST /api/upload-predictions`) still does its
own in-route matching against `source_models` and `games`, so it does **not**
share the kickoff lock, the alias table or `cfb_ingest_runs` logging. Pointing it
at `cfb_ingest_predictions` (with `p_backfill: true` for archive files) would put
both paths on the same lock and log. Not changed here.

## Troubleshooting

Unmatched games and newly auto-registered columns are logged as a single
`console.error` line prefixed `[pt-ingest <season>] NEEDS ATTENTION` and returned
in the response as `unmatched` / `new_columns`.

Add a team alias (the key must be the normalized predictiontracker name):

```sql
insert into cfb_team_alias(norm_key, team)
values (cfb_norm_team('PT Name Here'), 'Exact games.home_team value')
on conflict (norm_key) do update set team = excluded.team;
```

A column in `new_columns` is sitting in `source_models` at status `verify` and
contributes nothing to the consensus until it is reviewed and set to `include`.

Check recent runs:

```sql
select * from cfb_ingest_runs order by id desc limit 5;          -- expect status = 'ok'
select * from raw_prediction_history order by seen_at desc limit 20;
```

Override the lock for manual repair, within one session only:

```sql
set local cfb.force = 'on';
select cfb_compute(season, week);
```
