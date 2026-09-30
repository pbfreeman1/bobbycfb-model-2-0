// One-time ESPN backfill driver.
//
// /api/nfl/espn-sync is the route for ongoing use, but it needs
// SUPABASE_SERVICE_ROLE_KEY and there is no local .env. This script does the
// same work with the anon key for reads (nfl_games and nfl_teams both have
// FOR SELECT USING (true)) and emits SQL for the writes, which are then applied
// through the Supabase connection.
//
// Resumable: every ESPN response is cached to disk, so re-running costs no
// requests for slates already fetched.
//
//   node scripts/nfl-espn-backfill.mjs <outDir> [season ...]

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  seasonSlates, buildTeamResolver, normalizeEvent, fetchSlate, THROTTLE_MS, sleep,
} from '../lib/espn.js';

const SUPABASE_URL = 'https://zpmdrazbqgzheqkvfltv.supabase.co';
const ANON = readFileSync(new URL('../lib/supabase.js', import.meta.url), 'utf8')
  .match(/eyJ[A-Za-z0-9._-]+/)[0];

const outDir = process.argv[2];
const seasons = process.argv.slice(3).map(Number);
if (!outDir || !seasons.length) {
  console.error('usage: node scripts/nfl-espn-backfill.mjs <outDir> <season ...>');
  process.exit(1);
}
const cacheDir = join(outDir, 'espn-cache');
mkdirSync(cacheDir, { recursive: true });

