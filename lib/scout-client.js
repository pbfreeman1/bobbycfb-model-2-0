// Browser helpers for outside picks (scout). Reads the scout_* views with the
// public key; the only write is scout_request_run ("Pull picks now"), which the
// database throttles and caps.

import { sbFetch, sbFetchAll, sbRpc } from './supabase';

export async function scoutRuns(sport, limit = 15) {
  return sbFetch(`scout_run_log?sport=eq.${sport}&order=id.desc&limit=${limit}`);
}

export async function scoutRun(id) {
  const rows = await sbFetch(`scout_run_log?id=eq.${id}`);
  return rows[0] || null;
}

export async function recentPicks(sport, hours = 36) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  return sbFetch(`scout_pick_list?sport=eq.${sport}&created_at=gte.${encodeURIComponent(since)}&order=start_time.asc.nullslast,game_id.asc,created_at.asc&limit=500`);
}

// Starts a pull and waits for it. onStatus gets progress text.
export async function requestPicks(sport, onStatus = () => {}) {
  const res = await sbRpc('scout_request_run', { p_sport: sport });
  if (!['queued', 'running'].includes(res.status)) throw new Error(res.message || 'Could not start a pull.');
  onStatus(res.status === 'running' ? 'Already running, waiting…' : 'Queued, starts within a minute…');
  for (let i = 0; i < 96; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const run = await scoutRun(res.run_id);
    if (!run) continue;
    if (run.status !== 'running') return run;
    onStatus(`Reading ${run.articles} article${run.articles === 1 ? '' : 's'} · ${run.picks} picks so far…`);
  }
  throw new Error('Still running after 8 minutes. Check the table below.');
}

export function runCost(run) {
  let c = 0;
  let any = false;
  for (const j of run?.jobs || []) {
    const v = Number(j?.result?.cost);
    if (Number.isFinite(v)) { c += v; any = true; }
  }
  return any ? c : null;
}

export function runNote(run) {
  const errs = (run?.jobs || []).filter((j) => j.status === 'error').map((j) => `${j.source || 'Source'}${j.kind === 'article' ? ' article' : ''}: ${j.error || 'error'}`);
  const skipped = (run?.jobs || []).filter((j) => j.status === 'skipped').length;
  const empty = (run?.jobs || []).filter((j) => j.kind === 'hub' && j.status === 'done' && !(j.result?.chosen || []).length).map((j) => j.source);
  const parts = [];
  if (run?.note) parts.push(run.note);
  if (errs.length) parts.push(errs.join(' · '));
  if (empty.length) parts.push(`No picks articles found: ${empty.join(', ')}`);
  if (skipped) parts.push(`${skipped} unreadable page${skipped === 1 ? '' : 's'} skipped`);
  return parts.join(' · ');
}

const sgn = (v) => (v > 0 ? `+${v}` : v === 0 ? 'PK' : String(v));

// "Auburn -3.5", "Under 141.5", "Notre Dame ML +120", "Auburn 1H TT Over 38.5"
export function describePick(p) {
  const team = p.side === 'home' ? p.home : p.side === 'away' ? p.away : null;
  const per = p.period && p.period !== 'full' ? `${p.period.toUpperCase()} ` : '';
  const num = (v) => (v === null || v === undefined ? '' : ` ${v}`);
  if (p.status === 'unmatched') return p.pick_text || p.team_text || '—';
  if (p.market === 'spread') return `${team} ${per}${p.line === null ? '' : sgn(Number(p.line))}`.trim();
  if (p.market === 'total') return `${per}${p.side === 'over' ? 'Over' : 'Under'}${num(p.line)}`;
  if (p.market === 'moneyline') return `${team} ${per}ML${p.odds === null ? '' : ` ${sgn(p.odds)}`}`;
  if (p.market === 'team_total') return `${team} ${per}TT ${p.ou === 'over' ? 'Over' : 'Under'}${num(p.line)}`;
  return p.pick_text || '—';
}

// ---------------------------------------------------------------------------
// Phase 2: board column, drawer section, research pages
// ---------------------------------------------------------------------------

const idList = (ids) => [...new Set(ids.filter((x) => x !== null && x !== undefined))].join(',');

// scout_game_crowd rows for a set of games, keyed `${game_id}|${grp}`.
export async function crowdFor(sport, gameIds) {
  const ids = idList(gameIds);
  if (!ids) return new Map();
  const rows = await sbFetch(`scout_game_crowd?sport=eq.${sport}&game_id=in.(${ids})`);
  return new Map(rows.map((r) => [`${r.game_id}|${r.grp}`, r]));
}

// Every pick stored for one game (not the unmatched ones).
export async function gamePicks(sport, gameId) {
  return sbFetch(`scout_pick_list?sport=eq.${sport}&game_id=eq.${gameId}&status=neq.unmatched&order=market.asc,side.asc,source_name.asc`);
}

// Crowd rows for the research page. open: games not final; plus finished rows for the record.
export async function crowdRows(sport, { since } = {}) {
  const q = since ? `&game_date=gte.${since}` : '';
  return sbFetchAll(`scout_game_crowd?sport=eq.${sport}${q}&order=game_date.desc,game_id.asc`);
}

export async function sideRows(sport, gameIds) {
  const ids = idList(gameIds);
  if (!ids) return [];
  return sbFetch(`scout_side_consensus?sport=eq.${sport}&game_id=in.(${ids})`);
}

export async function sourceBoard(sport) {
  return sbFetch(`scout_source_board?sport=eq.${sport}&order=graded.desc,picks.desc`);
}

export async function expertBoard(sport) {
  return sbFetchAll(`scout_expert_board?sport=eq.${sport}&order=graded.desc,picks.desc`);
}
