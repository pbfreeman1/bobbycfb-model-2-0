// Outside picks (scout), phase 2: pure helpers behind the board "Tags" column,
// the game drawer section and the research pages. No I/O.
//
// Rows come from the views in supabase/migrations/20261119000500_scout_research_views.sql:
//   scout_game_crowd  one row per game and group ('side' = spread + moneyline, 'total')
//   scout_side_consensus  one row per game, group and side
// Lines are home-relative (+3 = home favored by 3), as everywhere in the database.

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export const GROUPS = { side: 'Sides', total: 'Totals' };
export const SIDES = { side: ['home', 'away'], total: ['over', 'under'] };
export const otherSide = (s) => ({ home: 'away', away: 'home', over: 'under', under: 'over' }[s] || null);

// Sources on each side of a crowd row, keyed by side.
export function sideCounts(c) {
  if (!c) return {};
  const a = num(c.a_src) || 0;
  const b = num(c.b_src) || 0;
  return c.grp === 'total' ? { over: a, under: b } : { home: a, away: b };
}

// What the board shows for one game: sources on the model's side vs against,
// or, with no model side, the crowd's side and count.
//   tone: 'with' (more sources with the model), 'against', 'split' (tied), 'none' (no model side)
export function tagSummary(c, modelSide) {
  if (!c) return null;
  const counts = sideCounts(c);
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  if (!total) return null;
  if (modelSide && counts[modelSide] !== undefined) {
    const withN = counts[modelSide];
    const againstN = counts[otherSide(modelSide)] || 0;
    const tone = withN > againstN ? 'with' : againstN > withN ? 'against' : 'split';
    return { withN, againstN, total, tone, crowdSide: c.crowd_side || null };
  }
  return { withN: null, againstN: null, total, tone: c.crowd_side ? 'none' : 'split', crowdSide: c.crowd_side || null, top: num(c.crowd_sources) || 0 };
}

// Sportsbook-style spread for a side from a home-relative line.
export function spreadFor(side, homeRel) {
  const n = num(homeRel);
  if (n === null || !side) return '';
  const v = side === 'home' ? -n : n;
  if (v === 0) return 'PK';
  return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '');
}

// "Kansas -3.5", "Over 141.5", "Houston" when there is no line.
export function sideLabel(row, side, homeRel = row?.market_line, names = {}) {
  if (!side) return '—';
  if (side === 'over' || side === 'under') {
    const t = num(homeRel);
    return `${side === 'over' ? 'Over' : 'Under'}${t === null ? '' : ` ${t}`}`;
  }
  const team = side === 'home' ? (names.home || row?.home) : (names.away || row?.away);
  const s = spreadFor(side, homeRel);
  return s ? `${team} ${s}` : team;
}

// How far the line has moved since a source took it, from that side's view.
// Positive = the number is now worse for the side (the source got a better price).
export function lineWorseBy(side, takenHomeRel, nowHomeRel) {
  const t = num(takenHomeRel);
  const n = num(nowHomeRel);
  if (t === null || n === null) return null;
  if (side === 'home') return +(n - t).toFixed(2);
  if (side === 'away') return +(t - n).toFixed(2);
  if (side === 'over') return +(n - t).toFixed(2);
  if (side === 'under') return +(t - n).toFixed(2);
  return null;
}

// Line move from the opener toward (+) or away from (-) a side.
export function moveToward(side, openHomeRel, nowHomeRel) {
  const w = lineWorseBy(side, openHomeRel, nowHomeRel);
  return w === null ? null : w; // a worse number for the side = the market moved toward it
}

// Spotlights for the research page from open (not final) crowd rows.
export function spotlights(rows, { minCrowd = 2 } = {}) {
  const lead = (r) => (num(r.crowd_sources) || 0) - (num(r.other_sources) || 0);
  const open = rows.filter((r) => !r.final);
  const byCrowd = (a, b) => (num(b.crowd_sources) - num(a.crowd_sources)) || (lead(b) - lead(a));
  return {
    together: open.filter((r) => r.model_relation === 'with' && num(r.crowd_sources) >= minCrowd && lead(r) >= 2).sort(byCrowd),
    against: open.filter((r) => r.model_relation === 'against' && num(r.crowd_sources) >= minCrowd && lead(r) >= 2).sort(byCrowd),
    splits: open.filter((r) => num(r.other_sources) >= 1 && lead(r) <= 1 && num(r.crowd_sources) + num(r.other_sources) >= 3)
      .sort((a, b) => (num(b.crowd_sources) + num(b.other_sources)) - (num(a.crowd_sources) + num(a.other_sources)) || lead(a) - lead(b)),
    steam: open.filter((r) => {
      const m = moveToward(r.crowd_side, r.open_line, r.market_line);
      return m !== null && Math.abs(m) >= 1 && num(r.crowd_sources) >= minCrowd;
    }).sort(byCrowd),
  };
}

const bucket = (n) => (n >= 4 ? '4+' : String(n));

// Record of the crowd's side against the market line, by number of sources
// and by agreement with the model. rows: final scout_game_crowd rows.
export function crowdRecord(rows) {
  const out = new Map();
  const add = (key, r) => {
    if (!out.has(key)) out.set(key, { key, w: 0, l: 0, p: 0 });
    const o = out.get(key);
    if (r.crowd_result === 'W') o.w += 1; else if (r.crowd_result === 'L') o.l += 1; else if (r.crowd_result === 'P') o.p += 1;
  };
  for (const r of rows) {
    if (!r.crowd_result) continue;
    const n = num(r.crowd_sources) || 0;
    const unanimous = (num(r.other_sources) || 0) === 0;
    const rel = r.model_relation || 'none';
    for (const g of [r.grp, 'all']) {
      add(`${g}|n:${bucket(n)}|all`, r);
      add(`${g}|n:${bucket(n)}|${rel}`, r);
      add(`${g}|n:all|${rel}`, r);
      add(`${g}|n:all|all`, r);
      if (unanimous && n >= 2) add(`${g}|unanimous2+|all`, r);
    }
  }
  return out;
}

export function rec(o) {
  if (!o) return { text: '0-0', pct: null, units: 0, n: 0 };
  const n = o.w + o.l;
  const units = +(o.w - 1.1 * o.l).toFixed(1);
  return { text: `${o.w}-${o.l}${o.p ? `-${o.p}` : ''}`, pct: n ? (100 * o.w) / n : null, units, n };
}

export const pctText = (p) => (p === null || p === undefined ? '—' : `${p.toFixed(1)}%`);
export const unitsText = (u) => `${u > 0 ? '+' : ''}${Number(u || 0).toFixed(1)}u`;
