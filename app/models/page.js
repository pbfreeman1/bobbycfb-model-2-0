'use client';
import { useEffect, useState } from 'react';
import { sbFetch, fmt } from '../../lib/supabase';

export default function Models() {
  const [season, setSeason] = useState(2026);
  const [grades, setGrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState('rank');
  const [sortDir, setSortDir] = useState('asc');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const data = await sbFetch(`model_grades?select=*,source_models(colname,system_name,status)&as_of_season=eq.${season}&order=rank.asc`);
      setGrades(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [season]);

  const sorted = [...grades].sort((a, b) => {
    const av = a[sortKey] ?? (sortDir === 'asc' ? Infinity : -Infinity);
    const bv = b[sortKey] ?? (sortDir === 'asc' ? Infinity : -Infinity);
    return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
  });

  function toggleSort(k) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('asc'); }
  }

  const top7 = sorted.slice(0, 7);

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>🤖 Model Scoreboard</h1>
          <p>Walk-forward historical rankings of all source prediction systems</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>As-of Season</label>
          <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inp} />
          <button className="btn btn-outline" onClick={load} style={{ fontSize: 12 }}>↻ Refresh</button>
        </div>
      </div>

      {/* Top 7 badge grid */}
      {top7.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: '#38bd94', fontWeight: 800, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '.05em' }}>Top-7 Active Pool (used in current consensus)</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {top7.map((g, i) => (
              <div key={g.id} style={{ background: '#0b0e14', border: '1px solid rgba(56,189,148,.3)', borderRadius: 8, padding: '8px 14px', minWidth: 120 }}>
                <div style={{ fontSize: 10, color: '#38bd94', fontWeight: 800, marginBottom: 2 }}>#{i + 1}</div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{g.source_models?.system_name || g.source_models?.colname}</div>
                <div style={{ fontSize: 11, color: '#8a92a3' }}>{g.ats_pct != null ? `${(g.ats_pct * 100).toFixed(1)}% ATS` : '—'} · {g.games_graded} games</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="loading">Loading models…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                {[['rank','Rank'],['source_models.system_name','Model'],['games_graded','Games'],['ats_pct','ATS%'],['shrunk_ats_pct','Shrunk ATS%'],['mae','MAE'],['bias','Bias'],['ats_wins','W'],['ats_losses','L'],['ats_pushes','P']].map(([k, label]) => (
                  <th key={k} className="sortable" onClick={() => toggleSort(k)}>
                    {label}{sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((g, i) => {
                const inTop7 = i < 7;
                return (
                  <tr key={g.id} style={inTop7 ? { background: 'rgba(56,189,148,.04)' } : {}}>
                    <td style={{ fontWeight: 800, color: inTop7 ? '#38bd94' : '#e6e9ef' }}>#{g.rank ?? (i+1)}</td>
                    <td style={{ fontWeight: 700 }}>{g.source_models?.system_name || g.source_models?.colname}</td>
                    <td>{g.games_graded}</td>
                    <td style={{ color: g.ats_pct >= 0.524 ? '#38bd94' : 'inherit', fontWeight: g.ats_pct >= 0.524 ? 700 : 400 }}>
                      {g.ats_pct != null ? `${(g.ats_pct * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td>{g.shrunk_ats_pct != null ? `${(g.shrunk_ats_pct * 100).toFixed(1)}%` : '—'}</td>
                    <td>{fmt(g.mae, 2)}</td>
                    <td style={{ color: g.bias != null && Math.abs(g.bias) > 1 ? '#facc15' : 'inherit' }}>{fmt(g.bias, 2)}</td>
                    <td style={{ color: '#38bd94' }}>{g.ats_wins}</td>
                    <td style={{ color: '#f87171' }}>{g.ats_losses}</td>
                    <td style={{ color: '#facc15' }}>{g.ats_pushes}</td>
                    <td>
                      <span className="badge">{g.source_models?.status || '—'}</span>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && <tr><td colSpan={11} className="empty">No model grades found for season {season}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 12, color: '#5b6272', marginTop: 16 }}>
        Walk-forward grading: each season's rankings are built only from prior seasons, preventing data leakage.
        52.4% is the breakeven threshold at standard −110 juice. Shrunk ATS% applies a Bayesian shrinkage toward 50%.
      </p>
    </div>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110 };
