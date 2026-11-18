// THE Bobby Model — NFL (CBB-style build) shared helpers.
//
// Everything is computed in Postgres (nfl2_cycle, run by pg_cron through the
// day). These pages only read views: nfl2_board, nfl2_results_weekly,
// nfl2_results_all_games, nfl2_system_board, nfl2_bucket_stats, nfl2_run_log.
//
// Spreads are home-relative everywhere in the database: +3 means the home team
// is favored by 3. Every number shown is converted to sportsbook notation at
// the edge (the favorite carries the minus sign).

import { sbFetch, sbFetchAll, sbRpc } from './supabase';

export { C, FH, FM } from './nfl-board';

export const MARKETS = {
  spread: { key: 'spread', label: 'ATS', long: 'Against the spread' },
  total: { key: 'total', label: 'O/U', long: 'Totals' },
};

export const TIER_COLOR = { Play: '#6FBF73', Lean: '#D4A73C', 'No tier': '#8B9992' };

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
export const f1 = (v, d = 1) => (num(v) === null ? '—' : num(v).toFixed(d));
export const pct = (w, l) => (w + l > 0 ? `${((100 * w) / (w + l)).toFixed(1)}%` : '—');
export const units = (v) => {
  const n = num(v) ?? 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}u`;
};
export const signed = (v, d = 1) => {
  const n = num(v);
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(d)}`;
};

// Sportsbook-style spread for one side from a home-relative number.
export function spreadFor(side, homeRel) {
  const n = num(homeRel);
  if (n === null || !side) return '—';
  const v = side === 'home' ? -n : n;
  if (v === 0) return 'PK';
  return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '');
}

// "KC -3.5" from a home-relative line.
export function lineLabel(row, homeRel = row.line) {
  const n = num(homeRel);
  if (n === null) return '—';
  if (row.market === 'total') return n.toFixed(1).replace(/\.0$/, '');
  if (n === 0) return 'PK';
  return n > 0 ? `${row.home_abbr} ${spreadFor('home', n)}` : `${row.away_abbr} ${spreadFor('away', n)}`;
}

// The pick at a given number, e.g. "IND +12.5" or "Over 40.5".
export function pickLabel(row, side = row.pick_side, at = row.line) {
  if (!side) return '—';
  if (row.market === 'total') return `${side === 'over' ? 'Over' : 'Under'} ${f1(at)}`;
  return `${side === 'home' ? row.home_abbr : row.away_abbr} ${spreadFor(side, at)}`;
}

// The model's number in the same notation as the line.
export function modelLabel(row) {
  if (row.market === 'total') return f1(row.consensus);
  return lineLabel(row, row.consensus);
}

export const fmtKick = (iso) => (iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit',
}) : 'TBD');

