import { gradeWeek, GradeError } from '../../../lib/cfb-grade';
import { serviceClient } from '../../../lib/pt-fetch';
import { guard } from '../../../lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Grades one CFB week from CFBD scores, driven by the Ingest page.
// The logic lives in lib/cfb-grade.js so /api/cron/cfb-daily runs exactly the
// same code rather than a second copy that can drift.
export async function POST(req) {
  // Admin gate. Also enforced by middleware.js; repeated here so the
  // route stays closed if the matcher is ever narrowed.
  const denied = await guard(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week   = parseInt(searchParams.get('week')   || '1');

  try {
    // serviceClient() falls back to the project URL in lib/supabase.js when
    // NEXT_PUBLIC_SUPABASE_URL is absent (it is set in Vercel but not in
    // .env.local), and is constructed INSIDE the try so a missing key is
    // reported as JSON rather than an empty 500.
    const supabase = serviceClient();
    const result = await gradeWeek({
      supabase,
      season,
      week,
      cfbdKey: process.env.CFBD_API_KEY,
    });
    return Response.json(result);
  } catch (e) {
    const status = e instanceof GradeError ? e.status : 500;
    return Response.json({ error: e.message }, { status });
  }
}
