# NFL predictiontracker column map

Every `line*` and `tot*` column across every source, with what it resolves to.
**Nothing has been written from this yet** — no alias rows, no model rows, no
predictions. This is the proposal.

Sources and their row counts:

| key | source | rows | covers |
|---|---|---|---|
| A | `nfl_import_staging` (loaded 2021-25 spread archive) | 1,425 | 2021-2025 |
| B | `data/archive/nfl_spread/nfl26_ats.csv` | 48 | 2026 wk 1-3 |
| C | `data/samples/nfl_spread_sample.csv` | 16 | 2026 wk 4 |
| D | `data/archive/nfl_totals/nfltotals26.csv` | 32 | 2026 wk 1-2 |
| E | `data/samples/nfl_totals_sample.csv` | 16 | 2026 wk 4 |

The 2021-2025 **totals** history is not here yet, so no totals column has any
pre-2026 evidence. Numbers in the table are filled cells, not percentages.

## Status meanings

- **MAPPED** — resolves to an existing `nfl_source_models` row, either by exact
  `model_key` or via an existing `csv_aliases` entry, or (for `tot*`) by a new
  alias this proposal would add.
- **NEW MODEL** — needs a new `nfl_source_models` row.
- **DORMANT** — the column exists but is empty in every file we hold. Not
  excluded: a null is skipped at ingest anyway, so if the system starts
  publishing, it flows in with no code change. Excluding them permanently would
  be wrong for `tot*` columns that clearly belong to a real system.
- **EXCLUDED** — never a model input: the market line, the pre-computed
  aggregates, and `lineca` (~0.999 correlated with the market line).

## Spread (`line*`) — 59 mapped, 12 dormant, 8 excluded

