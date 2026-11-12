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

## Insights (Research Report > Insights)
Graded spread tags sliced by model tier, with/against model, dog/fav, home/road, distinct sources, KAM rank band and source, plus totals. Each game+side counts once, flat 1u. "All" is the in-sample hypothesis; the Forward column (week 11+) is the test. Rows with under 10 decided results are marked `*`.

## Lines
Each game now has a frozen `pt_line` (PredictionTracker's `line`, set when the CSV is uploaded, locked at kickoff). The model computes and recalibrates on it, falling back to `current_line` when missing. A `Stale line` badge appears when `pt_line` and the book line differ by 3+ points or flip sign; it is display-only.

## KAM import (Quick Tag > Import KAM ranks)
Set the week first (Quick Tag defaults to the last graded week). **Import KAM ATS** or **Import KAM Totals** reads the Kambour page (highest probability first), shows a preview, and saves on confirm. Ranks 1-10 become `KAM #n`, 11-15 become `KAM Topish` (both cutoffs adjustable). ATS pick = the team whose predicted score covers the printed spread; totals use the O/U shown on the page. Existing KAM tags for the same game+side+type are left alone if the rank matches or re-ranked if not (keeps the original tag-time line). Games not matched (rare name mismatches) are listed so you can tag them by hand. If the fetch fails or the page layout changes, use **Paste page text**. The KAM pages are not dated, so a low match count usually means the wrong week.

## Article import (Quick Tag > Import from an article)
Pick the source, paste the article URL (ESPN, CBS, Fox, Yahoo, VSIN, SportsLine hosts only), click **Read article**. The server fetches the text and Claude extracts spread and total picks, matched to the selected week's games. Preview, untick anything wrong, Save. One tag per source per game+side+type (existing ones are skipped); the expert names go in the tag note. Moneylines, team totals, halves, props and parlays are listed under "not tagged". If a site blocks the fetch or needs JavaScript or a login, use **Paste article text** (select all on the page, copy, paste).

Vercel env vars: `ANTHROPIC_API_KEY` (required), `IMPORT_PASSCODE` (optional but recommended: when set, the page asks for it once), `ANTHROPIC_MODEL` (optional, default `claude-haiku-5-5`).


### SportsLine pick sheet
Source SportsLine + "Paste article text" with the whole page from sportsline.com/college-football/picks/ (select all, copy). The importer reads the table directly (no model call) and tags the **A and A+** simulation picks: spreads and totals become tags labelled `SportsLine - Model A` / `SportsLine - Model A+`; moneyline picks are listed as not tagged. B and C grades are ignored. The "expert picks" count column is not used yet.

### SportsLine expert picks tab
Source SportsLine + paste the whole Expert Picks tab. Each card becomes a tag labelled `SportsLine - <expert>` (spread and over/under picks; moneylines listed as not tagged). Cards name teams by nickname, resolved through a nickname table in `lib/sportsline-experts.js`; a card whose game can't be matched is listed as not tagged with the nicknames shown, so add the nickname to the table if one is missing.
