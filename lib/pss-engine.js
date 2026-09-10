// ============================================================================
// BobbyPSSModel engine — Dynamic Top-K qualification + Play Strength Score
// ============================================================================
// This is a NEW, independent engine. It does not modify or depend on the
// original model's compute logic in app/api/compute/route.js — it only reads
// the same shared, already-computed weekly Top-7 model pool from
// `model_grades` (same 80/20-blended rankings the original model uses,
// per BobbyPSSModel spec section 2/3: "Same logic as the other model").
//
// Reference: BobbyPSSModel_Logic_and_Dashboard_Specification.docx
// ============================================================================

export const TOP_POOL_SIZE = 7;

// --- Dynamic Top-K qualification thresholds (spec section 2) --------------
const HIST_RANK = { Medium: 0, 'Med-High': 1, High: 2, Elite: 3 };

export function checkQualifies(tierName, m) {
  const { absEdge, rawMss, stddev, agreement, agreementCount, k, historicalTier } = m;
  const histRank = HIST_RANK[historicalTier] ?? 0;
  if (tierName === 'top3') {
    return absEdge >= 4.5 && rawMss >= 7.5 && stddev <= 3.0 && agreementCount === k && histRank >= 2; // High+
  }
  if (tierName === 'top5') {
    return absEdge >= 3.0 && rawMss >= 6.5 && stddev <= 4.5 && agreement >= 0.8 && histRank >= 1; // Med-High+
  }
  // top7 / broadest tier
  return absEdge >= 2.0 && rawMss >= 5.5 && stddev <= 6.0 && agreement >= 5 / 7 && histRank >= 0; // Medium+
}

export const SIGNAL_TYPE_BY_TIER = {
  top3: 'Conviction',
  top5: 'Confirmation',
  top7: 'Consensus',
};

// Minimum-edge threshold used for Edge Cushion, per tier (spec section 2 "Starting thresholds")
const TIER_MIN_EDGE = { top3: 4.5, top5: 3.0, top7: 2.0 };

// --- Piecewise-linear normalization helpers (spec section 5 anchors) ------
function lerp(x, x0, y0, x1, y1) {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}
function clamp(x, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, x));
}

export function edgeScore(absEdge) {
  if (absEdge <= 2) return clamp(lerp(absEdge, 0, 0, 2, 50));
  if (absEdge <= 3) return clamp(lerp(absEdge, 2, 50, 3, 65));
  if (absEdge <= 4.5) return clamp(lerp(absEdge, 3, 65, 4.5, 80));
  if (absEdge <= 6) return clamp(lerp(absEdge, 4.5, 80, 6, 95));
  return clamp(95 + (absEdge - 6) * 2);
}

export function mssScore(rawMss) {
  if (rawMss <= 5.5) return clamp(lerp(rawMss, 0, 0, 5.5, 55));
  if (rawMss <= 6.5) return clamp(lerp(rawMss, 5.5, 55, 6.5, 70));
  if (rawMss <= 7.5) return clamp(lerp(rawMss, 6.5, 70, 7.5, 82));
  if (rawMss <= 8.5) return clamp(lerp(rawMss, 7.5, 82, 8.5, 95));
  return clamp(95 + (rawMss - 8.5) * 5);
}

export function agreementScore(frac) {
  if (frac <= 0.5) return 0;
  if (frac <= 5 / 7) return clamp(lerp(frac, 0.5, 0, 5 / 7, 72));
  if (frac <= 0.8) return clamp(lerp(frac, 5 / 7, 72, 0.8, 80));
  if (frac <= 6 / 7) return clamp(lerp(frac, 0.8, 80, 6 / 7, 86));
  if (frac < 1) return clamp(lerp(frac, 6 / 7, 86, 1, 100));
  return 100;
}

export function stddevScore(std) {
  if (std <= 2) return 100;
  if (std <= 3) return clamp(lerp(std, 2, 100, 3, 85));
  if (std <= 4.5) return clamp(lerp(std, 3, 85, 4.5, 65));
  if (std <= 6) return clamp(lerp(std, 4.5, 65, 6, 40));
  return clamp(lerp(std, 6, 40, 10, 0));
}

const HIST_TIER_SCORE = { Medium: 60, 'Med-High': 75, High: 88, Elite: 100 };

export function historicalTierFromAts(avgShrunkAts) {
  if (avgShrunkAts == null || Number.isNaN(avgShrunkAts)) return 'Medium';
  if (avgShrunkAts >= 0.58) return 'Elite';
  if (avgShrunkAts >= 0.55) return 'High';
  if (avgShrunkAts >= 0.52) return 'Med-High';
  return 'Medium';
}

