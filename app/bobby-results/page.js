'use client';
import { useEffect, useState } from 'react';
import { sbFetch, fmt } from '../../lib/supabase';

const CONFIDENCE_ORDER = ['Very Strong', 'Strong', 'Moderate', 'Weak', 'Very Weak'];
const BREAKEVEN = 0.524; // standard -110 juice
const EDGE_BUCKETS = [
  { label: '0 - 1.5', min: 0, max: 1.5 },
  { label: '1.5 - 3', min: 1.5, max: 3 },
  { label: '3 - 5', min: 3, max: 5 },
  { label: '5 - 7', min: 5, max: 7 },
  { label: '7+', min: 7, max: Infinity },
];

export default function BobbyResults() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const [mode, setMode] = useState('week'); // 'week' | 'season'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [allSlate, setAllSlate] = useState({ wins: 0, losses: 0, pushes: 0 });
  const [suggested, setSuggested] = useState({ wins: 0, losses: 0, pushes: 0 });
  const [binRows, setBinRows] = useState([]);
  const [edgeRows, setEdgeRows] = useState([]);
  const [weeklyTrend, setWeeklyTrend] = useState([]);

  const weekFilter = mode === 'week' ? `week=eq.${week}` : `week=lte.${week}`;

  const load = async () => {
    setLoading(true); setError(null);
    try {
      // ---- Top summary + breakdowns for the selected scope (This Week / Season to Date) ----
      const games = await sbFetch(`games?select=id&season=eq.${season}&${weekFilter}`);
      const gameIds = games.map((g) => g.id);
      const idList = gameIds.length ? `(${gameIds.join(',')})` : '(00000000-0000-0000-0000-000000000000)';

      const metrics = await sbFetch(
        `game_metrics?select=id,game_id,edge,mss,confidence_bin,suggested_play,pick_grades(ats_result)&game_id=in.${idList}`
      );
      const graded = metrics
        .map((m) => ({ ...m, pg: Array.isArray(m.pick_grades) ? m.pick_grades[0] : m.pick_grades }))
        .filter((m) => m.pg);

      setAllSlate(tally(graded.map((m) => m.pg.ats_result)));
      setSuggested(tally(graded.filter((m) => m.suggested_play).map((m) => m.pg.ats_result)));
      setBinRows(bucketBy(graded, (m) => m.confidence_bin || 'Very Weak', CONFIDENCE_ORDER));
      setEdgeRows(bucketByEdge(graded));

      // ---- Weekly trend, always spans season start through the selected week ----
      const trendGames = await sbFetch(`games?select=id,week&season=eq.${season}&week=lte.${week}`);
      const trendGameIds = trendGames.map((g) => g.id);
      const trendIdList = trendGameIds.length ? `(${trendGameIds.join(',')})` : '(00000000-0000-0000-0000-000000000000)';
      const weekByGame = new Map(trendGames.map((g) => [g.id, g.week]));

      const trendMetrics = await sbFetch(
        `game_metrics?select=id,game_id,suggested_play,pick_grades(ats_result)&game_id=in.${trendIdList}`
      );
      const trendGraded = trendMetrics
        .map((m) => ({ ...m, pg: Array.isArray(m.pick_grades) ? m.pick_grades[0] : m.pick_grades, week: weekByGame.get(m.game_id) }))
        .filter((m) => m.pg);

      const byWeek = new Map();
      for (const m of trendGraded) {
        const row = byWeek.get(m.week) || { week: m.week, all: [], suggested: [] };
        row.all.push(m.pg.ats_result);
        if (m.suggested_play) row.suggested.push(m.pg.ats_result);
        byWeek.set(m.week, row);
      }
      setWeeklyTrend(
        Array.from(byWeek.values())
          .sort((a, b) => a.week - b.week)
          .map((r) => ({ week: r.week, all: tally(r.all), suggested: tally(r.suggested) }))
      );
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [season, week, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const insights = buildInsights({ allSlate, suggested, binRows, edgeRows });

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>🏈 Bobby Model Results</h1>
          <p>How the BobbyModels consensus itself performed &mdash; every game, not just the qualified plays</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
          <input type="number" value={season} onChange={(e) => setSeason(+e.target.value)} style={inp} />
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
          <input type="number" value={week} onChange={(e) => setWeek(+e.target.value)} style={{ ...inp, width: 70 }} />
          <div style={{ display: 'flex', border: '1px solid #2a3042', borderRadius: 6, overflow: 'hidden' }}>
            <button onClick={() => setMode('week')} style={toggleBtn(mode === 'week')}>This Week</button>
            <button onClick={() => setMode('season')} style={toggleBtn(mode === 'season')}>Season to Date</button>
          </div>
          <button className="btn btn-outline" onClick={load} style={{ fontSize: 12 }}>↻ Refresh</button>
        </div>
      </div>

      {loading && <div className="loading">Loading results…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 20 }}>
            <SummaryCard title="All 43 Plays (Full Slate)" record={allSlate} note="Every graded game, win or lose" />
            <SummaryCard title="Suggested Plays" record={suggested} note="Edge \u22651.5, StdDev \u22642.5, Agreement \u226585%" highlight />
          </div>

          {insights.length > 0 && (
            <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(250,204,21,.3)' }}>
              <div style={{ fontSize: 12, color: '#facc15', fontWeight: 800, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Calibration Notes
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, color: '#c9cedb', fontSize: 13, lineHeight: 1.8 }}>
                {insights.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 12, color: '#8a92a3', fontWeight: 700, marginBottom: 8 }}>By Confidence Bin</div>
              <BreakdownTable rows={binRows} labelKey="label" />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#8a92a3', fontWeight: 700, marginBottom: 8 }}>By Edge Size (points)</div>
              <BreakdownTable rows={edgeRows} labelKey="label" />
            </div>
          </div>

          <div style={{ fontSize: 12, color: '#8a92a3', fontWeight: 700, marginBottom: 8 }}>Week-by-Week Trend (through Week {week})</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Suggested W-L-P</th>
                  <th>Suggested ATS%</th>
                  <th>Full Slate W-L-P</th>
                  <th>Full Slate ATS%</th>
                </tr>
              </thead>
              <tbody>
                {weeklyTrend.map((r) => (
                  <tr key={r.week}>
                    <td style={{ fontWeight: 700 }}>Week {r.week}</td>
                    <td>{recordStr(r.suggested)}</td>
                    <td>{pctCell(r.suggested)}</td>
                    <td>{recordStr(r.all)}</td>
                    <td>{pctCell(r.all)}</td>
                  </tr>
                ))}
                {weeklyTrend.length === 0 && <tr><td colSpan={5} className="empty">No graded weeks yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p style={{ fontSize: 12, color: '#5b6272', marginTop: 16 }}>
        "Full Slate" grades the consensus pick (whichever side has the edge) for every game, regardless of whether it cleared the qualification filter.
        Comparing it to "Suggested Plays" shows whether the filter is actually adding value, and the bin/edge breakdowns show whether MSS and edge size are calibrated the way the 2021-2025 backtest predicted.
      </p>
    </div>
  );
}

function tally(results) {
  return results.reduce((acc, r) => {
    if (r === 'win') acc.wins++;
    else if (r === 'loss') acc.losses++;
    else if (r === 'push') acc.pushes++;
    return acc;
  }, { wins: 0, losses: 0, pushes: 0 });
}

function pct(record) {
  const decided = record.wins + record.losses;
  return decided > 0 ? record.wins / decided : null;
}

function recordStr(record) {
  return `${record.wins}-${record.losses}${record.pushes ? `-${record.pushes}` : ''}`;
}

function pctCell(record) {
  const p = pct(record);
  if (p == null) return '—';
  return <span style={{ color: p >= BREAKEVEN ? '#38bd94' : '#f87171', fontWeight: 700 }}>{(p * 100).toFixed(1)}%</span>;
}

function bucketBy(graded, keyFn, order) {
  const map = new Map();
  for (const m of graded) {
    const k = keyFn(m);
    const row = map.get(k) || { label: k, results: [] };
    row.results.push(m.pg.ats_result);
    map.set(k, row);
  }
  const rows = Array.from(map.values()).map((r) => ({ label: r.label, record: tally(r.results) }));
  return rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

function bucketByEdge(graded) {
  return EDGE_BUCKETS.map((b) => {
    const results = graded
      .filter((m) => m.edge != null && Math.abs(parseFloat(m.edge)) >= b.min && Math.abs(parseFloat(m.edge)) < b.max)
      .map((m) => m.pg.ats_result);
    return { label: b.label, record: tally(results) };
  });
}

function buildInsights({ allSlate, suggested, binRows, edgeRows }) {
  const notes = [];
  const allPct = pct(allSlate);
  const sugPct = pct(suggested);

  if (allPct != null && sugPct != null) {
    if (sugPct > allPct) {
      notes.push(`The qualification filter is working: suggested plays are hitting ${(sugPct * 100).toFixed(1)}% vs ${(allPct * 100).toFixed(1)}% for the full slate.`);
    } else if (allPct - sugPct > 0.03) {
      notes.push(`Full-slate ATS% (${(allPct * 100).toFixed(1)}%) is currently beating suggested plays (${(sugPct * 100).toFixed(1)}%) \u2014 worth watching if this holds up over more games before trusting it.`);
    }
  }

  for (const row of binRows) {
    const decided = row.record.wins + row.record.losses;
    if (decided < 5) continue; // too small a sample to flag
    const p = row.record.wins / decided;
    if (p < BREAKEVEN - 0.03) {
      notes.push(`"${row.label}" confidence games are hitting only ${(p * 100).toFixed(1)}% ATS over ${decided} decided games \u2014 below the ${(BREAKEVEN * 100).toFixed(1)}% breakeven line.`);
    } else if (p > BREAKEVEN + 0.08) {
      notes.push(`"${row.label}" confidence games are running hot at ${(p * 100).toFixed(1)}% ATS over ${decided} games.`);
    }
  }

  for (const row of edgeRows) {
    const decided = row.record.wins + row.record.losses;
    if (decided < 5) continue;
    const p = row.record.wins / decided;
    if (p < BREAKEVEN - 0.03) {
      notes.push(`Edge bucket ${row.label} pts is underperforming at ${(p * 100).toFixed(1)}% ATS over ${decided} games.`);
    }
  }

  return notes;
}

function BreakdownTable({ rows }) {
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr><th>Bucket</th><th>Games</th><th>W-L-P</th><th>ATS%</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const decided = r.record.wins + r.record.losses;
            return (
              <tr key={r.label}>
                <td style={{ fontWeight: 700 }}>{r.label}</td>
                <td>{decided + r.record.pushes}</td>
                <td>{recordStr(r.record)}</td>
                <td>{pctCell(r.record)}</td>
              </tr>
            );
          })}
          {rows.every((r) => r.record.wins + r.record.losses + r.record.pushes === 0) && (
            <tr><td colSpan={4} className="empty">No graded games in this bucket yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SummaryCard({ title, record, note, highlight }) {
  const decided = record.wins + record.losses;
  const p = pct(record);
  return (
    <div className="card" style={highlight ? { borderColor: 'rgba(56,189,148,.3)' } : {}}>
      <div style={{ fontSize: 12, color: '#8a92a3', fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>
        <span style={{ color: '#38bd94' }}>{record.wins}</span>
        <span style={{ color: '#5b6272' }}>-</span>
        <span style={{ color: '#f87171' }}>{record.losses}</span>
        {record.pushes > 0 && <span style={{ color: '#facc15' }}>-{record.pushes}</span>}
        {decided > 0 && <span style={{ fontSize: 14, color: '#8a92a3', marginLeft: 8 }}>{(p * 100).toFixed(1)}%</span>}
      </div>
      <div style={{ fontSize: 11, color: '#5b6272', marginTop: 4 }}>{note}</div>
    </div>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110 };

function toggleBtn(active) {
  return {
    background: active ? '#38bd94' : '#0b0e14',
    color: active ? '#0b0e14' : '#8a92a3',
    border: 'none',
    padding: '7px 12px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  };
}
