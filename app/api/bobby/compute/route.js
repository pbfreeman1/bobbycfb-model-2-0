import { createClient } from '@supabase/supabase-js';
import { guard } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  // Admin gate. Also enforced by middleware.js; repeated here so the
  // route stays closed if the matcher is ever narrowed.
  const denied = await guard(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week = parseInt(searchParams.get('week') || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { data, error } = await supabase.rpc('cfb_compute', { p_season: season, p_week: week });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true, rows: data });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