| column | status | -> model_key | system | A 21-25 | B 26arc | C cur | D 26tot | E curtot |
|---|---|---|---|--:|--:|--:|--:|--:|
| `lineash` | MAPPED | `lineash` | Ashby AccuRatings | 1425 | 48 | 16 | - | - |
| `linedonchess` | MAPPED | `linedonchess` | Donchess Inference | 1425 | 48 | 16 | - | - |
| `lineelo` | MAPPED | `lineelo` | Beck Elo | 1425 | 48 | 16 | - | - |
| `lineffw` | MAPPED | `lineffw` | FF-Winners | 1425 | 48 | 16 | - | - |
| `linel1` | MAPPED | `linel1` | Least Abs. Val Reg | 1425 | 48 | 16 | - | - |
| `linel2` | MAPPED | `linel2` | Least Squares | 1425 | 48 | 16 | - | - |
| `linel2h` | MAPPED | `linel2h` | LS - w/ team HFA | 1425 | 48 | 16 | - | - |
| `linel2to` | MAPPED | `linel2to` | Turnover Adj. regression | 1425 | 48 | 16 | - | - |
| `linelog` | MAPPED | `linelog` | Logistic Regression | 1425 | 48 | 16 | - | - |
| `linemass` | MAPPED | `linemass` | Massey Ratings | 1425 | 48 | 16 | - | - |
| `linemore` | MAPPED | `linemore` | Sonny Moore | 1425 | 48 | - | - | - |
| `linepi` | MAPPED | `linepi` | Pi-Rate Ratings | 1425 | 48 | 16 | - | - |
| `linepib` | MAPPED | `linepib` | Pi-Rate Bias | 1425 | 48 | 16 | - | - |
| `linepim` | MAPPED | `linepim` | Pi-Rate Mean | 1425 | 48 | 16 | - | - |
| `lineppg` | MAPPED | `lineppg` | Points Per Game | 1425 | 48 | 16 | - | - |
| `linepugh` | MAPPED | `linepugh` | Pugh | 1425 | 48 | 16 | - | - |
| `linepyth` | MAPPED | `linepyth` | Pythagorean Ratings | 1425 | 48 | 16 | - | - |
| `linepz` | MAPPED | `linepz` | PerformanZ Ratings | 1425 | 48 | - | - | - |
| `linesag` | MAPPED | `linesag` | Sagarin Rating | 1425 | 48 | 16 | - | - |
| `linesaggm` | MAPPED | `linesaggm` | Sagarin Golden Mean | 1425 | 48 | 16 | - | - |
| `linesagp` | MAPPED | `linesagp` | Sagarin Points | 1425 | 48 | - | - | - |
| `linesagr` | MAPPED | `linesagr` | Sagarin Recent | 1425 | 48 | 16 | - | - |
| `linestjohn` | MAPPED | `linestjohn` | Lou St. John | 1425 | 48 | 0 | - | - |
| `linetalis` | MAPPED | `linetalis` | Talisman Red | 1425 | 48 | 16 | - | - |
| `lineteamrank` | MAPPED | `lineteamrank` | TeamRankings.com | 1425 | 48 | 16 | - | - |
| `lineclean` | MAPPED | `lineclean` | Cleanup Hitter | 1424 | 48 | 16 | - | - |
| `linedok` | MAPPED | `linedok` | Dokter Entropy | 1424 | 48 | 0 | - | - |
| `linedwig` | MAPPED | `linedwig` | Dwiggins | 1424 | 48 | 16 | - | - |
| `lineeff` | MAPPED | `lineeff` | Scoring Effeciency | 1423 | 48 | 16 | - | - |
| `lineespn` | MAPPED | `lineespn` | ESPN FPI | 1418 | 48 | 16 | - | - |
| `linecurry` | MAPPED | `linecurry` | Daniel Curry Index | 1412 | 48 | 0 | - | - |
| `linekerns` | MAPPED | `linekerns` | Stephen Kerns | 1409 | 48 | 0 | - | - |
| `linerwp` | MAPPED | `linerwp` | Laffaye RWP | 1398 | 48 | 0 | - | - |
| `lineexcel` | MAPPED | `lineexcel` | RP Excel | 1382 | 48 | 0 | - | - |
| `linedunk` | MAPPED | `linedunk` | Dunkel Index | 1361 | 32 | 16 | - | - |
| `linepig` | MAPPED | `linepig` | Pigskin Index | 1348 | 0 | 0 | - | - |
| `linehanson` | MAPPED | `linehanson` | Dan Hanson | 1329 | 48 | 0 | - | - |
| `linegt` | MAPPED | `linegt` | Game Time Decision | 1315 | 48 | 16 | - | - |
| `linejohns` | MAPPED | `linejohns` | Roger Johnson | 1169 | 0 | - | - | - |
| `lineargh` | MAPPED | `lineargh` | ARGH Power Ratings | 1121 | - | - | - | - |
| `linecoff` | MAPPED | `linecoff` | John Coffey | 1045 | 0 | 0 | - | - |
| `lineround` | MAPPED | `lineround` | Roundtable | 963 | - | - | - | - |
| `linebihl` | MAPPED | `linebihl` | Bihl Rankings | 908 | 0 | 0 | - | - |
| `linefox` | MAPPED | `linefox` | Fox Sports | 855 | - | - | - | - |
| `linecong` | MAPPED | `linecong` | Congrove Computer Ranking | 570 | 48 | 0 | - | - |
| `lineexcel2` | MAPPED | `lineexcel2` | RP Excel 2 | 549 | - | - | - | - |
| `lineesp` | MAPPED | `lineesp` | Enhanced Spread Projections | 436 | - | - | - | - |
| `lineesp2` | MAPPED | `lineesp2` | Enhanced Spread Projections 2 | 436 | - | - | - | - |
| `lineturner` | MAPPED | `lineturner` | Turner Ratings | 297 | - | - | - | - |
| `linedoi` | MAPPED | `linedoi` | Director of Information | 285 | 48 | 16 | - | - |
| `linenfelo` | MAPPED | `linenfelo` | NFELO | 285 | 48 | 16 | - | - |
| `linegrok` | MAPPED | `linegrok` | Grok | 284 | 48 | - | - | - |
| `lineshark` | MAPPED | `lineshark` | Odds Shark | 283 | - | - | - | - |
| `linebetbetter` | MAPPED | `linebetbetter` | Bet Better | - | - | 16 | - | - |
| `linekam` | MAPPED | `linekam` | Kambour Rating | - | - | 16 | - | - |
| `linemoore` | MAPPED | `linemore` | Sonny Moore | - | - | 16 | - | - |
| `linepfz` | MAPPED | `linepz` | PerformanZ Ratings | - | - | 16 | - | - |
| `linepve` | MAPPED | `linepve` | PvE Sports Ratings | - | - | 16 | - | - |
| `linesagpred` | MAPPED | `linesagp` | Sagarin Points | - | - | 16 | - | - |
| `lineblitz` | DORMANT | `lineblitz` | Statblitz Index | - | - | 0 | - | - |
| `linecongrove` | DORMANT | — | — | - | - | 0 | - | - |
| `linecovers` | DORMANT | `linecovers` | Covers.com | 0 | - | - | - | - |
| `linecraig` | DORMANT | `linecraig` | Brent Craig | 0 | - | - | - | - |
| `linefeng` | DORMANT | `linefeng` | Feng Ratings | 0 | - | - | - | - |
| `lineform` | DORMANT | `lineform` | Formula Ratings | 0 | - | - | - | - |
| `lineherbert` | DORMANT | `lineherbert` | Herbert Ratings | 0 | - | - | - | - |
| `linejens` | DORMANT | `linejens` | Steven Jens | 0 | - | - | - | - |
| `linejens2` | DORMANT | `linejens2` | Steven Jens 2 | 0 | - | - | - | - |
| `linejohnson` | DORMANT | `linejohns` | Roger Johnson | - | - | 0 | - | - |
| `linenewbury` | DORMANT | `linenewbury` | Max Newbury | - | - | 0 | - | - |
| `linenutshell` | DORMANT | `linenutshell` | Football Nutshell | 0 | - | - | - | - |
| `line` | EXCLUDED | — | — | 1425 | 48 | 16 | 32 | 16 |
| `lineavg` | EXCLUDED | — | — | 1425 | 48 | 16 | - | - |
| `lineca` | EXCLUDED | — | — | 1425 | 48 | 16 | - | - |
| `linemed` | EXCLUDED | — | — | 1425 | 48 | - | - | - |
| `linemidweek` | EXCLUDED | — | — | 1425 | 48 | 0 | 32 | 0 |
| `lineopen` | EXCLUDED | — | — | 1425 | 48 | 16 | 32 | 16 |
| `linestd` | EXCLUDED | — | — | 1425 | 48 | 16 | - | - |
| `linemedian` | EXCLUDED | — | — | - | - | 16 | - | - |

