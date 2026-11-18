'use client';

// NFL results: paper-unit record of taken Plays, top spots, leans and the model
// side on every game, by week, plus the current system weights.
// Forward = computed live before kickoff; Backfill = rebuilt from
// PredictionTracker's season files and scored at the opening line.

import { useEffect, useMemo, useState } from 'react';
import { sbFetchAll } from '../../../lib/supabase';
import { C, FH, FM, MARKETS, f1, pct, signed, units } from '../../../lib/nfl2';

const cell = { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const n = (v) => Number(v || 0);
const btnStyle = (on) => ({
  background: C.surface, border: `1px solid ${on ? C.green : C.border}`, color: C.text,
  borderRadius: 6, padding: '5px 11px', fontSize: 12, cursor: 'pointer',
});
const KEYS = ['play_w', 'play_l', 'play_p', 'play_units', 'top_w', 'top_l', 'top_units', 'lean_w', 'lean_l', 'clv_n', 'clv_sum', 'clv_beat'];

function sum(rows) {
  const t = Object.fromEntries(KEYS.map((k) => [k, 0]));
  rows.forEach((r) => KEYS.forEach((k) => { t[k] += n(r[k]); }));
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

export default function NflResults() {
  const [weekly, setWeekly] = useState([]);
  const [all, setAll] = useState([]);
  const [systems, setSystems] = useState([]);
  const [market, setMarket] = useState('spread');
  const [scope, setScope] = useState('all');
  const [season, setSeason] = useState('2026');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      sbFetchAll('nfl2_results_weekly?order=season.desc,week.desc'),
      sbFetchAll('nfl2_results_all_games?order=season.desc,week.desc'),
      sbFetchAll('nfl2_system_board?order=rank.asc'),
    ]).then(([w, a, s]) => { setWeekly(w); setAll(a); setSystems(s); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const seasons = useMemo(() => [...new Set(weekly.map((r) => r.season))].sort((a, b) => b - a), [weekly]);
  const inSeason = (r) => (season === 'since2022' ? r.season >= 2022 : String(r.season) === season);
  const rows = useMemo(() => weekly.filter((r) => r.market === market && inSeason(r)
    && (scope === 'all' || r.source === scope)), [weekly, market, scope, season]); // eslint-disable-line react-hooks/exhaustive-deps
  const allRows = useMemo(() => all.filter((r) => r.market === market && inSeason(r)), [all, market, season]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = useMemo(() => sum(rows), [rows]);
  const side = useMemo(() => allRows.reduce((a, r) => ({ w: a.w + n(r.w), l: a.l + n(r.l) }), { w: 0, l: 0 }), [allRows]);
  const byWeek = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => { const k = `${r.season}-${r.week}`; m.set(k, [...(m.get(k) || []), r]); });
    return [...m.entries()].map(([k, rs]) => {
      const [s, w] = k.split('-').map(Number);
      const ag = allRows.find((x) => x.season === s && x.week === w) || {};
      return { s, w, src: [...new Set(rs.map((x) => x.source))].join('/'), ...sum(rs), aw: n(ag.w), al: n(ag.l) };
    });
  }, [rows, allRows]);
  const sys = systems.filter((s) => s.market === market);
  const asOf = sys[0];

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <h1 style={{ ...FH, fontSize: 21, margin: '0 0 12px' }}>NFL — Results</h1>
      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {Object.values(MARKETS).map((m) => (
          <button key={m.key} onClick={() => setMarket(m.key)} style={{ ...btnStyle(market === m.key), fontWeight: 700, padding: '6px 14px' }}>{m.label}</button>
        ))}
        <span style={{ width: 10 }} />
        {[['all', 'All'], ['live', 'Forward (live)'], ['archive', 'Backfill']].map(([k, label]) => (
          <button key={k} onClick={() => setScope(k)} style={btnStyle(scope === k)}>{label}</button>
        ))}
        <span style={{ width: 10 }} />
        <select value={season} onChange={(e) => setSeason(e.target.value)} style={{ ...btnStyle(false), colorScheme: 'dark' }}>
          {seasons.map((s) => <option key={s} value={String(s)}>{s}</option>)}
          <option value="since2022">2022 to now</option>
        </select>
      </div>
      {scope !== 'live' && (
        <p style={{ fontSize: 12, color: C.sub, margin: '0 0 12px', maxWidth: 820, lineHeight: 1.6 }}>
          Backfill rows are rebuilt from PredictionTracker&rsquo;s season files and scored at the opening line, standing in for an
          early-week pull. Those files hold each system&rsquo;s final number for the week, which flatters the record. Forward rows are the real test.
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 22 }}>
        <Stat label="Plays taken (1u)" w={t.play_w} l={t.play_l} u={t.play_units} />
        <Stat label="Top 3 each week" w={t.top_w} l={t.top_l} u={t.top_units} />
        <Stat label="Leans" w={t.lean_w} l={t.lean_l} note="record only" />
        <Stat label="Model side, all games" w={side.w} l={side.l} note="breakeven is 52.4%" />
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub }}>Closing line value</div>
          <div style={{ ...FH, fontSize: 20, fontWeight: 700, margin: '2px 0' }}>
            {t.clv_n ? signed(t.clv_sum / t.clv_n, 2) : '—'} <span style={{ fontSize: 13, color: C.sub }}>pts / play</span>
          </div>
          <div style={{ ...FM, fontSize: 12, color: C.sub }}>
            {t.clv_n ? `beat the close ${t.clv_beat} of ${t.clv_n} (${f1((100 * t.clv_beat) / t.clv_n, 0)}%)` : 'no graded plays'}
          </div>
        </div>
      </div>

      <h2 style={{ ...FH, fontSize: 15, margin: '0 0 8px' }}>By week</h2>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, marginBottom: 24 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Week', 'Source', 'Plays', 'Units', 'Top 3', 'Leans', 'All games', 'Avg CLV'].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {byWeek.map((r) => (
              <tr key={`${r.s}-${r.w}`}>
                <td style={cell}>{season === 'since2022' ? `${r.s} · ` : ''}Week {r.w}</td>
                <td style={{ ...cell, color: C.sub }}>{r.src === 'live' ? 'Forward' : r.src === 'archive' ? 'Backfill' : 'Mixed'}</td>
                <td style={{ ...cell, ...FM }}>{r.play_w}-{r.play_l}{r.play_p ? `-${r.play_p}` : ''}</td>
                <td style={{ ...cell, ...FM, color: r.play_units >= 0 ? C.green : C.warn }}>{units(r.play_units)}</td>
                <td style={{ ...cell, ...FM }}>{r.top_w}-{r.top_l}</td>
                <td style={{ ...cell, ...FM }}>{r.lean_w}-{r.lean_l}</td>
                <td style={{ ...cell, ...FM }}>{r.aw}-{r.al}</td>
                <td style={{ ...cell, ...FM }}>{r.clv_n ? signed(r.clv_sum / r.clv_n) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ ...FH, fontSize: 15, margin: '0 0 4px' }}>Systems · {MARKETS[market].long}</h2>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>
        {asOf ? `Weights for ${asOf.season} week ${asOf.as_of_week}, from games before it. ` : ''}
        Score is average points of error versus the median system on the same game (negative is better), blended with last season.
        A single system's weight is capped near 25%. Records are against the closing line.
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Rank', 'System', 'Games', 'Last season', market === 'total' ? 'O/U' : 'ATS', '%', 'Avg error', 'Score', 'Weight'].map((h) => <th key={h} style={head}>{h}</th>)}</tr></thead>
          <tbody>
            {sys.map((s) => (
              <tr key={s.col} style={{ opacity: n(s.weight) > 0 ? 1 : 0.6 }}>
                <td style={{ ...cell, ...FM }}>{s.rank}</td>
                <td style={cell}>{s.name}</td>
                <td style={{ ...cell, ...FM }}>{s.games}</td>
                <td style={{ ...cell, ...FM, color: C.sub }}>{s.prior_games || '—'}</td>
                <td style={{ ...cell, ...FM }}>{s.wins}-{s.losses}{s.pushes ? `-${s.pushes}` : ''}</td>
                <td style={{ ...cell, ...FM }}>{s.ats_pct === null ? '—' : `${f1(100 * n(s.ats_pct))}%`}</td>
                <td style={{ ...cell, ...FM }}>{s.mae === null ? '—' : f1(s.mae, 2)}</td>
                <td style={{ ...cell, ...FM }}>{s.score === null ? '—' : signed(s.score, 2)}</td>
                <td style={{ ...cell, ...FM }}>{n(s.weight) > 0 ? `${f1(s.share, 1)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
