import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Same shrinkage strength used in the original 2021-2025 walk-forward backtest:
// K pseudo-games at a 0.5 prior, applied on top of the blended estimate below.
const SHRINK_K = 150;
const SHRINK_PRIOR = 0.5;

// How much weight the blended ATS%/MAE/bias give to 2026-to-date vs. the
// 2021-2025 backtest baseline. Deliberately recency-heavy per project owner.
const SEASON_WEIGHT = 0.8;
const HIST_WEIGHT = 0.2;

async function fetchAllRows(supabase, table, build) {
  // Supabase/PostgREST caps unpaginated selects at 1000 rows silently -
  // page through with .range() so a full week's raw_predictions isn't truncated.
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await build(supabase.from(table)).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const throughWeek = parseInt(searchParams.get('week') || '1'); // last graded week
  const nextWeek = throughWeek + 1; // snapshot we're producing, used starting this week

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. The immutable 2021-2025 baseline for every model (as_of_week=1, written once
    //    at the start of the season). This is always the "history" side of the blend -
    //    we never blend an already-blended row, to avoid compounding drift week over week.
    const baseline = await fetchAllRows(supabase, 'model_grades', (q) =>
      q.select('model_id, games_graded, ats_wins, ats_losses, ats_pushes, mae, bias')
        .eq('as_of_season', season).eq('as_of_week', 1)
    );
    if (!baseline.length) {
      return Response.json({ error: `No as_of_week=1 baseline found for season ${season}. Run the initial backtest load first.` }, { status: 400 });
    }
    const baseById = new Map(baseline.map((b) => [b.model_id, b]));

    // 2. Every completed 2026 game through the given week, with a market line to grade against.
    const games = await fetchAllRows(supabase, 'games', (q) =>
      q.select('id, home_score, away_score, current_line')
        .eq('season', season).lte('week', throughWeek).eq('status', 'final').not('current_line', 'is', null)
    );
    if (!games.length) {
      return Response.json({ error: `No final games with a line found for season ${season} through week ${throughWeek}.` }, { status: 400 });
    }
    const gameIds = games.map((g) => g.id);
    const gameById = new Map(games.map((g) => [g.id, g]));

    // 3. Every model's prediction for those games.
    const preds = await fetchAllRows(supabase, 'raw_predictions', (q) =>
      q.select('game_id, model_id, predicted_margin').in('game_id', gameIds)
    );

    // 4. Grade each prediction against the game's line (same sign convention used
    //    everywhere else: positive = home favored; margin = home_score - away_score).
    const seasonStats = new Map(); // model_id -> { wins, losses, pushes, sumAbsErr, sumErr, count }
    for (const p of preds) {
      const g = gameById.get(p.game_id);
      if (!g || g.home_score == null || g.away_score == null || p.predicted_margin == null) continue;
      const vegasLine = parseFloat(g.current_line);
      const margin = g.home_score - g.away_score;
      const predicted = parseFloat(p.predicted_margin);

      let atsResult;
      if (predicted > vegasLine) atsResult = margin > vegasLine ? 'win' : margin < vegasLine ? 'loss' : 'push'; // model liked home
      else if (predicted < vegasLine) atsResult = margin < vegasLine ? 'win' : margin > vegasLine ? 'loss' : 'push'; // model liked away
      else atsResult = 'push'; // model landed exactly on the line - no pick

      const err = predicted - margin;

      const s = seasonStats.get(p.model_id) || { wins: 0, losses: 0, pushes: 0, sumAbsErr: 0, sumErr: 0, count: 0 };
      if (atsResult === 'win') s.wins++;
      else if (atsResult === 'loss') s.losses++;
      else s.pushes++;
      s.sumAbsErr += Math.abs(err);
      s.sumErr += err;
      s.count++;
      seasonStats.set(p.model_id, s);
    }

    // 5. Blend each model's season-to-date stats with its 2021-2025 baseline, then
    //    apply the K=150 shrinkage-toward-0.5 on top, same as the original backtest.
    const rows = [];
    for (const [modelId, base] of baseById) {
      const hist = {
        wins: base.ats_wins || 0,
        losses: base.ats_losses || 0,
        pushes: base.ats_pushes || 0,
        games: base.games_graded || 0,
        mae: base.mae != null ? parseFloat(base.mae) : 0,
        bias: base.bias != null ? parseFloat(base.bias) : 0,
      };
      const histDecided = hist.wins + hist.losses;
      const histPct = histDecided > 0 ? hist.wins / histDecided : 0.5;

      const s = seasonStats.get(modelId);
      const seasonDecided = s ? s.wins + s.losses : 0;

      let blendedPct, blendedMae, blendedBias, shrunk;
      const totalWins = hist.wins + (s?.wins || 0);
      const totalLosses = hist.losses + (s?.losses || 0);
      const totalPushes = hist.pushes + (s?.pushes || 0);
      const totalGames = hist.games + (s?.count || 0);

      if (seasonDecided > 0) {
        const seasonPct = s.wins / seasonDecided;
        const seasonMae = s.sumAbsErr / s.count;
        const seasonBias = s.sumErr / s.count;

        blendedPct = SEASON_WEIGHT * seasonPct + HIST_WEIGHT * histPct;
        blendedMae = SEASON_WEIGHT * seasonMae + HIST_WEIGHT * hist.mae;
        blendedBias = SEASON_WEIGHT * seasonBias + HIST_WEIGHT * hist.bias;
        shrunk = (blendedPct * seasonDecided + SHRINK_K * SHRINK_PRIOR) / (seasonDecided + SHRINK_K);
      } else {
        // No 2026 picks graded yet for this model (e.g. missing predictions this
        // week) - nothing new to blend in, carry the historical baseline forward.
        blendedPct = histPct;
        blendedMae = hist.mae;
        blendedBias = hist.bias;
        shrunk = (histPct * histDecided + SHRINK_K * SHRINK_PRIOR) / (histDecided + SHRINK_K);
      }

      rows.push({
        model_id: modelId,
        as_of_season: season,
        as_of_week: nextWeek,
        games_graded: totalGames,
        ats_wins: totalWins,
        ats_losses: totalLosses,
        ats_pushes: totalPushes,
        ats_pct: parseFloat(blendedPct.toFixed(6)),
        mae: parseFloat(blendedMae.toFixed(4)),
        bias: parseFloat(blendedBias.toFixed(4)),
        shrunk_ats_pct: parseFloat(shrunk.toFixed(6)),
        computed_at: new Date().toISOString(),
        _season_games: seasonDecided, // dropped before insert, kept for the response summary
      });
    }

    // 6. Rank by the shrunk blended percentage, best first.
    rows.sort((a, b) => b.shrunk_ats_pct - a.shrunk_ats_pct);
    rows.forEach((r, i) => { r.rank = i + 1; });

    const forInsert = rows.map(({ _season_games, ...r }) => r);
    const { error: upErr } = await supabase.from('model_grades').upsert(forInsert, {
      onConflict: 'model_id,as_of_season,as_of_week',
    });
    if (upErr) throw new Error(`upsert: ${upErr.message}`);

    // 7. Name the top 7 for a readable confirmation.
    const { data: sourceModels } = await supabase.from('source_models').select('id, system_name');
    const nameById = new Map((sourceModels || []).map((m) => [m.id, m.system_name]));
    const top7 = rows.slice(0, 7).map((r) => ({
      system_name: nameById.get(r.model_id) || r.model_id,
      shrunk_ats_pct: r.shrunk_ats_pct,
      season_games: r._season_games,
    }));

    return Response.json({
      season,
      snapshot_for_week: nextWeek,
      models_updated: rows.length,
      games_used: games.length,
      predictions_graded: preds.length,
      top7,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
