import { createClient } from '@supabase/supabase-js';
import {
  seasonSlates, buildTeamResolver, fetchNormalizedSlate, THROTTLE_MS, sleep,
} from '../../../../lib/espn';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Syncs NFL schedule, kickoff (UTC), broadcast network and finals from ESPN's
// public scoreboard into nfl_games. Idempotent: every write is an upsert keyed
// on nfl_games_unique (season, week, home_team, away_team), so re-running a week
// fills gaps and refreshes scores without duplicating rows.
//
//   POST /api/nfl/espn-sync?season=2026            all weeks, creating rows
//   POST /api/nfl/espn-sync?season=2026&week=4     one week
//   POST /api/nfl/espn-sync?season=2024&create=false
//
// `create=false` is the archive mode: it updates existing rows only and never
// inserts. The 2021-2025 rows came from predictiontracker and are the spine the
// 63,133 predictions hang off; ESPN's slate can differ from ours on neutral-site
// and relocated games, and inserting on a name mismatch would silently fork a
// game into two rows.
//
// `from_week` makes the backfill resumable: a run that times out can be
// restarted where it stopped rather than re-walking the season.
export async function POST(req) {
  const { searchParams } = new URL(req.url);
  const season = parseInt(searchParams.get('season') || '', 10);
  const weekParam = searchParams.get('week');
  const fromWeek = parseInt(searchParams.get('from_week') || '0', 10);
  const create = searchParams.get('create') !== 'false';

  if (!Number.isInteger(season)) {
    return Response.json({ error: 'season is required, e.g. ?season=2026' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let runId = null;
  try {
    const { data: teams, error: tErr } = await supabase
      .from('nfl_teams').select('name, abbr, aliases');
    if (tErr) throw new Error(`nfl_teams: ${tErr.message}`);
    if (!teams?.length) throw new Error('nfl_teams is empty — run the nfl_bobby_schema migration first.');
    const resolve = buildTeamResolver(teams);

    const { data: runRow } = await supabase
      .from('nfl_bobby_runs')
      .insert({ kind: 'ingest', season, week: weekParam ? parseInt(weekParam, 10) : null,
                actor: 'espn-sync', detail: { create, from_week: fromWeek || null } })
      .select('id').single();
    runId = runRow?.id ?? null;

    let slates = seasonSlates(season);
    if (weekParam) {
      const w = parseInt(weekParam, 10);
      slates = slates.filter((s) => s.week === w);
      if (!slates.length) return Response.json({ error: `week ${w} is not an NFL week` }, { status: 400 });
    } else if (fromWeek) {
      slates = slates.filter((s) => s.week >= fromWeek);
    }

    // Existing rows, so archive mode can match rather than insert. Paginated:
    // a season is ~285 rows, well under 1,000, but this runs per season and the
    // habit costs nothing.
    const existing = new Map();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('nfl_games')
        .select('id, week, home_team, away_team')
        .eq('season', season)
        .range(from, from + 999);
      if (error) throw new Error(`nfl_games: ${error.message}`);
      for (const g of data || []) existing.set(`${g.week}|${g.home_team}|${g.away_team}`, g.id);
      if (!data || data.length < 1000) break;
    }

    const perWeek = [];
    const unmatched = [];
    const unresolved = [];
    let inserted = 0, updated = 0, seen = 0, lastWeek = null;

    for (const slate of slates) {
      const games = await fetchNormalizedSlate({ ...slate, resolve });
      let wInserted = 0, wUpdated = 0;

      for (const g of games) {
        seen++;
        if (!g.resolved) {
          // A team name ESPN uses that nfl_teams has no alias for. Reported so
          // an alias can be added rather than guessed at here.
          unresolved.push({ week: g.week, espn: `${g.espn_away} @ ${g.espn_home}`, id: g.source_game_id });
          continue;
        }

        const row = {
          season: g.season, week: g.week, season_type: g.season_type,
          game_date: g.game_date, home_team: g.home_team, away_team: g.away_team,
          neutral_site: g.neutral_site, source_game_id: g.source_game_id,
          completed: g.completed, updated_at: new Date().toISOString(),
        };
        // Never blank a score we already have with an in-progress null.
        if (g.home_score != null) row.home_score = g.home_score;
        if (g.away_score != null) row.away_score = g.away_score;
        if (g.tv_network != null) row.tv_network = g.tv_network;

        const key = `${g.week}|${g.home_team}|${g.away_team}`;
        const existingId = existing.get(key);

        if (existingId) {
          const { error } = await supabase.from('nfl_games').update(row).eq('id', existingId);
          if (error) throw new Error(`update ${key}: ${error.message}`);
          wUpdated++; updated++;
        } else if (create) {
          const { data, error } = await supabase
            .from('nfl_games')
            .upsert(row, { onConflict: 'season,week,home_team,away_team' })
            .select('id').single();
          if (error) throw new Error(`insert ${key}: ${error.message}`);
          existing.set(key, data.id);
          wInserted++; inserted++;
        } else {
          // Archive mode: ESPN has a game we do not. Reported, never created.
          unmatched.push({ week: g.week, matchup: `${g.away_team} @ ${g.home_team}`, kickoff: g.game_date });
        }
      }

      perWeek.push({ week: slate.week, type: slate.label, espn_games: games.length,
                     inserted: wInserted, updated: wUpdated });
      lastWeek = slate.week;
      await sleep(THROTTLE_MS);
    }

    const result = {
      season, create, weeks: perWeek.length, espn_games_seen: seen,
      inserted, updated,
      matched_pct: seen ? Math.round(((inserted + updated) / seen) * 1000) / 10 : null,
      unmatched_count: unmatched.length,
      unresolved_count: unresolved.length,
      unmatched, unresolved, per_week: perWeek,
      resume_hint: lastWeek != null ? `?season=${season}&from_week=${lastWeek}` : null,
    };

    if (runId) {
      await supabase.from('nfl_bobby_runs')
        .update({ rows_written: inserted + updated, finished_at: new Date().toISOString(),
                  ok: true, detail: result })
        .eq('id', runId);
    }
    return Response.json(result);
  } catch (e) {
    if (runId) {
      const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await supa.from('nfl_bobby_runs')
        .update({ finished_at: new Date().toISOString(), ok: false, detail: { error: String(e.message || e) } })
        .eq('id', runId);
    }
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

// Convenience for a browser check; same work, same idempotency.
export const GET = POST;
