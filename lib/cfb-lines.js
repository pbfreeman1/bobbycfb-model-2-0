// CFBD schedule + lines sync for one CFB week, lifted out of
// app/api/cfbd-sync/route.js so the manual Ingest button and the daily cron run
// the same code rather than two drifting copies.
//
// WHY THIS MATTERS TO THE ENGINE. cfb_compute reads games.current_line as its
// line snapshot, and cfb_grade/cfb_recalibrate grade against the same column.
// If this has not run for the week, the engine computes against whatever line
// was last written by hand.
//
// SIGN CONVENTION. CFBD states spreads as negative = home favoured; this
// project uses positive = home favoured, so every spread read here is negated.
// Over/under is not home-relative and is stored as given.

import { matchKey } from './team-match.js';

// Thrown for a condition the caller should surface as a failed step rather than
// a crash: a missing key, an upstream outage, a database read error.
export class LinesError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'LinesError';
    this.status = status;
  }
}

// Returns { games, skippedFcs, updated, inserted, unmatched }.
//
// Those key names are load-bearing: app/cfb/ingest/page.js reads `games`,
// `updated` and `unmatched[].cfbd_home/.cfbd_away` to build its log line.
export async function syncLines({ supabase, season, week, cfbdKey }) {
  if (!cfbdKey) throw new LinesError('CFBD_API_KEY not set', 500);

  const seasonInt = parseInt(season, 10);
  const weekInt = parseInt(week, 10);
  const headers = { Authorization: `Bearer ${cfbdKey}`, Accept: 'application/json' };

  const [gamesRes, mediaRes, linesRes] = await Promise.all([
    fetch(`https://api.collegefootballdata.com/games?year=${season}&week=${week}&seasonType=regular&classification=fbs`, { headers }),
    fetch(`https://api.collegefootballdata.com/games/media?year=${season}&week=${week}&seasonType=regular`, { headers }),
    fetch(`https://api.collegefootballdata.com/lines?year=${season}&week=${week}&seasonType=regular`, { headers }),
  ]);

  if (!gamesRes.ok) throw new LinesError(`CFBD games error ${gamesRes.status}`, 502);

  const cfbdGames = await gamesRes.json();
  // Media and lines are enrichment: a week with no posted line should still get
  // its kickoff times and TV, so these are tolerated failing.
  const mediaData = mediaRes.ok ? await mediaRes.json() : [];
  const linesData = linesRes.ok ? await linesRes.json() : [];

  const mediaByName = {};
  for (const m of mediaData) {
    const key = `${m.homeTeam}|${m.awayTeam}`;
    if (!mediaByName[key]) mediaByName[key] = m.outlet || m.network || null;
  }

  const linesByName = {};
  const openLineByName = {};
  for (const l of linesData) {
    const key = `${l.homeTeam}|${l.awayTeam}`;
    const withOU = (l.lines || []).find((x) => x.overUnder != null);
    if (withOU) linesByName[key] = withOU.overUnder;
    // Prefer the consensus provider for CLV tracking; fall back to whatever is first.
    const lineEntry = (l.lines || []).find((x) => x.provider === 'consensus') || l.lines?.[0];
    if (lineEntry?.spreadOpen != null) {
      openLineByName[key] = -parseFloat(lineEntry.spreadOpen);
    }
    if (lineEntry?.spread != null && !linesByName[`current|${key}`]) {
      linesByName[`current|${key}`] = -parseFloat(lineEntry.spread);
    }
  }

  const { data: dbGames, error: dbGamesErr } = await supabase
    .from('games')
    .select('id, home_team, away_team')
    .eq('season', seasonInt)
    .eq('week', weekInt);
  if (dbGamesErr) throw new LinesError(dbGamesErr.message, 500);

  const dbByKey = new Map();
  for (const g of dbGames || []) dbByKey.set(matchKey(g.home_team, g.away_team), g);

  // CFBD's `classification` filter only requires ONE side to match, so
  // FBS-vs-FCS buy games still come through. Both sides must be FBS.
  const fbsGames = cfbdGames.filter((g) => g.homeClassification === 'fbs' && g.awayClassification === 'fbs');
  const skippedFcs = cfbdGames.length - fbsGames.length;

  let updated = 0;
  let inserted = 0;
  const unmatched = [];

  for (const g of fbsGames) {
    const rawKey = `${g.homeTeam}|${g.awayTeam}`;
    const dbGame = dbByKey.get(matchKey(g.homeTeam, g.awayTeam));

    const kickoff = g.startDate && !g.startTimeTBD ? g.startDate : null;
    const tv = mediaByName[rawKey] || null;
    const ou = linesByName[rawKey] ?? null;
    const openingLine = openLineByName[rawKey] ?? null;
    const currentLine = linesByName[`current|${rawKey}`] ?? null;

    if (dbGame) {
      const { error } = await supabase
        .from('games')
        .update({
          kickoff_at: kickoff,
          tv_network: tv,
          over_under: ou != null ? parseFloat(ou) : null,
          external_game_id: String(g.id),
          opening_line: openingLine,
          current_line: currentLine,
          home_classification: g.homeClassification,
          away_classification: g.awayClassification,
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbGame.id);
      if (!error) updated++;
    } else {
      if (!g.homeTeam || !g.awayTeam) continue;
      const { error } = await supabase
        .from('games')
        .insert({
          season: seasonInt,
          week: weekInt,
          home_team: g.homeTeam,
          away_team: g.awayTeam,
          kickoff_at: kickoff,
          tv_network: tv,
          over_under: ou != null ? parseFloat(ou) : null,
          external_game_id: String(g.id),
          opening_line: openingLine,
          current_line: currentLine,
          home_classification: g.homeClassification,
          away_classification: g.awayClassification,
          status: 'scheduled',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      if (!error) inserted++;
      else unmatched.push({ cfbd_home: g.homeTeam, cfbd_away: g.awayTeam, error: error.message });
    }
  }

  return { games: fbsGames.length, skippedFcs, updated, inserted, unmatched };
}
