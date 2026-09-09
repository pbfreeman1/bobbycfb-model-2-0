import { createClient } from '@supabase/supabase-js';
import { matchKey } from '../../../lib/team-match';

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
    // 1. Fetch CFBD scores for the week
    const res = await fetch(
      `https://api.collegefootballdata.com/games?year=${season}&week=${week}&seasonType=regular`,
      { headers: { Authorization: `Bearer ${cfbdKey}` } }
    );
    if (!res.ok) return Response.json({ error: `CFBD error ${res.status}` }, { status: 502 });
    const cfbdGames = await res.json();

    // 2. Pull our own games for the week and index them by normalized name key.
    //    Matching in-memory (rather than per-row .ilike() calls) lets us use
    //    the same normalization on both sides and report exactly what failed.
    const { data: dbGames, error: dbGamesErr } = await supabase
      .from('games')
      .select('id, home_team, away_team, current_line')
      .eq('season', season)
      .eq('week', week);
    if (dbGamesErr) return Response.json({ error: dbGamesErr.message }, { status: 500 });

    const dbByKey = new Map();
    for (const g of dbGames || []) {
      dbByKey.set(matchKey(g.home_team, g.away_team), g);
    }

    let gamesMatched = 0;
    let gamesMarkedFinal = 0;
    let metricsGraded = 0;
    let picksGraded = 0;
    let modelPicksGraded = 0;
    const unmatched = [];
    const modelGradeRows = []; // batched and upserted once at the end

    for (const g of cfbdGames) {
      const key = matchKey(g.homeTeam, g.awayTeam);
      const dbGame = dbByKey.get(key);

      if (!dbGame) {
        // Only worth reporting completed games we expected to grade
        if (g.homePoints != null && g.awayPoints != null) {
          unmatched.push({ cfbd_home: g.homeTeam, cfbd_away: g.awayTeam });
        }
        continue;
      }
      gamesMatched++;

      if (g.homePoints == null || g.awayPoints == null) continue; // not final yet
      const margin = (g.homePoints || 0) - (g.awayPoints || 0);

      const { error: updErr } = await supabase
        .from('games')
        .update({
          home_score: g.homePoints,
          away_score: g.awayPoints,
          status: 'final',
          closing_line: g.lines?.[0]?.spread ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbGame.id);
      if (!updErr) gamesMarkedFinal++;

      // 3. Grade EVERY model's raw prediction for this game, not just the
      //    suggested plays - this is what powers the weekly results page and
      //    lets the whole model pool be analyzed, not just qualified plays.
      //    Graded against the same current_line the compute engine used.
      if (dbGame.current_line != null) {
        const vegasLine = parseFloat(dbGame.current_line);
        const { data: gamePreds } = await supabase
          .from('raw_predictions')
          .select('model_id, predicted_margin')
          .eq('game_id', dbGame.id);

        for (const p of gamePreds || []) {
          if (p.predicted_margin == null) continue;
          const predicted = parseFloat(p.predicted_margin);
          let atsResult;
          if (predicted > vegasLine) atsResult = margin > vegasLine ? 'win' : margin < vegasLine ? 'loss' : 'push';
          else if (predicted < vegasLine) atsResult = margin < vegasLine ? 'win' : margin > vegasLine ? 'loss' : 'push';
          else atsResult = 'push';
          const signedErr = predicted - margin;

          modelGradeRows.push({
            model_id: p.model_id,
            game_id: dbGame.id,
            season,
            week,
            predicted_margin: predicted,
            vegas_line: vegasLine,
            actual_margin: margin,
            ats_result: atsResult,
            abs_error: parseFloat(Math.abs(signedErr).toFixed(2)),
            signed_error: parseFloat(signedErr.toFixed(2)),
            graded_at: new Date().toISOString(),
          });
        }
      }

      // 4. Grade game_metrics suggested plays for THIS game (using our own
      //    internal game id, not CFBD's g.id).
      const { data: metrics } = await supabase
        .from('game_metrics')
        .select('id, suggested_side, suggested_line, consensus_spread, vegas_line')
        .eq('game_id', dbGame.id)
        .eq('suggested_play', true);

      for (const m of metrics || []) {
        const lineAdj = m.suggested_side === 'home'
          ? margin + (m.suggested_line || 0)
          : -margin + Math.abs(m.suggested_line || 0);

        const atsResult = lineAdj > 0 ? 'win' : lineAdj < 0 ? 'loss' : 'push';
        const clv = (m.vegas_line || 0) - (g.lines?.[0]?.spread || m.vegas_line || 0);
        const consensusErr = (m.consensus_spread || 0) - margin;

        await supabase.from('pick_grades').upsert({
          game_metrics_id: m.id,
          ats_result: atsResult,
          ats_margin: parseFloat(lineAdj.toFixed(2)),
          consensus_error: parseFloat(consensusErr.toFixed(2)),
          clv: parseFloat(clv.toFixed(2)),
          graded_at: new Date().toISOString(),
        }, { onConflict: 'game_metrics_id' });

        metricsGraded++;
      }

      // 5. Grade user_picks for this game
      const { data: picks } = await supabase.from('user_picks').select('*').eq('game_id', dbGame.id);
      for (const p of picks || []) {
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
        picksGraded++;
      }
    }

    // Batch upsert all individual model grades, chunked to stay well under
    // PostgREST payload limits (a full week can be ~2,000+ rows: 43 games x ~50 models).
    const CHUNK = 500;
    for (let i = 0; i < modelGradeRows.length; i += CHUNK) {
      const chunk = modelGradeRows.slice(i, i + CHUNK);
      const { error: mgErr } = await supabase.from('model_pick_grades').upsert(chunk, { onConflict: 'model_id,game_id' });
      if (!mgErr) modelPicksGraded += chunk.length;
    }

    return Response.json({
      cfbd_games: cfbdGames.length,
      games_matched: gamesMatched,
      games_marked_final: gamesMarkedFinal,
      model_picks_graded: modelPicksGraded,
      metrics_graded: metricsGraded,
      picks_graded: picksGraded,
      unmatched, // any completed CFBD game we couldn't match to our games table
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
