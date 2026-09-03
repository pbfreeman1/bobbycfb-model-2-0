import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

// === Engine constants (mirrors model_engine.py) ===
const TOP_K = 7;
const EDGE_MIN = 1.5;
const EDGE_MAX = 7.0;
const STDDEV_MAX = 2.5;
const AGREEMENT_MIN = 0.85;

// MSS component weights
const W_EDGE = 0.50, W_AGREE = 0.30, W_VAR = 0.20;

// MSS confidence bins (right-skewed calibrated)
const BINS = [
  { label: 'Very Strong', min: 10.0 },
  { label: 'Strong',      min: 4.0  },
  { label: 'Moderate',    min: 1.5  },
  { label: 'Weak',        min: 0.5  },
  { label: 'Very Weak',   min: 0    },
];

function confidenceBin(mss) {
  for (const b of BINS) if (mss >= b.min) return b.label;
  return 'Very Weak';
}

export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week   = parseInt(searchParams.get('week')   || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Get ranked models for this season (use prior seasons)
    const { data: grades, error: grErr } = await supabase
      .from('model_grades')
      .select('model_id, rank, shrunk_ats_pct')
      .eq('as_of_season', season)
      .order('rank', { ascending: true });
    if (grErr) throw new Error(`grades: ${grErr.message}`);

    // Top-K model IDs and weights
    const topK = grades.slice(0, TOP_K);
    const topIds = topK.map(g => g.model_id);
    const rawWeights = topK.map(g => Math.max(0.001, (g.shrunk_ats_pct || 0.5) - 0.5));
    const sumW = rawWeights.reduce((a, b) => a + b, 0);
    const weights = sumW > 0 ? rawWeights.map(w => w / sumW) : rawWeights.map(() => 1 / TOP_K);

    // 2. Get games for this week
    const { data: games, error: gErr } = await supabase
      .from('games')
      .select('id, current_line')
      .eq('season', season)
      .eq('week', week);
    if (gErr) throw new Error(`games: ${gErr.message}`);

    // 3. Get raw predictions
    const gameIds = games.map(g => g.id);
    const { data: preds, error: pErr } = await supabase
      .from('raw_predictions')
      .select('game_id, model_id, predicted_margin')
      .in('game_id', gameIds)
      .in('model_id', topIds);
    if (pErr) throw new Error(`preds: ${pErr.message}`);

    // Group predictions by game
    const predsByGame = {};
    for (const p of preds) {
      if (!predsByGame[p.game_id]) predsByGame[p.game_id] = [];
      predsByGame[p.game_id].push(p);
    }

    let metricsInserted = 0, plays = 0;

    for (const game of games) {
      const gamePreds = predsByGame[game.id] || [];
      const vegasLine = game.current_line != null ? parseFloat(game.current_line) : null;
      if (!vegasLine && vegasLine !== 0) continue;

      // Only use top-K predictions that exist for this game
      const availPreds = topIds.map((id, i) => {
        const p = gamePreds.find(p => p.model_id === id);
        return p ? { pred: parseFloat(p.predicted_margin), weight: weights[i] } : null;
      }).filter(Boolean);

      if (availPreds.length < 3) continue; // not enough models

      // Weighted consensus
      const sumWeights = availPreds.reduce((a, p) => a + p.weight, 0);
      const consensus = availPreds.reduce((a, p) => a + p.weight * p.pred, 0) / sumWeights;

      // StdDev
      const mean = availPreds.reduce((a, p) => a + p.pred, 0) / availPreds.length;
      const variance = availPreds.reduce((a, p) => a + Math.pow(p.pred - mean, 2), 0) / availPreds.length;
      const stddev = Math.sqrt(variance);

      // Edge (consensus - vegas, positive = home team has model edge)
      const edge = consensus - vegasLine;

      // Agreement: fraction agreeing on which side has edge
      const homeCount = availPreds.filter(p => p.pred > vegasLine).length;
      const awayCount = availPreds.filter(p => p.pred < vegasLine).length;
      const majority = Math.max(homeCount, awayCount);
      const agreement = majority / availPreds.length;

      // MSS components
      const absEdge = Math.abs(edge);
      const edgeScore = Math.min(1, absEdge / 3.5);
      const agreeScore = Math.max(0, (agreement - 0.5) / 0.5);
      const varScore = Math.max(0, 1 - stddev / 5);
      const mss = (W_EDGE * edgeScore + W_AGREE * agreeScore + W_VAR * varScore) * 10;

      const confBin = confidenceBin(mss);

      // Qualification
      const qualifies = (
        absEdge >= EDGE_MIN &&
        absEdge <= EDGE_MAX &&
        stddev <= STDDEV_MAX &&
        agreement >= AGREEMENT_MIN
      );

      const suggestedSide = edge > 0 ? 'home' : 'away';
      const suggestedLine = edge > 0 ? vegasLine - absEdge : vegasLine + absEdge;

      // Upsert game_metrics
      const { error: uErr } = await supabase.from('game_metrics').upsert({
        game_id: game.id,
        snapshot_type: 'pregame_final',
        computed_at: new Date().toISOString(),
        valid_model_count: availPreds.length,
        target_k: TOP_K,
        actual_k: availPreds.length,
        topk_model_ids: topIds,
        topk_weights: weights,
        consensus_spread: parseFloat(consensus.toFixed(4)),
        vegas_line: vegasLine,
        edge: parseFloat(edge.toFixed(4)),
        stddev: parseFloat(stddev.toFixed(4)),
        agreement: parseFloat(agreement.toFixed(4)),
        edge_score: parseFloat(edgeScore.toFixed(4)),
        agreement_score: parseFloat(agreeScore.toFixed(4)),
        variance_score: parseFloat(varScore.toFixed(4)),
        mss: parseFloat(mss.toFixed(4)),
        confidence_bin: confBin,
        suggested_play: qualifies,
        suggested_side: qualifies ? suggestedSide : null,
        suggested_line: qualifies ? parseFloat(suggestedLine.toFixed(1)) : null,
      }, { onConflict: 'game_id' });

      if (!uErr) { metricsInserted++; if (qualifies) plays++; }
    }

    return Response.json({ games: metricsInserted, plays });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
