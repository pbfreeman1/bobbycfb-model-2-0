// CFB grading for one week, lifted out of app/api/grade/route.js so the manual
// Ingest button and the daily cron run the same code.
//
// IDEMPOTENT BY CONSTRUCTION. Every write is an update keyed on a row's own id
// or an upsert on a natural key, so re-running a week rewrites the same values:
//   games                 update by id, only when CFBD reports both scores
//   model_pick_grades     upsert on (model_id, game_id)
//   pick_grades           upsert on (game_metrics_id)
//   user_picks            update by id
// A game CFBD has not finished is skipped before any write, so grading the
// current week mid-slate touches only the games that are actually final.
//
// games.actual_margin is NOT written here — the database derives it from the
// scores (all 323 final 2026 games have it set, none are missing it), and
// cfb_recalibrate and cfb_current_week both key off that column.

import { gradeAgainstScore } from './bet-types.js';
import { matchKey } from './team-match.js';

export class GradeError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'GradeError';
    this.status = status;
  }
}

// Returns { cfbd_games, games_matched, games_marked_final, model_picks_graded,
//           metrics_graded, picks_graded, unmatched }.
export async function gradeWeek({ supabase, season, week, cfbdKey }) {
  if (!cfbdKey) throw new GradeError('CFBD_API_KEY not set', 500);

  const seasonInt = parseInt(season, 10);
  const weekInt = parseInt(week, 10);

  const res = await fetch(
    `https://api.collegefootballdata.com/games?year=${seasonInt}&week=${weekInt}&seasonType=regular`,
    { headers: { Authorization: `Bearer ${cfbdKey}` } }
  );
  if (!res.ok) throw new GradeError(`CFBD error ${res.status}`, 502);
  const cfbdGames = await res.json();

  // Matching in-memory (rather than per-row .ilike() calls) lets the same
  // normalization run on both sides and reports exactly what failed.
  const { data: dbGames, error: dbGamesErr } = await supabase
    .from('games')
    .select('id, home_team, away_team, current_line')
    .eq('season', seasonInt)
    .eq('week', weekInt);
  if (dbGamesErr) throw new GradeError(dbGamesErr.message, 500);

  const dbByKey = new Map();
  for (const g of dbGames || []) dbByKey.set(matchKey(g.home_team, g.away_team), g);

  let gamesMatched = 0;
  let gamesMarkedFinal = 0;
  let metricsGraded = 0;
  let picksGraded = 0;
  let modelPicksGraded = 0;
  const unmatched = [];
  const modelGradeRows = [];

  for (const g of cfbdGames) {
    const dbGame = dbByKey.get(matchKey(g.homeTeam, g.awayTeam));

    if (!dbGame) {
      // Only worth reporting completed games we expected to grade.
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

    // Grade EVERY model's raw prediction, not just the suggested plays — this
    // powers the weekly results page and lets the whole model pool be
    // analyzed. Graded against the same current_line the compute engine used.
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
          season: seasonInt,
          week: weekInt,
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

    // Grade the consensus pick for EVERY game, not just the qualified subset,
    // so the results page can check whether confidence bins and edge size are
    // actually calibrated.
    const { data: metrics } = await supabase
      .from('game_metrics')
      .select('id, edge, consensus_spread, vegas_line, suggested_play, mss, confidence_bin')
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

      await supabase.from('pick_grades').upsert({
        game_metrics_id: m.id,
        ats_result: atsResult,
        ats_margin: parseFloat(atsMargin.toFixed(2)),
        consensus_error: parseFloat(consensusErr.toFixed(2)),
        clv: parseFloat(clv.toFixed(2)),
        graded_at: new Date().toISOString(),
      }, { onConflict: 'game_metrics_id' });

      metricsGraded++;
    }

    // Custom picks are logged only; their result is set by hand in My card.
    // gradeAgainstScore holds the single rule for every auto-graded type.
    const { data: picks } = await supabase.from('user_picks').select('*').eq('game_id', dbGame.id);
    for (const p of picks || []) {
      const result = gradeAgainstScore(p, g.homePoints, g.awayPoints);
      if (!p.played || result === null) continue;
      await supabase.from('user_picks').update({ result, updated_at: new Date().toISOString() }).eq('id', p.id);
      picksGraded++;
    }
  }

  // Chunked to stay well under PostgREST payload limits: a full week can be
  // ~2,000+ rows (43 games x ~50 models).
  const CHUNK = 500;
  for (let i = 0; i < modelGradeRows.length; i += CHUNK) {
    const chunk = modelGradeRows.slice(i, i + CHUNK);
    const { error: mgErr } = await supabase
      .from('model_pick_grades')
      .upsert(chunk, { onConflict: 'model_id,game_id' });
    if (!mgErr) modelPicksGraded += chunk.length;
  }

  return {
    cfbd_games: cfbdGames.length,
    games_matched: gamesMatched,
    games_marked_final: gamesMarkedFinal,
    model_picks_graded: modelPicksGraded,
    metrics_graded: metricsGraded,
    picks_graded: picksGraded,
    unmatched,
  };
}
