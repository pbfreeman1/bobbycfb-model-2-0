'use client';

// THE Bobby Model — NFL, shared board internals.
//
// Extracted from the first cut of app/nfl/dashboard so /nfl/ats, /nfl/totals
// and the dashboard read through ONE loader instead of three copies. The shape
// the dashboard established is kept exactly:
//
//   - useNflBoard() owns all reading.
//   - the rows it returns are {game, pick, snapshot}.
//   - GameCard takes one row plus display helpers.
//
// The one thing added here is the market dimension. 'spread' reads
// nfl_games.spread_line and picks a side; 'total' reads nfl_games.total_line
// and picks over/under. Everything downstream keys off MARKET[market] so a
// third market would be a table entry, not a new branch in every component.
//
// NOTATION (spread). The database stores spreads home-relative, positive
// meaning the home team is favoured (predictiontracker's convention). Every
// number shown is converted to sportsbook notation at the edge, so the
// favourite always carries the minus sign. teamLine() from lib/bobby-model is
// the single place that happens, shared with the CFB dashboard.
//
// This is a tracking and research surface. Nothing here is advice.

import { useEffect, useMemo, useState } from 'react';
import { sbFetch, sbFetchAll, fmtKickoff } from './supabase';
import { TIER_COLOR, fmtSpread, teamLine } from './bobby-model';

export const FH = { fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif" };
export const FM = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };
export const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', gold: '#D4A73C', green: '#6FBF73',
  blue: '#5B9BD4', warn: '#E07A62',
};

export const sel = {
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text,
  padding: '7px 9px', fontSize: 13, minWidth: 92,
};

export const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021];

// Per-market differences, in one place.
export const MARKET = {
  spread: {
    key: 'spread',
    label: 'ATS',
    lineField: 'spread_line',
    openField: 'spread_open',
    // The market line as a sportsbook would write it: whoever is favoured,
    // with a minus. A home-relative line of +2.5 means the home team gives 2.5.
    marketLine: (v, hA, aA) => {
      const m = parseFloat(v);
      if (!Number.isFinite(m)) return '—';
      if (Math.abs(m) < 0.05) return 'PK';
      return m > 0 ? `${hA} ${fmtSpread(-m)}` : `${aA} ${fmtSpread(m)}`;
    },
    // What the pick is on, as a label.
    sideLabel: (pick, game) =>
      pick.pick_side === 'home' ? game.home_team
      : pick.pick_side === 'away' ? game.away_team : null,
    sideAbbr: (pick, hA, aA) => (pick.pick_side === 'home' ? hA : aA),
    // A number, shown on the side the pick is on.
    atLine: (v, pick) => teamLine(v, pick.pick_side),
    poolSide: (m, hA, aA) => (m.side === 'home' ? hA : aA),
    poolPrediction: (m, hA) => `${hA} ${fmtSpread(-m.prediction)}`,
    poolOnPick: (m, pick) => m.side === pick.pick_side,
  },
  total: {
    key: 'total',
    label: 'O/U',
    lineField: 'total_line',
    openField: 'total_open',
    marketLine: (v) => {
      const t = parseFloat(v);
      return Number.isFinite(t) ? t.toFixed(1) : '—';
    },
    sideLabel: (pick) =>
      pick.pick_side === 'over' ? 'Over' : pick.pick_side === 'under' ? 'Under' : null,
    sideAbbr: (pick) => (pick.pick_side === 'over' ? 'O' : 'U'),
    atLine: (v, pick) => {
      const t = parseFloat(v);
      if (!Number.isFinite(t)) return '—';
      return `${pick.pick_side === 'over' ? 'o' : 'u'}${t.toFixed(1)}`;
    },
    poolSide: (m) => (m.side === 'over' ? 'OVER' : 'UNDER'),
    poolPrediction: (m) => Number(m.prediction).toFixed(1),
    poolOnPick: (m, pick) => m.side === pick.pick_side,
  },
};

