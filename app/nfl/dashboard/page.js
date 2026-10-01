'use client';

import { useEffect, useMemo, useState } from 'react';
import { sbFetch, sbFetchAll, fmtKickoff } from '../../../lib/supabase';
import { TIER_COLOR, fmtSpread, teamLine } from '../../../lib/bobby-model';

// THE Bobby Model — NFL dashboard, minimal read-only first cut.
//
// Deliberately has no sort, filter, tags or My Card: those are Phase 3. The
// structure is meant to be EXTENDED rather than replaced, so:
//   - useWeekData() owns all reading. Phase 3 adds picks/research/logos to it.
//   - the rows it returns are {game, pick, snapshot}. Phase 3 wraps that array
//     with filtering and attachBobbyRank before it reaches the cards.
//   - GameCard takes one row plus display helpers. Phase 3 adds badges and
//     actions inside it without changing how it is fed.
//
// NOTATION. The database stores spreads home-relative, positive meaning the
// home team is favoured (predictiontracker's convention). Every number shown
// here is converted to sportsbook notation at the edge, so the favourite always
// carries the minus sign. teamLine() from lib/bobby-model is the single place
// that conversion happens, shared with the CFB dashboard.

const FH = { fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif" };
const FM = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };
const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', gold: '#D4A73C', green: '#6FBF73',
  blue: '#5B9BD4', warn: '#E07A62',
};

// The market line as a sportsbook would write it: whoever is favoured, with a
// minus. A home-relative line of +2.5 means the home team gives 2.5.
function marketLine(homeMargin, homeAbbr, awayAbbr) {
  const m = parseFloat(homeMargin);
  if (!Number.isFinite(m)) return '—';
  if (Math.abs(m) < 0.05) return 'PK';
  return m > 0 ? `${homeAbbr} ${fmtSpread(-m)}` : `${awayAbbr} ${fmtSpread(m)}`;
}

function useWeekData(season, week) {
  const [state, setState] = useState({ loading: true, error: null, rows: [], cfg: {}, abbr: {}, weeks: [] });

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
          sbFetchAll(`nfl_bobby_config?select=key,value,value_text&market=eq.spread`),
        ]);
        const weeks = [...new Set(weekRows.map((r) => r.week))].sort((a, b) => a - b);
        const abbr = {};
        for (const t of teamRows) abbr[t.name] = t.abbr;
        const cfg = {};
        for (const r of cfgRows) cfg[r.key] = r.value != null ? parseFloat(r.value) : r.value_text;

        if (week == null) { if (!cancelled) setState((s) => ({ ...s, loading: false, weeks, abbr, cfg })); return; }

        const games = await sbFetchAll(
          `nfl_games?select=id,week,home_team,away_team,game_date,tv_network,spread_line,spread_open,` +
          `neutral_site,is_divisional,is_primetime,home_score,away_score,completed` +
          `&season=eq.${season}&week=eq.${week}&order=game_date.asc`
        );

        // Embedded-join filters do not actually filter rows in PostgREST, so
        // the week's game ids are fetched first and everything else is keyed off
        // them with in.(...).
        const ids = games.map((g) => g.id);
        let picks = [];
        if (ids.length) {
          picks = await sbFetchAll(
            `nfl_bobby_picks?select=*&market=eq.spread&game_id=in.(${ids.join(',')})`
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
  }, [season, week]);

  return state;
}

