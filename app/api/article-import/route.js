import { createClient } from '@supabase/supabase-js';
import { buildExtractionRequest, htmlToArticleText, isAllowedUrl, resolvePicks, MAX_ARTICLE_CHARS } from '../../../lib/article-import';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

// POST /api/article-import  { season, week, url? | text?, sourceName? }
// Reads one betting article with Claude and returns the picks matched to that
// week's games. Writes nothing; the page previews and saves.
//
// Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional),
//      IMPORT_PASSCODE (optional; when set, requests must send it in x-import-passcode).
export async function POST(req) {
  try {
    if (process.env.IMPORT_PASSCODE && req.headers.get('x-import-passcode') !== process.env.IMPORT_PASSCODE) {
      return Response.json({ ok: false, error: 'Wrong or missing passcode.' }, { status: 401 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json({ ok: false, error: 'ANTHROPIC_API_KEY is not set in Vercel. Add it under Project > Settings > Environment Variables, then redeploy.' }, { status: 500 });
    }
    const body = await req.json();
    const season = parseInt(body.season, 10), week = parseInt(body.week, 10);
    if (!Number.isInteger(season) || !Number.isInteger(week)) return Response.json({ ok: false, error: 'season and week are required' }, { status: 400 });

    // 1. Article text
    let text = '';
    if (body.text && String(body.text).trim()) {
      text = htmlToArticleText(String(body.text));
    } else if (body.url) {
      if (!isAllowedUrl(body.url)) return Response.json({ ok: false, error: 'That site is not on the allowed list (ESPN, CBS, Fox, Yahoo, VSIN, SportsLine, Action Network).' }, { status: 400 });
      const res = await fetch(body.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BobbyModels/1.0)', Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(20000), cache: 'no-store', redirect: 'follow',
      });
      if (!res.ok) return Response.json({ ok: false, error: `The site returned ${res.status}. Use "Paste article text" instead.` }, { status: 502 });
      text = htmlToArticleText(await res.text());
    } else {
      return Response.json({ ok: false, error: 'Send a url or text.' }, { status: 400 });
    }
    if (text.length < 1500) return Response.json({ ok: false, error: `Only ${text.length} characters of article text were found (the page may need JavaScript or a login). Use "Paste article text" instead.` }, { status: 502 });

    // 2. This week's games
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: games, error: gErr } = await supabase.from('games').select('id, home_team, away_team').eq('season', season).eq('week', week).order('home_team', { ascending: true });
    if (gErr) throw new Error(`games: ${gErr.message}`);
    if (!games?.length) return Response.json({ ok: false, error: `No games found for season ${season} week ${week}.` }, { status: 400 });

    // 3. Ask Claude for structured picks (forced tool call)
    const { system, user, tool } = buildExtractionRequest(text, games, { sourceName: body.sourceName });
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(50000),
    });
    const aj = await ar.json().catch(() => ({}));
    if (!ar.ok) return Response.json({ ok: false, error: `Anthropic API ${ar.status}: ${aj?.error?.message || 'request failed'}` }, { status: 502 });
    const block = (aj.content || []).find((b) => b.type === 'tool_use');
    if (!block) return Response.json({ ok: false, error: 'The model returned no picks block.' }, { status: 502 });

    const { picks, skipped } = resolvePicks(block.input?.picks, games);
    return Response.json({
      ok: true, chars: text.length, preview: text.slice(0, 500), truncated: text.length >= MAX_ARTICLE_CHARS, model: MODEL, usage: aj.usage || null,
      picks: picks.map((p) => ({ game_id: p.game.id, type: p.type, side: p.side, line: p.line, experts: p.experts, text: p.text })),
      skipped,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
