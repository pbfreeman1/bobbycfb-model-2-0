'use client';
import { useState } from 'react';

export default function Ingest() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState([]);

  function addLog(msg, type = 'info') {
    setLog(prev => [...prev, { msg, type, t: new Date().toLocaleTimeString() }]);
  }

  async function runCFBDSync() {
    setLoading(true); setStatus(null);
    addLog(`Starting CFBD sync for ${season} Week ${week}…`);
    try {
      const res = await fetch(`/api/cfbd-sync?season=${season}&week=${week}`);
      const data = await res.json();
      if (data.error) { addLog(`Error: ${data.error}`, 'error'); setStatus('error'); }
      else {
        addLog(`Synced ${data.games || 0} games, ${data.updated || 0} updated with kickoff/TV/O/U`, 'ok');
        setStatus('ok');
      }
    } catch (e) { addLog(`Network error: ${e.message}`, 'error'); setStatus('error'); }
    finally { setLoading(false); }
  }

  async function runComputeEngine() {
    setLoading(true); setStatus(null);
    addLog(`Running compute engine for ${season} Week ${week}…`);
    try {
      const res = await fetch(`/api/compute?season=${season}&week=${week}`, { method: 'POST' });
      const data = await res.json();
      if (data.error) { addLog(`Error: ${data.error}`, 'error'); setStatus('error'); }
      else {
        addLog(`Computed metrics for ${data.games || 0} games. Plays: ${data.plays || 0}`, 'ok');
        setStatus('ok');
      }
    } catch (e) { addLog(`Network error: ${e.message}`, 'error'); setStatus('error'); }
    finally { setLoading(false); }
  }

  async function gradeResults() {
    setLoading(true); setStatus(null);
    addLog(`Grading results for ${season} Week ${week}…`);
    try {
      const res = await fetch(`/api/grade?season=${season}&week=${week}`, { method: 'POST' });
      const data = await res.json();
      if (data.error) { addLog(`Error: ${data.error}`, 'error'); setStatus('error'); }
      else { addLog(`Graded ${data.graded || 0} games.`, 'ok'); setStatus('ok'); }
    } catch (e) { addLog(`Network error: ${e.message}`, 'error'); setStatus('error'); }
    finally { setLoading(false); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>⚙️ Data Ingest</h1>
        <p>Pull CFBD schedule/TV/O/U data, trigger compute engine, grade completed games</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
          <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inp} />
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
          <input type="number" value={week} onChange={e => setWeek(+e.target.value)} style={{ ...inp, width: 70 }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          <IngestStep
            number={1}
            title="CFBD Sync"
            desc="Pull kickoff times, TV networks, and O/U from CFBD API and update the games table."
            action="Run CFBD Sync"
            onClick={runCFBDSync}
            loading={loading}
          />
          <IngestStep
            number={2}
            title="Compute Engine"
            desc="Run the model-of-models engine on raw_predictions to produce game_metrics (consensus, edge, MSS, plays)."
            action="Run Compute"
            onClick={runComputeEngine}
            loading={loading}
          />
          <IngestStep
            number={3}
            title="Grade Results"
            desc="After games are final, pull scores from CFBD and grade all pick_grades and user_picks."
            action="Grade Results"
            onClick={gradeResults}
            loading={loading}
          />
        </div>
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Run Log</div>
            <button className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setLog([])}>Clear</button>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {log.map((l, i) => (
              <div key={i} style={{ padding: '4px 0', color: l.type === 'error' ? '#f87171' : l.type === 'ok' ? '#38bd94' : '#8a92a3', borderBottom: '1px solid #131722' }}>
                <span style={{ color: '#3a404e', marginRight: 8 }}>{l.t}</span>{l.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 24 }} className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Weekly Pipeline Reference</div>
        <ol style={{ color: '#8a92a3', fontSize: 13, lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
          <li>Download the week's predictions CSV from thepredictiontracker.com</li>
          <li>Paste the insert SQL into Supabase SQL Editor (raw_predictions batch insert)</li>
          <li>Run CFBD Sync above to populate kickoff times, TV, and O/U</li>
          <li>Run Compute Engine to generate game_metrics and suggested plays</li>
          <li>After games are played, run Grade Results to update pick outcomes</li>
        </ol>
      </div>
    </div>
  );
}

function IngestStep({ number, title, desc, action, onClick, loading }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 28, height: 28, borderRadius: '50%', background: '#38bd94', color: '#0b0e14', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>{number}</span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: '#8a92a3', lineHeight: 1.5 }}>{desc}</p>
      <button className="btn btn-primary" onClick={onClick} disabled={loading} style={{ fontSize: 13, marginTop: 'auto' }}>
        {loading ? 'Running…' : action}
      </button>
    </div>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110 };
