import { createClient } from '@supabase/supabase-js';
import { htmlToArticleText } from '../../../../lib/article-import';
import {
  extractLinks, extractJsonLinks, buildLinkChoice, chosenArticles, buildScoutExtraction, resolveScoutPicks, slateWindow, callCost,
} from '../../../../lib/scout';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// POST /api/scout/job { job_id }
// Runs one queued scout job (see supabase/migrations/20261119000300_scout_picks_core.sql).
// Called by the database's dispatcher (pg_net). The job is claimed first:
// only a job the dispatcher sent in the last 5 minutes, and nobody has claimed,
// can run, so this public route cannot start work that was not queued.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function fetchPage(url, ms = 12000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(ms), cache: 'no-store', redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return res.text();
}

// One forced tool call. Newer models reject a forced tool_choice, so fall back to auto.
async function askClaude({ model, system, user, tool, maxTokens, ms }) {
  const ask = (toolChoice) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, tools: [tool], tool_choice: toolChoice, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(ms),
  });
  let res = await ask({ type: 'tool', name: tool.name });
  let body = await res.json().catch(() => ({}));
  if (res.status === 400 && /tool_choice/i.test(body?.error?.message || '')) {
    res = await ask({ type: 'auto' });
    body = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message || 'request failed'}`);
  const block = (body.content || []).find((b) => b.type === 'tool_use');
  return { input: block?.input || null, usage: body.usage || null, stop: body.stop_reason || null };
}

// A page with no readable text (built by JavaScript, or a paywall) is skipped, not an error.
class SkipJob extends Error {}

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export async function POST(req) {
  let supabase;
  let jobId = null;
  let claimed = false;
  try {
    const body = await req.json().catch(() => ({}));
    jobId = Number.parseInt(body.job_id, 10);
    if (!Number.isInteger(jobId)) return Response.json({ ok: false, error: 'job_id is required' }, { status: 400 });

    supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: job, error: cErr } = await supabase.rpc('scout_job_claim', { p_job_id: jobId });
    if (cErr) throw new Error(`claim: ${cErr.message}`);
    if (!job?.id) return Response.json({ ok: false, error: 'Job is not waiting to run.' }, { status: 409 });
    claimed = true;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in Vercel');

    const [{ data: cfgRows }, { data: source }] = await Promise.all([
      supabase.from('scout_config').select('key, value'),
      job.source_id ? supabase.from('scout_sources').select('*').eq('id', job.source_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const cfg = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
    const sourceName = source?.name || 'Unknown';

    const { data: slate, error: sErr } = await supabase.from('scout_slate').select('*').eq('sport', job.sport)
      .order('game_date', { ascending: true }).order('start_time', { ascending: true, nullsFirst: false }).order('game_id', { ascending: true });
    if (sErr) throw new Error(`slate: ${sErr.message}`);
    const slateDesc = slateWindow(job.sport, slate || [], todayET());

    let result;
    if (job.kind === 'hub') {
      if (!slate?.length) {
        result = { links: 0, chosen: [], note: 'No games on the slate' };
      } else {
        const html = await fetchPage(job.url);
        let links;
        if (/^\s*[[{]/.test(html)) {
          try { links = extractJsonLinks(JSON.parse(html)); } catch { links = []; }
        } else {
          links = extractLinks(html, job.url);
        }
        if (!links.length) throw new Error(`No article links found on the page (${html.length} bytes; it may need JavaScript)`);
        const max = Number(cfg.max_articles_per_source) || 3;
        const model = cfg.model_links || 'claude-haiku-5-5';
        const req1 = buildLinkChoice({ sport: job.sport, sourceName, window: slateDesc, links, max });
        const ans = await askClaude({ model, ...req1, maxTokens: 1000, ms: 30000 });
        const chosen = chosenArticles(asArray(ans.input?.articles), links, max);
        const { data: added, error: aErr } = await supabase.rpc('scout_add_articles', { p_job_id: job.id, p_articles: chosen });
        if (aErr) throw new Error(`add articles: ${aErr.message}`);
        result = { links: links.length, chosen, ...added, model, usage: ans.usage, cost: callCost(model, ans.usage) };
      }
    } else {
      const html = await fetchPage(job.url);
      const text = htmlToArticleText(html);
      if (text.length < 800) throw new SkipJob(`Only ${text.length} characters of text (JavaScript page or paywall)`);
      const model = cfg.model_extract || 'claude-sonnet-5-5';
      const req2 = buildScoutExtraction(text, slate || [], { sport: job.sport, sourceName, window: slateDesc });
      const ans = await askClaude({ model, ...req2, maxTokens: 8000, ms: 42000 });
      const { picks, skipped } = resolveScoutPicks(asArray(ans.input?.picks), slate || []);
      const { data: stored, error: pErr } = await supabase.rpc('scout_submit', {
        p_sport: job.sport, p_run_id: job.run_id, p_job_id: job.id, p_origin: 'import',
        p_source_id: job.source_id, p_source_name: sourceName, p_url: job.url, p_picks: picks,
      });
      if (pErr) throw new Error(`submit: ${pErr.message}`);
      result = { chars: text.length, extracted: picks.length, skipped, ...stored, model, usage: ans.usage, stop: ans.stop, cost: callCost(model, ans.usage) };
    }

    await supabase.rpc('scout_job_finish', { p_job_id: job.id, p_status: 'done', p_result: result, p_error: null });
    return Response.json({ ok: true, job_id: job.id, result });
  } catch (e) {
    const msg = String(e?.message || e);
    const skip = e instanceof SkipJob;
    if (claimed) {
      try { await supabase.rpc('scout_job_finish', { p_job_id: jobId, p_status: skip ? 'skipped' : 'error', p_result: null, p_error: msg }); } catch { /* the dispatcher retries after 4 minutes */ }
    }
    return Response.json({ ok: skip, skipped: skip, error: msg }, { status: skip ? 200 : 500 });
  }
}
