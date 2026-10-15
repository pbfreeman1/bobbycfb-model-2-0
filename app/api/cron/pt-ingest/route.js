import {
  fetchPtCsv, buildPtPayload, resolveSeason, serviceClient, alertOnAttention, PtError, PT_URL,
} from '../../../../lib/pt-fetch';
import { guard } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
// The point of this route is to read a file that changes during the day. A
// cached response would re-ingest this morning's numbers tonight.
export const dynamic = 'force-dynamic';

// The predictiontracker ingest on its own, kept for manual use and for
// ?dry=1 inspection. The DAILY CRON is /api/cron/cfb-daily, which runs this
// same work as one step in order after the line sync and grading; this route
// deliberately does NOT refresh lines or results first.
//
//   GET /api/cron/pt-ingest          ingest, then refresh
//   GET /api/cron/pt-ingest?dry=1    fetch and parse only, touches nothing
//   GET /api/cron/pt-ingest?season=2026
//
// GET, unlike the other write routes here, because Vercel Cron only issues GET.
// The write is still gated: middleware.js and guard() both require either
// Bearer CRON_SECRET or admin Basic, and both fail closed when ADMIN_USER /
// ADMIN_PASSWORD are unset. A GET with no credential never reaches the fetch.
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

  try {
    const text = await fetchPtCsv();
    const { built, report } = buildPtPayload(text);
    const parseReport = { season, fetched_at: startedAt, ...report };

    if (dry) {
      return Response.json({
        ok: true,
        dry_run: true,
        note: 'Parsed only. No database call was made.',
        ...parseReport,
        sample_row: built.rows[0],
      });
    }

    const supabase = serviceClient();

    const { data: ingest, error: ingestErr } = await supabase.rpc('cfb_ingest_predictions', {
      p_season: season,
      p_rows: built.rows,
      p_backfill: false,
    });
    if (ingestErr) {
      return fail(500, `cfb_ingest_predictions failed: ${ingestErr.message}`, { ...parseReport, stage: 'ingest' });
    }

    // cfb_refresh throws when the target week has no weights yet. That is a
    // real condition to surface, not to swallow: the predictions ARE ingested
    // at this point, so the response has to say so alongside the failure or the
    // next run would look like the first.
    const { data: refresh, error: refreshErr } = await supabase.rpc('cfb_refresh', {
      p_season: season,
      p_recalibrate: true,
    });

    const unmatched = ingest?.unmatched ?? [];
    const newColumns = ingest?.new_columns ?? [];
    alertOnAttention({ season, unmatched, newColumns, blank: parseReport.columns_blank_this_pull });

    const body = {
      ok: !refreshErr,
      ...parseReport,
      // Passed through whole rather than cherry-picked, so a count is never
      // silently null if the function's return keys are ever renamed.
      ingest: ingest ?? null,
      unmatched,
      new_columns: newColumns,
      refresh: refreshErr ? null : refresh,
    };

    if (refreshErr) {
      return Response.json(
        { ...body, error: `Predictions were ingested, but cfb_refresh failed: ${refreshErr.message}`, stage: 'refresh' },
        { status: 500 }
      );
    }
    return Response.json(body);
  } catch (e) {
    if (e instanceof PtError) return fail(e.status, e.message, { season, dry, ...e.context });
    return fail(500, String(e?.message || e), { season, dry });
  }
}

function fail(status, error, context = {}) {
  console.error(`[pt-ingest] ${error}`);
  return Response.json({ ok: false, error, source: PT_URL, ...context }, { status });
}
