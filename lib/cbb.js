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
