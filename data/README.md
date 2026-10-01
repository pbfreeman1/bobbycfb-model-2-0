# predictiontracker source data

## samples/
Current-week files, kept as format references for the ingest parsers.

- `nfl_spread_sample.csv` — 16 games, 50 system columns. **No `week` and no
  `date` column**, so season and week must be passed to the upload route, the
  way the CFB route already does it.
- `nfl_totals_sample.csv` — 16 games, 22 `tot*` system columns, and it *does*
  carry `date` and `week`.

## archive/
2026 season history, pulled once.

- `nfl_spread/nfl26_ats.csv` — 48 games, weeks 1-3, with `rscore` / `hscore`
  finals. Header is `Home,Road` (capitalised, home first). 45 system columns.
- `nfl_totals/nfltotals26.csv` — 32 games, weeks 1-2 only. **Week 3 totals are
  missing.** No scores; finals come from ESPN via `nfl_games`.

## Conventions

`date` is a SAS serial: days since 1960-01-01. 24383 = 2026-10-04 (week 4
Sunday). Week 1 Sunday was 2026-09-13.

`line` and every system column are in **home-margin** terms: positive means
the home team is favoured, the opposite of sportsbook notation. Verified
against a completed archive row — home margin, system predictions and the line
all carry the same sign. Totals columns are raw combined points and are not
home-relative.

Market and aggregate columns to exclude from model inputs: `line`, `lineopen`,
`linemidweek`, `lineavg`, `linemedian`, `linemed`, `linestd`, `lineca`,
`totavg`, `totmed`, `totstd`, `min`, `max`, plus `neutral`, `phcover`,
`phwin`, `rscore`, `hscore`, `week`, `date`.

## Column drift

The same system is named differently between the archive and current-week
files. `nfl_source_models.csv_aliases` already covers every spread case:
`linejohns`/`linejohnson`, `linemore`/`linemoore`, `linepz`/`linepfz`,
`linesagp`/`linesagpred`, `linemed`/`linemedian`. The `tot*` names still need
aliases added.

## Dead totals columns

`totbihl`, `totcoffey`, `totkerns` and `totround` are empty in every file we
have. 18 totals systems have usable archive coverage.

The current-week totals file is published early in the week and carries only
11 of the 22 systems; the post-week archive file carries 18. Re-ingesting
closer to kickoff picks up the rest, which is a reason to keep taking `ingest`
line snapshots rather than reading the week once.