## Totals (`tot*`) — 17 mapped, 1 new, 4 dormant, 3 excluded

| column | status | -> model_key | system | A 21-25 | B 26arc | C cur | D 26tot | E curtot |
|---|---|---|---|--:|--:|--:|--:|--:|
| `totpirate` | NEW MODEL | `totpirate` | Pi-Rate (totals) | - | - | - | 32 | 16 |
| `totashby` | MAPPED | `lineash` | Ashby AccuRatings | - | - | - | 32 | 16 |
| `totbetbetter` | MAPPED | `linebetbetter` | Bet Better | - | - | - | 32 | 16 |
| `totclean` | MAPPED | `lineclean` | Cleanup Hitter | - | - | - | 32 | 16 |
| `totcurry` | MAPPED | `linecurry` | Daniel Curry Index | - | - | - | 32 | 0 |
| `totdokter` | MAPPED | `linedok` | Dokter Entropy | - | - | - | 32 | 0 |
| `totdonchess` | MAPPED | `linedonchess` | Donchess Inference | - | - | - | 32 | 16 |
| `totexcel` | MAPPED | `lineexcel` | RP Excel | - | - | - | 32 | 0 |
| `totffw` | MAPPED | `lineffw` | FF-Winners | - | - | - | 32 | 16 |
| `tothanson` | MAPPED | `linehanson` | Dan Hanson | - | - | - | 32 | 0 |
| `totmass` | MAPPED | `linemass` | Massey Ratings | - | - | - | 32 | 16 |
| `totnewbury` | MAPPED | `linenewbury` | Max Newbury | - | - | - | 32 | 0 |
| `totpugh` | MAPPED | `linepugh` | Pugh | - | - | - | 32 | 16 |
| `totpve` | MAPPED | `linepve` | PvE Sports Ratings | - | - | - | 32 | 16 |
| `totrwp` | MAPPED | `linerwp` | Laffaye RWP | - | - | - | 32 | 0 |
| `totsag` | MAPPED | `linesag` | Sagarin Rating | - | - | - | 32 | 0 |
| `totstjohn` | MAPPED | `linestjohn` | Lou St. John | - | - | - | 32 | 0 |
| `tottalis` | MAPPED | `linetalis` | Talisman Red | - | - | - | 32 | 16 |
| `totbihl` | DORMANT | `linebihl` | Bihl Rankings | - | - | - | 0 | 0 |
| `totcoffey` | DORMANT | `linecoff` | John Coffey | - | - | - | 0 | 0 |
| `totkerns` | DORMANT | `linekerns` | Stephen Kerns | - | - | - | 0 | 0 |
| `totround` | DORMANT | `lineround` | Roundtable | - | - | - | 0 | 0 |
| `totavg` | EXCLUDED | — | — | - | - | - | 32 | 16 |
| `totmed` | EXCLUDED | — | — | - | - | - | 32 | 16 |
| `totstd` | EXCLUDED | — | — | - | - | - | 32 | 16 |

