'use client';

// THE Bobby Model — college basketball daily board.
//
// Reads cbb_board for one date. The database pulls PredictionTracker and
// recomputes on a schedule, so there is nothing to upload or run here.
// This is a tracking and research surface with paper units.

import { useCallback, useEffect, useMemo, useState } from 'react';
import RefreshButton from '../_ui/RefreshButton';
import GameDetail from '../_ui/GameDetail';
import {
  C, FH, FM, TIER_COLOR, f1, fmtDay, fmtET, lastRun, latestBoardDate, loadBoard, shiftDate, spreadFor, todayET, units,
} from '../../../lib/cbb';

const SORTS = {
  rank: { label: 'Rank', fn: (a, b) => (a.rank_in_day ?? 999) - (b.rank_in_day ?? 999) },
  edge: { label: 'Edge', fn: (a, b) => Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0) },
  agree: { label: 'Agreement', fn: (a, b) => (b.vote_share ?? 0) - (a.vote_share ?? 0) },
  spread: { label: 'Tightest', fn: (a, b) => (a.std_dev ?? 99) - (b.std_dev ?? 99) },
  game: { label: 'Matchup', fn: (a, b) => a.home.localeCompare(b.home) },
};

const cell = { padding: '9px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const btn = {
  background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6,
  padding: '7px 11px', fontSize: 13, cursor: 'pointer',
};

