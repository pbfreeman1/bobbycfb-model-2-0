'use client';

// Outside picks (scout) panel for a sport's pull log: "Pull picks now", the
// recent pulls, and the picks stored in the last 36 hours.

import { useEffect, useMemo, useState } from 'react';
import { C, FH, FM } from '../../lib/nfl-board';
import { scoutRuns, recentPicks, requestPicks, runCost, runNote, describePick } from '../../lib/scout-client';

const cell = { padding: '7px 9px', borderBottom: `1px solid ${C.border}`, fontSize: 12.5, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const STATUS = {
  ok: { label: 'OK', color: C.green }, partial: { label: 'Partial', color: C.gold },
  error: { label: 'Error', color: C.warn }, running: { label: 'Running', color: C.gold },
};
const PICK_STATUS = { ok: null, check: { label: 'Check', color: C.gold }, unmatched: { label: 'No game', color: C.warn } };
const TRIGGER = { scheduled: 'Scheduled', manual: 'Manual', agent: 'Agent' };

const fmtET = (iso) => (iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—');

export default function ScoutPanel({ sport, schedule }) {
  const [runs, setRuns] = useState([]);
  const [picks, setPicks] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = () => Promise.all([scoutRuns(sport), recentPicks(sport)])
    .then(([r, p]) => { setRuns(r); setPicks(p); setError(null); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [sport]);

  async function pull() {
    setBusy(true);
    setMsg('Requesting…');
    try {
      const run = await requestPicks(sport, setMsg);
      setMsg(`${STATUS[run.status]?.label || run.status}: ${run.picks} picks from ${run.articles} articles.`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
      load();
    }
  }

  const games = useMemo(() => {
    const by = new Map();
    for (const p of picks) {
      const key = p.game_id ? `g${p.game_id}` : 'none';
      if (!by.has(key)) by.set(key, { key, away: p.away, home: p.home, start: p.start_time, picks: [] });
      by.get(key).picks.push(p);
    }
    return [...by.values()].sort((a, b) => (a.key === 'none') - (b.key === 'none') || String(a.start).localeCompare(String(b.start)));
  }, [picks]);
  const shown = showAll ? games : games.slice(0, 12);

  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ ...FH, fontSize: 17, margin: 0 }}>Outside picks</h2>
        <button onClick={pull} disabled={busy} style={{
          background: busy ? C.surface : C.green, color: busy ? C.sub : '#0F1412', border: `1px solid ${busy ? C.border : C.green}`,
          borderRadius: 6, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer',
        }}>{busy ? 'Pulling…' : 'Pull picks now'}</button>
        {msg && <span style={{ fontSize: 12, color: C.sub }}>{msg}</span>}
      </div>
      <p style={{ fontSize: 12.5, color: C.sub, margin: '0 0 12px', maxWidth: 900, lineHeight: 1.55 }}>
        {schedule} Each pull reads the listing page of every active source, opens up to 3 picks articles per source, and
        stores each expert pick against the slate. Articles read in the last 3 hours are skipped. <b style={{ color: C.gold }}>Check</b> means
        the pick&apos;s line is far from the market line (often the wrong side or game); <b style={{ color: C.warn }}>No game</b> means the game is not on the slate.
      </p>
      {error && <div className="error-msg">{error}</div>}

      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            {['Started (ET)', 'Trigger', 'Status', 'Sources', 'Articles', 'Picks', 'Check', 'No game', 'Cost', 'Note'].map((h) => <th key={h} style={head}>{h}</th>)}
          </tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td style={{ ...cell, color: C.sub }} colSpan={10}>No pulls yet.</td></tr>}
            {runs.map((r) => {
              const st = STATUS[r.status] || { label: r.status, color: C.sub };
              const cost = runCost(r);
              const note = runNote(r);
              return (
                <tr key={r.id}>
                  <td style={{ ...cell, ...FM }}>{fmtET(r.started_at)}</td>
                  <td style={cell}>{TRIGGER[r.trigger] || r.trigger}</td>
                  <td style={{ ...cell, fontWeight: 700, color: st.color }}>{st.label}</td>
                  <td style={{ ...cell, ...FM }}>{r.origin === 'agent' ? '—' : r.sources}</td>
                  <td style={{ ...cell, ...FM }}>{r.origin === 'agent' ? '—' : r.articles}</td>
                  <td style={{ ...cell, ...FM }}>{r.picks}</td>
                  <td style={{ ...cell, ...FM }}>{r.checks || ''}</td>
                  <td style={{ ...cell, ...FM }}>{r.unmatched || ''}</td>
                  <td style={{ ...cell, ...FM, color: C.sub }}>{cost === null ? '—' : `$${cost.toFixed(2)}`}</td>
                  <td style={{ ...cell, whiteSpace: 'normal', color: C.sub, minWidth: 220, fontSize: 12 }}>{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ ...FH, fontSize: 14.5, margin: '0 0 8px' }}>Picks stored in the last 36 hours ({picks.length})</h3>
      {games.length === 0 && <div style={{ fontSize: 12.5, color: C.sub }}>None yet.</div>}
      <div style={{ display: 'grid', gap: 10 }}>
        {shown.map((g) => (
          <div key={g.key} style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, padding: '9px 12px' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 5 }}>
              <span style={{ ...FH, fontWeight: 600, fontSize: 14 }}>{g.key === 'none' ? 'Not matched to a game' : `${g.away} at ${g.home}`}</span>
              {g.key !== 'none' && <span style={{ ...FM, fontSize: 11, color: C.sub }}>{fmtET(g.start)}</span>}
              <span style={{ ...FM, fontSize: 11, color: C.sub }}>{g.picks.length} pick{g.picks.length === 1 ? '' : 's'}</span>
            </div>
            {g.picks.map((p) => {
              const ps = PICK_STATUS[p.status];
              return (
                <div key={p.id} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '2px 0', flexWrap: 'wrap' }}>
                  <span style={{ ...FM, minWidth: 170, fontWeight: 600 }}>{describePick(p)}</span>
                  <span style={{ minWidth: 150 }}>
                    {p.url ? <a href={p.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>{p.source_name}</a> : p.source_name}
                    {p.expert ? <span style={{ color: C.sub }}> · {p.expert}</span> : null}
                    {p.origin === 'agent' ? <span style={{ color: C.gold }}> · agent</span> : null}
                  </span>
                  {ps && <span style={{ color: ps.color, fontWeight: 700 }}>{ps.label}</span>}
                  {p.check_reason && <span style={{ color: C.sub }}>{p.check_reason}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {games.length > 12 && (
        <button onClick={() => setShowAll(!showAll)} style={{ marginTop: 10, background: 'transparent', color: C.blue, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px', fontSize: 12.5, cursor: 'pointer' }}>
          {showAll ? 'Show fewer' : `Show all ${games.length} games`}
        </button>
      )}
    </section>
  );
}
