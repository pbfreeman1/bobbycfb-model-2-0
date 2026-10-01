// Applies a predictiontracker NFL archive CSV directly, with the service role.
//
//   node scripts/nfl-apply-archive.mjs <csv> <season> <market> [--dry]
//
// This is the privileged counterpart to nfl-load-archive.mjs. That script reads
// over the anon key and EMITS SQL because it cannot write; this one writes.
// Both resolve through the same lib/nfl-csv.js and lib/espn.js, so there is one
// parsing path, not two.
//
// WHY NOT THE INGEST ROUTE. /api/nfl/ingest-predictions is for ongoing weekly
// pulls and carries a kickoff lock: it will not set a line column on a game
// that has already started. Every archive game has already started, so the
// route would load the predictions and leave total_line unset — predictions
// with nothing to measure them against. Archive semantics are the opposite:
// the file IS the record of what the line was, so the line is always written.
//
// SNAPSHOT TIMESTAMPS ARE NOMINAL, exactly as in nfl-load-archive.mjs. The
// archive gives a final `line` and a `lineopen` but never says when either was
// observed, so:
//   phase 'close' -> captured_at = kickoff - 1 minute
//   phase 'open'  -> captured_at = kickoff - 7 days
// The phase label carries the meaning; the timestamp only has to order
// correctly and sit before kickoff. The source string on every row says the
// timestamp is nominal so nobody later mistakes it for an observation.
//
// Idempotent: predictions upsert on (game_id, model_id, market), line
// snapshots are inserted with duplicates ignored, and the nfl_games update is
// a plain set. Re-running the same file changes nothing.
//
// The key is read from .env.local (gitignored) and never printed.

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { parseCsv, detectMarket, buildColumnResolver, extractGames } from '../lib/nfl-csv.js';
import { buildTeamNameResolver } from '../lib/espn.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const [csvPath, seasonArg, marketArg] = args.filter((a) => a !== '--dry');
if (!csvPath || !seasonArg) {
  console.error('usage: node scripts/nfl-apply-archive.mjs <csv> <season> [market] [--dry]');
  process.exit(1);
}
const season = parseInt(seasonArg, 10);

