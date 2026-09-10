'use client';
import { useEffect, useState } from 'react';
import { sbFetch, fmt, getCurrentWeek } from '../../lib/supabase';

export default function Results() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null); // resolved to the latest week with games below
  const [mode, setMode] = useState('week'); // 'week' | 'season'

  useEffect(() => {
    let cancelled = false;
    getCurrentWeek(season).then((w) => { if (!cancelled) setWeek(w); });
    return () => { cancelled = true; };
  }, [season]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState('ats_pct');
  const [sortDir, setSortDir] = useState('desc');

  const [suggested, setSuggested] = useState({ wins: 0, losses: 0, pushes: 0 });
  const [userPicks, setUserPicks] = useState({ wins: 0, losses: 0, pushes: 0 });
  const [modelRows, setModelRows] = useState([]);

  const weekFilter = mode === 'week' ? `week=eq.${week}` : `week=lte.${week}`;

  const load = async () => {
    setLoading(true); setError(null);
    try {
      // Games in scope (this week, or every week up to it for season-to-date)
      const games = await sbFetch(`games?select=id&season=eq.${season}&${weekFilter}`);
      const gameIds = games.map((g) => g.id);
      const idList = gameIds.length ? `(${gameIds.join(',')})` : '(00000000-0000-0000-0000-000000000000)';

      // Suggested-play (ensemble) record for the games in scope
      const metricsRows = await sbFetch(
        `game_metrics?select=id,suggested_play,pick_grades(ats_result)&game_id=in.${idList}&suggested_play=eq.true`
      );
      setSuggested(tally(metricsRows.map((m) => m.pick_grades?.ats_result)));

      // Your own logged picks for the games in scope
      const picks = await sbFetch(`user_picks?select=result,played,is_custom&game_id=in.${idList}`);
      setUserPicks(tally(picks.filter((p) => p.played && !p.is_custom).map((p) => p.result)));

      // Every individual model's graded picks for the games in scope.
      // Paginate in chunks of 1000 — PostgREST silently caps unpaginated
      // selects at 1000 rows, so a week with 35+ models × 43 games = 1,500+
      // rows gets truncated, showing only ~29 games per model instead of 43.
      const PAGE = 1000;
      let allGrades = [], from = 0;
      while (true) {
        const chunk = await sbFetch(
          `model_pick_grades?select=model_id,ats_result,abs_error,signed_error,source_models(system_name,status)&season=eq.${season}&${weekFilter}&offset=${from}&limit=${PAGE}`
        );
        allGrades = allGrades.concat(chunk);
        if (chunk.length < PAGE) break;
        from += PAGE;
      }
      setModelRows(aggregateByModel(allGrades));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (week != null) load(); }, [season, week, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = [...modelRows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
  });

  function toggleSort(k) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('desc'); }
  }

  const poolTotals = modelRows.reduce(
    (acc, r) => ({ wins: acc.wins + r.wins, losses: acc.losses + r.losses, pushes: acc.pushes + r.pushes }),
    { wins: 0, losses: 0, pushes: 0 }
  );

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>📅 Weekly Results</h1>
          <p>How the full model pool, the suggested plays, and your own picks actually performed</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
          <input type="number" value={season} onChange={(e) => setSeason(+e.target.value)} style={inp} />
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
          <input type="number" value={week ?? ''} onChange={(e) => setWeek(+e.target.value)} style={{ ...inp, width: 70 }} />
          <div style={{ display: 'flex', border: '1px solid #2a3042', borderRadius: 6, overflow: 'hidden' }}>
            <button
              onClick={() => setMode('week')}
              style={toggleBtn(mode === 'week')}
            >This Week</button>
            <button
              onClick={() => setMode('season')}
              style={toggleBtn(mode === 'season')}
            >Season to Date</button>
          </div>
          <button className="btn btn-outline" onClick={load} style={{ fontSize: 12 }}>↻ Refresh</button>
        </div>
      </div>

      {loading && <div className="loading">Loading results…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            <SummaryCard title="Suggested Plays" record={suggested} note="Edge \u22651.5, StdDev \u22642.5, Agreement \u226585%" />
            <SummaryCard title="My Picks" record={userPicks} note="Played, non-custom picks" />
            <SummaryCard title="Full Model Pool" record={poolTotals} note={`${modelRows.length} systems graded`} />
          </div>

          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    ['system_name', 'Model'],
                    ['games', 'Games'],
                    ['ats_pct', 'ATS%'],
                    ['mae', 'MAE'],
                    ['bias', 'Bias'],
                    ['wins', 'W'],
                    ['losses', 'L'],
                    ['pushes', 'P'],
                  ].map(([k, label]) => (
                    <th key={k} className="sortable" onClick={() => toggleSort(k)}>
                      {label}{sortKey === k ? (sortDir === 'asc' ? ' \u25b2' : ' \u25bc') : ''}
                    </th>
                  ))}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.model_id}>
                    <td style={{ fontWeight: 700 }}>{r.system_name}</td>
                    <td>{r.games}</td>
                    <td style={{ color: r.ats_pct >= 0.524 ? '#38bd94' : 'inherit', fontWeight: r.ats_pct >= 0.524 ? 700 : 400 }}>
                      {r.ats_pct != null ? `${(r.ats_pct * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td>{fmt(r.mae, 2)}</td>
                    <td style={{ color: Math.abs(r.bias) > 1 ? '#facc15' : 'inherit' }}>{fmt(r.bias, 2)}</td>
                    <td style={{ color: '#38bd94' }}>{r.wins}</td>
                    <td style={{ color: '#f87171' }}>{r.losses}</td>
                    <td style={{ color: '#facc15' }}>{r.pushes}</td>
                    <td><span className="badge">{r.status || '—'}</span></td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr><td colSpan={9} className="empty">No graded model picks for this selection yet — run Grade Results on the Ingest page first.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p style={{ fontSize: 12, color: '#5b6272', marginTop: 16 }}>
        "Full Model Pool" grades every system's raw prediction against the market line for each game, regardless of whether it was one of the Top-7 used in that week's consensus.
        This is the same data the weekly recalibration blends into next week's rankings.
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

function aggregateByModel(grades) {
  const byModel = new Map();
  for (const g of grades) {
    const key = g.model_id;
    const row = byModel.get(key) || {
      model_id: key,
      system_name: g.source_models?.system_name || 'Unknown',
      status: g.source_models?.status,
      wins: 0, losses: 0, pushes: 0, games: 0, sumAbsErr: 0, sumErr: 0,
    };
    if (g.ats_result === 'win') row.wins++;
    else if (g.ats_result === 'loss') row.losses++;
    else row.pushes++;
    row.sumAbsErr += g.abs_error != null ? parseFloat(g.abs_error) : 0;
    row.sumErr += g.signed_error != null ? parseFloat(g.signed_error) : 0;
    row.games++;
    byModel.set(key, row);
  }
  return Array.from(byModel.values()).map((r) => {
    const decided = r.wins + r.losses;
    return {
      ...r,
      ats_pct: decided > 0 ? r.wins / decided : null,
      mae: r.games > 0 ? r.sumAbsErr / r.games : null,
      bias: r.games > 0 ? r.sumErr / r.games : null,
    };
  });
}

function SummaryCard({ title, record, note }) {
  const decided = record.wins + record.losses;
  const pct = decided > 0 ? ((record.wins / decided) * 100).toFixed(1) : '—';
  return (
    <div className="card">
      <div style={{ fontSize: 12, color: '#8a92a3', fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>
        <span style={{ color: '#38bd94' }}>{record.wins}</span>
        <span style={{ color: '#5b6272' }}>-</span>
        <span style={{ color: '#f87171' }}>{record.losses}</span>
        {record.pushes > 0 && <span style={{ color: '#facc15' }}>-{record.pushes}</span>}
        {decided > 0 && <span style={{ fontSize: 14, color: '#8a92a3', marginLeft: 8 }}>{pct}%</span>}
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
