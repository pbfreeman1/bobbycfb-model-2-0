// Loads a predictiontracker NFL archive CSV into SQL statements.
//
// The ingest ROUTE is what handles ongoing weekly pulls. This exists because the
// archive load is a one-off that has to run without SUPABASE_SERVICE_ROLE_KEY:
// it reads over the anon key and emits SQL to be applied through a privileged
// channel. It writes no anon-insert policies and touches nothing itself.
//
//   node scripts/nfl-load-archive.mjs <outDir> <csv> <season> <market> [maxWeek]
//
// SNAPSHOT TIMESTAMPS ARE NOMINAL for archive rows. The archive gives a final
// `line` and a `lineopen` but never says when either was observed, so:
//   phase 'close' -> captured_at = kickoff - 1 minute
//   phase 'open'  -> captured_at = kickoff - 7 days
// The phase label carries the meaning; the timestamp only has to order
// correctly and sit before kickoff so nfl_compute and nfl_grade can see it. The
// source string on every row says the timestamp is nominal, so nobody later
// mistakes it for an observation time.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, detectMarket, buildColumnResolver, extractGames } from '../lib/nfl-csv.js';
import { buildTeamNameResolver } from '../lib/espn.js';

const [, , outDir, csvPath, seasonArg, marketArg, maxWeekArg] = process.argv;
if (!outDir || !csvPath || !seasonArg) {
  console.error('usage: node scripts/nfl-load-archive.mjs <outDir> <csv> <season> [market] [maxWeek]');
  process.exit(1);
}
const season = parseInt(seasonArg, 10);
const maxWeek = maxWeekArg ? parseInt(maxWeekArg, 10) : 99;
mkdirSync(outDir, { recursive: true });

const SUPABASE_URL = 'https://zpmdrazbqgzheqkvfltv.supabase.co';
const ANON = readFileSync(new URL('../lib/supabase.js', import.meta.url), 'utf8')
  .match(/eyJ[A-Za-z0-9._-]+/)[0];
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