// --- PSS component weights (spec section 4) --------------------------------
const W_EDGE = 0.30, W_MSS = 0.25, W_AGREE = 0.20, W_STD = 0.15, W_HIST = 0.10;

export function pssBin(pss) {
  if (pss >= 90) return 'Elite';
  if (pss >= 82) return 'Very Strong';
  if (pss >= 74) return 'Strong';
  if (pss >= 66) return 'Moderate';
  return 'No Play';
}

// --- Compute the metrics for one candidate K-subset -------------------------
// subsetPreds: array of { modelId, rank, shrunkAtsPct, predictedMargin }, best-ranked first.
export function computeSubsetMetrics(subsetPreds, vegasLine) {
  const k = subsetPreds.length;
  const rawWeights = subsetPreds.map((p) => Math.max(0.001, (p.shrunkAtsPct ?? 0.5) - 0.5));
  const sumW = rawWeights.reduce((a, b) => a + b, 0);
  const weights = sumW > 0 ? rawWeights.map((w) => w / sumW) : rawWeights.map(() => 1 / k);

  const consensus = subsetPreds.reduce((a, p, i) => a + weights[i] * p.predictedMargin, 0);
  const mean = subsetPreds.reduce((a, p) => a + p.predictedMargin, 0) / k;
  const variance = subsetPreds.reduce((a, p) => a + Math.pow(p.predictedMargin - mean, 2), 0) / k;
  const stddev = Math.sqrt(variance);
  const values = subsetPreds.map((p) => p.predictedMargin);
  const modelRange = Math.max(...values) - Math.min(...values);

  const edge = consensus - vegasLine;
  const absEdge = Math.abs(edge);
  const edgePositive = edge >= 0;
  const agreementCount = subsetPreds.filter((p) =>
    edgePositive ? p.predictedMargin > vegasLine : p.predictedMargin < vegasLine
  ).length;
  const agreement = agreementCount / k;

  // Raw MSS — same component family as the original model's MSS, scoped to this subset.
  const edgeScoreRaw = Math.min(1, absEdge / 3.5);
  const agreeScoreRaw = Math.max(0, (agreement - 0.5) / 0.5);
  const varScoreRaw = Math.max(0, 1 - stddev / 5);
  const rawMss = (0.5 * edgeScoreRaw + 0.3 * agreeScoreRaw + 0.2 * varScoreRaw) * 10;

  const avgShrunkAts = subsetPreds.reduce((a, p) => a + (p.shrunkAtsPct ?? 0.5), 0) / k;
  const historicalTier = historicalTierFromAts(avgShrunkAts);

  return {
    k,
    modelIds: subsetPreds.map((p) => p.modelId),
    weights,
    consensus,
    stddev,
    modelRange,
    edge,
    absEdge,
    agreement,
    agreementCount,
    rawMss,
    historicalTier,
    avgShrunkAts,
  };
}

// --- Cascade: try Top-3 -> Top-5 -> Top-7(broad); fall back to broadest for display ---
// pool: array of { modelId, rank, shrunkAtsPct, predictedMargin }, already sorted by rank asc,
// restricted to models with a valid prediction for this game (length <= 7).
export function runDynamicTopK(pool, vegasLine) {
  const poolSize = pool.length;
  const tiers = [];
  if (poolSize >= 3) tiers.push({ tierName: 'top3', k: 3 });
  if (poolSize >= 5) tiers.push({ tierName: 'top5', k: 5 });
  if (poolSize >= 3) tiers.push({ tierName: 'top7', k: Math.min(poolSize, 7) });

  let chosen = null;
  let lastComputed = null;
  for (const tier of tiers) {
    const subset = pool.slice(0, tier.k);
    const m = computeSubsetMetrics(subset, vegasLine);
    lastComputed = { tierName: tier.tierName, m };
    if (checkQualifies(tier.tierName, m)) {
      chosen = { tierName: tier.tierName, m, qualifies: true };
      break;
    }
  }
  if (!chosen) {
    // Nothing qualified — use the broadest attempted tier for display, marked as not qualifying.
    chosen = { tierName: lastComputed?.tierName ?? null, m: lastComputed?.m ?? null, qualifies: false };
  }
  return chosen;
}