// --- credentials ------------------------------------------------------------
const ENV_FILE = new URL('../.env.local', import.meta.url);
if (!existsSync(ENV_FILE)) {
  console.error('Missing .env.local with SUPABASE_SERVICE_ROLE_KEY=...');
  process.exit(1);
}
const env = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL || 'https://zpmdrazbqgzheqkvfltv.supabase.co';
if (!SERVICE_KEY) {
  console.error('.env.local has no SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!/^ey|^sb_secret/.test(SERVICE_KEY)) {
  console.error('SUPABASE_SERVICE_ROLE_KEY does not look like a Supabase key');
  process.exit(1);
}

const sb = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

// Refuse to run with anything but the service role, so a pasted anon key fails
// loudly here instead of silently writing nothing through RLS.
{
  const payload = JSON.parse(Buffer.from(SERVICE_KEY.split('.')[1] || '', 'base64').toString() || '{}');
  if (payload.role && payload.role !== 'service_role') {
    console.error(`key role is '${payload.role}', expected 'service_role'`);
    process.exit(1);
  }
}

// --- read reference data ----------------------------------------------------
async function all(table, select, eq) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (eq) q = q.eq(eq[0], eq[1]);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const models = await all('nfl_source_models', 'id, model_key, csv_aliases, is_aggregate, is_active');
const teams = await all('nfl_teams', 'name, abbr, aliases');
const games = await all('nfl_games', 'id, week, home_team, away_team, game_date', ['season', season]);
if (!games.length) throw new Error(`No nfl_games rows for ${season}. Run the ESPN sync first.`);

const resolveTeam = buildTeamNameResolver(teams);
const resolveColumn = buildColumnResolver(models);
const parsed = parseCsv(readFileSync(csvPath, 'utf8'));
const market = marketArg || detectMarket(parsed.headers);
const ex = extractGames(parsed, { market, resolveTeam, resolveColumn, defaultWeek: null });

const byKey = new Map(games.map((g) => [`${g.week}|${g.home_team}|${g.away_team}`, g]));

// Blank-week rows: only usable if exactly one scheduled game with the same
// home AND away team has no CSV row of its own. Same rule as the emit script.
const csvKeys = new Set(ex.games.filter((g) => g.week != null).map((g) => `${g.week}|${g.home}|${g.away}`));
const ambiguous = [];
for (const b of ex.noWeek) {
  const cands = games.filter((g) =>
    g.home_team === b.home && g.away_team === b.away &&
    !csvKeys.has(`${g.week}|${g.home_team}|${g.away_team}`));
  if (cands.length === 1) {
    const r = ex.games.find((x) => x.week === null && x.home === b.home && x.away === b.away);
    if (r) r.week = cands[0].week;
  } else {
    ambiguous.push(`${b.away} @ ${b.home} (${cands.length} candidates)`);
  }
}

// --- build rows -------------------------------------------------------------
const preds = [];
const lines = [];
const gameUpdates = [];
const unmatched = [];
const lineCol = market === 'total' ? 'total_line' : 'spread_line';
const openCol = market === 'total' ? 'total_open' : 'spread_open';

for (const g of ex.games) {
  if (g.week == null) continue;
  const dbg = byKey.get(`${g.week}|${g.home}|${g.away}`);
  if (!dbg) { unmatched.push(`wk${g.week} ${g.away} @ ${g.home}`); continue; }
  for (const p of g.preds) {
    preds.push({ game_id: dbg.id, model_id: p.model_id, market, predicted_line: p.value });
  }
  const kickoff = dbg.game_date;
  if (kickoff && g.line != null) {
    lines.push({
      game_id: dbg.id, market, phase: 'close', line: g.line,
      captured_at: new Date(Date.parse(kickoff) - 60e3).toISOString(),
      source: 'predictiontracker archive (nominal timestamp)',
    });
  }
  if (kickoff && g.open != null) {
    lines.push({
      game_id: dbg.id, market, phase: 'open', line: g.open,
      captured_at: new Date(Date.parse(kickoff) - 7 * 864e5).toISOString(),
      source: 'predictiontracker archive lineopen (nominal timestamp)',
    });
  }
  if (g.line != null) gameUpdates.push({ id: dbg.id, ln: g.line, op: g.open });
}

// Local checksum, so a partial write is detectable rather than assumed fine.
const sum = preds.reduce((t, r) => t + Number(r.predicted_line), 0);
console.log(`market=${market} season=${season}${dry ? '  [DRY RUN]' : ''}`);
console.log(`  csv rows            ${parsed.rows.length}`);
console.log(`  model columns used  ${ex.modelCols.length}`);
console.log(`  games matched       ${gameUpdates.length}`);
console.log(`  predictions         ${preds.length}  (sum ${sum.toFixed(3)})`);
console.log(`  line snapshots      ${lines.length}`);
if (unmatched.length) console.log(`  UNMATCHED (${unmatched.length}): ${unmatched.join('; ')}`);
if (ambiguous.length) console.log(`  blank-week AMBIGUOUS, skipped: ${ambiguous.join('; ')}`);
if (ex.unresolvedTeams.length) console.log(`  UNRESOLVED TEAMS: ${ex.unresolvedTeams.join('; ')}`);
if (ex.skipped.unknown.length) console.log(`  unknown columns: ${ex.skipped.unknown.join(', ')}`);

if (dry) { console.log('  nothing written.'); process.exit(0); }

// --- write ------------------------------------------------------------------
async function chunked(label, rows, fn, size = 1000) {
  let done = 0;
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const { error } = await fn(slice);
    if (error) throw new Error(`${label}: ${error.message}`);
    done += slice.length;
    process.stdout.write(`\r  ${label}: ${done}/${rows.length}`);
  }
  if (rows.length) process.stdout.write('\n');
}

await chunked('predictions', preds, (s) =>
  sb.from('nfl_raw_predictions').upsert(s, { onConflict: 'game_id,model_id,market' }));

await chunked('line snapshots', lines, (s) =>
  sb.from('nfl_bobby_lines').upsert(s, {
    onConflict: 'game_id,market,phase,captured_at', ignoreDuplicates: true,
  }));

// Archive semantics: the line is written whether or not the game has started.
// This is the one place that deliberately differs from the ingest route.
let gi = 0;
for (const u of gameUpdates) {
  const patch = { [lineCol]: u.ln, updated_at: new Date().toISOString() };
  if (u.op != null) patch[openCol] = u.op;
  const { error } = await sb.from('nfl_games').update(patch).eq('id', u.id);
  if (error) throw new Error(`nfl_games ${u.id}: ${error.message}`);
  process.stdout.write(`\r  game lines: ${++gi}/${gameUpdates.length}`);
}
if (gameUpdates.length) process.stdout.write('\n');

// --- verify -----------------------------------------------------------------
const { count: predCount, error: cErr } = await sb
  .from('nfl_raw_predictions')
  .select('game_id', { count: 'exact', head: true })
  .eq('market', market)
  .in('game_id', gameUpdates.map((u) => u.id));
if (cErr) throw new Error(`verify: ${cErr.message}`);
console.log(`  verified: ${predCount} ${market} predictions now on this season's matched games`);
