'use client';

// Pull log: every NFL cycle (scheduled or manual) and what it did.

import { useEffect, useState } from 'react';
import RefreshButton from '../_ui/RefreshButton';
import ScoutPanel from '../../_scout/ScoutPanel';
import { C, FH, FM, fmtET, runLog } from '../../../lib/nfl2';

const cell = { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const v = (x) => (x === null || x === undefined ? '—' : x);

const STATUS = {
  ok: { label: 'OK', color: '#6FBF73' }, error: { label: 'Error', color: '#E07A62' }, running: { label: 'Running', color: '#D4A73C' },
};

function note(r) {
  if (r.error) return r.error;
  if (r.unmatched) return `Not matched to a game: ${r.unmatched}`;
  if (!r.ats_rows && !r.ou_rows) return 'PredictionTracker had no NFL rows';
  return '';
}

export default function NflLog() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => runLog(100).then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>NFL — Pull Log</h1>
        <RefreshButton onDone={load} />
      </div>
      <p style={{ fontSize: 12.5, color: C.sub, margin: '0 0 14px', maxWidth: 860, lineHeight: 1.6 }}>
        Scheduled pulls run at 8:15 AM, 12:15 PM and 4:45 PM ET every day, plus 12:35 and 3:40 PM ET on Sundays. Each one syncs
        ESPN (schedule, kickoffs, finals), loads PredictionTracker&rsquo;s season files for anything missed, pulls this week&rsquo;s spread
        and total predictions, grades, reweights the systems and recomputes. Games freeze at kickoff. Showing the last 100.
      </p>
      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              {['Started (ET)', 'Trigger', 'Status', 'Week', 'ESPN updates', 'ATS rows', 'O/U rows', 'Lines moved', 'Preds added', 'Preds changed', 'Signals', 'Graded', 'Note'].map((h) => <th key={h} style={head}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS[r.status] || { label: r.status, color: C.sub };
                return (
                  <tr key={r.id}>
                    <td style={{ ...cell, ...FM }}>{fmtET(r.started_at)}</td>
                    <td style={cell}>{r.trigger === 'manual' ? 'Manual' : 'Scheduled'}</td>
                    <td style={{ ...cell, fontWeight: 700, color: st.color }}>{st.label}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.week)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.espn_changed)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.ats_rows)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.ou_rows)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.lines_changed)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.preds_added)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.preds_changed)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.signals)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.graded)}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', color: r.error ? C.warn : C.sub, minWidth: 180 }}>{note(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 28, paddingTop: 20 }}>
        <ScoutPanel sport="nfl" schedule="Scheduled pulls run Thursdays at noon and Sundays at 11 AM ET." />
      </div>
    </main>
  );
}
