import { createClient } from '@supabase/supabase-js';
import { guard } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Calls the NFL engine functions over RPC.
//
//   POST /api/nfl/engine?op=recalibrate&season=2026&week=3&market=spread
//   POST /api/nfl/engine?op=compute&season=2026&week=4&market=spread
//   POST /api/nfl/engine?op=grade&season=2026&week=3&market=spread
//   POST /api/nfl/engine?op=priors&market=spread&from=2021&through=2025
//   POST /api/nfl/engine?op=classify&season=2026
//
// Recalibrate always runs in live mode here. Backtest mode is Phase 2 and is
// deliberately not reachable from the Ingest page, so a stray click cannot
// write survivorship-biased weights into the live season.
const OPS = {
  recalibrate: { fn: 'nfl_recalibrate', args: (q) => ({ p_season: q.season, p_week: q.week, p_market: q.market, p_mode: 'live' }) },
  compute:     { fn: 'nfl_compute',     args: (q) => ({ p_season: q.season, p_week: q.week, p_market: q.market }) },
  grade:       { fn: 'nfl_grade',       args: (q) => ({ p_season: q.season, p_week: q.week, p_market: q.market }) },
  priors:      { fn: 'nfl_bobby_build_priors', args: (q) => ({ p_market: q.market, p_from_season: q.from, p_through_season: q.through }) },
  classify:    { fn: 'nfl_classify_games', args: (q) => ({ p_season: q.season }) },
};

export async function POST(req) {
  // Admin gate. Also enforced by middleware.js; repeated here so the
  // route stays closed if the matcher is ever narrowed.
  const denied = await guard(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const op = searchParams.get('op');
  const spec = OPS[op];
  if (!spec) {
    return Response.json({ error: `op must be one of: ${Object.keys(OPS).join(', ')}` }, { status: 400 });
  }

  const num = (k, dflt = null) => {
    const v = searchParams.get(k);
    if (v === null || v === '') return dflt;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
  };
  const q = {
    season: num('season'),
    week: num('week'),
    market: searchParams.get('market') || 'spread',
    from: num('from', 2021),
    through: num('through', 2025),
  };
  if (!['spread', 'total'].includes(q.market)) {
    return Response.json({ error: "market must be 'spread' or 'total'" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase.rpc(spec.fn, spec.args(q));
  if (error) return Response.json({ op, error: error.message }, { status: 500 });
  return Response.json({ op, fn: spec.fn, market: q.market, season: q.season, week: q.week, rows: data });
}
