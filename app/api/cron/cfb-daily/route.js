import { syncLines } from '../../../../lib/cfb-lines';
import { gradeWeek } from '../../../../lib/cfb-grade';
import {
  fetchPtCsv, buildPtPayload, resolveSeason, serviceClient, alertOnAttention, PtError,
} from '../../../../lib/pt-fetch';
import { guard } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
// 60s is the Hobby ceiling. This is the tightest constraint on the whole job:
// grading walks each game in a week with several sequential round trips apiece,
// and step 3 does TWO weeks. If the run times out inside grading, steps 4 and 5
// never happen at all, so a slow CFBD day silently costs the day's compute
// rather than just the day's grades.
//
// Nothing is corrupted by that — every step is idempotent and the next run
// repeats the work — but if timeouts show up in the Vercel log, raise this to
// 300 (Pro) or split grading into its own cron ordered before this one.
export const maxDuration = 60;
// Reads a file that changes during the day; a cached response would re-ingest
// this morning's numbers tonight.
export const dynamic = 'force-dynamic';

// THE DAILY CFB JOB. One route, five steps, in this order:
//
//   1. resolve the week    cfb_current_week
//   2. sync lines          lib/cfb-lines (the logic behind /api/cfbd-sync)
//   3. grade               lib/cfb-grade (the logic behind /api/grade)
//   4. ingest predictions  cfb_ingest_predictions
//   5. refresh             cfb_refresh
//
// WHY THE ORDER IS THE WHOLE POINT. cfb_compute reads games.current_line as its
// line snapshot and cfb_recalibrate weights systems from graded games. Running
// the ingest and refresh without steps 2 and 3 first recomputes the week
// against a stale line and stale weights — which is exactly what a cron on
// /api/cron/pt-ingest alone would do.
//
// Steps 2 and 3 call shared library functions, NOT this app's own HTTP routes.
// A serverless function calling back into its own deployment would need the
// credential, the absolute URL and a second cold start per step, and would fail
// differently in local dev. The manual Ingest page still drives the same code
// through /api/cfbd-sync and /api/grade.
//
//   GET /api/cron/cfb-daily          run all five steps
//   GET /api/cron/cfb-daily?dry=1    report the plan for each step, write nothing
//   GET /api/cron/cfb-daily?season=2026
//
// GET because Vercel Cron only issues GET; guard() still requires Bearer
// CRON_SECRET or admin Basic, and fails closed without ADMIN_USER /
// ADMIN_PASSWORD.
export async function GET(req) {
  const denied = await guard(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const dry = searchParams.get('dry') === '1';
  const season = resolveSeason(searchParams.get('season'));
  if (!Number.isInteger(season)) {
    return Response.json({ error: 'season must be an integer, e.g. ?season=2026' }, { status: 400 });
  }

  const startedAt = new Date().toISOString();
  const steps = [];
  // A step the caller must see as a failed run: lines (2), ingest (4) or
  // refresh (5). Grading is tracked separately — see `degraded`.
  let blocked = null;
  let degraded = false;

  const step = (name, ok, detail) => {
    steps.push({ step: name, ok, detail });
    return ok;
  };

  try {
    const supabase = serviceClient();
    const cfbdKey = process.env.CFBD_API_KEY;

    // --- 1. resolve the week ----------------------------------------------
    const { data: wk, error: wkErr } = await supabase.rpc('cfb_current_week', { p_season: season });
    if (wkErr) {
      step('resolve_week', false, { error: wkErr.message });
      return respond(500, { season, started_at: startedAt, dry, status: 'failed', steps });
    }

    const currentWeek = wk?.current_week ?? null;
    const previousWeek = wk?.previous_week ?? null;

    if (currentWeek == null) {
      // No game left to kick off: the season is over, or the schedule has not
      // been loaded. Nothing to compute, and not an error.
      step('resolve_week', true, { ...wk, note: 'no upcoming games' });
      return respond(200, {
        season, started_at: startedAt, dry, status: 'no_upcoming_games', steps,
      });
    }
    step('resolve_week', true, wk);

    // Grade the previous week (late finishers) and the current week (Tue–Thu
    // games finish before the main slate). Week 0 or lower does not exist.
    const gradeWeeks = [previousWeek, currentWeek].filter((w) => Number.isInteger(w) && w >= 1);

    // --- dry run: report the plan, write nothing --------------------------
    if (dry) {
      let ptPlan;
      try {
        const { built, report } = buildPtPayload(await fetchPtCsv());
        ptPlan = { ...report, would_send_rows: built.rows.length, sample_row: built.rows[0] };
        step('sync_lines', true, { would_sync_week: currentWeek, note: 'not run (dry)' });
        step('grade', true, { would_grade_weeks: gradeWeeks, note: 'not run (dry)' });
        step('ingest_predictions', true, { ...ptPlan, note: 'parsed only, no RPC call' });
        step('refresh', true, { would_call: 'cfb_refresh', p_season: season, p_recalibrate: true, note: 'not run (dry)' });
      } catch (e) {
        const msg = e instanceof PtError ? e.message : String(e?.message || e);
        step('sync_lines', true, { would_sync_week: currentWeek, note: 'not run (dry)' });
        step('grade', true, { would_grade_weeks: gradeWeeks, note: 'not run (dry)' });
        step('ingest_predictions', false, { error: msg });
        step('refresh', false, { note: 'would be skipped: the predictiontracker file is unusable' });
        return respond(502, { season, started_at: startedAt, dry: true, status: 'failed', steps });
      }
      return respond(200, {
        season, started_at: startedAt, dry: true, status: 'plan_ok',
        current_week: currentWeek, grade_weeks: gradeWeeks, steps,
      });
    }

    // --- 2. sync lines for the current week -------------------------------
    try {
      const lines = await syncLines({ supabase, season, week: currentWeek, cfbdKey });
      step('sync_lines', true, { week: currentWeek, ...lines });
    } catch (e) {
      blocked = blocked || 'sync_lines';
      step('sync_lines', false, { week: currentWeek, error: String(e?.message || e) });
    }

    // --- 3. grade previous + current week ---------------------------------
    // Non-blocking by design: stale results make the NEXT recalibration stale,
    // but they do not corrupt this week's compute, so a CFBD scores outage
    // should not also cost us the ingest.
    for (const w of gradeWeeks) {
      try {
        const graded = await gradeWeek({ supabase, season, week: w, cfbdKey });
        step(`grade_week_${w}`, true, graded);
      } catch (e) {
        degraded = true;
        step(`grade_week_${w}`, false, { error: String(e?.message || e) });
      }
    }

    // --- 4. ingest predictions --------------------------------------------
    let ingest = null;
    let ptReport = null;
    try {
      const { built, report } = buildPtPayload(await fetchPtCsv());
      ptReport = report;
      const { data, error } = await supabase.rpc('cfb_ingest_predictions', {
        p_season: season,
        p_rows: built.rows,
        p_backfill: false,
      });
      if (error) throw new Error(`cfb_ingest_predictions failed: ${error.message}`);
      ingest = data;
      step('ingest_predictions', true, { ...report, ingest: data });
      alertOnAttention({
        season,
        unmatched: data?.unmatched ?? [],
        newColumns: data?.new_columns ?? [],
        blank: report.columns_blank_this_pull,
      });
    } catch (e) {
      blocked = blocked || 'ingest_predictions';
      step('ingest_predictions', false, { ...(ptReport || {}), error: String(e?.message || e) });
    }

    // --- 5. refresh --------------------------------------------------------
    // Skipped when the line sync or the ingest failed: recomputing the week off
    // a stale line, or off predictions that did not land, writes signals that
    // look current and are not.
    if (blocked) {
      step('refresh', false, { skipped: true, because: `${blocked} failed` });
    } else {
      const { data: refresh, error: refreshErr } = await supabase.rpc('cfb_refresh', {
        p_season: season,
        p_recalibrate: true,
      });
      if (refreshErr) {
        blocked = 'refresh';
        step('refresh', false, { error: refreshErr.message });
      } else {
        step('refresh', true, refresh);
      }
    }

    const status = blocked ? 'failed' : degraded ? 'degraded' : 'ok';
    if (degraded && !blocked) {
      // Grading failures do not fail the run, so say so loudly in the log —
      // otherwise a week of silent CFBD outages would only show up as weights
      // that stopped moving.
      console.error(`[cfb-daily ${season}] DEGRADED — grading failed; predictions and compute still ran.`);
    }

    return respond(blocked ? 500 : 200, {
      season,
      started_at: startedAt,
      dry: false,
      status,
      degraded,
      current_week: currentWeek,
      grade_weeks: gradeWeeks,
      unmatched: ingest?.unmatched ?? [],
      new_columns: ingest?.new_columns ?? [],
      steps,
    });
  } catch (e) {
    const status = e instanceof PtError ? e.status : 500;
    step('unhandled', false, { error: String(e?.message || e) });
    return respond(status, { season, started_at: startedAt, dry, status: 'failed', steps });
  }
}

function respond(httpStatus, body) {
  if (httpStatus >= 400) {
    const failed = (body.steps || []).filter((s) => !s.ok).map((s) => s.step);
    console.error(`[cfb-daily] run failed; steps: ${failed.join(', ') || 'unknown'}`);
  }
  return Response.json(body, { status: httpStatus });
}