## Also excluded, non-`line`/`tot` columns

`road`, `home`, `Home`, `Road`, `date`, `week`, `rscore`, `hscore`, `neutral`,
`phcover`, `phwin`, `min`, `max`.

## Aliases this proposal would add

21 `tot*` aliases onto existing model rows, plus one new model row. One
`model_id` per system across both markets, which is what
`nfl_raw_predictions UNIQUE (game_id, model_id, market)` is built for, and it
means a system's spread and totals records grade separately while its identity
stays single.

Existing spread aliases already in the table and needing no change:
`linejohns`←`linejohnson`, `linemore`←`linemoore`, `linepz`←`linepfz`,
`linesagp`←`linesagpred`, `linemed`←`linemedian`.

---

# Resolution log

Every alias and model row actually created, and why. Updated as columns appear.

## 2026-09-30 — tot* mapping completed

The map above was built from `nfltotals26.csv` alone. The 2021–2025 totals files
carry **28** `tot*` system columns in total, not 22, so five more needed
resolving. Standing rule applied: a `tot*` column with no unambiguous spread
counterpart becomes a totals-only model row; only ambiguity between two or more
existing systems is escalated.

### Aliases added onto existing model rows (25)

First batch, 21: `totmass`→`linemass`, `totbihl`→`linebihl`,
`totexcel`→`lineexcel`, `totdonchess`→`linedonchess`, `totdokter`→`linedok`,
`totpve`→`linepve`, `tottalis`→`linetalis`, `totpugh`→`linepugh`,
`totclean`→`lineclean`, `totround`→`lineround`, `tothanson`→`linehanson`,
`totffw`→`lineffw`, `totrwp`→`linerwp`, `totsag`→`linesag`,
`totstjohn`→`linestjohn`, `totbetbetter`→`linebetbetter`, `totashby`→`lineash`,
`totcurry`→`linecurry`, `totcoffey`→`linecoff`, `totkerns`→`linekerns`,
`totnewbury`→`linenewbury`.

Second batch, 4, found only in the 2021–2025 files: `totargh`→`lineargh`
(1,137 rows), `totshark`→`lineshark` (852), `totexcel2`→`lineexcel2` (549),
`totgrok`→`linegrok` (284). All four are retired spread systems. That is fine:
priors deliberately ignore `is_active`, so their history still counts.

One `model_id` per system across both markets, which is what
`nfl_raw_predictions UNIQUE (game_id, model_id, market)` is for. A system's
spread and totals records grade separately while its identity stays single.

### New totals-only model rows (3)

| model_key | display_name | rows | why not aliased |
|---|---|---|--:|---|
| `totpirate` | Pi-Rate (totals) | 1,470 | Three Pi-Rate spread variants exist (`linepi` Ratings, `linepim` Mean, `linepib` Bias) and nothing says which the totals feed matches. Escalated and confirmed. |
| `totturing` | Turing (totals) | 298 | `lineturner` is "Turner Ratings" — a different name, no established link. |
| `totwhatif` | What If (totals) | 0 | No spread counterpart at all. Empty in every file held; created so a future publish needs no code change. |

### Correction to the table above

`totbihl`, `totcoffey`, `totkerns` and `totround` are marked DORMANT above.
That was correct for `nfltotals26.csv` but wrong for the archive as a whole —
they carry 857, 1,045, 1,140 and 963 rows across 2021–2025. They are simply not
publishing totals in 2026. Only `totwhatif` is dormant across every file.

### Still unmapped

`linecongrove` — 0 rows everywhere, so there is nothing to correlate against
`linecong` yet. Stays unmapped by decision.
