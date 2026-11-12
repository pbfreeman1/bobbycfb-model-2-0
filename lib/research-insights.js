// Research Insights: slices graded research tags (by side) the ways that
// mattered in the weeks 1-10 review. Pure functions over buildReport() output.
//
// Every row counts each game+side ONCE (a side tagged by three sources is one
// result). Units are flat 1u paper units: win +1, loss -1.1, push 0.
//
// These slices were chosen after looking at weeks 1-10, so backfill rows are
// hypotheses. Each group reports forward (week >= forwardFrom) separately.

import { teamSpread } from './research-report.js';

export const WIN = 1, LOSS = -1.1;
const num = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

const blank = () => ({ w: 0, l: 0, p: 0, units: 0 });
function add(rec, result) {
  if (result === 'win') { rec.w++; rec.units += WIN; }
  else if (result === 'loss') { rec.l++; rec.units += LOSS; }
  else if (result === 'push') rec.p++;
}
export const decided = (r) => r.w + r.l;
export const pct = (r) => (decided(r) ? r.w / decided(r) : null);
export const round1 = (n) => Math.round(n * 10) / 10;

// Best (lowest) KAM rank on a side, or the unnumbered conviction.
export function kamBand(side) {
  let rank = null, top = false, topish = false, any = false;
  for (const t of side.tags) {
    if (!/^KAM/i.test(t.source_label || '')) continue;
    any = true;
    if (Number.isInteger(t.rank)) rank = rank == null ? t.rank : Math.min(rank, t.rank);
    else if (t.conviction === 'top') top = true;
    else if (t.conviction === 'topish') topish = true;
  }
  if (!any) return null;
  if (rank != null) return rank <= 3 ? 'KAM #1-3' : rank <= 5 ? 'KAM #4-5' : rank <= 15 ? 'KAM #6-15' : 'KAM #16+';
  if (top) return 'KAM Top (no rank)';
  if (topish) return 'KAM Topish (no rank)';
  return 'KAM (unranked)';
}

function sideSpread(side) {
  const line = num(side.signal?.vegas_line) ?? num(side.game?.current_line);
  return teamSpread(line, side.side);
}

// Which source names credited this side (distinct).
const sourceNames = (side) => [...side.sources.keys()];

export function buildInsights(report, { forwardFrom = 11 } = {}) {
  const spread = report.sides.filter((s) => s.type === 'spread' && s.result !== null);
  const total = report.sides.filter((s) => s.type === 'total' && s.result !== null);

  function group(title, note, sides, keyFn, order) {
    const map = new Map();
    for (const s of sides) {
      const keys = [].concat(keyFn(s) ?? []);
      for (const k of keys) {
        if (!map.has(k)) map.set(k, { label: k, all: blank(), fwd: blank() });
        const row = map.get(k);
        add(row.all, s.result);
        if (s.week >= forwardFrom) add(row.fwd, s.result);
      }
    }
    let rows = [...map.values()];
    rows.forEach((r) => { r.all.units = round1(r.all.units); r.fwd.units = round1(r.fwd.units); });
    if (order) rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    else rows.sort((a, b) => decided(b.all) - decided(a.all));
    return { title, note, rows };
  }

  const tierKey = (s) => {
    if (!s.signal) return 'No model signal';
    if (s.bobby === 'oppose') return 'Against the model';
    const t = s.signal.tier || 'No tier';
    return `With model: ${t}`;
  };

  const groups = [
    group('Model tier vs the tagged side', 'Does a research tag add anything when the model has a tiered play on the same side? Best slice in weeks 1-10 was 1U + tag.',
      spread, tierKey,
      ['With model: 3U', 'With model: 2U', 'With model: 1U', 'With model: Lean', 'With model: No tier', 'Against the model', 'No model signal']),
    group('With vs against the model', 'Overall difference was not distinguishable in weeks 1-10.',
      spread, (s) => (s.bobby === 'agree' ? 'With model' : s.bobby === 'oppose' ? 'Against model' : 'No signal'),
      ['With model', 'Against model', 'No signal']),
    group('Underdog vs favorite', 'The tagged team\'s side of the spread.',
      spread, (s) => { const sp = sideSpread(s); return sp == null ? 'No line' : sp > 0 ? 'Underdog' : sp < 0 ? 'Favorite' : 'Pick\'em'; },
      ['Underdog', 'Favorite', 'Pick\'em', 'No line']),
    group('Home vs away tag', 'Week 10 was a one-week road-team shift; do not act on one week.',
      spread, (s) => (s.side === 'home' ? 'Home team' : 'Road team'), ['Home team', 'Road team']),
    group('Home tag where the model leans away', 'Weeks 1-9 were strong, week 10 went 0 for 9. Treat as a caution flag, not a rule.',
      spread.filter((s) => s.side === 'home' && s.bobby === 'oppose'), () => 'Home tag, model away'),
    group('Distinct sources on the side', 'Stacking looked good but the with-model stack result was mostly one week.',
      spread, (s) => { const n = s.sources.size; return n >= 3 ? '3+ sources' : n === 2 ? '2 sources' : '1 source'; },
      ['1 source', '2 sources', '3+ sources']),
    group('KAM rank', 'Rank within the KAM model at tag time.',
      spread, (s) => kamBand(s),
      ['KAM #1-3', 'KAM #4-5', 'KAM #6-15', 'KAM #16+', 'KAM Top (no rank)', 'KAM Topish (no rank)', 'KAM (unranked)']),
    group('Source', 'Each source credited once per side (a side with two sources appears in both rows).',
      spread, (s) => sourceNames(s)),
    group('Totals tags', 'Net loser in weeks 1-10 (tracking only).',
      total, (s) => (s.side === 'over' ? 'Over' : 'Under'), ['Over', 'Under']),
  ];

  const all = blank(), fwd = blank();
  for (const s of spread) { add(all, s.result); if (s.week >= forwardFrom) add(fwd, s.result); }
  all.units = round1(all.units); fwd.units = round1(fwd.units);

  return { groups: groups.filter((g) => g.rows.length), spreadAll: all, spreadForward: fwd, forwardFrom };
}
