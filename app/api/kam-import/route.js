import { parseKamText } from '../../../lib/kam-import';

export const runtime = 'nodejs';
export const maxDuration = 30;

const URLS = {
  ats: 'https://www.kambour.net/NCAAPredsSprd.html',
  ou: 'https://www.kambour.net/NCAAPredsOU.html',
};

// GET /api/kam-import?kind=ats|ou
// Fetches the Kambour page server-side (the browser cannot, no CORS) and
// returns it parsed and ranked. Nothing is written here.
export async function GET(req) {
  const kind = new URL(req.url).searchParams.get('kind');
  if (!URLS[kind]) return Response.json({ ok: false, error: 'kind must be ats or ou' }, { status: 400 });
  try {
    const res = await fetch(URLS[kind], {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BobbyModels/1.0)' },
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (!res.ok) return Response.json({ ok: false, error: `Kambour returned ${res.status}` }, { status: 502 });
    const { entries, skipped } = parseKamText(await res.text(), kind);
    if (entries.length < 10) return Response.json({ ok: false, error: `Only ${entries.length} games parsed; the page layout may have changed. Use "Paste page text" instead.`, skipped }, { status: 502 });
    return Response.json({ ok: true, kind, entries, skipped });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 502 });
  }
}