// All reading for one season/week/market.
export function useNflBoard(season, week, market = 'spread') {
  const M = MARKET[market];
  const [state, setState] = useState({
    loading: true, error: null, rows: [], cfg: {}, abbr: {}, weeks: [],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        // Weeks that exist for the selector, and the team abbreviations the
        // pool table uses. Both small, both paginated on principle.
        const [weekRows, teamRows, cfgRows] = await Promise.all([
          sbFetchAll(`nfl_games?select=week&season=eq.${season}&order=week.asc`),
          sbFetchAll('nfl_teams?select=name,abbr'),
          sbFetchAll(`nfl_bobby_config?select=key,value,value_text&market=eq.${market}`),
        ]);
        const weeks = [...new Set(weekRows.map((r) => r.week))].sort((a, b) => a - b);
        const abbr = {};
        for (const t of teamRows) abbr[t.name] = t.abbr;
        const cfg = {};
        for (const r of cfgRows) cfg[r.key] = r.value != null ? parseFloat(r.value) : r.value_text;

        if (week == null) {
          if (!cancelled) setState((s) => ({ ...s, loading: false, weeks, abbr, cfg }));
          return;
        }

        const games = await sbFetchAll(
          `nfl_games?select=id,week,home_team,away_team,game_date,tv_network,spread_line,spread_open,` +
          `total_line,total_open,neutral_site,is_divisional,is_primetime,home_score,away_score,completed` +
          `&season=eq.${season}&week=eq.${week}&order=game_date.asc`
        );

        // Embedded-join filters do not actually filter rows in PostgREST, so
        // the week's game ids are fetched first and everything else is keyed
        // off them with in.(...).
        const ids = games.map((g) => g.id);
        let picks = [];
        if (ids.length) {
          picks = await sbFetchAll(
            `nfl_bobby_picks?select=*&market=eq.${market}&game_id=in.(${ids.join(',')})`
          );
        }

        // Which snapshot each pick was scored against, and when it was taken.
        const snapIds = [...new Set(picks.map((p) => p.line_snapshot_id).filter(Boolean))];
        const snaps = {};
        if (snapIds.length) {
          const rows = await sbFetchAll(
            `nfl_bobby_lines?select=id,phase,line,captured_at,source&id=in.(${snapIds.join(',')})`
          );
          for (const r of rows) snaps[r.id] = r;
        }

        const pickByGame = {};
        for (const p of picks) pickByGame[p.game_id] = p;
        const rows = games.map((game) => {
          const pick = pickByGame[game.id] || null;
          return { game, pick, snapshot: pick?.line_snapshot_id ? snaps[pick.line_snapshot_id] : null };
        });

        if (!cancelled) setState({ loading: false, error: null, rows, cfg, abbr, weeks });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: String(e.message || e) }));
      }
    })();
    return () => { cancelled = true; };
  }, [season, week, market]);

  return state;
}

// Lands the board on the newest week that has been computed for this market,
// rather than week 1, falling back to the last scheduled week before anything
// has been computed at all.
export function useDefaultWeek(season, week, setWeek, market = 'spread') {
  useEffect(() => {
    let cancelled = false;
    if (week != null) return;
    (async () => {
      try {
        const computed = await sbFetch(
          `nfl_bobby_picks?select=week&market=eq.${market}&season=eq.${season}&order=week.desc&limit=1`
        );
        if (cancelled) return;
        if (computed.length) { setWeek(computed[0].week); return; }
        const scheduled = await sbFetch(`nfl_games?select=week&season=eq.${season}&order=week.desc&limit=1`);
        if (!cancelled) setWeek(scheduled.length ? scheduled[0].week : 1);
      } catch { if (!cancelled) setWeek(1); }
    })();
    return () => { cancelled = true; };
  }, [season, week, market, setWeek]);
}

export function boardCounts(rows) {
  const c = { games: rows.length, computed: 0, tiered: 0 };
  for (const r of rows) {
    if (r.pick) c.computed++;
    if (r.pick && r.pick.tier !== 'No tier') c.tiered++;
  }
  return c;
}

