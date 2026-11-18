// College basketball (CBB) shared helpers.
//
// Everything is computed in Postgres (cbb_cycle, run by pg_cron several times a
// day). These pages only read three views: cbb_board, cbb_results_daily and
// cbb_system_board. PredictionTracker lines are home-relative: +3 means the
// home team is favored by 3.

import { sbFetch, sbRpc } from './supabase';

export { C, FH, FM } from './nfl-board';

export const todayET = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function fmtDay(iso) {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Sportsbook-style spread for one side from a home-relative number.
export function spreadFor(side, homeRel) {
  const n = num(homeRel);
  if (n === null || !side) return '—';
  const v = side === 'home' ? -n : n;
  if (v === 0) return 'PK';
  return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '');
}

export const f1 = (v, d = 1) => (num(v) === null ? '—' : num(v).toFixed(d));
export const pct = (w, l) => (w + l > 0 ? `${((100 * w) / (w + l)).toFixed(1)}%` : '—');
export const units = (v) => {
  const n = num(v) ?? 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}u`;
};

export function normalizeRow(r) {
  return {
    ...r,
    line: num(r.line), open_line: num(r.open_line), consensus: num(r.consensus), edge: num(r.edge),
    vote_share: num(r.vote_share), std_dev: num(r.std_dev), score: num(r.score), coverage: num(r.coverage),
    flags: r.flags || [], systems: r.systems || [],
  };
}

export async function loadBoard(date) {
  const rows = await sbFetch(`cbb_board?game_date=eq.${date}&order=rank_in_day.asc.nullslast`);
  return rows.map(normalizeRow);
}

export async function latestBoardDate() {
  const rows = await sbFetch('cbb_signals?select=game_date&order=game_date.desc&limit=1');
  return rows.length ? rows[0].game_date : todayET();
}

export async function runLog(limit = 1) {
  return sbFetch(`cbb_run_log?order=id.desc&limit=${limit}`);
}

export async function lastRun() {
  const rows = await runLog(1);
  return rows[0] || null;
}

// Queues a pull. The database picks it up within a minute; resolves with the
// finished run, or throws with a readable message.
export async function requestRefresh(onStatus = () => {}) {
  const before = (await lastRun())?.id ?? 0;
  const res = await sbRpc('cbb_request_refresh');
  if (res.status === 'throttled') throw new Error(res.message);
  onStatus(res.status === 'pending' ? 'Already queued, waiting…' : 'Queued, starts within a minute…');
  for (let i = 0; i < 36; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const run = await lastRun();
    if (run && run.id > before && run.status !== 'running') return run;
    if (run && run.id > before) onStatus('Pulling PredictionTracker…');
  }
  throw new Error('No result after 3 minutes. Check the pull log.');
}

export const fmtET = (iso) => (iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—');

export const TIER_COLOR = { Play: '#6FBF73', Lean: '#D4A73C', 'No tier': '#8B9992' };

// ---------------------------------------------------------------------------
// Game detail: context loaded when a game is opened
// ---------------------------------------------------------------------------

let systemBoardCache = null;
export function systemBoard() {
  if (!systemBoardCache) {
    systemBoardCache = sbFetch('cbb_system_board?order=rank.asc')
      .catch((e) => { systemBoardCache = null; throw e; });
  }
  return systemBoardCache;
}

let spotCache = null;
export function spotStats() {
  if (!spotCache) spotCache = sbFetch('cbb_spot_stats').catch((e) => { spotCache = null; throw e; });
  return spotCache;
}

// PostgREST or=() value; names are double-quoted so periods and apostrophes are safe.
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

export async function loadGameContext(row) {
  const teams = [row.home, row.road];
  const or = encodeURIComponent(`(${teams.flatMap((t) => [`home.eq.${q(t)}`, `road.eq.${q(t)}`]).join(',')})`);
  const [lines, preds, spots, systems, teamGames] = await Promise.all([
    sbFetch(`cbb_line_history?game_id=eq.${row.game_id}&order=seen_at.asc`),
    sbFetch(`cbb_prediction_history?game_id=eq.${row.game_id}&order=seen_at.asc`),
    spotStats(),
    systemBoard(),
    sbFetch(`cbb_games?select=id,game_date,home,road,neutral,line,home_score,road_score&season=eq.${row.season}&or=${or}&order=game_date.asc`),
  ]);
  return { lines, preds, spots, systems, teamGames };
}

// One team's season before this game: ATS vs the final line, form, rest.
export function teamForm(team, games, beforeDate, gameId) {
  const out = { ats: [0, 0, 0], su: [0, 0], last: [], pf: 0, pa: 0, n: 0, rest: null, next: null };
  const mine = games.filter((g) => g.home === team || g.road === team);
  const played = mine.filter((g) => g.game_date < beforeDate && g.home_score !== null && g.road_score !== null && g.id !== gameId);
  for (const g of played) {
    const home = g.home === team;
    const pts = home ? g.home_score : g.road_score;
    const opp = home ? g.road_score : g.home_score;
    out.pf += pts; out.pa += opp; out.n += 1;
    out.su[pts > opp ? 0 : 1] += 1;
    if (g.line !== null) {
      // home covers when (home margin) > home-relative line
      const homeCover = g.home_score - g.road_score - Number(g.line);
      const c = home ? homeCover : -homeCover;
      out.ats[c > 0 ? 0 : c < 0 ? 1 : 2] += 1;
    }
    out.last.push({ date: g.game_date, opp: home ? g.road : g.home, home, neutral: g.neutral, pts, opp_pts: opp });
  }
  const prev = played[played.length - 1];
  if (prev) out.rest = Math.round((Date.parse(`${beforeDate}T12:00:00Z`) - Date.parse(`${prev.game_date}T12:00:00Z`)) / 86400000);
  const upcoming = mine.find((g) => g.game_date > beforeDate);
  if (upcoming) out.next = { date: upcoming.game_date, opp: upcoming.home === team ? upcoming.road : upcoming.home };
  out.last = out.last.slice(-5).reverse();
  return out;
}

export const EDGE_B = (e) => (e < 1 ? 1 : e < 1.5 ? 2 : e < 2.5 ? 3 : e < 4 ? 4 : 5);
export const VOTE_B = (v) => (v < 0.6 ? 1 : v < 0.7 ? 2 : v < 0.85 ? 3 : 4);
export const OPEN_B = (g) => (g < 0 ? 0 : g < 1 ? 1 : g < 2 ? 2 : g < 3 ? 3 : 4);
export const EDGE_LABEL = { 1: 'under 1', 2: '1–1.5', 3: '1.5–2.5', 4: '2.5–4', 5: '4+' };
export const VOTE_LABEL = { 1: 'under 60%', 2: '60–70%', 3: '70–85%', 4: '85%+' };
export const OPEN_LABEL = { 0: 'on the other side', 1: 'under 1', 2: '1–2', 3: '2–3', 4: '3+' };
