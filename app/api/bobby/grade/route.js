import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week = parseInt(searchParams.get('week') || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { data: signals, error: sErr } = await supabase
      .from('cfb_game_signals')
      .select('game_id, games(status)')
      .eq('season', season)
      .eq('week', week);
    if (sErr) throw new Error(`cfb_game_signals: ${sErr.message}`);

    const notFinal = (signals || []).filter((s) => s.games?.status !== 'final');
    if (notFinal.length > 0) {
      return Response.json(
        { ok: false, error: `${notFinal.length} game(s) in season ${season} week ${week} are not final yet.` },
        { status: 400 }
      );
    }

    const { data, error } = await supabase.rpc('cfb_grade', { p_season: season, p_week: week });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true, rows: data });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
