'use client';
import { useEffect, useState } from 'react';
import { sbFetch, fmt } from '../../lib/supabase';

export default function Calibration() {
  const [runs, setRuns] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const [rData, mData] = await Promise.all([
          sbFetch('backtest_runs?select=*&order=run_at.desc'),
          // Paginated count via range header
          fetch('https://zpmdrazbqgzheqkvfltv.supabase.co/rest/v1/game_metrics?select=suggested_play,confidence_bin&suggested_play=eq.true', {
            headers: {
              apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag',
              Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag',
              'Range-Unit': 'items',
              'Range': '0-9999',
              Prefer: 'count=exact',
            },
          }).then(async r => ({ count: parseInt(r.headers.get('Content-Range')?.split('/')[1] || '0'), data: await r.json() })),
        ]);
        setRuns(rData);
        setMetrics(mData);
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    }
    load();
  }, []);

  const latest = runs[0];
  const results = latest?.results || {};

  return (
    <div className="page">
      <div className="page-header">
        <h1>📈 Calibration</h1>
        <p>Founding backtest results and live qualification filter performance tracking</p>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && latest && (
        <>
          {/* Big numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
            <StatCard label="Games Evaluated" value={latest.games_evaluated?.toLocaleString()} />
            <StatCard label="Overall ATS%" value={results.overall_ats_pct != null ? `${(results.overall_ats_pct * 100).toFixed(2)}%` : '—'} />
            <StatCard label="Qualified Plays" value={results.qualified_plays} highlight />
            <StatCard label="Qualified ATS%" value={results.qualified_ats_pct != null ? `${(results.qualified_ats_pct * 100).toFixed(2)}%` : '—'} highlight />
            <StatCard label="Breakeven" value="52.4%" sub="at −110 juice" />
            <StatCard label="Live Plays Tracked" value={metrics?.count ?? '—'} />
          </div>

          {/* Qualification criteria */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>Qualification Filter (Empirically Validated)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
              <FilterCrit label="Edge" value="≥ 1.5 pts" sub="consensus vs. Vegas line" />
              <FilterCrit label="Agreement" value="≥ 85%" sub="Top-7 models on same side" />
              <FilterCrit label="StdDev" value="≤ 2.5 pts" sub="prediction spread across models" />
              <FilterCrit label="Edge Ceiling" value="≤ 7 pts" sub="7+ pt edges → only 38.8% ATS" />
            </div>
          </div>

          {/* Runs history */}
          <div style={{ fontSize: 12, fontWeight: 700, color: '#5b6272', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>Backtest Run History</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Seasons</th>
                  <th>Games</th>
                  <th>Qualified Plays</th>
                  <th>Qualified ATS%</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => {
                  const res = r.results || {};
                  return (
                    <tr key={r.id}>
                      <td style={{ color: '#8a92a3', fontSize: 12 }}>{new Date(r.run_at).toLocaleDateString()}</td>
                      <td>{r.description}</td>
                      <td style={{ color: '#8a92a3' }}>{r.seasons_used?.join(', ')}</td>
                      <td>{r.games_evaluated?.toLocaleString()}</td>
                      <td style={{ color: '#38bd94', fontWeight: 700 }}>{res.qualified_plays ?? '—'}</td>
                      <td style={{ color: '#38bd94', fontWeight: 700 }}>{res.qualified_ats_pct != null ? `${(res.qualified_ats_pct * 100).toFixed(2)}%` : '—'}</td>
                    </tr>
                  );
                })}
                {runs.length === 0 && <tr><td colSpan={6} className="empty">No backtest runs found.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, highlight }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#5b6272', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: highlight ? '#38bd94' : '#e6e9ef', lineHeight: 1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#5b6272', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function FilterCrit({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#5b6272', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#38bd94' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#8a92a3', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