export const fmtET = (iso) => (iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—');

export function normalizeRow(r) {
  return {
    ...r,
    line: num(r.line), open_line: num(r.open_line), line_now: num(r.line_now), consensus: num(r.consensus),
    edge: num(r.edge), kedge: num(r.kedge), vote_share: num(r.vote_share), std_dev: num(r.std_dev),
    coverage: num(r.coverage), score: num(r.score), top5_side_share: num(r.top5_side_share),
    taken_line: num(r.taken_line), close_line: num(r.close_line), clv: num(r.clv), cover_by: num(r.cover_by),
    units_result: num(r.units_result),
    flags: r.flags || [], keys_crossed: r.keys_crossed || [], systems: r.systems || [],
  };
}

export async function loadBoard(season, week) {
  const rows = await sbFetch(`nfl2_board?season=eq.${season}&week=eq.${week}&order=rank_in_week.asc.nullslast`);
  return rows.map(normalizeRow);
}

// Weeks that have a board, newest last, and the week to open on: the earliest
// week with a game not yet played, else the newest week.
export async function boardWeeks(season) {
  const rows = await sbFetchAll(`nfl2_signals?select=week&season=eq.${season}&market=eq.spread`);
  return [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
}

export async function defaultWeek(season) {
  const open = await sbFetch(
    `nfl_games?select=week&season=eq.${season}&completed=eq.false&spread_line=not.is.null&order=week.asc&limit=1`,
  );
  if (open.length) return open[0].week;
  const last = await sbFetch(`nfl2_signals?select=week&season=eq.${season}&order=week.desc&limit=1`);
  return last.length ? last[0].week : 1;
}

export async function runLog(limit = 1) {
  return sbFetch(`nfl2_run_log?order=id.desc&limit=${limit}`);
}

export async function lastRun() {
  const rows = await runLog(1);
  return rows[0] || null;
}

// Queues a pull; the database runs it within a minute. Resolves with the run.
export async function requestRefresh(onStatus = () => {}) {
  const before = (await lastRun())?.id ?? 0;
  const res = await sbRpc('nfl2_request_refresh');
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

// ---------------------------------------------------------------------------
// Game detail: extra context loaded only when a game is opened
// ---------------------------------------------------------------------------

export async function loadGameContext(row) {
  const [lines, preds, buckets, season] = await Promise.all([
    sbFetch(`nfl2_line_history?game_id=eq.${row.game_id}&market=eq.${row.market}&order=captured_at.asc`),
    sbFetch(`nfl2_prediction_history?game_id=eq.${row.game_id}&market=eq.${row.market}&order=captured_at.asc`),
    sbFetch(`nfl2_bucket_stats?market=eq.${row.market}`),
    sbFetchAll(
      `nfl_games?select=id,week,game_date,home_team,away_team,home_score,away_score,spread_line,total_line` +
      `&season=eq.${row.season}&order=week.asc`,
    ),
  ]);
  return { lines, preds, buckets, seasonGames: season };
}

export const kBucket = (k) => (k < 1 ? 1 : k < 2 ? 2 : k < 3 ? 3 : k < 4.5 ? 4 : 5);
export const vBucket = (v) => (v < 0.7 ? 1 : v < 0.85 ? 2 : 3);
export const K_LABEL = { 1: 'under 1', 2: '1–2', 3: '2–3', 4: '3–4.5', 5: '4.5+' };
export const V_LABEL = { 1: 'under 70%', 2: '70–85%', 3: '85%+' };

// One team's season so far: ATS and O/U records and the last few results,
// built from the schedule rows. Games after `beforeWeek` are ignored.
export function teamForm(team, games, beforeWeek) {
  const out = { ats: [0, 0, 0], ou: [0, 0, 0], last: [], pf: 0, pa: 0, n: 0 };
  const played = games
    .filter((g) => g.week < beforeWeek && g.home_score !== null && (g.home_team === team || g.away_team === team))
    .sort((a, b) => a.week - b.week);
  for (const g of played) {
    const home = g.home_team === team;
    const mine = home ? g.home_score : g.away_score;
    const theirs = home ? g.away_score : g.home_score;
    out.pf += mine; out.pa += theirs; out.n += 1;
    if (g.spread_line !== null) {
      // home covers when (home margin) > home-relative line
      const homeCover = g.home_score - g.away_score - Number(g.spread_line);
      const c = home ? homeCover : -homeCover;
      out.ats[c > 0 ? 0 : c < 0 ? 1 : 2] += 1;
    }
    if (g.total_line !== null) {
      const t = g.home_score + g.away_score - Number(g.total_line);
      out.ou[t > 0 ? 0 : t < 0 ? 1 : 2] += 1;
    }
    out.last.push({ week: g.week, opp: home ? g.away_team : g.home_team, home, mine, theirs });
  }
  out.last = out.last.slice(-4).reverse();
  return out;
}

// ---------------------------------------------------------------------------
// The read: plain-language reasons for and against a pick
// ---------------------------------------------------------------------------
// Built only from what the board already shows, so every line can be checked
// against a number on screen. The backtest numbers quoted are from the
// 2022-2026 walk-forward described in docs/nfl-model.md.

export function buildRead(row, ctx) {
  const pros = [];
  const cons = [];
  const isTot = row.market === 'total';
  const vote = row.vote_share ?? 0;
  const k = row.kedge ?? 0;
  const moved = row.open_line !== null && row.line !== null ? row.line - row.open_line : 0;
  // movement toward the pick: for spreads the pick is home when edge > 0
  const towardPick = Math.sign(moved) === Math.sign(row.edge ?? 0) && moved !== 0;

  if (row.tier === 'Play') pros.push(`Meets the Play rule: key-adjusted edge ${f1(k)} (2.0+) with ${f1(100 * vote, 0)}% of system weight on this side (85%+).`);
  else if (row.taken_side) pros.push(`Was taken as a Play at ${pickLabel(row, row.taken_side, row.taken_line)}; the current numbers no longer qualify, but the taken line is what is graded.`);
  else if (row.tier === 'Lean') cons.push('Lean only: close to the Play rule but short on edge or agreement. Leans have run about 50% historically.');
  else cons.push('Does not meet the Play rule. Shown for reference.');

  if (row.keys_crossed.length) {
    const ks = row.keys_crossed.join(' and ');
    pros.push(isTot
      ? `The model's total is on the other side of ${ks}, totals that land more often than most.`
      : `The model's number is on the other side of ${ks}${row.keys_crossed.includes(3) ? ' (about 3.4× as common as a typical margin)' : row.keys_crossed.includes(7) ? ' (about 1.7× as common)' : ''}.`);
  } else if (k > 0 && Math.abs(row.edge ?? 0) >= 1.5) {
    cons.push('The gap to the line crosses no key number, so it is worth less than the raw points suggest.');
  }

  if (row.top5_side_share !== null) {
    if (row.top5_side_share >= 0.99) pros.push('All five most-trusted systems agree on this side.');
    else if (row.top5_side_share <= 0.4) cons.push('The most-trusted systems are split: most of the top five are on the other side.');
  }
  if ((row.std_dev ?? 0) >= 3) cons.push(`The systems disagree widely with each other (spread of ${f1(row.std_dev)} points).`);
  if (row.voters < 5) cons.push(`Only ${row.voters} weighted systems posted on this game.`);
  if ((row.coverage ?? 1) < 0.7) cons.push(`Only ${f1(100 * (row.coverage ?? 0), 0)}% of the usual system weight is present; some trusted systems have not posted.`);

  if (Math.abs(moved) >= (isTot ? 1.5 : 1)) {
    if (towardPick) pros.push(`The market has moved ${f1(Math.abs(moved))} from the opener toward the model. That is the pattern the backtest rewards, but some of the value is gone.`);
    else cons.push(`The line has moved ${f1(Math.abs(moved))} from the opener AWAY from the model. Check injuries and news: the market may know something the systems do not.`);
  }
  if (row.flags.includes('Big edge')) cons.push(`The gap to the line (${f1(Math.abs(row.edge))}) is unusually large. In the NFL that usually means news (a quarterback out, weather) the computer systems have not priced.`);

  const outliers = row.systems.filter((s) => s.out);
  if (outliers.length) cons.push(`${outliers.map((s) => s.name).join(', ')} ${outliers.length === 1 ? 'was' : 'were'} ignored on this game: the number is too far from every other system to be real.`);

  if (ctx?.buckets) {
    const b = ctx.buckets.find((x) => x.kb === kBucket(k) && x.vb === vBucket(vote));
    if (b && b.w + b.l >= 20) {
      const p = b.w / (b.w + b.l);
      const line = `Similar spots since 2022 (edge ${K_LABEL[kBucket(k)]}, agreement ${V_LABEL[vBucket(vote)]}): ${b.w}-${b.l}${b.p ? `-${b.p}` : ''} (${(100 * p).toFixed(1)}%).`;
      (p >= 0.535 ? pros : p < 0.5 ? cons : pros).push(line);
    }
  }

  if (!isTot && !row.neutral_site && row.home_rest_days !== null && row.away_rest_days !== null) {
    const d = row.home_rest_days - row.away_rest_days;
    if (Math.abs(d) >= 3) {
      const rested = d > 0 ? row.home_abbr : row.away_abbr;
      const pickTeam = row.pick_side === 'home' ? row.home_abbr : row.away_abbr;
      (rested === pickTeam ? pros : cons).push(`${rested} has ${Math.abs(d)} more days of rest.`);
    }
  }
  return { pros, cons };
}
