'use client';

// Outside picks research page (CBB and NFL): where the sources are, how that
// lines up with THE Bobby Model, and how sources and the crowd have done.
// Reads scout_game_crowd, scout_side_consensus, scout_source_board and
// scout_expert_board (supabase/migrations/20261119000500_scout_research_views.sql).

import { useEffect, useMemo, useState } from 'react';
import { C, FH, FM } from '../../lib/nfl-board';
import { crowdRows, sideRows, sourceBoard, expertBoard, scoutRuns } from '../../lib/scout-client';
import {
  GROUPS, crowdRecord, moveToward, pctText, rec, sideLabel, spotlights, unitsText,
} from '../../lib/scout-research';

const SPORT = {
  cbb: { title: 'College Basketball', board: '/cbb/dashboard', log: '/cbb/log', daily: true },
  nfl: { title: 'NFL', board: '/nfl/dashboard', log: '/nfl/log', daily: false },
};

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const shift = (iso, d) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const fmtDay = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) : '');
const fmtStart = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const fmtET = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const num = (v) => (v === null || v === undefined ? null : Number(v));

const cell = { padding: '8px 9px', borderBottom: `1px solid ${C.border}`, fontSize: 12.5, whiteSpace: 'nowrap', verticalAlign: 'top' };
const head = { ...cell, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const btn = { background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer' };
const tableBox = { overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface };
const REL = { with: { label: 'With model', color: C.green }, against: { label: 'Against model', color: C.warn } };

function Chip({ on, onClick, children }) {
  return <button onClick={onClick} style={{ ...btn, padding: '4px 10px', fontSize: 12, borderColor: on ? C.green : C.border }}>{children}</button>;
}

function crowdLabel(r) {
  if (!r.crowd_side) return 'Split';
  return sideLabel(r, r.crowd_side, r.market_line);
}

function modelText(r, sport) {
  if (!r.model_side) return r.grp === 'total' && sport === 'cbb' ? 'no totals model' : '—';
  const team = r.model_side === 'home' ? r.home : r.model_side === 'away' ? r.away : r.model_side === 'over' ? 'Over' : 'Under';
  const e = num(r.model_edge);
  return `${team} · ${r.model_tier || 'No tier'}${e !== null ? ` ${e.toFixed(1)}` : ''}`;
}

function Spot({ title, note, rows, color, empty }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderTop: `3px solid ${color}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ ...FH, fontWeight: 700, fontSize: 14 }}>{title} <span style={{ ...FM, fontSize: 11, color: C.sub, fontWeight: 400 }}>{rows.length}</span></div>
      <div style={{ fontSize: 11.5, color: C.sub, margin: '2px 0 8px' }}>{note}</div>
      {!rows.length && <div style={{ fontSize: 12, color: C.sub }}>{empty}</div>}
      {rows.slice(0, 6).map((r) => {
        const mv = moveToward(r.crowd_side, r.open_line, r.market_line);
        return (
          <div key={`${r.game_id}|${r.grp}`} style={{ fontSize: 12.5, padding: '4px 0', borderTop: `1px solid ${C.border}` }}>
            <div style={{ fontWeight: 600 }}>{crowdLabel(r)} <span style={{ ...FM, fontSize: 11, color: C.sub }}>{r.grp === 'total' ? 'total' : ''}</span></div>
            <div style={{ ...FM, fontSize: 11, color: C.sub }}>
              {r.away} @ {r.home} · {num(r.crowd_sources)}–{num(r.other_sources)} sites
              {r.model_side ? ` · model ${r.model_side === r.crowd_side ? 'agrees' : 'disagrees'}` : ''}
              {mv !== null && Math.abs(mv) >= 1 ? ` · line ${mv > 0 ? 'toward' : 'away from'} crowd ${Math.abs(mv)}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ResearchPage({ sport }) {
  const cfg = SPORT[sport];
  const [rows, setRows] = useState([]);
  const [sides, setSides] = useState([]);
  const [sources, setSources] = useState([]);
  const [experts, setExperts] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [date, setDate] = useState(todayET());
  const [grp, setGrp] = useState('all');
  const [minSrc, setMinSrc] = useState(1);
  const [boardMode, setBoardMode] = useState('sites');
  const [minGraded, setMinGraded] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([crowdRows(sport, { since: shift(todayET(), -90) }), sourceBoard(sport), expertBoard(sport), scoutRuns(sport, 1)])
      .then(([c, s, e, r]) => { if (!live) return; setRows(c); setSources(s); setExperts(e); setLastRun(r[0] || null); })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sport]);

  // Games in view: CBB = the chosen day; NFL = games not final (this week).
  const inView = useMemo(() => rows.filter((r) => (cfg.daily ? r.game_date === date : !r.final))
    .filter((r) => grp === 'all' || r.grp === grp), [rows, date, grp, cfg.daily]);

  useEffect(() => {
    let live = true;
    sideRows(sport, inView.map((r) => r.game_id)).then((s) => { if (live) setSides(s); }).catch(() => {});
    return () => { live = false; };
  }, [sport, inView]);

  const namesFor = useMemo(() => {
    const m = new Map();
    for (const s of sides) m.set(`${s.game_id}|${s.grp}|${s.side}`, s.source_names || []);
    return m;
  }, [sides]);

  const spots = useMemo(() => spotlights(inView.map((r) => (cfg.daily ? { ...r, final: false } : r))), [inView, cfg.daily]);
  const table = useMemo(() => [...inView]
    .filter((r) => num(r.crowd_sources) >= minSrc)
    .sort((a, b) => num(b.crowd_sources) - num(a.crowd_sources) || (num(b.crowd_sources) - num(b.other_sources)) - (num(a.crowd_sources) - num(a.other_sources))
      || String(a.start_time).localeCompare(String(b.start_time))), [inView, minSrc]);

  const history = useMemo(() => crowdRecord(rows.filter((r) => r.final)), [rows]);
  const hk = grp === 'all' ? 'all' : grp;
  const histRows = [
    ['All games with picks', `${hk}|n:all`],
    ['1 site', `${hk}|n:1`], ['2 sites', `${hk}|n:2`], ['3 sites', `${hk}|n:3`], ['4+ sites', `${hk}|n:4+`],
  ];
  const unanimous = rec(history.get(`${hk}|unanimous2+|all`));

  const board = useMemo(() => {
    const src = boardMode === 'sites' ? sources : experts;
    const by = new Map();
    for (const r of src) {
      if (grp !== 'all' && r.grp !== grp) continue;
      const k = boardMode === 'sites' ? r.source_name : `${r.source_name}|${r.expert}`;
      if (!by.has(k)) by.set(k, { source_name: r.source_name, expert: r.expert, picks: 0, graded: 0, w: 0, l: 0, p: 0, units: 0, last: null });
      const o = by.get(k);
      o.picks += Number(r.picks); o.graded += Number(r.graded); o.w += Number(r.w); o.l += Number(r.l); o.p += Number(r.p); o.units += Number(r.units);
      if (!o.last || r.last_pick > o.last) o.last = r.last_pick;
    }
    return [...by.values()].filter((o) => o.graded >= minGraded)
      .sort((a, b) => b.graded - a.graded || b.units - a.units || b.picks - a.picks);
  }, [sources, experts, boardMode, grp, minGraded]);

  const openCount = inView.length;
  const pickedSites = new Set(sides.flatMap((s) => s.source_names || [])).size;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <h1 style={{ ...FH, fontSize: 21, margin: '0 0 4px' }}>Outside Picks — {cfg.title}</h1>
      <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginBottom: 14 }}>
        {lastRun ? <>Last picks pull {fmtET(lastRun.started_at)} ET ({lastRun.trigger}, {lastRun.picks} picks) · </> : null}
        <a href={cfg.log}>pull log &amp; Pull picks now</a> · <a href={cfg.board}>board</a>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        {cfg.daily && (
          <>
            <button style={btn} onClick={() => setDate(shift(date, -1))} aria-label="Previous day">←</button>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ ...btn, colorScheme: 'dark' }} />
            <button style={btn} onClick={() => setDate(shift(date, 1))} aria-label="Next day">→</button>
            <button style={btn} onClick={() => setDate(todayET())}>Today</button>
          </>
        )}
        {!cfg.daily && <span style={{ ...FM, fontSize: 12, color: C.sub }}>Games not yet final</span>}
        <span style={{ width: 8 }} />
        <Chip on={grp === 'all'} onClick={() => setGrp('all')}>All</Chip>
        <Chip on={grp === 'side'} onClick={() => setGrp('side')}>Sides</Chip>
        <Chip on={grp === 'total'} onClick={() => setGrp('total')}>Totals</Chip>
        <span style={{ ...FM, fontSize: 12, color: C.sub, marginLeft: 6 }}>
          {openCount} game-market{openCount === 1 ? '' : 's'} with picks · {pickedSites} site{pickedSites === 1 ? '' : 's'}
        </span>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10, marginBottom: 22 }}>
            <Spot title="Crowd + model" color={C.green} rows={spots.together}
              note="2+ sites on a side, leading by 2+, and the model is on it too." empty="None right now." />
            <Spot title="Crowd vs model" color={C.warn} rows={spots.against}
              note="2+ sites leading on a side the model does not like." empty="None right now." />
            <Spot title="Split" color={C.gold} rows={spots.splits}
              note="3+ sites picked it, divided within one site." empty="No real splits." />
            <Spot title="Line moving" color={C.blue} rows={spots.steam}
              note="2+ sites on a side and the line has moved 1+ since the open." empty="No big moves." />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <h2 style={{ ...FH, fontSize: 15, margin: 0, marginRight: 6 }}>Every game with picks</h2>
            {[1, 2, 3].map((n) => <Chip key={n} on={minSrc === n} onClick={() => setMinSrc(n)}>{n}+ site{n === 1 ? '' : 's'}</Chip>)}
          </div>
          <div style={{ ...tableBox, marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {['Start (ET)', 'Game', 'Market', 'Crowd side', 'Sites', 'Who', 'Model', '', 'Line move', 'Result'].map((h, i) => <th key={`${h}${i}`} style={head}>{h}</th>)}
              </tr></thead>
              <tbody>
                {table.length === 0 && <tr><td colSpan={10} style={{ ...cell, color: C.sub }}>No picks stored for {cfg.daily ? fmtDay(date) : 'these games'} yet.</td></tr>}
                {table.map((r) => {
                  const rel = REL[r.model_relation];
                  const mv = moveToward(r.crowd_side, r.open_line, r.market_line);
                  const names = r.crowd_side ? namesFor.get(`${r.game_id}|${r.grp}|${r.crowd_side}`) || [] : [];
                  const other = r.crowd_side ? namesFor.get(`${r.game_id}|${r.grp}|${{ home: 'away', away: 'home', over: 'under', under: 'over' }[r.crowd_side]}`) || [] : [];
                  return (
                    <tr key={`${r.game_id}|${r.grp}`}>
                      <td style={{ ...cell, ...FM, color: C.sub }}>{fmtStart(r.start_time)}</td>
                      <td style={cell}>{r.away} @ {r.home}</td>
                      <td style={{ ...cell, color: C.sub }}>{GROUPS[r.grp]}</td>
                      <td style={{ ...cell, fontWeight: 700 }}>{crowdLabel(r)}</td>
                      <td style={{ ...cell, ...FM }}><b>{num(r.crowd_sources)}</b><span style={{ color: C.sub }}>–{num(r.other_sources)}</span></td>
                      <td style={{ ...cell, whiteSpace: 'normal', minWidth: 180, fontSize: 12 }}>
                        {names.join(', ')}
                        {other.length ? <span style={{ color: C.sub }}> · vs {other.join(', ')}</span> : null}
                      </td>
                      <td style={{ ...cell, fontSize: 12 }}>{modelText(r, sport)}</td>
                      <td style={{ ...cell, fontSize: 11.5, fontWeight: 700, color: rel ? rel.color : C.sub }}>{rel ? rel.label : ''}</td>
                      <td style={{ ...cell, ...FM, color: mv === null ? C.sub : mv >= 1 ? C.green : mv <= -1 ? C.warn : C.text }}>
                        {mv === null ? '—' : `${mv > 0 ? '+' : ''}${mv}`}
                      </td>
                      <td style={{ ...cell, ...FM, fontWeight: 700, color: r.crowd_result === 'W' ? C.green : r.crowd_result === 'L' ? C.warn : C.sub }}>{r.crowd_result || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h2 style={{ ...FH, fontSize: 15, margin: '0 0 4px' }}>How the crowd&apos;s side has done</h2>
          <p style={{ fontSize: 12, color: C.sub, margin: '0 0 8px', maxWidth: 900, lineHeight: 1.55 }}>
            The side with more sites, graded against the market line ({sport === 'cbb' ? 'frozen at noon ET on game day' : 'the latest stored line'}). Flat 1 unit, -110.
            {unanimous.n ? ` Unanimous with 2+ sites: ${unanimous.text} (${pctText(unanimous.pct)}, ${unitsText(unanimous.units)}).` : ''} Small samples swing hard; treat anything under about 50 games as noise.
          </p>
          <div style={{ ...tableBox, marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['', 'All', 'With model', 'Against model'].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
              <tbody>
                {histRows.map(([label, k]) => (
                  <tr key={k}>
                    <td style={{ ...cell, fontWeight: 600 }}>{label}</td>
                    {['all', 'with', 'against'].map((rel) => {
                      const o = rec(history.get(`${k}|${rel}`));
                      return (
                        <td key={rel} style={{ ...cell, ...FM }}>
                          {o.n ? <>{o.text} <span style={{ color: C.sub }}>{pctText(o.pct)}</span> <span style={{ color: o.units > 0 ? C.green : o.units < 0 ? C.warn : C.sub }}>{unitsText(o.units)}</span></> : <span style={{ color: C.sub }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <h2 style={{ ...FH, fontSize: 15, margin: 0, marginRight: 6 }}>Source records</h2>
            <Chip on={boardMode === 'sites'} onClick={() => setBoardMode('sites')}>Sites</Chip>
            <Chip on={boardMode === 'experts'} onClick={() => setBoardMode('experts')}>Experts</Chip>
            <span style={{ width: 8 }} />
            {[0, 10, 25].map((n) => <Chip key={n} on={minGraded === n} onClick={() => setMinGraded(n)}>{n ? `${n}+ graded` : 'Any'}</Chip>)}
          </div>
          <div style={tableBox}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {['Site', ...(boardMode === 'experts' ? ['Expert'] : []), 'Picks', 'Graded', 'W-L-P', 'Win %', 'Units', 'Last pick'].map((h) => <th key={h} style={head}>{h}</th>)}
              </tr></thead>
              <tbody>
                {board.length === 0 && <tr><td colSpan={8} style={{ ...cell, color: C.sub }}>No records yet.</td></tr>}
                {board.map((o) => {
                  const n = o.w + o.l;
                  return (
                    <tr key={`${o.source_name}|${o.expert || ''}`}>
                      <td style={{ ...cell, fontWeight: 600 }}>{o.source_name}</td>
                      {boardMode === 'experts' && <td style={cell}>{o.expert}</td>}
                      <td style={{ ...cell, ...FM }}>{o.picks}</td>
                      <td style={{ ...cell, ...FM }}>{o.graded}</td>
                      <td style={{ ...cell, ...FM }}>{o.w}-{o.l}{o.p ? `-${o.p}` : ''}</td>
                      <td style={{ ...cell, ...FM }}>{n ? `${((100 * o.w) / n).toFixed(1)}%` : '—'}</td>
                      <td style={{ ...cell, ...FM, color: o.units > 0 ? C.green : o.units < 0 ? C.warn : C.sub }}>{unitsText(o.units)}</td>
                      <td style={{ ...cell, ...FM, color: C.sub }}>{fmtET(o.last)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 22, fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
            <summary style={{ cursor: 'pointer', color: C.text }}>How to read this page</summary>
            <p><b style={{ color: C.text }}>Sites</b> count once, toward the side most of their experts picked; a site whose experts split evenly (CBS&apos;s expert grid often does) counts on neither. So no single site can stack up a side. &ldquo;3–1&rdquo; means 3 sites on the crowd&apos;s side and 1 on the other. In the NFL most sites pick every game, so close splits are normal there; the stronger signal is a lopsided count.</p>
            <p><b style={{ color: C.text }}>Sides</b> combine spread and moneyline picks on a team; <b style={{ color: C.text }}>Totals</b> are full-game over/unders. Halves and team totals are listed in each game&apos;s drawer on the board but not counted here.</p>
            <p><b style={{ color: C.text }}>Line move</b> is how far the market has moved toward (+) or away from (-) the crowd&apos;s side since the opener. Source records grade each pick at the number the source gave (moneylines straight up, units only when odds were stated).</p>
            <p>This is research, not a betting signal yet: none of these patterns has a forward record. The score that combines them with the model comes after enough games are graded.</p>
          </details>
        </>
      )}
    </main>
  );
}
