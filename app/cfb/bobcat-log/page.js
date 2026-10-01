'use client';
import { useEffect, useState } from 'react';
import { sbFetch } from '../../../lib/supabase';

// Forward-tracking log for the Bobcat Formula. Everything here comes from
// aggregate views (cfb_bobcat_summary, cfb_bobcat_summary_by_week) plus one row
// per flagged signal (cfb_bobcat_log), so nothing raw reaches the browser.
//
// The point of this page is to keep the sample size in view. A season produces
// roughly 15-20 flags, which is far too few to tell a real edge from noise, so n
// is shown before any percentage.

const VARIANTS = [
  { v: 'bobcat', label: 'Bobcat', note: 'Weighted consensus edge' },
  { v: 'bobcat_eq', label: 'Shadow (equal weight)', note: 'Same test on the equal-weight edge' },
  { v: 'control', label: 'Control', note: 'Same edge band and side, without the hit or coverage filter' },
];

const COHORTS = [
  { c: 'forward', label: 'Forward', note: 'Flagged before kickoff' },
  { c: 'backfill', label: 'Backfill', note: 'Not pre-registered' },
];

function pct(v) {
  return v == null ? '—' : `${(parseFloat(v) * 100).toFixed(1)}%`;
}
function units(v) {
  const n = parseFloat(v ?? 0);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}u`;
}
function uColor(v) {
  const n = parseFloat(v ?? 0);
  return n > 0 ? '#38bd94' : n < 0 ? '#f87171' : '#8a92a3';
}

export default function BobcatLog() {
  const [season, setSeason] = useState(2026);
  const [summary, setSummary] = useState([]);
  const [byWeek, setByWeek] = useState([]);
  const [log, setLog] = useState([]);
  const [cfg, setCfg] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [s, w, l, c] = await Promise.all([
        sbFetch(`cfb_bobcat_summary?select=*&season=eq.${season}`),
        sbFetch(`cfb_bobcat_summary_by_week?select=*&season=eq.${season}&order=week.asc`),
        sbFetch(`cfb_bobcat_log?select=*&season=eq.${season}&order=week.asc,teams.asc`),
        sbFetch(`cfb_tracker_config?select=key,value`),
      ]);
      setSummary(s); setByWeek(w); setLog(l);
      const map = {};
      for (const r of c) map[r.key] = parseFloat(r.value);
      setCfg(map);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [season]); // eslint-disable-line react-hooks/exhaustive-deps

  const cell = (cohort, variant) =>
    summary.find((r) => r.cohort === cohort && r.variant === variant) || null;

  const fwdWeek = Number.isFinite(cfg.bobcat_forward_week) ? cfg.bobcat_forward_week : 5;
  const emin = Number.isFinite(cfg.bobcat_edge_min) ? cfg.bobcat_edge_min : 1.5;
  const emax = Number.isFinite(cfg.bobcat_edge_max) ? cfg.bobcat_edge_max : 3.0;
  const hmin = Number.isFinite(cfg.bobcat_hits_min) ? cfg.bobcat_hits_min : 10;
  const covPct = Math.round((Number.isFinite(cfg.min_coverage) ? cfg.min_coverage : 0.7) * 100);
  const topkPct = Math.round((Number.isFinite(cfg.bobcat_topk_pct) ? cfg.bobcat_topk_pct : 0.1) * 100);

  const totalFlagged = summary
    .filter((r) => r.variant === 'bobcat')
    .reduce((a, r) => a + (r.flagged_n || 0), 0);

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>🐾 Bobcat Formula log</h1>
          <p>
            Edge {emin} to under {emax}, on the same side as at least {hmin} systems’ top-{topkPct}% edge picks,
            with at least {covPct}% weight coverage. Forward-tracked from Week {fwdWeek}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
          <input
            type="number" value={season} onChange={(e) => setSeason(+e.target.value)}
            style={{ background: '#11151f', border: '1px solid #2a3042', borderRadius: 6, color: '#e6e8ee', padding: '6px 8px', width: 90, fontSize: 13 }}
          />
          <button className="btn btn-outline" onClick={load} style={{ fontSize: 12 }}>↻ Refresh</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18, borderLeft: '3px solid #facc15' }}>
        <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
          n = {totalFlagged}
          <span style={{ fontSize: 13, fontWeight: 400, color: '#8a92a3', marginLeft: 10 }}>Bobcat flags, {season}</span>
        </div>
        <p style={{ fontSize: 12.5, color: '#8a92a3', margin: '8px 0 0' }}>
          Small samples: expect roughly 15-20 flags per season; treat as noise until much larger.
          This is an experimental signal under measurement — it is not a card, and the thresholds do not move during the forward test.
        </p>
      </div>

      {loading && <div className="loading">Loading Bobcat log…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <>
          {COHORTS.map((co) => (
            <div key={co.c} style={{ marginBottom: 18 }}>
              <h2 style={{ fontSize: 15, margin: '0 0 2px' }}>
                {co.label}
                <span style={{ fontSize: 12, fontWeight: 400, color: co.c === 'backfill' ? '#facc15' : '#8a92a3', marginLeft: 8 }}>
                  {co.c === 'backfill' ? `Weeks before ${fwdWeek} — not pre-registered` : `Week ${fwdWeek} onward — ${co.note}`}
                </span>
              </h2>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Variant</th><th>Flagged</th><th>Graded n</th><th>W</th><th>L</th><th>P</th><th>ATS%</th><th>Flat units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {VARIANTS.map((va) => {
                      const r = cell(co.c, va.v);
                      return (
                        <tr key={va.v}>
                          <td>
                            <span style={{ fontWeight: 700 }}>{va.label}</span>
                            <div style={{ fontSize: 11, color: '#5b6272' }}>{va.note}</div>
                          </td>
                          <td>{r?.flagged_n ?? 0}</td>
                          <td style={{ fontWeight: 700 }}>{r?.n ?? 0}</td>
                          <td style={{ color: '#38bd94' }}>{r?.wins ?? 0}</td>
                          <td style={{ color: '#f87171' }}>{r?.losses ?? 0}</td>
                          <td style={{ color: '#facc15' }}>{r?.pushes ?? 0}</td>
                          <td>{r?.n ? pct(r.ats_pct) : '—'}</td>
                          <td style={{ color: uColor(r?.flat_units) }}>{r?.n ? units(r.flat_units) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <h2 style={{ fontSize: 15, margin: '22px 0 2px' }}>
            By week
            <span style={{ fontSize: 12, fontWeight: 400, color: '#8a92a3', marginLeft: 8 }}>Bobcat and shadow variant only</span>
          </h2>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Week</th><th>Cohort</th><th>Variant</th><th>Flagged</th><th>Graded n</th><th>W-L-P</th><th>ATS%</th><th>Flat units</th></tr>
              </thead>
              <tbody>
                {byWeek.filter((r) => r.variant !== 'control').map((r, i) => (
                  <tr key={i}>
                    <td>{r.week}</td>
                    <td>
                      {r.cohort}
                      {r.cohort === 'backfill' && <span className="badge" style={{ marginLeft: 6 }}>not pre-registered</span>}
                    </td>
                    <td>{r.variant}</td>
                    <td>{r.flagged_n}</td>
                    <td style={{ fontWeight: 700 }}>{r.n}</td>
                    <td>{r.wins}-{r.losses}{r.pushes ? `-${r.pushes}` : ''}</td>
                    <td>{r.n ? pct(r.ats_pct) : '—'}</td>
                    <td style={{ color: uColor(r.flat_units) }}>{r.n ? units(r.flat_units) : '—'}</td>
                  </tr>
                ))}
                {byWeek.filter((r) => r.variant !== 'control').length === 0 && (
                  <tr><td colSpan={8} className="empty">No Bobcat flags yet for {season}.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h2 style={{ fontSize: 15, margin: '22px 0 2px' }}>
            Every flagged game
            <span style={{ fontSize: 12, fontWeight: 400, color: '#8a92a3', marginLeft: 8 }}>{log.length} rows</span>
          </h2>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Wk</th><th>Cohort</th><th>Game</th><th>Side</th><th>Line</th><th>Edge</th>
                  <th>Hits</th><th>Opp</th><th>Coverage</th><th>Variant</th><th>Result</th><th>Flat</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r) => {
                  // A row can be flagged by either variant, and the two can sit on
                  // opposite sides, so each is graded on the side it actually took.
                  const res = r.bobcat ? r.ats_result : r.eq_ats_result;
                  const fl = r.bobcat ? r.flat_pl : r.eq_flat_pl;
                  const side = r.bobcat ? r.pick_side : r.eq_side;
                  return (
                    <tr key={r.signal_id}>
                      <td>{r.week}</td>
                      <td>
                        {r.cohort}
                        {r.cohort === 'backfill' && <span className="badge" style={{ marginLeft: 6 }}>not pre-registered</span>}
                      </td>
                      <td style={{ fontWeight: 700 }}>{r.teams}</td>
                      <td>{side === 'home' ? r.home_team : side === 'away' ? r.away_team : '—'}</td>
                      <td>{r.vegas_line}</td>
                      <td>{parseFloat(r.bobcat ? r.edge : r.eq_edge).toFixed(2)}</td>
                      <td style={{ fontWeight: 700 }}>{r.hit_count}/{r.models_n}</td>
                      <td style={{ color: r.hit_opp >= (cfg.bobcat_opp_conflict ?? 3) ? '#facc15' : 'inherit' }}>{r.hit_opp}</td>
                      <td>{pct(r.coverage)}</td>
                      <td>
                        {r.bobcat && <span className="badge">Bobcat</span>}
                        {r.bobcat_eq && <span className="badge" style={{ marginLeft: 4 }}>Shadow</span>}
                      </td>
                      <td style={{ color: res === 'win' ? '#38bd94' : res === 'loss' ? '#f87171' : '#8a92a3' }}>
                        {res || 'ungraded'}
                      </td>
                      <td style={{ color: uColor(fl) }}>{fl == null ? '—' : units(fl)}</td>
                    </tr>
                  );
                })}
                {log.length === 0 && (
                  <tr><td colSpan={12} className="empty">No Bobcat flags yet for {season}.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12, color: '#5b6272', marginTop: 16 }}>
            Backfill rows were scored after the fact and were never pre-registered, so they cannot support the formula —
            they are shown for completeness only. Control is the same edge band on the same side as the hits, without
            having to clear the hit-count or coverage bar; it is what the Bobcat rows have to beat to mean anything.
            The shadow variant can sit on the opposite side from the Bobcat pick, and is graded on the side it took.
            See docs/bobcat-formula.md for the frozen definition and the backtest it came from.
          </p>
        </>
      )}
    </div>
  );
}
