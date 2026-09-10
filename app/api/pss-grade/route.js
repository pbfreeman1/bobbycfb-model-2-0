import { createClient } from '@supabase/supabase-js';
import { matchKey } from '../../../lib/team-match';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Grades BobbyPSSModel picks after games go final. Independent of /api/grade
// (the original model's grading route) — reads its own CFBD scores pass and
// writes only to pss_pick_grades / pss_user_picks / games (score fields are
// shared and idempotent to update from either pipeline).
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '2026');
  const week = parseInt(searchParams.get('week') || '1');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const cfbdKey = process.env.CFBD_API_KEY;
  if (!cfbdKey) return Response.json({ error: 'CFBD_API_KEY not set' }, { status: 500 });

  try {
    const res = await fetch(
      `https://api.collegefootballdata.com/games?year=${season}&week=${week}&seasonType=regular`,
      { headers: { Authorization: `Bearer ${cfbdKey}` } }
    );
    if (!res.ok) return Response.json({ error: `CFBD error ${res.status}` }, { status: 502 });
    const cfbdGames = await res.json();

    const { data: dbGames, error: dbGamesErr } = await supabase
      .from('games')
      .select('id, home_team, away_team, current_line')
      .eq('season', season)
      .eq('week', week);
    if (dbGamesErr) return Response.json({ error: dbGamesErr.message }, { status: 500 });

    const dbByKey = new Map();
    for (const g of dbGames || []) dbByKey.set(matchKey(g.home_team, g.away_team), g);

    let gamesMatched = 0, metricsGraded = 0, picksGraded = 0;
    const unmatched = [];

    for (const g of cfbdGames) {
      const key = matchKey(g.homeTeam, g.awayTeam);
      const dbGame = dbByKey.get(key);
      if (!dbGame) {
        if (g.homePoints != null && g.awayPoints != null) {
          unmatched.push({ cfbd_home: g.homeTeam, cfbd_away: g.awayTeam });
        }
        continue;
      }
      gamesMatched++;
      if (g.homePoints == null || g.awayPoints == null) continue;
      const margin = (g.homePoints || 0) - (g.awayPoints || 0);

      // games.home_score/away_score/status are shared fields the original
      // grading route also writes — safe to (idempotently) confirm here too
      // in case PSS grading runs before the original pipeline's grade step.
      await supabase.from('games').update({
        home_score: g.homePoints,
        away_score: g.awayPoints,
        status: 'final',
        closing_line: g.lines?.[0]?.spread ?? null,
        updated_at: new Date().toISOString(),
      }).eq('id', dbGame.id);

      // Grade the PSS consensus pick for every game this week (not just qualifying plays).
      const { data: metrics } = await supabase
        .from('pss_game_metrics')
        .select('id, edge, consensus_spread, vegas_line')
        .eq('game_id', dbGame.id);

      for (const m of metrics || []) {
        if (m.vegas_line == null || m.edge == null) continue;
        const vegasLine = parseFloat(m.vegas_line);
        const edge = parseFloat(m.edge);
        const pickSide = edge > 0 ? 'home' : 'away';

        const atsResult = pickSide === 'home'
          ? (margin > vegasLine ? 'win' : margin < vegasLine ? 'loss' : 'push')
          : (margin < vegasLine ? 'win' : margin > vegasLine ? 'loss' : 'push');
        const atsMargin = pickSide === 'home' ? margin - vegasLine : vegasLine - margin;
        const clv = vegasLine - (g.lines?.[0]?.spread ?? vegasLine);
        const consensusErr = (m.consensus_spread || 0) - margin;

        await supabase.from('pss_pick_grades').upsert({
          pss_game_metrics_id: m.id,
          ats_result: atsResult,
          ats_margin: parseFloat(atsMargin.toFixed(2)),
          consensus_error: parseFloat(consensusErr.toFixed(2)),
          clv: parseFloat(clv.toFixed(2)),
          graded_at: new Date().toISOString(),
        }, { onConflict: 'pss_game_metrics_id' });

        metricsGraded++;
      }

      // Grade pss_user_picks for this game
      const { data: picks } = await supabase.from('pss_user_picks').select('*').eq('game_id', dbGame.id);
      for (const p of picks || []) {
        if (!p.played || p.is_custom) continue;
        const linePlayed = p.line_played != null ? parseFloat(p.line_played) : 0;
        let atsMargin;
        if (p.pick_type === 'total') {
          const total = (g.homePoints || 0) + (g.awayPoints || 0);
          atsMargin = p.side === 'over' ? total - linePlayed : linePlayed - total;
        } else {
          atsMargin = p.side === 'home' ? margin - linePlayed : -margin + -linePlayed;
        }
        const result = atsMargin > 0 ? 'win' : atsMargin < 0 ? 'loss' : 'push';
        await supabase.from('pss_user_picks').update({ result, updated_at: new Date().toISOString() }).eq('id', p.id);
        picksGraded++;
      }
    }

    return Response.json({
      cfbd_games: cfbdGames.length,
      games_matched: gamesMatched,
      metrics_graded: metricsGraded,
      picks_graded: picksGraded,
      unmatched,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
