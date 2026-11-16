'use client';

// College basketball results: paper-unit record by tier, by day, plus the
// current system weights. Forward = captured live; Backfill = rebuilt from
// PredictionTracker's season file using that file's final line.

import { useEffect, useMemo, useState } from 'react';
import { sbFetch } from '../../../lib/supabase';
import { C, FH, FM, f1, fmtDay, pct, units } from '../../../lib/cbb';

const cell = { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const n = (v) => Number(v || 0);

function sum(rows) {
  const t = { games: 0, w: 0, l: 0, play_w: 0, play_l: 0, play_units: 0, top5_w: 0, top5_l: 0, top5_units: 0, lean_w: 0, lean_l: 0 };
  rows.forEach((r) => Object.keys(t).forEach((k) => { t[k] += n(r[k]); }));
  return t;
}

function Stat({ label, w, l, u, note }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub }}>{label}</div>
      <div style={{ ...FH, fontSize: 20, fontWeight: 700, margin: '2px 0' }}>{w}-{l} <span style={{ fontSize: 13, color: C.sub }}>{pct(w, l)}</span></div>
      <div style={{ ...FM, fontSize: 12, color: u === undefined ? C.sub : u >= 0 ? C.green : C.warn }}>
        {u === undefined ? note : units(u)}
      </div>
    </div>
  );
}

export default function CbbResults() {
  const [daily, setDaily] = useState([]);
  const [systems, setSystems] = useState([]);
  const [scope, setScope] = useState('all');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      sbFetch('cbb_results_daily?season=eq.2026&order=game_date.desc'),
      sbFetch('cbb_system_board?order=rank.asc'),
    ]).then(([d, s]) => { setDaily(d); setSystems(s); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => (scope === 'all' ? daily : daily.filter((r) => r.source === scope)), [daily, scope]);
  const t = useMemo(() => sum(rows), [rows]);
  const byDay = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => m.set(r.game_date, [...(m.get(r.game_date) || []), r]));
    return [...m.entries()].map(([d, rs]) => ({ d, ...sum(rs) }));
  }, [rows]);

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <h1 style={{ ...FH, fontSize: 21, margin: '0 0 12px' }}>College Basketball — Results</h1>
      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[['all', 'All'], ['live', 'Forward (live)'], ['archive', 'Backfill']].map(([k, label]) => (
          <button key={k} onClick={() => setScope(k)} style={{
            background: C.surface, border: `1px solid ${scope === k ? C.green : C.border}`, color: C.text,
            borderRadius: 6, padding: '5px 11px', fontSize: 12, cursor: 'pointer',
          }}>{label}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 22 }}>
        <Stat label="Plays (flat 1u)" w={t.play_w} l={t.play_l} u={t.play_units} />
        <Stat label="Top 5 each day" w={t.top5_w} l={t.top5_l} u={t.top5_units} />
        <Stat label="Leans" w={t.lean_w} l={t.lean_l} note="record only" />
        <Stat label="Model side, all games" w={t.w} l={t.l} note="breakeven is 52.4%" />
      </div>

      <h2 style={{ ...FH, fontSize: 15, margin: '0 0 8px' }}>By day</h2>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, marginBottom: 24 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Date', 'Games', 'Plays', 'Play units', 'Top 5', 'Leans', 'All games'].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {byDay.map((r) => (
              <tr key={r.d}>
                <td style={cell}><a href="/cbb/dashboard" style={{ color: C.text }}>{fmtDay(r.d)}</a></td>
                <td style={{ ...cell, ...FM }}>{r.games}</td>
                <td style={{ ...cell, ...FM }}>{r.play_w}-{r.play_l}</td>
                <td style={{ ...cell, ...FM, color: r.play_units >= 0 ? C.green : C.warn }}>{units(r.play_units)}</td>
                <td style={{ ...cell, ...FM }}>{r.top5_w}-{r.top5_l}</td>
                <td style={{ ...cell, ...FM }}>{r.lean_w}-{r.lean_l}</td>
                <td style={{ ...cell, ...FM }}>{r.w}-{r.l}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ ...FH, fontSize: 15, margin: '0 0 4px' }}>Systems</h2>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>
        Season to date{systems[0] ? `, as of ${fmtDay(systems[0].as_of_date)}` : ''}. Weight goes to systems with lower error than the median system; recalculated every morning.
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Rank', 'System', 'Games', 'ATS', 'ATS %', 'Avg error', 'Bias', 'Weight'].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {systems.map((s) => (
              <tr key={s.col} style={{ opacity: n(s.weight) > 0 ? 1 : 0.6 }}>
                <td style={{ ...cell, ...FM }}>{s.rank}</td>
                <td style={cell}>{s.name}{s.status !== 'include' ? ` (${s.status})` : ''}</td>
                <td style={{ ...cell, ...FM }}>{s.games}</td>
                <td style={{ ...cell, ...FM }}>{s.wins}-{s.losses}-{s.pushes}</td>
                <td style={{ ...cell, ...FM }}>{f1(100 * n(s.ats_pct))}%</td>
                <td style={{ ...cell, ...FM }}>{f1(s.mae, 2)}</td>
                <td style={{ ...cell, ...FM }}>{f1(s.bias, 2)}</td>
                <td style={{ ...cell, ...FM }}>{n(s.weight) > 0 ? `${f1(100 * n(s.weight) / systems.reduce((a, x) => a + n(x.weight), 0), 0)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
