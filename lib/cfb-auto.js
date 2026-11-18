// THE Bobby Model (CFB): automated pulls.
//
// Everything runs in Postgres (cfb_cycle, run by pg_cron): ESPN for schedule,
// kickoffs and finals, PredictionTracker's live CSV for predictions and PT's
// line, grading, recalibration and compute. The app only reads cfb_run_log and
// can queue a pull with cfb_request_refresh (run within a minute).

import { sbFetch, sbRpc } from './supabase';

export const fmtET = (iso) => (iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—');

export async function runLog(limit = 1) {
  return sbFetch(`cfb_run_log?order=id.desc&limit=${limit}`);
}

export async function lastRun() {
  const rows = await runLog(1);
  return rows[0] || null;
}

// Queues a pull; the database runs it within a minute. Resolves with the run.
export async function requestRefresh(onStatus = () => {}) {
  const before = (await lastRun())?.id ?? 0;
  const res = await sbRpc('cfb_request_refresh');
  if (res.status === 'throttled') throw new Error(res.message);
  onStatus(res.status === 'pending' ? 'Already queued, waiting…' : 'Queued, starts within a minute…');
  for (let i = 0; i < 36; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const run = await lastRun();
    if (run && run.id > before && run.status !== 'running') return run;
    if (run && run.id > before) onStatus('Pulling ESPN and PredictionTracker…');
  }
  throw new Error('No result after 3 minutes. Check the pull log.');
}