export function Badge({ color, children, filled, dashed }) {
  return (
    <span style={{
      ...FM, fontSize: 10.5, lineHeight: 1, padding: '5px 8px', borderRadius: 4,
      border: `1px ${dashed ? 'dashed' : 'solid'} ${color}`,
      background: filled ? `${color}22` : 'transparent',
      color, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// The banner the first cut carried: tier cutoffs are the CFB numbers, not yet
// tested against NFL history. Shown per market, since each market has its own
// tiers_validated flag in nfl_bobby_config.
export function UnvalidatedNotice({ cfg, market }) {
  if (cfg.tiers_validated !== 0) return null;
  return (
    <div style={{
      border: `1px dashed ${C.gold}`, background: `${C.gold}14`, borderRadius: 6,
      padding: '10px 12px', margin: '10px 0 16px', fontSize: 12.5, lineHeight: 1.6, color: C.text,
    }}>
      <b style={{ color: C.gold }}>Tiers unvalidated.</b> The {MARKET[market].label} tier cutoffs are
      the CFB numbers, carried over so the engine runs. They have not been tested against NFL history
      yet, so a 3U here does not mean what a 3U means on the CFB board. Paper units only.
    </div>
  );
}

export function SeasonWeekPicker({ season, setSeason, setWeek, week, weeks, counts }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', margin: '0 0 16px' }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.4 }}>SEASON</span>
        <select value={season} onChange={(e) => { setSeason(+e.target.value); setWeek(null); }} style={sel}>
          {SEASONS.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.4 }}>WEEK</span>
        <select value={week ?? ''} onChange={(e) => setWeek(+e.target.value)} style={sel}>
          {weeks.map((w) => <option key={w} value={w}>{w >= 19 ? `${w} (post)` : w}</option>)}
        </select>
      </label>
      {counts && (
        <span style={{ ...FM, fontSize: 11.5, color: C.sub, paddingBottom: 8 }}>
          {counts.games} games · {counts.computed} computed · {counts.tiered} tiered
        </span>
      )}
    </div>
  );
}

export function GameCard({ row, abbr, market = 'spread' }) {
  const M = MARKET[market];
  const { game, pick, snapshot } = row;
  const [open, setOpen] = useState(false);
  const home = game.home_team, away = game.away_team;
  const hA = abbr[home] || home, aA = abbr[away] || away;
  const tier = pick?.tier || 'No tier';
  const tierColor = TIER_COLOR[tier] || C.sub;
  const line = game[M.lineField];

  const sideName = pick ? M.sideLabel(pick, game) : null;
  const sideAbbr = pick ? M.sideAbbr(pick, hA, aA) : null;
  const pool = Array.isArray(pick?.pool) ? pick.pool : [];

  const stats = pick ? [
    ['Consensus', `${sideAbbr} ${M.atLine(pick.consensus, pick)}`],
    ['Edge', `${Math.abs(parseFloat(pick.edge)).toFixed(2)} pts`],
    ['Vote share', `${(parseFloat(pick.agreement) * 100).toFixed(1)}%`],
    ['Std dev', `${parseFloat(pick.std_dev).toFixed(2)}`],
    ['Conviction', `${parseFloat(pick.conviction).toFixed(2)}`],
    ['Voters', String(pick.voters)],
  ] : [];

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderLeft: `4px solid ${tier === 'No tier' ? C.border : tierColor}`,
      borderRadius: 6, marginBottom: 12, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{ flexGrow: 1, minWidth: 0, padding: '13px 15px' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ ...FH, fontSize: 15, fontWeight: 600 }}>{away} @ {home}</span>
            <span style={{ ...FM, fontSize: 11, color: C.sub }}>{fmtKickoff(game.game_date)}</span>
            {game.tv_network && <span style={{ ...FM, fontSize: 11, color: C.sub }}>{game.tv_network}</span>}
            <span style={{ ...FM, fontSize: 11, color: C.sub }}>
              {market === 'total' ? 'Total ' : 'Spread '}{M.marketLine(line, hA, aA)}
            </span>
            {game.completed && (
              <span style={{ ...FM, fontSize: 11, color: C.sub }}>
                Final {game.away_score}–{game.home_score}
                {market === 'total' && game.home_score != null && game.away_score != null
                  ? ` (${game.home_score + game.away_score})` : ''}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '9px 0 0' }}>
            <Badge color={tier === 'No tier' ? C.sub : tierColor} filled={tier !== 'No tier'}>
              {tier === 'No tier' ? 'No tier' : `${tier} · ${parseFloat(pick.units)}u`}
            </Badge>
            {pick?.near_miss && <Badge color={C.gold} dashed>Near miss · {pick.near_miss}</Badge>}
            {(pick?.flags || []).map((f) => <Badge key={f} color={C.warn} filled>{f}</Badge>)}
            {(pick?.keys_crossed || []).length > 0 && (
              <Badge color={C.blue}>Crosses {pick.keys_crossed.join(', ')}</Badge>
            )}
            {game.is_divisional && <Badge color={C.sub}>Divisional</Badge>}
            {game.is_primetime && <Badge color={C.sub}>Primetime</Badge>}
            {game.neutral_site && <Badge color={C.sub}>Neutral site</Badge>}
          </div>

          <div style={{ height: 1, background: C.border, margin: '12px 0 10px' }} />

          {pick ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ ...FM, fontSize: 13.5 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>BOBBY PICK: </span>
                <b>{sideName} {M.atLine(pick.line_used, pick)}</b>
                <span style={{ color: C.sub }}> (model {M.atLine(pick.consensus, pick)})</span>
              </span>
              <span style={{ ...FM, fontSize: 11.5, color: '#C9CFC8' }}>
                <span style={{ color: C.green, fontWeight: 700 }}>
                  Edge {Math.abs(parseFloat(pick.edge)).toFixed(2)}
                </span>
                {' · '}Vote {(parseFloat(pick.agreement) * 100).toFixed(0)}%
                {' · '}STD {parseFloat(pick.std_dev).toFixed(2)}
                {' · '}Conv {parseFloat(pick.conviction).toFixed(2)}
                {' · '}{pick.voters} voters
              </span>
              <span style={{ ...FM, fontSize: 10.5, color: C.sub }}>
                {snapshot
                  ? `Scored against the ${snapshot.phase} snapshot of ${fmtKickoff(snapshot.captured_at)}`
                  : `Scored against nfl_games.${M.lineField} — no line snapshot for this game`}
                {pick.locked_at ? ' · locked (kicked off)' : ' · open to revision until kickoff'}
              </span>
            </div>
          ) : (
            <span style={{ ...FM, fontSize: 12, color: C.sub }}>
              Not computed yet — run Compute for this week on the Ingest page.
            </span>
          )}
        </div>

        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label="Toggle pool breakdown"
          disabled={!pick}
          style={{
            width: 42, flexShrink: 0, border: 'none', borderLeft: `1px solid ${C.border}`,
            background: 'transparent', color: pick ? C.sub : C.border,
            cursor: pick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
               style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {open && pick && (
        <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface2, padding: 15 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
            gap: '10px 16px', marginBottom: 15,
          }}>
            {stats.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, textTransform: 'uppercase' }}>{k}</span>
                <span style={{ ...FM, fontSize: 13 }}>{v}</span>
              </div>
            ))}
          </div>
          <PoolTable pool={pool} pick={pick} homeAbbr={hA} awayAbbr={aA} market={market} />
        </div>
      )}
    </div>
  );
}

