import { createClient } from '@supabase/supabase-js';
import { normalizeTeamName } from '../../../lib/team-match';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Populates team_logos from CFBD's own /teams endpoint (which is where the
// existing rows' logo URLs came from — cdn.collegefootballdata.com), matched
// against the distinct team names actually in our `games` table via the same
// normalizer used for grading/sync, instead of relying on team_logos being
// hand-populated one-off. Includes FCS opponents (year-round /teams, not
// just /teams/fbs), since several early-season games are against them.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const season = searchParams.get('season') || '2026';

  const apiKey = process.env.CFBD_API_KEY;
  if (!apiKey) return Response.json({ error: 'CFBD_API_KEY not set' }, { status: 500 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  try {
    const res = await fetch(`https://api.collegefootballdata.com/teams?year=${season}`, { headers });
    if (!res.ok) return Response.json({ error: `CFBD teams error ${res.status}` }, { status: 502 });
    const cfbdTeams = await res.json();

    const cfbdByKey = new Map();
    for (const t of cfbdTeams) {
      const logo = Array.isArray(t.logos) && t.logos.length ? t.logos[0] : null;
      if (!logo) continue;
      cfbdByKey.set(normalizeTeamName(t.school), logo);
    }

    // Distinct team names actually referenced in our games this season.
    const { data: games, error: gErr } = await supabase
      .from('games')
      .select('home_team, away_team')
      .eq('season', parseInt(season));
    if (gErr) return Response.json({ error: gErr.message }, { status: 500 });

    const ourTeams = new Set();
    for (const g of games || []) { ourTeams.add(g.home_team); ourTeams.add(g.away_team); }

    // Only fill in gaps — never overwrite an existing (possibly manually
    // curated) logo_url.
    const { data: existing } = await supabase.from('team_logos').select('team_name');
    const existingSet = new Set((existing || []).map((r) => r.team_name));

    let matched = 0;
    const unmatched = [];
    const rows = [];
    for (const team of ourTeams) {
      if (existingSet.has(team)) continue;
      const logo = cfbdByKey.get(normalizeTeamName(team));
      if (logo) {
        rows.push({ team_name: team, logo_url: logo });
        matched++;
      } else {
        unmatched.push(team);
      }
    }

    if (rows.length) {
      const { error: upErr } = await supabase.from('team_logos').upsert(rows, { onConflict: 'team_name' });
      if (upErr) return Response.json({ error: upErr.message }, { status: 500 });
    }

    return Response.json({ checked: ourTeams.size, already_had_logo: existingSet.size, added: matched, unmatched });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