export default function NflDashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const { loading, error, rows, cfg, abbr, weeks } = useWeekData(season, week);

  // Default to the newest week that has been computed, so the board lands on
  // the live week rather than week 1, and falls back to the last scheduled week
  // before anything has been computed at all.
  useEffect(() => {
    let cancelled = false;
    if (week != null) return;
    (async () => {
      try {
        const computed = await sbFetch(
          `nfl_bobby_picks?select=week&market=eq.spread&season=eq.${season}&order=week.desc&limit=1`
        );
        if (cancelled) return;
        if (computed.length) { setWeek(computed[0].week); return; }
        const scheduled = await sbFetch(`nfl_games?select=week&season=eq.${season}&order=week.desc&limit=1`);
        if (!cancelled) setWeek(scheduled.length ? scheduled[0].week : 1);
      } catch { if (!cancelled) setWeek(1); }
    })();
    return () => { cancelled = true; };
  }, [season, week]);

  const counts = useMemo(() => {
    const c = { games: rows.length, computed: 0, tiered: 0 };
    for (const r of rows) { if (r.pick) c.computed++; if (r.pick && r.pick.tier !== 'No tier') c.tiered++; }
    return c;
  }, [rows]);

  const unvalidated = cfg.tiers_validated === 0;

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 64px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>THE Bobby Model — NFL</h1>
        <span style={{ ...FM, fontSize: 12, color: C.sub }}>ATS · {season} week {week ?? '…'}</span>
      </div>

      {unvalidated && (
        <div style={{
          border: `1px dashed ${C.gold}`, background: `${C.gold}14`, borderRadius: 6,
          padding: '10px 12px', margin: '10px 0 16px', fontSize: 12.5, lineHeight: 1.6, color: C.text,
        }}>
          <b style={{ color: C.gold }}>Tiers unvalidated.</b> The tier cutoffs are the CFB numbers,
          carried over so the engine runs. They have not been tested against NFL history yet, so a
          3U here does not mean what a 3U means on the CFB board. Paper units only.
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', margin: '0 0 16px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.4 }}>SEASON</span>
          <select value={season} onChange={(e) => { setSeason(+e.target.value); setWeek(null); }} style={sel}>
            {[2026, 2025, 2024, 2023, 2022, 2021].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.4 }}>WEEK</span>
          <select value={week ?? ''} onChange={(e) => setWeek(+e.target.value)} style={sel}>
            {weeks.map((w) => <option key={w} value={w}>{w >= 19 ? `${w} (post)` : w}</option>)}
          </select>
        </label>
        <span style={{ ...FM, fontSize: 11.5, color: C.sub, paddingBottom: 8 }}>
          {counts.games} games · {counts.computed} computed · {counts.tiered} tiered
        </span>
      </div>

      {loading && <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>Loading…</div>}
      {error && <div style={{ ...FM, fontSize: 12.5, color: C.warn }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>
          No games for {season} week {week}. Run the ESPN sync on the Ingest page.
        </div>
      )}

      {rows.map((r) => <GameCard key={r.game.id} row={r} abbr={abbr} />)}
    </main>
  );
}

const sel = {
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text,
  padding: '7px 9px', fontSize: 13, minWidth: 92,
};

function GameCard({ row, abbr }) {
  const { game, pick, snapshot } = row;
  const [open, setOpen] = useState(false);
  const home = game.home_team, away = game.away_team;
  const hA = abbr[home] || home, aA = abbr[away] || away;
  const tier = pick?.tier || 'No tier';
  const tierColor = TIER_COLOR[tier] || C.sub;
  const line = game.spread_line;

  const pickSide = pick?.pick_side;
  const pickTeam = pickSide === 'home' ? home : pickSide === 'away' ? away : null;
  const pickAbbr = pickSide === 'home' ? hA : aA;
  const pool = Array.isArray(pick?.pool) ? pick.pool : [];

  const stats = pick ? [
    ['Consensus', `${pickAbbr} ${teamLine(pick.consensus, pickSide)}`],
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
              Spread {marketLine(line, hA, aA)}
            </span>
            {game.completed && (
              <span style={{ ...FM, fontSize: 11, color: C.sub }}>
                Final {game.away_score}–{game.home_score}
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
                <b>{pickTeam} {teamLine(pick.line_used, pickSide)}</b>
                <span style={{ color: C.sub }}> (model {teamLine(pick.consensus, pickSide)})</span>
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
                  : 'Scored against nfl_games.spread_line — no line snapshot for this game'}
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
          <PoolTable pool={pool} pickAbbr={pickAbbr} homeAbbr={hA} awayAbbr={aA} />
        </div>
      )}
    </div>
  );
}

// The pool exactly as nfl_compute snapshotted it onto the pick, so this stays
// true even after the weights move on.
function PoolTable({ pool, pickAbbr, homeAbbr, awayAbbr }) {
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
          const on = m.side === (pickAbbr === homeAbbr ? 'home' : 'away');
          const sideAbbr = m.side === 'home' ? homeAbbr : awayAbbr;
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
              {/* Prediction shown as the home team's spread, so it reads on the
                  same scale as the game line above. */}
              <span style={{ color: '#C9CFC8' }}>{homeAbbr} {fmtSpread(-m.prediction)}</span>
              <span style={{ fontWeight: 700, color: on ? C.green : C.warn }}>{sideAbbr}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Badge({ color, children, filled, dashed }) {
  return (
    <span style={{
      ...FM, fontSize: 10.5, lineHeight: 1, padding: '5px 8px', borderRadius: 4,
      border: `1px ${dashed ? 'dashed' : 'solid'} ${color}`,
      background: filled ? `${color}22` : 'transparent',
      color, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}
