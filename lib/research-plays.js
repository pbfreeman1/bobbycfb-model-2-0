// Play Finder: turns a week's research tags + model signals into ranked
// buckets, and scores each bucket over time. Pure functions.
//
// Buckets (spread tags only; totals tags were a net loser in weeks 1-10 and
// are shown separately and never bucketed):
//   A  Model play + research same side   (signal tier 1U/2U/3U, tag agrees)
//   B  Research agrees with a Lean / no-tier model side
//   X  Research opposes the model side   (informational, not a bet by itself)
//   M  Model 1U/2U/3U play with no spread tag
//   N  Tagged, but no model signal yet
//
// These are hypotheses from slicing weeks 1-10 (small samples, in-sample).
// The scoreboard separates backfill (weeks before forwardFrom) from forward
// weeks so the rule can be judged out of sample.

import { gradeTag, teamSpread } from './research-report.js';

export const TIERED = new Set(['1U', '2U', '3U']);
export const BUCKETS = ['A', 'B', 'X', 'M', 'N'];
export const BUCKET_NAMES = {
  A: 'Model play + research',
  B: 'Research + lean',
  X: 'Research vs model',
  M: 'Model only',
  N: 'No signal',
};
const TIER_ORDER = { '3U': 3, '2U': 2, '1U': 1 };
export const LINE_MOVE_POINTS = 3;
export const WIN = 1, LOSS = -1.1;

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

// Line moved 3+ points, or flipped favourite, since the tag/signal line.
export function lineMoved(oldLine, newLine, threshold = LINE_MOVE_POINTS) {
  const a = num(oldLine), b = num(newLine);
  if (a == null || b == null) return false;
  if (Math.abs(b - a) >= threshold) return true;
  return a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b);
}

function latestSignals(signals) {
  const m = new Map();
  for (const s of signals || []) {
    const p = m.get(s.game_id);
    if (!p || String(s.computed_at) > String(p.computed_at)) m.set(s.game_id, s);
  }
  return m;
}

export function unitsFor(result) {
  return result === 'win' ? WIN : result === 'loss' ? LOSS : 0;
}

// -> array of side objects, each with a bucket, sorted best-first.
export function buildPlays({ tags, games, signals, forwardFrom = 11 }) {
  const sigByGame = latestSignals(signals);
  const gameById = new Map((games || []).map((g) => [g.id, g]));
  const out = [];
  const taggedSpreadGames = new Set();

  const bySide = new Map();
  for (const t of tags || []) {
    const type = t.pick_type || 'spread';
    if (type !== 'spread' || (t.pick_side !== 'home' && t.pick_side !== 'away')) continue;
    taggedSpreadGames.add(t.game_id);
    const k = `${t.game_id}|${t.pick_side}`;
    if (!bySide.has(k)) bySide.set(k, []);
    bySide.get(k).push(t);
  }

  for (const [k, list] of bySide) {
    const [gameId, side] = k.split('|');
    const game = gameById.get(gameId) || null;
    const signal = sigByGame.get(gameId) || null;
    const tier = signal?.tier || null;
    let bucket;
    if (!signal) bucket = 'N';
    else if (signal.pick_side !== side) bucket = 'X';
    else bucket = TIERED.has(tier) ? 'A' : 'B';

    const sources = new Set();
    let kamRank = null, kamTopish = false, kamTop = false;
    for (const t of list) {
      const name = (t.source_label || '').split(/\s+[#T]/)[0].trim() || 'Unlabeled';
      sources.add(name);
      if (/^KAM/i.test(t.source_label || '')) {
        if (Number.isInteger(t.rank)) kamRank = kamRank == null ? t.rank : Math.min(kamRank, t.rank);
        if (t.conviction === 'top') kamTop = true;
        if (t.conviction === 'topish') kamTopish = true;
      }
    }
    const tagLine = num(list.find((t) => t.line_at_tag != null)?.line_at_tag);
    const baseLine = tagLine ?? num(signal?.vegas_line);
    const result = gradeTag({ pick_type: 'spread', pick_side: side }, game, signal);
    out.push({
      key: k, game_id: gameId, game, side, week: list[0].week, bucket, tier, signal, tags: list,
      sources: [...sources], sourceCount: sources.size, kamRank, kamTop: kamTop || kamRank != null && kamRank <= 5, kamTopish,
      spread: teamSpread(baseLine, side),
      moved: lineMoved(baseLine, game?.current_line),
      lowCoverage: signal?.coverage != null && num(signal.coverage) < 0.9,
      result, forward: list[0].week >= forwardFrom,
    });
  }

  // Model plays with no spread tag
  for (const [gameId, signal] of sigByGame) {
    if (taggedSpreadGames.has(gameId) || !TIERED.has(signal.tier)) continue;
    const game = gameById.get(gameId) || null;
    if (!game) continue;
    const side = signal.pick_side;
    const result = gradeTag({ pick_type: 'spread', pick_side: side }, game, signal);
    out.push({
      key: `${gameId}|${side}`, game_id: gameId, game, side, week: game.week, bucket: 'M', tier: signal.tier, signal, tags: [],
      sources: [], sourceCount: 0, kamRank: null, kamTop: false, kamTopish: false,
      spread: teamSpread(signal.vegas_line, side), moved: lineMoved(signal.vegas_line, game.current_line),
      lowCoverage: signal.coverage != null && num(signal.coverage) < 0.9,
      result, forward: game.week >= forwardFrom,
    });
  }

  const order = { A: 0, B: 1, M: 2, X: 3, N: 4 };
  out.sort((a, b) =>
    order[a.bucket] - order[b.bucket]
    || (TIER_ORDER[b.tier] || 0) - (TIER_ORDER[a.tier] || 0)
    || Number(b.kamTop) - Number(a.kamTop)
    || b.sourceCount - a.sourceCount
    || (num(b.signal?.edge) ?? 0) - (num(a.signal?.edge) ?? 0));
  return out;
}

// Flat 1u paper units per side, win +1 / loss -1.1.
export function scoreboard(plays) {
  const blank = () => ({ w: 0, l: 0, p: 0, units: 0 });
  const sb = {};
  for (const b of BUCKETS) sb[b] = { forward: blank(), backfill: blank() };
  for (const p of plays) {
    if (!p.result) continue;
    const r = sb[p.bucket][p.forward ? 'forward' : 'backfill'];
    if (p.result === 'win') r.w++; else if (p.result === 'loss') r.l++; else r.p++;
    r.units += unitsFor(p.result);
  }
  for (const b of BUCKETS) for (const k of ['forward', 'backfill']) sb[b][k].units = Math.round(sb[b][k].units * 10) / 10;
  return sb;
}
