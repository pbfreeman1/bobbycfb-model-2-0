import { createClient } from '@supabase/supabase-js';
import { matchKey } from '../../../lib/team-match';

export const runtime = 'nodejs';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const season = searchParams.get('season') || '2026';
  const week = searchParams.get('week') || '1';

  const apiKey = process.env.CFBD_API_KEY;
  if (!apiKey) return Response.json({ error: 'CFBD_API_KEY not set' }, { status: 500 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  try {
    const [gamesRes, mediaRes, linesRes] = await Promise.all([
      fetch(`https://api.collegefootballdata.com/games?year=${season}&week=${week}&seasonType=regular&division=fbs`, { headers }),
      fetch(`https://api.collegefootballdata.com/games/media?year=${season}&week=${week}&seasonType=regular`, { headers }),
      fetch(`https://api.collegefootballdata.com/lines?year=${season}&week=${week}&seasonType=regular`, { headers }),
    ]);

    if (!gamesRes.ok) return Response.json({ error: `CFBD games error ${gamesRes.status}` }, { status: 502 });

    const cfbdGames = await gamesRes.json();
    const mediaData = mediaRes.ok ? await mediaRes.json() : [];
    const linesData = linesRes.ok ? await linesRes.json() : [];

    // Build lookup maps (CFBD-to-CFBD keys, so raw strings are fine here)
    const mediaByName = {};
    for (const m of mediaData) {
      const key = `${m.homeTeam}|${m.awayTeam}`;
      if (!mediaByName[key]) mediaByName[key] = m.outlet || m.network || null;
    }

    const linesByName = {};
    const openLineByName = {};
    for (const l of linesData) {
      const key = `${l.homeTeam}|${l.awayTeam}`;
      const withOU = (l.lines || []).find(x => x.overUnder != null);
      if (withOU) linesByName[key] = withOU.overUnder;
      // Capture opening line for CLV tracking — prefer consensus provider
      const lineEntry = (l.lines || []).find(x => x.provider === 'consensus') || l.lines?.[0];
      if (lineEntry?.spreadOpen != null) {
        // CFBD uses negative = home favored; we use positive = home favored
        openLineByName[key] = -parseFloat(lineEntry.spreadOpen);
      }
      if (lineEntry?.spread != null) {
        // Store current line too (negative = home favored → negate)
        if (!linesByName[`current|${key}`]) {
          linesByName[`current|${key}`] = -parseFloat(lineEntry.spread);
        }
      }
    }

    // Load existing games for this week
    const { data: dbGames, error: dbGamesErr } = await supabase
      .from('games')
      .select('id, home_team, away_team')
      .eq('season', parseInt(season))
      .eq('week', parseInt(week));
    if (dbGamesErr) return Response.json({ error: dbGamesErr.message }, { status: 500 });

    const dbByKey = new Map();
    for (const g of dbGames || []) dbByKey.set(matchKey(g.home_team, g.away_team), g);

    let updated = 0, inserted = 0;
    const unmatched = [];

    for (const g of cfbdGames) {
      const rawKey = `${g.homeTeam}|${g.awayTeam}`;
      const dbGame = dbByKey.get(matchKey(g.homeTeam, g.awayTeam));

      const kickoff = g.startDate && !g.startTimeTBD ? g.startDate : null;
      const tv = mediaByName[rawKey] || null;
      const ou = linesByName[rawKey] ?? null;
      const openingLine = openLineByName[rawKey] ?? null;
      const currentLine = linesByName[`current|${rawKey}`] ?? null;

      if (dbGame) {
        // Game already exists — update metadata
        const { error } = await supabase
          .from('games')
          .update({
            kickoff_at: kickoff,
            tv_network: tv,
            over_under: ou != null ? parseFloat(ou) : null,
            external_game_id: String(g.id),
            opening_line: openingLine,
            current_line: currentLine,
            updated_at: new Date().toISOString(),
          })
          .eq('id', dbGame.id);
        if (!error) updated++;
      } else {
        // Game doesn't exist yet — insert it
        // Only insert FBS games (CFBD /games?division=fbs already filters this,
        // but guard against edge cases)
        if (!g.homeTeam || !g.awayTeam) continue;

        const { error } = await supabase
          .from('games')
          .insert({
            season: parseInt(season),
            week: parseInt(week),
            home_team: g.homeTeam,
            away_team: g.awayTeam,
            kickoff_at: kickoff,
            tv_network: tv,
            over_under: ou != null ? parseFloat(ou) : null,
            external_game_id: String(g.id),
            opening_line: openingLine,
            current_line: currentLine,
            status: 'scheduled',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

        if (!error) {
          inserted++;
        } else {
          unmatched.push({ cfbd_home: g.homeTeam, cfbd_away: g.awayTeam, error: error.message });
        }
      }
    }

    return Response.json({ games: cfbdGames.length, updated, inserted, unmatched });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
