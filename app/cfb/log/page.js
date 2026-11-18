'use client';

// Pull log: every CFB cycle (scheduled or manual) and what it did.

import { useEffect, useState } from 'react';
import RefreshButton from '../_ui/RefreshButton';
import { C, FH, FM } from '../../../lib/nfl-board';
import { fmtET, runLog } from '../../../lib/cfb-auto';

const cell = { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const v = (x) => (x === null || x === undefined ? '—' : x);

const STATUS = {
  ok: { label: 'OK', color: '#6FBF73' }, error: { label: 'Error', color: '#E07A62' }, running: { label: 'Running', color: '#D4A73C' },
};

function note(r) {
  const parts = [];
  if (r.error) parts.push(r.error);
  if (r.unmatched) parts.push(`Not matched to a game: ${r.unmatched}`);
  if (r.new_columns) parts.push(`New PT systems (status "verify", not weighted until approved): ${r.new_columns}`);
  if (r.games_added) parts.push(`${r.games_added} games added from ESPN`);
  if (r.backfilled) parts.push(`${r.backfilled} missing predictions filled from PT's season file`);
  if (r.my_picks_graded) parts.push(`${r.my_picks_graded} My Card picks graded`);
  return parts.join(' · ');
}

export default function CfbLog() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => runLog(100).then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>CFB — Pull Log</h1>
        <RefreshButton onDone={load} />
      </div>
      <p style={{ fontSize: 12.5, color: C.sub, margin: '0 0 14px', maxWidth: 860, lineHeight: 1.6 }}>
        Scheduled pulls run at 8:30 AM, 12:30 PM and 4:30 PM ET every day, plus 10:30 AM, 2:30 PM and 6:30 PM ET on Saturdays.
        Each one syncs ESPN (schedule, kickoffs, finals, current line), grades finished games (THE Bobby Model, every system and
        My Card), fills missing predictions from PredictionTracker&rsquo;s season file once a day, pulls this week&rsquo;s PredictionTracker
        predictions and line, reweights the systems and recomputes the board. Games freeze at kickoff. Showing the last 100.
      </p>
      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              {['Started (ET)', 'Trigger', 'Status', 'Week', 'ESPN updates', 'Finals', 'PT rows', 'Lines moved', 'Preds added', 'Preds changed', 'Signals', 'Graded', 'Note'].map((h) => <th key={h} style={head}>{h}</th>)}
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
                    <td style={{ ...cell, ...FM }}>{v(r.finals)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.pt_rows)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.lines_moved)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.preds_added)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.preds_changed)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.signals)}</td>
                    <td style={{ ...cell, ...FM }}>{v(r.graded)}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', color: r.error ? C.warn : C.sub, minWidth: 220 }}>{note(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
