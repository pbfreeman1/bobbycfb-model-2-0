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
    // 0. Models explicitly marked status='exclude' in source_models (line-derived
    //    columns that are not independent predictions - lineca, lineavg, lineopen,
    //    linemidweek, etc.) must never be eligible for Top-K selection. Some of these
    //    (e.g. linemidweek) have real baseline rows from the historical data load, so
    //    unlike the cleanly-never-loaded ones, they need to be actively filtered here
    //    rather than just absent from the data.
    const { data: excludedRows, error: exErr } = await supabase
      .from('source_models')
      .select('id')
      .eq('status', 'exclude');
    if (exErr) throw new Error(`source_models: ${exErr.message}`);
    const excludedIds = new Set((excludedRows || []).map((r) => r.id));

    // 1. The immutable 2021-2025 baseline for every model (as_of_week=1, written once
    //    at the start of the season). This is always the "history" side of the blend -
    //    we never blend an already-blended row, to avoid compounding drift week over week.
    const rawBaseline = await fetchAllRows(supabase, 'model_grades', (q) =>
      q.select('model_id, games_graded, ats_wins, ats_losses, ats_pushes, mae, bias')
        .eq('as_of_season', season).eq('as_of_week', 1)
    );
    const baseline = rawBaseline.filter((b) => !excludedIds.has(b.model_id));
    if (!baseline.length) {
      return Response.json({ error: `No as_of_week=1 baseline found for season ${season}. Run the initial backtest load first.` }, { status: 400 });
    }
    const baseById = new Map(baseline.map((b) => [b.model_id, b]));

    // 2. Every individual model pick already graded this season through the given
    //    week - populated by /api/grade, which grades ALL raw_predictions (not just
    //    suggested plays) each time games are marked final. Single source of truth
    //    shared with the weekly results page, so rankings and displayed history
    //    can never drift apart.
    const grades = await fetchAllRows(supabase, 'model_pick_grades', (q) =>
      q.select('model_id, ats_result, abs_error, signed_error')
        .eq('season', season).lte('week', throughWeek)
    );
    if (!grades.length) {
      return Response.json({ error: `No graded picks found in model_pick_grades for season ${season} through week ${throughWeek}. Run Grade Results first.` }, { status: 400 });
    }

    // 3. Aggregate per model.
    const seasonStats = new Map(); // model_id -> { wins, losses, pushes, sumAbsErr, sumErr, count }
    for (const gr of grades) {
      const s = seasonStats.get(gr.model_id) || { wins: 0, losses: 0, pushes: 0, sumAbsErr: 0, sumErr: 0, count: 0 };
      if (gr.ats_result === 'win') s.wins++;
      else if (gr.ats_result === 'loss') s.losses++;
      else s.pushes++;
      s.sumAbsErr += gr.abs_error != null ? parseFloat(gr.abs_error) : 0;
      s.sumErr += gr.signed_error != null ? parseFloat(gr.signed_error) : 0;
      s.count++;
      seasonStats.set(gr.model_id, s);
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
      picks_graded_used: grades.length,
      top7,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
