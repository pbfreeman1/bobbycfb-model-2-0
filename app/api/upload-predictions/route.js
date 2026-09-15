import { createClient } from '@supabase/supabase-js';
import { matchKey } from '../../../lib/team-match';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Parses a predictiontracker CSV upload and upserts into raw_predictions.
// Replaces the manual "paste SQL into Supabase" step.
// Accepts multipart/form-data with a single field named "file".
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week   = parseInt(searchParams.get('week')   || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Parse the uploaded file from multipart form data
    const formData = await req.formData();
    const file = formData.get('file');
    if (!file) return Response.json({ error: 'No file uploaded. Send a field named "file".' }, { status: 400 });

    const text = await file.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return Response.json({ error: 'CSV appears empty.' }, { status: 400 });

    // Parse header row — handle Windows \r\n line endings
    const headers = lines[0].replace(/\r/g, '').split(',').map(h => h.trim().toLowerCase());
    const roadIdx  = headers.indexOf('road');
    const homeIdx  = headers.indexOf('home');
    const lineIdx  = headers.indexOf('line');
    const openIdx  = headers.indexOf('lineopen');

    if (roadIdx === -1 || homeIdx === -1 || lineIdx === -1) {
      return Response.json({ error: 'CSV missing required columns: road, home, line' }, { status: 400 });
    }

    // Load source_models colname → id map (only include/active systems)
    const { data: models, error: modErr } = await supabase
      .from('source_models')
      .select('id, colname, status');
    if (modErr) throw new Error(`source_models: ${modErr.message}`);

    const modelMap = {}; // colname → { id, status }
    for (const m of models) modelMap[m.colname] = m;

    // Load this week's games indexed by matchKey
    const { data: dbGames, error: gErr } = await supabase
      .from('games')
      .select('id, home_team, away_team')
      .eq('season', season)
      .eq('week', week);
    if (gErr) throw new Error(`games: ${gErr.message}`);

    const gameByKey = new Map();
    for (const g of dbGames || []) gameByKey.set(matchKey(g.home_team, g.away_team), g);

    // Parse CSV rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i].replace(/\r/g, '');
      if (!raw.trim()) continue;
      const cols = raw.split(',');
      const road = cols[roadIdx]?.trim();
      const home = cols[homeIdx]?.trim();
      if (!road || !home) continue;
      rows.push({ road, home, cols });
    }

    let gamesMatched = 0, predictionsWritten = 0, gamesUnmatched = [];
    const openingLineUpdates = [];

    // Columns to skip — not individual model predictions
    const SKIP_COLS = new Set([
      'road', 'home', 'neutral', 'lineavg', 'linestd', 'linemedian',
      'phcover', 'phwin', 'lineca', 'linecons', 'lineopen', 'line',
    ]);

    const rawPredRows = [];

    for (const { road, home, cols } of rows) {
      const key = matchKey(home, road); // home first, road second (away)
      const dbGame = gameByKey.get(key);
      if (!dbGame) {
        gamesUnmatched.push(`${road} @ ${home}`);
        continue;
      }
      gamesMatched++;

      // Store opening line back to games table if present
      if (openIdx !== -1 && cols[openIdx] != null && cols[openIdx].trim() !== '') {
        const openVal = parseFloat(cols[openIdx].trim());
        if (!isNaN(openVal)) {
          openingLineUpdates.push({ id: dbGame.id, opening_line: openVal });
        }
      }

      // Build one raw_predictions row per model column
      for (let ci = 0; ci < headers.length; ci++) {
        const col = headers[ci];
        if (SKIP_COLS.has(col)) continue;

        const model = modelMap[col];
        if (!model) continue; // unknown column
        if (model.status === 'exclude') continue; // explicitly excluded

        const rawVal = cols[ci]?.trim();
        if (!rawVal || rawVal === '' || rawVal.toLowerCase() === 'nan') continue;
        const predicted = parseFloat(rawVal);
        if (isNaN(predicted)) continue;

        rawPredRows.push({
          game_id: dbGame.id,
          model_id: model.id,
          predicted_margin: predicted,
          season,
          week,
          pulled_at: new Date().toISOString(),
        });
      }
    }

    // Write opening lines back to games table
    for (const { id, opening_line } of openingLineUpdates) {
      await supabase.from('games').update({ opening_line }).eq('id', id);
    }

    // Upsert raw_predictions in chunks to stay under PostgREST payload limits
    const CHUNK = 500;
    for (let i = 0; i < rawPredRows.length; i += CHUNK) {
      const chunk = rawPredRows.slice(i, i + CHUNK);
      const { error: rpErr } = await supabase
        .from('raw_predictions')
        .upsert(chunk, { onConflict: 'game_id,model_id' });
      if (rpErr) throw new Error(`raw_predictions upsert: ${rpErr.message}`);
      predictionsWritten += chunk.length;
    }

    return Response.json({
      games_in_csv: rows.length,
      games_matched: gamesMatched,
      predictions_written: predictionsWritten,
      opening_lines_written: openingLineUpdates.length,
      unmatched: gamesUnmatched,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
