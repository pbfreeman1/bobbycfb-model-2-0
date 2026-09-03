import { createClient } from '@supabase/supabase-js';

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
      fetch(`https://api.collegefootballdata.com/games?year=${season}&week=${week}&seasonType=regular`, { headers }),
      fetch(`https://api.collegefootballdata.com/games/media?year=${season}&week=${week}&seasonType=regular`, { headers }),
      fetch(`https://api.collegefootballdata.com/lines?year=${season}&week=${week}&seasonType=regular`, { headers }),
    ]);

    if (!gamesRes.ok) return Response.json({ error: `CFBD games error ${gamesRes.status}` }, { status: 502 });

    const cfbdGames = await gamesRes.json();
    const mediaData = mediaRes.ok ? await mediaRes.json() : [];
    const linesData = linesRes.ok ? await linesRes.json() : [];

    // Build lookup maps
    const mediaByName = {};
    for (const m of mediaData) {
      const key = `${m.homeTeam}|${m.awayTeam}`;
      if (!mediaByName[key]) mediaByName[key] = m.outlet || m.network || null;
    }

    const linesByName = {};
    for (const l of linesData) {
      const key = `${l.homeTeam}|${l.awayTeam}`;
      const withOU = (l.lines || []).find(x => x.overUnder != null);
      if (withOU) linesByName[key] = withOU.overUnder;
    }

    let updated = 0;
    for (const g of cfbdGames) {
      const key = `${g.homeTeam}|${g.awayTeam}`;
      const kickoff = g.startDate && !g.startTimeTBD ? g.startDate : null;
      const tv = mediaByName[key] || null;
      const ou = linesByName[key] ?? null;

      // Match by home/away team name (case-insensitive)
      const { error } = await supabase
        .from('games')
        .update({
          kickoff_at: kickoff,
          tv_network: tv,
          over_under: ou != null ? parseFloat(ou) : null,
          external_game_id: String(g.id),
          updated_at: new Date().toISOString(),
        })
        .ilike('home_team', g.homeTeam)
        .ilike('away_team', g.awayTeam)
        .eq('season', parseInt(season))
        .eq('week', parseInt(week));

      if (!error) updated++;
    }

    return Response.json({ games: cfbdGames.length, updated });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