// 2026 is the live season with no nfl_games rows yet, so it gets inserts.
// Everything earlier is the predictiontracker spine: update only, never insert.
const LIVE_SEASON = 2026;
const LIVE_WEEKS_MAX = 4;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: ANON, Authorization: `Bearer ${ANON}`,
        Range: `${from}-${from + 999}`, 'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function cachedSlate(slate) {
  const f = join(cacheDir, `${slate.season}-t${slate.seasonType}-w${slate.espnWeek}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const payload = await fetchSlate(slate);
  writeFileSync(f, JSON.stringify(payload));
  await sleep(THROTTLE_MS);
  return payload;
}

const q = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

const teams = await sb('nfl_teams?select=name,abbr,aliases');
const resolve = buildTeamResolver(teams);
const games = await sbAll('nfl_games?select=id,season,week,home_team,away_team,game_date&order=id');
console.log(`nfl_teams: ${teams.length}  nfl_games: ${games.length}`);

const byExact = new Map();   // season|week|home|away -> row
const byUnordered = new Map(); // season|week|sorted(teams) -> row
for (const g of games) {
  byExact.set(`${g.season}|${g.week}|${g.home_team}|${g.away_team}`, g);
  byUnordered.set(`${g.season}|${g.week}|${[g.home_team, g.away_team].sort().join('~')}`, g);
}

const sqlParts = [];
const report = [];

for (const season of seasons) {
  const isLive = season === LIVE_SEASON;
  let slates = seasonSlates(season);
  if (isLive) slates = slates.filter((s) => s.label === 'REG' && s.week <= LIVE_WEEKS_MAX);

  const updates = [];
  const inserts = [];
  const swapped = [];
  const notInDb = [];
  const unresolved = [];
  let espnSeen = 0;

  for (const slate of slates) {
    const payload = await cachedSlate(slate);
    for (const ev of payload.events || []) {
      const g = normalizeEvent(ev, { season, week: slate.week, seasonType: slate.seasonType, resolve });
      if (!g) continue;
      espnSeen++;
      if (!g.resolved) {
        unresolved.push(`wk${g.week} ${g.espn_away} @ ${g.espn_home}`);
        continue;
      }

      const exact = byExact.get(`${season}|${g.week}|${g.home_team}|${g.away_team}`);
      const unord = exact || byUnordered.get(`${season}|${g.week}|${[g.home_team, g.away_team].sort().join('~')}`);

      if (unord) {
        if (!exact) swapped.push(`wk${g.week} ESPN ${g.away_team} @ ${g.home_team} vs DB ${unord.away_team} @ ${unord.home_team}`);
        // Match on the DB's own home/away so the WHERE clause hits, whichever
        // way round ESPN has it. Kickoff and network are orientation-neutral.
        updates.push(`(${unord.week},${q(unord.home_team)},${q(unord.away_team)},${q(g.game_date)},${q(g.tv_network)},${q(g.source_game_id)},${g.neutral_site})`);
      } else if (isLive) {
        inserts.push(`(${season},${g.week},${q(g.season_type)},${q(g.game_date)},${q(g.home_team)},${q(g.away_team)},${g.neutral_site},${q(g.tv_network)},${q(g.source_game_id)},${g.completed},${g.home_score ?? 'null'},${g.away_score ?? 'null'})`);
      } else {
        notInDb.push(`wk${g.week} ${g.away_team} @ ${g.home_team} (${g.game_date})`);
      }
    }
  }

  const dbCount = games.filter((x) => x.season === season).length;
  report.push({ season, espnSeen, dbCount, updates: updates.length, inserts: inserts.length,
                swapped, notInDb, unresolved });

  if (updates.length) {
    sqlParts.push(`-- ${season}: kickoff, network, ESPN id and neutral-site flag for existing rows
update nfl_games g set
  game_date = v.game_date::timestamptz,
  tv_network = coalesce(v.tv_network, g.tv_network),
  source_game_id = coalesce(v.src, g.source_game_id),
  neutral_site = v.neutral,
  updated_at = now()
from (values
${updates.join(',\n')}
) as v(week, home, away, game_date, tv_network, src, neutral)
where g.season = ${season} and g.week = v.week
  and g.home_team = v.home and g.away_team = v.away;`);
  }

  if (inserts.length) {
    sqlParts.push(`-- ${season}: new schedule rows (live season, no predictiontracker spine yet)
insert into nfl_games
  (season, week, season_type, game_date, home_team, away_team, neutral_site,
   tv_network, source_game_id, completed, home_score, away_score)
values
${inserts.join(',\n')}
on conflict (season, week, home_team, away_team) do update set
  season_type = excluded.season_type,
  game_date = excluded.game_date,
  neutral_site = excluded.neutral_site,
  tv_network = coalesce(excluded.tv_network, nfl_games.tv_network),
  source_game_id = coalesce(excluded.source_game_id, nfl_games.source_game_id),
  completed = excluded.completed,
  home_score = coalesce(excluded.home_score, nfl_games.home_score),
  away_score = coalesce(excluded.away_score, nfl_games.away_score),
  updated_at = now();`);
  }
}

writeFileSync(join(outDir, 'espn_backfill.sql'), sqlParts.join('\n\n') + '\n');
writeFileSync(join(outDir, 'espn_backfill_report.json'), JSON.stringify(report, null, 2));

console.log('\nseason  espn  db   upd  ins  swapped  espn-not-in-db  unresolved');
for (const r of report) {
  console.log(`${r.season}    ${String(r.espnSeen).padStart(3)}  ${String(r.dbCount).padStart(3)}  ${String(r.updates).padStart(4)} ${String(r.inserts).padStart(4)}  ${String(r.swapped.length).padStart(7)}  ${String(r.notInDb.length).padStart(14)}  ${String(r.unresolved.length).padStart(10)}`);
}
for (const r of report) {
  if (r.swapped.length) console.log(`\n${r.season} HOME/AWAY DISAGREEMENT (${r.swapped.length}):\n  ` + r.swapped.join('\n  '));
  if (r.notInDb.length) console.log(`\n${r.season} IN ESPN, NOT IN DB (${r.notInDb.length}):\n  ` + r.notInDb.join('\n  '));
  if (r.unresolved.length) console.log(`\n${r.season} UNRESOLVED TEAM NAMES (${r.unresolved.length}):\n  ` + r.unresolved.join('\n  '));
}
console.log(`\nSQL -> ${join(outDir, 'espn_backfill.sql')}`);
