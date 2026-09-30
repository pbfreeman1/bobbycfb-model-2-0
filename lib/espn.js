// ESPN public scoreboard client for NFL schedule, kickoff, network and finals.
//
// Endpoint (no key required):
//   site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
//     ?dates=<season year>&seasontype=<1|2|3>&week=<n>&limit=1000
//
// SEASON YEAR is ESPN's, which is the year the season STARTED — the Super Bowl
// of the 2025 season is February 2026 but still lives under dates=2025. That
// matches nfl_games.season, so no translation is needed.
//
// WEEK NUMBERING. nfl_games stores the postseason as weeks 19-23, and ESPN
// numbers seasontype=3 from 1. The mapping is week = 18 + espn_week:
//   19 wild card, 20 divisional, 21 conference, 23 Super Bowl.
// ESPN's postseason week 4 is the Pro Bowl, which has no nfl_games row and no
// line, so POST_WEEKS deliberately skips it.
//
// KICKOFF is returned as UTC ("2026-10-02T00:15Z") and stored as UTC in
// nfl_games.game_date (timestamptz). Every display converts to ET at the edge,
// which is also what nfl_classify_games does when deriving primetime.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

export const REG_WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);
// ESPN postseason week -> nfl_games week. 4 (Pro Bowl) is intentionally absent.
export const POST_WEEKS = [1, 2, 3, 5];

export function postWeekToDbWeek(espnWeek) {
  return 18 + espnWeek;
}

// Every slate we care about for one season, in chronological order so a
// resumable backfill can stop and pick up where it left off.
export function seasonSlates(season) {
  return [
    ...REG_WEEKS.map((w) => ({ season, seasonType: 2, espnWeek: w, week: w, label: 'REG' })),
    ...POST_WEEKS.map((w) => ({ season, seasonType: 3, espnWeek: w, week: postWeekToDbWeek(w), label: 'POST' })),
  ];
}

// ---------------------------------------------------------------------------
// Team name resolution
// ---------------------------------------------------------------------------
// nfl_games stores predictiontracker's city style ("LA Chargers", "N.Y. Jets").
// ESPN gives full club names ("Los Angeles Chargers"). nfl_teams.aliases is the
// source of truth for that mapping, so the caller passes the rows in and this
// builds the lookup — no second hardcoded copy of the league to drift.
//
// ESPN's abbreviation is included as a key because it is the most stable
// identifier in the payload, with one collision to know about: ESPN says WSH
// where nfl_teams says WAS. `location` is deliberately NOT used as a key,
// because the Chargers and Rams share "Los Angeles".
export function buildTeamResolver(teamRows) {
  const byKey = new Map();
  const put = (k, name) => {
    if (!k) return;
    const norm = normalizeKey(k);
    if (norm && !byKey.has(norm)) byKey.set(norm, name);
  };
  for (const t of teamRows) {
    put(t.name, t.name);
    put(t.abbr, t.name);
    for (const a of t.aliases || []) put(a, t.name);
  }
  // ESPN's Washington abbreviation differs from ours.
  put('WSH', byKey.get(normalizeKey('WAS')) || 'Washington');

  return function resolve(espnTeam) {
    if (!espnTeam) return null;
    for (const cand of [espnTeam.displayName, espnTeam.abbreviation, espnTeam.shortDisplayName, espnTeam.name]) {
      const hit = byKey.get(normalizeKey(cand));
      if (hit) return hit;
    }
    return null;
  };
}

function normalizeKey(raw) {
  return (raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Fetch + normalize one slate
// ---------------------------------------------------------------------------
export async function fetchSlate({ season, seasonType, espnWeek, fetchImpl = fetch }) {
  const url = `${BASE}/scoreboard?dates=${season}&seasontype=${seasonType}&week=${espnWeek}&limit=1000`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${season} type ${seasonType} week ${espnWeek}`);
  return res.json();
}

// Picks the network to display. National broadcasts win over local ones, and
// the first name in the list is the lead carrier — ESPN lists streaming
// co-carriers ("NBC", "Peacock") after the linear network.
export function pickNetwork(competition) {
  const casts = competition?.broadcasts || [];
  const national = casts.find((b) => b.market === 'national');
  const chosen = national || casts[0];
  const names = chosen?.names || [];
  return names.length ? names.join('/') : null;
}

// One ESPN event -> the fields nfl_games cares about. Returns null when either
// team cannot be resolved, so the caller can report it as unmatched rather than
// writing a half-identified row.
export function normalizeEvent(event, { season, week, seasonType, resolve }) {
  const comp = event?.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === 'home');
  const awayC = competitors.find((c) => c.homeAway === 'away');
  const home = resolve(homeC?.team);
  const away = resolve(awayC?.team);

  const status = event.status?.type || {};
  const completed = !!status.completed;
  const hs = homeC?.score != null && homeC.score !== '' ? parseInt(homeC.score, 10) : null;
  const as = awayC?.score != null && awayC.score !== '' ? parseInt(awayC.score, 10) : null;

  return {
    source_game_id: String(event.id),
    season,
    week,
    season_type: seasonType === 3 ? 'POST' : 'REG',
    // ESPN returns UTC; stored as UTC, displayed as ET.
    game_date: event.date ? new Date(event.date).toISOString() : null,
    home_team: home,
    away_team: away,
    espn_home: homeC?.team?.displayName || null,
    espn_away: awayC?.team?.displayName || null,
    neutral_site: !!comp.neutralSite,
    tv_network: pickNetwork(comp),
    completed,
    // Only trust scores on a completed game: ESPN reports 0-0 in-progress.
    home_score: completed ? hs : null,
    away_score: completed ? as : null,
    resolved: !!(home && away),
  };
}

export async function fetchNormalizedSlate({ season, seasonType, espnWeek, week, resolve, fetchImpl = fetch }) {
  const payload = await fetchSlate({ season, seasonType, espnWeek, fetchImpl });
  const events = payload?.events || [];
  return events
    .map((e) => normalizeEvent(e, { season, week, seasonType, resolve }))
    .filter(Boolean);
}

// Politeness delay between ESPN calls. The backfill walks ~115 slates, which is
// harmless at this pace but rude without it.
export const THROTTLE_MS = 350;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