function ResultTag({ row }) {
  if (!row.result || row.result === 'NP') return null;
  const color = row.result === 'W' ? C.green : row.result === 'L' ? C.warn : C.sub;
  return (
    <span style={{ ...FM, fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 6px' }}>
      {row.result}{row.tier === 'Play' ? ` ${units(row.units_result)}` : ''}
    </span>
  );
}

function Flags({ flags }) {
  if (!flags.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
      {flags.map((f) => (
        <span key={f} style={{ fontSize: 10.5, color: C.gold, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{f}</span>
      ))}
    </span>
  );
}

function TopSpot({ row, n, onOpen }) {
  return (
    <button onClick={onOpen} title="Open the full breakdown" style={{ textAlign: 'left', color: C.text, cursor: 'pointer', background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.green}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...FM, fontSize: 11, color: C.sub }}>#{n}</span>
        <ResultTag row={row} />
      </div>
      <div style={{ ...FH, fontSize: 17, fontWeight: 700, margin: '2px 0 2px' }}>
        {row.pick_team} <span style={{ color: C.green }}>{spreadFor(row.pick_side, row.line)}</span>
      </div>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>{row.road} @ {row.home}{row.neutral ? ' (neutral)' : ''}</div>
      <div style={{ ...FM, fontSize: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 3 }}>
        <span>Model {spreadFor(row.pick_side, row.consensus)}</span>
        <span>Edge {f1(Math.abs(row.edge))}</span>
        <span>Agree {f1(100 * row.vote_share, 0)}%</span>
        <span>Spread of models {f1(row.std_dev)}</span>
      </div>
      <div style={{ marginTop: 8 }}><Flags flags={row.flags} /></div>
    </button>
  );
}

export default function CbbDashboard() {
  const [date, setDate] = useState(null);
  const [rows, setRows] = useState([]);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('rank');
  const [tierFilter, setTierFilter] = useState('all');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    latestBoardDate().then(setDate).catch(() => setDate(todayET()));
    lastRun().then(setRun).catch(() => {});
  }, []);

  const [tick, setTick] = useState(0);
  const onRefreshed = (r) => { setRun(r); setTick((t) => t + 1); };

  useEffect(() => {
    if (!date) return;
    let live = true;
    setLoading(true);
    setError(null);
    loadBoard(date)
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date, tick]);

  const plays = useMemo(() => rows.filter((r) => r.tier === 'Play'), [rows]);
  const openRow = open ? rows.find((r) => r.game_id === open) || null : null;
  const closeDetail = useCallback(() => setOpen(null), []);
  const top = useMemo(() => [...plays].sort(SORTS.rank.fn).slice(0, 5), [plays]);
  const shown = useMemo(() => {
    const base = tierFilter === 'all' ? rows : rows.filter((r) => r.tier === tierFilter);
    return [...base].sort(SORTS[sort].fn);
  }, [rows, sort, tierFilter]);

  
  const leans = rows.filter((r) => r.tier === 'Lean').length;
  const graded = plays.filter((r) => r.result === 'W' || r.result === 'L');
  const pw = graded.filter((r) => r.result === 'W').length;
  const pu = plays.reduce((a, r) => a + Number(r.units_result || 0), 0);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>THE Bobby Model — College Basketball</h1>
        <span style={{ ...FM, fontSize: 12, color: C.sub }}>{fmtDay(date)}</span>
      </div>
      <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginBottom: 14 }}>
        {run ? (
          <>
            Last pull {fmtET(run.started_at)} ET ({run.trigger})
            {' · '}{run.status === 'error' ? <span style={{ color: C.warn }}>error: {run.error}</span> : run.status}
            {run.page_stamp ? ` · PredictionTracker: ${run.page_stamp}` : ''}
            {run.live_status === 'stale' ? ' · PredictionTracker has not posted today yet' : ''}
            {' · '}<a href="/cbb/log">pull log</a>
          </>
        ) : 'Checking last pull…'}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <button style={btn} onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">←</button>
        <input type="date" value={date || ''} onChange={(e) => e.target.value && setDate(e.target.value)}
          style={{ ...btn, colorScheme: 'dark' }} />
        <button style={btn} onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">→</button>
        <button style={btn} onClick={() => setDate(todayET())}>Today</button>
        <RefreshButton onDone={onRefreshed} />
        <span style={{ ...FM, fontSize: 12, color: C.sub, marginLeft: 6 }}>
          {rows.length} games · {plays.length} plays · {leans} leans
          {graded.length ? ` · plays ${pw}-${graded.length - pw} (${units(pu)})` : ''}
        </span>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="empty">No games loaded for this date.</div>
      )}

      {!loading && top.length > 0 && (
        <>
          <h2 style={{ ...FH, fontSize: 15, margin: '0 0 10px' }}>Top spots</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))', gap: 10, marginBottom: 22 }}>
            {top.map((r, i) => <TopSpot key={r.game_id} row={r} n={i + 1} onOpen={() => setOpen(r.game_id)} />)}
          </div>
        </>
      )}

      {!loading && rows.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <h2 style={{ ...FH, fontSize: 15, margin: 0, marginRight: 6 }}>All games</h2>
            {['all', 'Play', 'Lean', 'No tier'].map((t) => (
              <button key={t} onClick={() => setTierFilter(t)}
                style={{ ...btn, padding: '4px 10px', fontSize: 12, borderColor: tierFilter === t ? C.green : C.border }}>
                {t === 'all' ? 'All' : t}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <label style={{ fontSize: 12, color: C.sub }}>Sort{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ ...btn, padding: '4px 8px', fontSize: 12 }}>
                {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['#', 'Matchup', 'Tier', 'Pick', 'Line', 'Open', 'Model', 'Edge', 'Agree', 'SD', 'Flags', 'Final'].map((h) => (
                    <th key={h} style={head}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                    <tr key={r.game_id} onClick={() => setOpen(r.game_id)} style={{ cursor: 'pointer' }} title="Open the full breakdown">
                      <td style={{ ...cell, ...FM, color: C.sub }}>{r.rank_in_day ?? '—'}</td>
                      <td style={cell}>{r.road} @ {r.home}{r.neutral ? ' (N)' : ''}</td>
                      <td style={{ ...cell, fontWeight: 700, color: TIER_COLOR[r.tier] || C.sub }}>{r.tier || '—'}</td>
                      <td style={{ ...cell, fontWeight: 600 }}>{r.pick_team ? `${r.pick_team} ${spreadFor(r.pick_side, r.line)}` : '—'}</td>
                      <td style={{ ...cell, ...FM }}>{r.home} {spreadFor('home', r.line)}</td>
                      <td style={{ ...cell, ...FM, color: C.sub }}>{spreadFor('home', r.open_line)}</td>
                      <td style={{ ...cell, ...FM }}>{spreadFor('home', r.consensus)}</td>
                      <td style={{ ...cell, ...FM }}>{r.edge === null ? '—' : f1(Math.abs(r.edge))}</td>
                      <td style={{ ...cell, ...FM }}>{r.vote_share === null ? '—' : `${f1(100 * r.vote_share, 0)}%`}</td>
                      <td style={{ ...cell, ...FM }}>{f1(r.std_dev)}</td>
                      <td style={cell}><Flags flags={r.flags} /></td>
                      <td style={{ ...cell, ...FM }}>
                        {r.home_score === null ? '' : `${r.road_score}-${r.home_score} `}<ResultTag row={r} />
                      </td>
                    </tr>

                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <details style={{ marginTop: 22, fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
        <summary style={{ cursor: 'pointer', color: C.text }}>How to read this board</summary>
        <p><b style={{ color: C.text }}>Model</b> is the weighted average of the PredictionTracker systems that have beaten the median system on error this season. <b style={{ color: C.text }}>Edge</b> is the gap between that number and the line. <b style={{ color: C.text }}>Agree</b> is the share of system weight on the pick side. <b style={{ color: C.text }}>SD</b> is how spread out the systems are.</p>
        <p><b style={{ color: C.green }}>Play</b>: edge of 1.5+ with 70%+ agreement, tracked at a flat 1 unit (win +1.0, lose -1.1). <b style={{ color: C.gold }}>Lean</b>: edge of 1.0+ with 60%+ agreement, record only. Top spots are the five highest-ranked plays; rank favors agreement and tight systems and caps edge at 4 points.</p>
        <p>Lines and predictions freeze at noon ET on game day. Results are graded the next morning against the frozen line. Tap any game for the full breakdown: the read, the opening-line gap, every system with its season accuracy, both teams&rsquo; form and rest, and how similar spots have done.</p>
      </details>

      {openRow && <GameDetail row={openRow} onClose={closeDetail} />}
    </main>
  );
}
