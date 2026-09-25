// THE Bobby Model — display rank for the weekly board.
//
// This is presentation only: it orders the week from best to worst Bobby play.
// It never touches tier thresholds, units or grading — those are decided by
// cfb_compute and read as-is.
//
// The rank is a property of the GAME, computed once over every game on the
// board before any search / filter / sort, so a game's #N never moves.
//
// Note: cfb_game_signals.rank_in_week already exists but is ordered by raw
// conviction alone, which puts some 2U games ahead of 3U games. We want tier
// first, so we derive our own order here and leave that column alone.

import { nearMiss } from './bobby-model.js';

// Primary ordering bucket. Lower sorts first.
const TIER_GROUP = { '3U': 0, '2U': 1, '1U': 2, 'Lean': 3 };
const GROUP_NEAR_MISS = 4;   // no tier, but one threshold away from 1U
const GROUP_NO_PLAY = 5;     // computed, no tier, not close
const GROUP_NO_SIGNAL = 6;   // not computed yet

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Strength score inside a tier, 0..1.
//
//   0.50 * weighted agreement  (vote_share, rescaled so 50% => 0, 100% => 1)
// + 0.35 * tapered edge        (see below)
// + 0.15 * tightness           (std_dev, 5.0+ => 0, 1.0 or less => 1)
//
// The edge term is deliberately tapered rather than linear. Backtests showed
// ATS performance degrades once the edge runs past ~3 points, so:
//   - the first 3.0 points of edge count in full,
//   - points 3.0 -> 5.0 count at 25%,
//   - anything past 5.0 adds nothing at all.
// Effective edge therefore maxes out at 3.5 points. A 9-point edge scores no
// better than a 5-point one, and raw edge can never dominate the order on its
// own — it is at most 35% of the score.
export function bobbyStrength(signal) {
  if (!signal) return 0;

  const voteShare = Number(signal.vote_share);
  const rawEdge = Math.abs(Number(signal.edge));
  const stdDev = Number(signal.std_dev);

  const agreement = clamp01((voteShare - 0.5) / 0.5);

  const effEdge = Math.min(rawEdge || 0, 3) + 0.25 * Math.max(0, Math.min(rawEdge || 0, 5) - 3);
  const edgeScore = clamp01(effEdge / 3.5);

  const tightness = clamp01((5 - stdDev) / 4);

  return 0.5 * agreement + 0.35 * edgeScore + 0.15 * tightness;
}

// row: { game, signal }, config: flat cfb_tracker_config map
export function rankGroup(row, config) {
  const signal = row?.signal;
  if (!signal) return GROUP_NO_SIGNAL;
  const tier = signal.tier || 'No tier';
  if (TIER_GROUP[tier] != null) return TIER_GROUP[tier];
  return nearMiss({ ...signal, tier }, config || {}) ? GROUP_NEAR_MISS : GROUP_NO_PLAY;
}

// Returns a new array of rows, each with bobbyRank (1-based) and bobbyStrength
// attached. Input order is preserved so the caller can still sort however it
// likes without disturbing the ranks.
export function attachBobbyRank(rows, config) {
  const ordered = [...rows].sort((a, b) => (
    rankGroup(a, config) - rankGroup(b, config)
    || bobbyStrength(b.signal) - bobbyStrength(a.signal)
    // Deterministic tiebreaker so ties never shuffle between renders.
    || String(a.game.id).localeCompare(String(b.game.id))
  ));

  const rankByGame = new Map();
  ordered.forEach((r, i) => rankByGame.set(r.game.id, i + 1));

  return rows.map((r) => ({
    ...r,
    bobbyRank: rankByGame.get(r.game.id),
    bobbyStrength: bobbyStrength(r.signal),
  }));
}
