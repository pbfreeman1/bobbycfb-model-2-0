import { createClient } from '@supabase/supabase-js';
import { TOP_POOL_SIZE, runDynamicTopK, scorePSS } from '../../../lib/pss-engine';

export const runtime = 'nodejs';
export const maxDuration = 60;

// BobbyPSSModel compute engine. Reads the SAME weekly Top-7 model pool
// (model_grades, 80/20 blended rankings) the original model uses, then runs
// the Dynamic Top-K cascade (3 -> 5 -> 7) and Play Strength Score on top of
// it. Writes only to pss_game_metrics — never touches game_metrics.
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week = parseInt(searchParams.get('week') || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Same snapshot-resolution logic as the original model's /api/compute:
    //    most recent model_grades snapshot at or before this week.
    const { data: weeks, error: wkErr } = await supabase
      .from('model_grades')
      .select('as_of_week')
      .eq('as_of_season', season)
      .lte('as_of_week', week)
      .order('as_of_week', { ascending: false })
      .limit(1);
    if (wkErr) throw new Error(`weeks: ${wkErr.message}`);
    if (!weeks.length) throw new Error(`No model_grades snapshot found for season ${season} at or before week ${week}`);
    const snapshotWeek = weeks[0].as_of_week;

    const { data: grades, error: grErr } = await supabase
      .from('model_grades')
      .select('model_id, rank, shrunk_ats_pct')
      .eq('as_of_season', season)
      .eq('as_of_week', snapshotWeek)
      .order('rank', { ascending: true });
    if (grErr) throw new Error(`grades: ${grErr.message}`);

    const pool = grades.slice(0, TOP_POOL_SIZE); // the same validated Top-7 pool
    const poolIds = pool.map((g) => g.model_id);

    // 2. Games for this week
    const { data: games, error: gErr } = await supabase
      .from('games')
      .select('id, current_line, opening_line')
      .eq('season', season)
      .eq('week', week);
    if (gErr) throw new Error(`games: ${gErr.message}`);

    // 3. Raw predictions from the Top-7 pool for these games
    const gameIds = games.map((g) => g.id);
    const { data: preds, error: pErr } = await supabase
      .from('raw_predictions')
      .select('game_id, model_id, predicted_margin')
      .in('game_id', gameIds)
      .in('model_id', poolIds);
    if (pErr) throw new Error(`preds: ${pErr.message}`);

    const predsByGame = {};
    for (const p of preds) {
      if (!predsByGame[p.game_id]) predsByGame[p.game_id] = [];
      predsByGame[p.game_id].push(p);
    }

    let metricsInserted = 0, qualifiedPlays = 0, firstError = null;

    for (const game of games) {
      const vegasLine = game.current_line != null ? parseFloat(game.current_line) : null;
      if (vegasLine == null) continue;
      const openingLine = game.opening_line != null ? parseFloat(game.opening_line) : null;

      const gamePreds = predsByGame[game.id] || [];
      // Rank-ordered pool restricted to models with a valid prediction for this game.
      const availPool = pool
        .map((g) => {
          const p = gamePreds.find((p) => p.model_id === g.model_id);
          return p
            ? { modelId: g.model_id, shrunkAtsPct: g.shrunk_ats_pct, predictedMargin: parseFloat(p.predicted_margin) }
            : null;
        })
        .filter(Boolean);

      if (availPool.length < 3) continue; // not enough models to run even Top-3

      const cascade = runDynamicTopK(availPool, vegasLine);
      if (!cascade.m) continue;
      const scored = scorePSS(cascade, { vegasLine, openingLine });

      const { error: uErr } = await supabase.from('pss_game_metrics').upsert({
        game_id: game.id,
        season,
        week,
        computed_at: new Date().toISOString(),
        source_snapshot_week: snapshotWeek,
        pool_model_ids: availPool.map((p) => p.modelId),
        pool_size: availPool.length,
        selected_k: scored.agreementK,
        selected_model_ids: scored.selectedModelIds,
        signal_type: scored.signalType,
        qualifies: scored.qualifies,
        qualifying_tier: scored.qualifies ? scored.tierName : null,
        consensus_spread: parseFloat(scored.consensusSpread.toFixed(4)),
        vegas_line: vegasLine,
        edge: parseFloat(scored.edge.toFixed(4)),
        stddev: parseFloat(scored.stddev.toFixed(4)),
        model_range: scored.modelRange != null ? parseFloat(scored.modelRange.toFixed(4)) : null,
        agreement: parseFloat(scored.agreement.toFixed(4)),
        agreement_count: scored.agreementCount,
        agreement_k: scored.agreementK,
        raw_mss: parseFloat(scored.rawMss.toFixed(4)),
        edge_score: parseFloat(scored.edgeScore.toFixed(2)),
        mss_score: parseFloat(scored.mssScore.toFixed(2)),
        agreement_score: parseFloat(scored.agreementScore.toFixed(2)),
        stddev_score: parseFloat(scored.stddevScore.toFixed(2)),
        historical_tier: scored.historicalTier,
        historical_score: scored.historicalScore,
        pss: parseFloat(scored.pss.toFixed(2)),
        pss_bin: scored.pssBin,
        veto_triggered: scored.vetoTriggered,
        veto_reasons: scored.vetoReasons,
        decision: scored.decision,
        suggested_side: scored.suggestedSide,
        suggested_line: parseFloat(scored.suggestedLine.toFixed(1)),
        opening_line: openingLine,
        current_line: vegasLine,
        line_move: scored.lineMove != null ? parseFloat(scored.lineMove.toFixed(2)) : null,
        edge_at_open: scored.edgeAtOpen != null ? parseFloat(scored.edgeAtOpen.toFixed(2)) : null,
        edge_retention: scored.edgeRetention != null ? parseFloat(scored.edgeRetention.toFixed(3)) : null,
        edge_cushion: scored.edgeCushion != null ? parseFloat(scored.edgeCushion.toFixed(2)) : null,
        market_alignment: scored.marketAlignment,
        pss_drivers: scored.drivers,
        warnings: scored.warnings,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'game_id' });

      if (!uErr) { metricsInserted++; if (scored.qualifies) qualifiedPlays++; }
      else if (!firstError) firstError = uErr.message;
    }

    return Response.json({
      games: metricsInserted,
      qualified_plays: qualifiedPlays,
      snapshot_week: snapshotWeek,
      ...(firstError ? { warning: `Some rows failed to upsert, e.g.: ${firstError}` } : {}),
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