// The pool exactly as nfl_compute snapshotted it onto the pick, so this stays
// true even after the weights move on.
function PoolTable({ pool, pick, homeAbbr, awayAbbr, market }) {
  const M = MARKET[market];
  if (!pool.length) return <span style={{ ...FM, fontSize: 12, color: C.sub }}>No pool snapshot on this pick.</span>;
  const cols = 'minmax(0,1fr) 46px 96px 104px 62px 52px';
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ padding: '10px 13px', ...FM, fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>
        POOL · {pool.length} VOTING SYSTEMS
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 9, padding: '6px 13px',
                      background: C.surface2, ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, minWidth: 470 }}>
          <span>SYSTEM</span><span>RANK</span><span>RECORD</span><span>WEIGHT</span><span>PREDICTS</span><span>SIDE</span>
        </div>
        {pool.map((m, i) => {
          const on = M.poolOnPick(m, pick);
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: cols, gap: 9, alignItems: 'center',
                                  padding: '6px 13px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 11.5, minWidth: 470 }}>
              <span style={{ ...FH, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
              <span style={{ color: C.sub }}>#{m.rank}</span>
              <span style={{ color: C.sub }}>{m.record}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ flexGrow: 1, height: 5, background: C.bg, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, m.share)}%`, background: on ? C.green : C.warn }} />
                </div>
                <span style={{ width: 38, textAlign: 'right', color: '#C9CFC8' }}>{Number(m.share).toFixed(1)}%</span>
              </div>
              {/* Spread predictions are shown as the home team's line, so they
                  read on the same scale as the game line above. Totals are
                  already an absolute number. */}
              <span style={{ color: '#C9CFC8' }}>{M.poolPrediction(m, homeAbbr)}</span>
              <span style={{ fontWeight: 700, color: on ? C.green : C.warn }}>
                {M.poolSide(m, homeAbbr, awayAbbr)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The shared body of /nfl/ats and /nfl/totals: one market, season/week picker,
// and the cards. The dashboard composes both markets itself instead.
export function MarketBoard({ market, title, blurb }) {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const { loading, error, rows, cfg, abbr, weeks } = useNflBoard(season, week, market);
  useDefaultWeek(season, week, setWeek, market);
  const counts = useMemo(() => boardCounts(rows), [rows]);

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 64px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>{title}</h1>
        <span style={{ ...FM, fontSize: 12, color: C.sub }}>
          {MARKET[market].label} · {season} week {week ?? '…'}
        </span>
      </div>
      {blurb && (
        <p style={{ ...FM, fontSize: 11.5, color: C.sub, lineHeight: 1.6, margin: '0 0 4px', maxWidth: 760 }}>
          {blurb}
        </p>
      )}

      <UnvalidatedNotice cfg={cfg} market={market} />
      <SeasonWeekPicker
        season={season} setSeason={setSeason} week={week} setWeek={setWeek}
        weeks={weeks} counts={counts}
      />

      {loading && <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>Loading…</div>}
      {error && <div style={{ ...FM, fontSize: 12.5, color: C.warn }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>
          No games for {season} week {week}. Run the ESPN sync on the Ingest page.
        </div>
      )}
      {!loading && !error && rows.length > 0 && counts.computed === 0 && (
        <NoMarketData market={market} season={season} week={week} />
      )}

      {rows.map((r) => <GameCard key={r.game.id} row={r} abbr={abbr} market={market} />)}
    </main>
  );
}

// Distinguishes "this week has not been computed" from "this market has no
// source data at all", because the two need very different actions and the
// generic empty state hid the difference.
export function NoMarketData({ market, season, week }) {
  return (
    <div style={{
      border: `1px dashed ${C.border}`, background: C.surface, borderRadius: 6,
      padding: '12px 14px', margin: '0 0 16px', ...FM, fontSize: 12, lineHeight: 1.7, color: C.sub,
    }}>
      <b style={{ color: C.text }}>Nothing computed for {season} week {week}.</b>
      {market === 'total' ? (
        <>
          {' '}The totals market has model rows and config, but no totals predictions have been
          ingested yet and <code>nfl_games.total_line</code> is unset for this season, so there is
          nothing for the engine to vote on. Upload a totals CSV on the Ingest page, then run
          Priors → Recalibrate → Compute for <code>total</code>.
        </>
      ) : (
        <> Run Recalibrate then Compute for this week on the Ingest page.</>
      )}
    </div>
  );
}