async function sbAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { ...H, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const models = await sbAll('nfl_source_models?select=id,model_key,csv_aliases,is_aggregate,is_active');
const teams = await sbAll('nfl_teams?select=name,abbr,aliases');
const games = await sbAll(`nfl_games?select=id,week,home_team,away_team,game_date&season=eq.${season}`);

const resolveTeam = buildTeamNameResolver(teams);
const resolveColumn = buildColumnResolver(models);
const parsed = parseCsv(readFileSync(csvPath, 'utf8'));
const market = marketArg || detectMarket(parsed.headers);
const ex = extractGames(parsed, { market, resolveTeam, resolveColumn, defaultWeek: null });

const byKey = new Map(games.map((g) => [`${g.week}|${g.home_team}|${g.away_team}`, g]));

// --- rule 4: blank-week rows ----------------------------------------------
// Load a blank-week row only if exactly one scheduled game with the same home
// AND away team, within the weeks this file covers, has no CSV row yet.
const csvKeys = new Set(ex.games.filter((g) => g.week != null).map((g) => `${g.week}|${g.home}|${g.away}`));
const resolvedBlank = [];
const ambiguousBlank = [];
for (const b of ex.noWeek) {
  const candidates = games.filter((g) =>
    g.week <= maxWeek && g.home_team === b.home && g.away_team === b.away &&
    !csvKeys.has(`${g.week}|${g.home_team}|${g.away_team}`));
  if (candidates.length === 1) {
    const g = candidates[0];
    const rebuilt = ex.games.find((x) => x.week === null && x.home === b.home && x.away === b.away);
    if (rebuilt) { rebuilt.week = g.week; resolvedBlank.push(`wk${g.week} ${b.away} @ ${b.home}`); }
  } else {
    ambiguousBlank.push(`${b.away} @ ${b.home} — ${candidates.length} candidate game(s), skipped`);
  }
}

const q = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const predTuples = [];
const lineTuples = [];
const gameTuples = [];
const unmatched = [];
let games_used = 0, preds = 0;

for (const g of ex.games) {
  if (g.week == null || g.week > maxWeek) continue;
  const dbg = byKey.get(`${g.week}|${g.home}|${g.away}`);
  if (!dbg) { unmatched.push(`wk${g.week} ${g.away} @ ${g.home}`); continue; }
  games_used++;
  for (const p of g.preds) {
    // The market is a constant for the whole file, so it is projected in the
    // SELECT rather than repeated on every tuple. On a 2,000-row load that is
    // several KB of identical string literals saved.
    predTuples.push(`(${dbg.id},${p.model_id},${p.value})`);
    preds++;
  }
  const kickoff = dbg.game_date;
  if (g.line != null && kickoff) {
    lineTuples.push(`(${dbg.id},${q(market)},'close',${g.line},(${q(kickoff)}::timestamptz - interval '1 minute'),'predictiontracker archive (nominal timestamp)')`);
  }
  if (g.open != null && kickoff) {
    lineTuples.push(`(${dbg.id},${q(market)},'open',${g.open},(${q(kickoff)}::timestamptz - interval '7 days'),'predictiontracker archive lineopen (nominal timestamp)')`);
  }
  if (g.line != null) gameTuples.push(`(${dbg.id},${g.line},${g.open ?? 'null'})`);
}

const lineCol = market === 'total' ? 'total_line' : 'spread_line';
const openCol = market === 'total' ? 'total_open' : 'spread_open';
const sql = [];

if (predTuples.length) {
  // Chunked so each statement stays a manageable size.
  for (let i = 0; i < predTuples.length; i += 1200) {
    sql.push(`insert into nfl_raw_predictions (game_id, model_id, market, predicted_line)
select v.g, v.m, ${q(market)}, v.p from (values
${predTuples.slice(i, i + 1200).join(',\n')}
) as v(g, m, p)
on conflict (game_id, model_id, market) do update set predicted_line = excluded.predicted_line;`);
  }
}
if (lineTuples.length && process.env.EMIT_LINES !== '0') {
  sql.push(`insert into nfl_bobby_lines (game_id, market, phase, line, captured_at, source) values
${lineTuples.join(',\n')}
on conflict do nothing;`);
}
if (gameTuples.length && process.env.EMIT_GAMES !== '0') {
  sql.push(`update nfl_games g set ${lineCol} = v.ln, ${openCol} = coalesce(v.op, g.${openCol}), updated_at = now()
from (values
${gameTuples.join(',\n')}
) as v(id, ln, op)
where g.id = v.id;`);
}

const base = `load_${season}_${market}`;
sql.forEach((s, i) => writeFileSync(join(outDir, `${base}_${i + 1}.sql`), s + '\n'));

console.log(`market=${market} season=${season} maxWeek=${maxWeek}`);
console.log(`  csv rows            ${parsed.rows.length}`);
console.log(`  model columns used  ${ex.modelCols.length}`);
console.log(`  games matched       ${games_used}`);
console.log(`  predictions         ${preds}`);
console.log(`  line snapshots      ${lineTuples.length}`);
console.log(`  nfl_games updates   ${gameTuples.length}`);
console.log(`  statements          ${sql.length}  -> ${base}_*.sql`);
if (resolvedBlank.length) console.log(`  blank-week resolved (rule 4): ${resolvedBlank.join('; ')}`);
if (ambiguousBlank.length) console.log(`  blank-week AMBIGUOUS, skipped: ${ambiguousBlank.join('; ')}`);
if (unmatched.length) console.log(`  UNMATCHED (${unmatched.length}): ${unmatched.join('; ')}`);
if (ex.unresolvedTeams.length) console.log(`  UNRESOLVED TEAMS: ${ex.unresolvedTeams.join('; ')}`);
if (ex.skipped.unknown.length) console.log(`  unknown columns: ${ex.skipped.unknown.join(', ')}`);
if (ex.skipped.aggregate.length) console.log(`  aggregate columns skipped: ${ex.skipped.aggregate.join(', ')}`);
