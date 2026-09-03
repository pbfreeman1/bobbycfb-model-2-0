import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week   = parseInt(searchParams.get('week')   || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const cfbdKey = process.env.CFBD_API_KEY;
  if (!cfbdKey) return Response.json({ error: 'CFBD_API_KEY not set' }, { status: 500 });

  try {
    // 1. Fetch scores from CFBD
    const res = await fetch(
      `https://api.collegefootballdata.com/games?year=${season}&week=${week}&seasonType=regular`,
      { headers: { Authorization: `Bearer ${cfbdKey}` } }
    );
    if (!res.ok) return Response.json({ error: `CFBD error ${res.status}` }, { status: 502 });
    const cfbdGames = await res.json();

    // 2. Update games with scores and status
    let graded = 0;
    for (const g of cfbdGames) {
      if (g.homePoints == null || g.awayPoints == null) continue;
      const margin = (g.homePoints || 0) - (g.awayPoints || 0);

      await supabase
        .from('games')
        .update({
          home_score: g.homePoints,
          away_score: g.awayPoints,
          status: 'final',
          closing_line: g.lines?.[0]?.spread ?? null,
          updated_at: new Date().toISOString(),
        })
        .ilike('home_team', g.homeTeam)
        .ilike('away_team', g.awayTeam)
        .eq('season', season)
        .eq('week', week);

      // 3. Grade game_metrics that are suggested plays
      const { data: metrics } = await supabase
        .from('game_metrics')
        .select('id, suggested_side, suggested_line, consensus_spread, vegas_line')
        .eq('game_id', g.id)
        .eq('suggested_play', true);

      for (const m of (metrics || [])) {
        // ATS result from the suggested_side perspective
        // Positive spread = home favored; we take `suggested_side`
        const lineAdj = m.suggested_side === 'home'
          ? margin + (m.suggested_line || 0)   // home covers if margin > suggested_line
          : -margin + Math.abs(m.suggested_line || 0);

        const atsResult = lineAdj > 0 ? 'win' : lineAdj < 0 ? 'loss' : 'push';
        const atsMargin = lineAdj;
        const clv = (m.vegas_line || 0) - (g.lines?.[0]?.spread || m.vegas_line || 0);
        const consensusErr = (m.consensus_spread || 0) - margin;

        await supabase.from('pick_grades').upsert({
          game_metrics_id: m.id,
          ats_result: atsResult,
          ats_margin: parseFloat(atsMargin.toFixed(2)),
          consensus_error: parseFloat(consensusErr.toFixed(2)),
          clv: parseFloat(clv.toFixed(2)),
          graded_at: new Date().toISOString(),
        }, { onConflict: 'game_metrics_id' });

        graded++;
      }

      // 4. Grade user_picks for this game
      const { data: game } = await supabase.from('games').select('id').ilike('home_team', g.homeTeam).ilike('away_team', g.awayTeam).eq('season', season).eq('week', week).single();
      if (game) {
        const { data: picks } = await supabase.from('user_picks').select('*').eq('game_id', game.id);
        for (const p of (picks || [])) {
          if (!p.played || p.is_custom) continue;
          const linePlayed = p.line_played != null ? parseFloat(p.line_played) : 0;
          let atsMargin;
          if (p.pick_type === 'total') {
            const total = (g.homePoints || 0) + (g.awayPoints || 0);
            atsMargin = p.side === 'over' ? total - linePlayed : linePlayed - total;
          } else {
            atsMargin = p.side === 'home' ? margin - linePlayed : -margin + (-linePlayed);
          }
          const result = atsMargin > 0 ? 'win' : atsMargin < 0 ? 'loss' : 'push';
          await supabase.from('user_picks').update({ result, updated_at: new Date().toISOString() }).eq('id', p.id);
        }
      }
    }

    return Response.json({ graded });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