// --- Full PSS scoring + drivers/warnings + decision for a chosen subset ----
export function scorePSS({ tierName, m, qualifies }, game) {
  const eScore = edgeScore(m.absEdge);
  const mScore = mssScore(m.rawMss);
  const aScore = agreementScore(m.agreement);
  const sScore = stddevScore(m.stddev);
  const hScore = HIST_TIER_SCORE[m.historicalTier] ?? 60;

  const pss = W_EDGE * eScore + W_MSS * mScore + W_AGREE * aScore + W_STD * sScore + W_HIST * hScore;
  const bin = pssBin(pss);

  // Hard vetoes (spec section 6) — override decision regardless of PSS.
  const vetoReasons = [];
  if (m.stddev > 6) vetoReasons.push('StdDev > 6 (dispersion veto)');
  if (m.agreement < 0.70) vetoReasons.push('Agreement < 70% (directional veto)');
  if (m.absEdge < 2) vetoReasons.push('|Edge| < 2 (minimum edge veto)');
  const vetoTriggered = vetoReasons.length > 0;

  const suggestedSide = m.edge > 0 ? 'home' : 'away';
  const suggestedLine = m.edge > 0 ? game.vegasLine - m.absEdge : game.vegasLine + m.absEdge;

  // Market context
  let lineMove = null, edgeAtOpen = null, edgeRetention = null, marketAlignment = null;
  if (game.openingLine != null && game.vegasLine != null) {
    lineMove = game.vegasLine - game.openingLine;
    edgeAtOpen = m.consensus - game.openingLine;
    if (Math.abs(lineMove) < 0.25) marketAlignment = 'Stable';
    else if (Math.abs(m.edge) < Math.abs(edgeAtOpen) - 0.1) marketAlignment = 'Toward Model';
    else if (Math.abs(m.edge) > Math.abs(edgeAtOpen) + 0.1) marketAlignment = 'Against Model';
    else marketAlignment = 'Stable';
    edgeRetention = edgeAtOpen !== 0 ? m.edge / edgeAtOpen : null;
  }
  const minEdgeForTier = TIER_MIN_EDGE[tierName] ?? TIER_MIN_EDGE.top7;
  const edgeCushion = m.absEdge - minEdgeForTier;

  // Decision layer (spec section 13)
  let decision;
  if (vetoTriggered) {
    decision = 'PASS';
  } else if (pss >= 82) {
    decision = (marketAlignment === 'Against Model' && edgeRetention != null && edgeRetention < 0.5)
      ? 'REVIEW' : 'BET';
  } else if (pss >= 74) {
    decision = 'CONSIDER';
  } else if (pss >= 66) {
    decision = 'WATCH';
  } else {
    decision = 'PASS';
  }

  // Drivers (positive) — short phrases, most notable first, capped at 4
  const drivers = [];
  if (eScore >= 95) drivers.push('Elite Edge');
  else if (eScore >= 80) drivers.push('High Edge');
  if (aScore >= 100) drivers.push(`${m.agreementCount}/${m.k} Unanimous`);
  else if (aScore >= 86) drivers.push(`${m.agreementCount}/${m.k} Strong Agreement`);
  if (mScore >= 95) drivers.push('Elite MSS');
  else if (mScore >= 82) drivers.push('Strong MSS');
  if (sScore >= 95) drivers.push('Very Low STD');
  else if (sScore >= 85) drivers.push('Low STD');
  if (m.historicalTier === 'Elite') drivers.push('Elite Historical Confidence');

  // Warnings — capped at 3, plus explicit veto reasons
  const warnings = [...vetoReasons];
  if (m.stddev > 4.5 && m.stddev <= 6) warnings.push('High Model Dispersion');
  if (m.agreement < 0.8 && m.agreement >= 0.70) warnings.push('Minority Opposition');
  if (edgeRetention != null && edgeRetention < 0.6) warnings.push('Edge Eroding');
  if (marketAlignment === 'Against Model') warnings.push('Market Moving Against Model');
  if (edgeCushion != null && edgeCushion >= 0 && edgeCushion < 1.0) warnings.push('Near Qualification Floor');

  return {
    tierName,
    qualifies,
    signalType: qualifies ? SIGNAL_TYPE_BY_TIER[tierName] : null,
    consensusSpread: m.consensus,
    edge: m.edge,
    absEdge: m.absEdge,
    stddev: m.stddev,
    modelRange: m.modelRange,
    agreement: m.agreement,
    agreementCount: m.agreementCount,
    agreementK: m.k,
    rawMss: m.rawMss,
    edgeScore: eScore,
    mssScore: mScore,
    agreementScore: aScore,
    stddevScore: sScore,
    historicalTier: m.historicalTier,
    historicalScore: hScore,
    pss,
    pssBin: bin,
    vetoTriggered,
    vetoReasons,
    decision,
    suggestedSide,
    suggestedLine,
    lineMove,
    edgeAtOpen,
    edgeRetention,
    edgeCushion,
    marketAlignment,
    drivers: drivers.slice(0, 4),
    warnings: warnings.slice(0, 4),
    selectedModelIds: m.modelIds,
  };
}
