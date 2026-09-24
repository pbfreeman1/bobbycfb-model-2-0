import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

// week is the last graded week; writes the weights snapshot used for week + 1.
// week=0 builds the Week 1 snapshot from the full prior season.
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week = parseInt(searchParams.get('week') || '0');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { data, error } = await supabase.rpc('cfb_recalibrate', { p_season: season, p_week: week });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true, rows: data });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
