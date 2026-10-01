import { createClient } from '@supabase/supabase-js';
import {
  parseCsv, detectMarket, buildColumnResolver, extractGames, validateAgainstSchedule,
} from '../../../../lib/nfl-csv';
import { buildTeamNameResolver } from '../../../../lib/espn';
import { guard } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Ingests a predictiontracker NFL CSV — spread or totals, detected from the
// header — into nfl_raw_predictions, and writes the line snapshot that CLV
// depends on.
//
//   POST /api/nfl/ingest-predictions?season=2026&week=4          (multipart, field "file")
//   POST /api/nfl/ingest-predictions?season=2026&week=4&dry_run=1
//
// Every write is idempotent:
//   - nfl_raw_predictions upserts on (game_id, model_id, market)
//   - nfl_bobby_lines 'open' is one row per game/market; 'ingest' rows dedupe on
//     (game_id, market, phase, captured_at), so replaying the same file with the
//     same captured_at is a no-op rather than a duplicate snapshot
//   - nfl_games line columns are set from this pull, but NEVER for a game that
//     has already kicked off (the kickoff lock)
//
// WEEK VALIDATION is mandatory and blocking. The current-week spread file has no
// week column, so nothing in the file itself says which week it is. Every
// matchup is checked against the ESPN-sourced schedule for the requested week
// first; if any game belongs to a different week or is not on the schedule at
// all, nothing is written and the mismatches are returned. Loading this week's
// numbers onto last week's games would corrupt both weeks silently.
export async function POST(req) {
  // Admin gate. Also enforced by middleware.js; repeated here so the
  // route stays closed if the matcher is ever narrowed.
  const denied = await guard(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '', 10);
  const week = parseInt(searchParams.get('week') || '', 10);
  const dryRun = searchParams.get('dry_run') === '1';
  const capturedAt = searchParams.get('captured_at') || new Date().toISOString();

  if (!Number.isInteger(season) || !Number.isInteger(week)) {
    return Response.json({ error: 'season and week are required, e.g. ?season=2026&week=4' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let runId = null;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file) return Response.json({ error: 'No file uploaded. Send multipart field "file".' }, { status: 400 });
    const text = await file.text();

    const parsed = parseCsv(text);
    const market = detectMarket(parsed.headers);

    const [{ data: models, error: mErr }, { data: teams, error: tErr }, { data: sched, error: sErr }] =
      await Promise.all([
        supabase.from('nfl_source_models').select('id, model_key, csv_aliases, is_aggregate, is_active'),
        supabase.from('nfl_teams').select('name, abbr, aliases'),
        supabase.from('nfl_games').select('id, week, home_team, away_team, game_date').eq('season', season),
      ]);
    if (mErr) throw new Error(`nfl_source_models: ${mErr.message}`);
    if (tErr) throw new Error(`nfl_teams: ${tErr.message}`);
    if (sErr) throw new Error(`nfl_games: ${sErr.message}`);
    if (!sched?.length) throw new Error(`No nfl_games rows for ${season}. Run the ESPN sync first.`);

    const resolveTeam = buildTeamNameResolver(teams);
    const resolveColumn = buildColumnResolver(models);
    const ex = extractGames(parsed, { market, resolveTeam, resolveColumn, defaultWeek: week });

    // --- blocking validation -------------------------------------------------
    const v = validateAgainstSchedule(ex.games.filter((g) => g.week === week), sched, week);
    const blockers = [];
    if (ex.unresolvedTeams.length) blockers.push(`${ex.unresolvedTeams.length} unresolved team name(s)`);
    if (v.wrongWeek.length) blockers.push(`${v.wrongWeek.length} game(s) belong to another week`);
    if (v.notScheduled.length) blockers.push(`${v.notScheduled.length} game(s) are not on the ${season} schedule`);

    const report = {
      market, season, week, dry_run: dryRun, captured_at: capturedAt,
      csv_rows: parsed.rows.length,
      model_columns: ex.modelCols.length,
      predictions_in_file: ex.games.reduce((a, g) => a + g.preds.length, 0),
      matched_games: v.matched.length,
      validation: {
        ok: v.ok && !ex.unresolvedTeams.length,
        wrong_week: v.wrongWeek,
        not_scheduled: v.notScheduled,
        missing_from_csv: v.missingFromCsv,
        unresolved_teams: ex.unresolvedTeams,
      },
      skipped_columns: ex.skipped,
    };

    if (blockers.length) {
      return Response.json(
        { ...report, error: `Load blocked: ${blockers.join('; ')}. Nothing was written.` },
        { status: 409 }
      );
    }
    if (dryRun) return Response.json({ ...report, note: 'Dry run — nothing written.' });

    const { data: runRow } = await supabase.from('nfl_bobby_runs')
      .insert({ kind: 'ingest', market, season, week, actor: 'ingest page',
                detail: { captured_at: capturedAt, columns: ex.modelCols.length } })
      .select('id').single();
    runId = runRow?.id ?? null;

    const byKey = new Map(sched.map((g) => [`${g.week}|${g.home_team}|${g.away_team}`, g]));
    const now = new Date(capturedAt);

    const predRows = [];
    const lineRows = [];
    const gameUpdates = [];
    let lockedOut = 0;

    for (const g of v.matched) {
      const dbg = byKey.get(`${week}|${g.home}|${g.away}`);
      if (!dbg) continue;

      for (const p of g.preds) {
        predRows.push({ game_id: dbg.id, model_id: p.model_id, market, predicted_line: p.value });
      }

      // The kickoff lock applies to line data as well as to picks: a pull taken
      // after kickoff must not restate the number the game was scored against.
      const kicked = dbg.game_date && new Date(dbg.game_date) <= now;
      if (kicked) { lockedOut++; continue; }

      if (g.open != null) {
        lineRows.push({ game_id: dbg.id, market, phase: 'open', line: g.open,
                        captured_at: capturedAt, source: 'predictiontracker lineopen' });
      }
      if (g.line != null) {
        lineRows.push({ game_id: dbg.id, market, phase: 'ingest', line: g.line,
                        captured_at: capturedAt, source: 'predictiontracker csv' });
        gameUpdates.push({ id: dbg.id, line: g.line, open: g.open });
      }
    }

    // Predictions. Chunked to stay under the PostgREST payload cap.
    let predsWritten = 0;
    for (let i = 0; i < predRows.length; i += 500) {
      const chunk = predRows.slice(i, i + 500);
      const { error } = await supabase.from('nfl_raw_predictions')
        .upsert(chunk, { onConflict: 'game_id,model_id,market' });
      if (error) throw new Error(`nfl_raw_predictions: ${error.message}`);
      predsWritten += chunk.length;
    }

    // Line snapshots. ignoreDuplicates so a replay of the same pull is a no-op:
    // 'open' collides on the one-per-phase index, 'ingest' on the dedupe index.
    let snapshots = 0;
    for (let i = 0; i < lineRows.length; i += 500) {
      const chunk = lineRows.slice(i, i + 500);
      const { error } = await supabase.from('nfl_bobby_lines')
        .upsert(chunk, { onConflict: 'game_id,market,phase,captured_at', ignoreDuplicates: true });
      if (error) throw new Error(`nfl_bobby_lines: ${error.message}`);
      snapshots += chunk.length;
    }

    // nfl_games line columns, from this pull. Kickoff-locked above.
    const lineCol = market === 'total' ? 'total_line' : 'spread_line';
    const openCol = market === 'total' ? 'total_open' : 'spread_open';
    let gamesUpdated = 0;
    for (const u of gameUpdates) {
      const patch = { [lineCol]: u.line, updated_at: new Date().toISOString() };
      if (u.open != null) patch[openCol] = u.open;
      const { error } = await supabase.from('nfl_games').update(patch).eq('id', u.id);
      if (error) throw new Error(`nfl_games ${u.id}: ${error.message}`);
      gamesUpdated++;
    }

    const result = {
      ...report,
      predictions_written: predsWritten,
      line_snapshots_written: snapshots,
      games_line_updated: gamesUpdated,
      games_locked_after_kickoff: lockedOut,
      next_step: `POST /api/nfl/compute?season=${season}&week=${week}&market=${market}`,
    };
    if (runId) {
      await supabase.from('nfl_bobby_runs')
        .update({ rows_written: predsWritten, finished_at: new Date().toISOString(), ok: true, detail: result })
        .eq('id', runId);
    }
    return Response.json(result);
  } catch (e) {
    if (runId) {
      const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await supa.from('nfl_bobby_runs')
        .update({ finished_at: new Date().toISOString(), ok: false, detail: { error: String(e.message || e) } })
        .eq('id', runId);
    }
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
