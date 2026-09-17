'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { sbFetch, fmt, fmtKickoff, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../../lib/supabase';

const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

const FH = { fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif" };
const FM = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };
const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', pss: '#D4A73C', agree: '#6FBF73', warn: '#C4573F', dim: '#5B655F',
  mine: '#5B9BD4',
};

const PSS_BIN_ORDER = ['Elite', 'Very Strong', 'Strong', 'Moderate', 'No Play'];
const DECISION_COLOR = { BET: C.agree, CONSIDER: C.pss, WATCH: C.sub, REVIEW: C.warn, PASS: C.dim };
const PSS_BIN_COLOR = { Elite: C.agree, 'Very Strong': C.pss, Strong: '#C4933A', Moderate: '#8B7355', 'No Play': C.dim };
const TIER_LABEL = { top3: 'Top-3', top5: 'Top-5', top7: 'Top-7' };

// ---------------------------------------------------------------------------
// Line-sign helpers — stored lines are positive = home favored.
// ---------------------------------------------------------------------------
function spreadForSide(line, side) {
  if (line === null || line === undefined) return null;
  const v = parseFloat(line);
  if (Number.isNaN(v)) return null;
  return side === 'home' ? -v : v;
}
function favorite(line) {
  if (line === null || line === undefined) return null;
  const v = parseFloat(line);
  if (Number.isNaN(v) || v === 0) return null;
  return v > 0 ? { side: 'home', amt: v } : { side: 'away', amt: Math.abs(v) };
}
function favored(team, num) {
  if (num === null || num === undefined || Number.isNaN(num)) return `${team} —`;
  const n = Number(num);
  if (Number.isNaN(n)) return `${team} —`;
  return `${team} ${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}
function pssPick(pm, homeTeam, awayTeam) {
  if (pm?.consensus_spread == null || pm?.suggested_side == null) return null;
  const side = pm.suggested_side;
  const team = side === 'home' ? homeTeam : awayTeam;
  return { side, team, num: spreadForSide(pm.consensus_spread, side) };
}
function researchSideLabel(r, home, away) {
  if (r.pick_side === 'home') return home;
  if (r.pick_side === 'away') return away;
  if (r.pick_side === 'over') return 'Over';
  if (r.pick_side === 'under') return 'Under';
  return r.pick_side;
}
function playLabel(pick, home, away) {
  const type = pick.pick_type;
  const line = pick.line_played;
  if (type === 'total') {
    const label = pick.side === 'over' ? 'Over' : 'Under';
    return line == null ? label : `${label} ${Number(line).toFixed(1)}`;
  }
  const team = pick.side === 'home' ? home : away;
  const n = spreadForSide(line, pick.side);
  if (n === null) return `${team} ATS`;
  return `${team} ${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------
function Stat({ label, value, color, size = 13 }) {
  return (
    <div>
      <div style={{ ...FH, fontSize: 10, color: C.sub, marginBottom: 2, letterSpacing: 0.2 }}>{label}</div>
      <div style={{ ...FM, fontSize: size, color: color || C.text }}>{value}</div>
    </div>
  );
}
function Badge({ children, color, filled }) {
  return (
    <span style={{
      ...FM, fontSize: 10.5, padding: '2px 7px', borderRadius: 3, whiteSpace: 'nowrap',
      border: `1px solid ${color}`, color: filled ? '#0F1412' : color,
      background: filled ? color : 'transparent', letterSpacing: 0.3,
    }}>{children}</span>
  );
}
function TeamMark({ logoUrl, name }) {
  if (logoUrl) return <img src={logoUrl} alt={name} style={{ width: 22, height: 22, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
  return (
    <div style={{ width: 22, height: 22, borderRadius: '50%', background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, ...FM, color: C.sub, flexShrink: 0 }}>
      {name.slice(0, 3).toUpperCase()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------
function Modal({ title, onClose, children, wide }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
        width: '100%', maxWidth: wide ? 720 : 420, padding: 22,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ ...FH, fontSize: 15, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.sub, cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-model prediction breakdown — real PSS component weights/scores come
// straight off pss_game_metrics (lib/pss-engine.js's W_EDGE/W_MSS/etc.),
// never hardcoded here. Model list is the full selected_model_ids pool.
// ---------------------------------------------------------------------------
function ModelBreakdownTable({ row }) {
  const { game, pm } = row;
  const home = game.home_team, away = game.away_team;
  const vegasLine = (() => {
    const raw = pm?.vegas_line ?? game.current_line ?? null;
    if (raw === null || raw === undefined) return null;
    const v = parseFloat(raw);
    return Number.isNaN(v) ? null : v;
  })();
  const topkIds = pm?.selected_model_ids || [];

  const [models, setModels] = useState(null);

  useEffect(() => {
    if (!topkIds.length) { setModels([]); return; }
    let cancelled = false;
    const idList = topkIds.join(',');
    fetch(
      `${SUPABASE_URL}/rest/v1/raw_predictions?select=model_id,predicted_margin,source_models(system_name)&game_id=eq.${game.id}&model_id=in.(${idList})`,
      { headers: SB_HEADERS }
    )
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setModels(data); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  const modelStats = useMemo(() => {
    if (!models || !models.length) return null;
    const vals = models.map((m) => parseFloat(m.predicted_margin)).filter((v) => !Number.isNaN(v));
    if (!vals.length) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const variance = vals.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / vals.length;
    return { mean, median, std: Math.sqrt(variance), range: sorted[sorted.length - 1] - sorted[0] };
  }, [models]);

  // Weights mirror lib/pss-engine.js: W_EDGE=0.30, W_MSS=0.25, W_AGREE=0.20, W_STD=0.15, W_HIST=0.10
  const pssComponents = pm ? [
    { label: 'Edge',       actual: pm.edge != null ? (pm.edge > 0 ? `+${Number(pm.edge).toFixed(1)}` : Number(pm.edge).toFixed(1)) : '—', score: pm.edge_score,      weight: 30 },
    { label: 'MSS',        actual: pm.raw_mss != null ? Number(pm.raw_mss).toFixed(2) : '—',                                score: pm.mss_score,       weight: 25 },
    { label: 'Agreement',  actual: pm.agreement_count != null ? `${pm.agreement_count}/${pm.agreement_k}` : (pm.agreement != null ? `${Math.round(pm.agreement * 100)}%` : '—'), score: pm.agreement_score, weight: 20 },
    { label: 'STD',        actual: pm.stddev != null ? Number(pm.stddev).toFixed(2) : '—',                                  score: pm.stddev_score,    weight: 15 },
    { label: 'Historical', actual: pm.historical_tier || '—',                                                               score: pm.historical_score, weight: 10 },
  ] : null;
  const pssTotal = pssComponents ? pssComponents.reduce((a, c) => a + ((c.score || 0) * c.weight) / 100, 0) : null;

  const thStyle = { ...FM, fontSize: 10, color: C.sub, padding: '6px 10px', background: C.surface2, letterSpacing: 0.3, textAlign: 'left', borderBottom: `1px solid ${C.border}` };
  const tdStyle = { ...FM, fontSize: 11.5, padding: '7px 10px', borderBottom: `1px solid ${C.border}` };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {pssComponents && (
        <div>
          <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 8 }}>PSS COMPONENT BREAKDOWN</div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['COMPONENT', 'ACTUAL', 'SCORE', 'WEIGHT', 'CONTRIBUTION'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {pssComponents.map((c, i) => (
                  <tr key={c.label} style={{ background: i % 2 === 0 ? 'transparent' : C.surface2 }}>
                    <td style={{ ...tdStyle, color: C.text }}>{c.label}</td>
                    <td style={{ ...tdStyle, color: C.sub }}>{c.actual}</td>
                    <td style={{ ...tdStyle, color: C.text }}>{c.score != null ? Math.round(c.score) : '—'}</td>
                    <td style={{ ...tdStyle, color: C.sub }}>{c.weight}%</td>
                    <td style={{ ...tdStyle, color: C.pss }}>{c.score != null ? ((c.score * c.weight) / 100).toFixed(1) : '—'}</td>
                  </tr>
                ))}
                <tr style={{ background: C.surface2 }}>
                  <td colSpan={4} style={{ ...tdStyle, color: C.sub, fontWeight: 700 }}>TOTAL</td>
                  <td style={{ ...tdStyle, color: C.pss, fontWeight: 700 }}>{pssTotal != null ? pssTotal.toFixed(1) : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 8 }}>
          INDIVIDUAL MODEL PREDICTIONS ({models === null ? '…' : models.length})
        </div>
        {models === null ? (
          <div style={{ ...FM, fontSize: 11, color: C.dim }}>Loading…</div>
        ) : models.length === 0 ? (
          <div style={{ ...FM, fontSize: 11, color: C.dim }}>No model predictions found for this game.</div>
        ) : (
          <>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>{['MODEL', 'PREDICTED SPREAD', 'EDGE VS MARKET', 'SELECTED SIDE'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {models.map((m, i) => {
                    const pred = parseFloat(m.predicted_margin);
                    const edge = vegasLine === null ? null : pred - vegasLine;
                    const side = edge === null ? '—' : edge > 0 ? home : edge < 0 ? away : 'Even';
                    const edgeColor = edge !== null && Math.abs(edge) >= 1.5 ? C.agree : C.sub;
                    return (
                      <tr key={m.model_id} style={{ background: i % 2 === 0 ? 'transparent' : C.surface2 }}>
                        <td style={{ ...tdStyle, color: C.text }}>{m.source_models?.system_name || 'Unknown'}</td>
                        <td style={{ ...tdStyle, color: C.sub }}>{pred > 0 ? `+${pred.toFixed(1)}` : pred.toFixed(1)}</td>
                        <td style={{ ...tdStyle, color: edgeColor }}>{edge === null ? '—' : edge > 0 ? `+${edge.toFixed(1)}` : edge.toFixed(1)}</td>
                        <td style={{ ...tdStyle, color: edge !== null && edge > 0 ? C.agree : C.pss }}>{side}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {modelStats && (
              <div style={{ ...FM, fontSize: 11, color: C.sub, marginTop: 8, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <span>Mean <b style={{ color: C.text }}>{modelStats.mean.toFixed(2)}</b></span>
                <span>Median <b style={{ color: C.text }}>{modelStats.median.toFixed(2)}</b></span>
                <span>STD <b style={{ color: C.text }}>{modelStats.std.toFixed(2)}</b></span>
                <span>Range <b style={{ color: C.text }}>{modelStats.range.toFixed(2)}</b></span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend modal
// ---------------------------------------------------------------------------
function LegendModal({ onClose }) {
  const Section = ({ title, color, children }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...FH, fontSize: 13, color, marginBottom: 8 }}>{title}</div>
      <div style={{ ...FM, fontSize: 12, color: C.sub, lineHeight: 1.7 }}>{children}</div>
    </div>
  );
  return (
    <Modal title="How to read the board" onClose={onClose} wide>
      <Section title="PSS (BobbyPSSModel)" color={C.pss}>
        <p><b style={{ color: C.text }}>PSS score (0–100):</b> 30% Edge + 25% MSS + 20% Agreement + 15% Dispersion(StdDev) + 10% Historical Tier.</p>
        <p><b style={{ color: C.text }}>Bins:</b> {PSS_BIN_ORDER.join(' → ')}, high to low.</p>
        <p><b style={{ color: C.text }}>Top-K tier:</b> Top-3 = Conviction, Top-5 = Confirmation, Top-7 = Consensus.</p>
        <p><b style={{ color: C.text }}>Decision:</b> BET (PSS ≥82) · CONSIDER (74–81.9) · WATCH (66–73.9) · PASS (&lt;66). A BET can downgrade to REVIEW if the market has moved against the model.</p>
        <p><b style={{ color: C.text }}>Hard vetoes</b> force PASS regardless of score: StdDev &gt; 6, Agreement &lt; 70%, or |Edge| &lt; 2.</p>
      </Section>
      <Section title="Card cues" color={C.agree}>
        <p><b style={{ color: C.text }}>Gold left border:</b> Elite bin + BET decision. <b style={{ color: C.text }}>Green left border:</b> BET decision only.</p>
        <p>Cards are ranked #1…N by PSS score — the rank number stays attached to the game even if you change the sort order.</p>
      </Section>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Season stats modal
// ---------------------------------------------------------------------------
function SeasonStatsModal({ season, week, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const pssMetrics = await sbFetch(`pss_game_metrics?select=id,pss_bin,qualifies,pss_pick_grades(ats_result)&season=eq.${season}&week=lte.${week}`);
        const pssGraded = pssMetrics.map((m) => ({ ...m, pg: Array.isArray(m.pss_pick_grades) ? m.pss_pick_grades[0] : m.pss_pick_grades })).filter((m) => m.pg);
        if (cancelled) return;
        setData({
          overall: tally(pssGraded.filter((m) => m.qualifies).map((m) => m.pg.ats_result)),
          rows: bucketBy(pssGraded, (m) => m.pss_bin || 'No Play', PSS_BIN_ORDER),
        });
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [season, week]);

  return (
    <Modal title="Season stats" onClose={onClose} wide>
      {loading && <div style={{ ...FM, fontSize: 12, color: C.sub }}>Loading…</div>}
      {error && <div style={{ ...FM, fontSize: 12, color: C.warn }}>{error}</div>}
      {!loading && !error && data && (
        <>
          <div style={{ display: 'flex', gap: 28, marginBottom: 20 }}>
            <Stat label="QUALIFIED PLAYS RECORD" value={recordStr(data.overall)} size={18} />
            <Stat label="ATS %" value={pctStr(data.overall)} size={18} color={C.agree} />
          </div>
          <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 8 }}>BY BIN (all graded games, not just qualified)</div>
          {data.rows.map((r) => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}`, ...FM, fontSize: 12 }}>
              <span style={{ color: C.text, width: 120 }}>{r.label}</span>
              <span style={{ color: C.sub, width: 80 }}>{recordStr(r.record)}</span>
              <span style={{ color: C.text }}>{pctStr(r.record)}</span>
            </div>
          ))}
        </>
      )}
    </Modal>
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
function recordStr(record) {
  return `${record.wins}-${record.losses}${record.pushes ? `-${record.pushes}` : ''}`;
}
function pctStr(record) {
  const decided = record.wins + record.losses;
  if (decided === 0) return '—';
  return `${((record.wins / decided) * 100).toFixed(1)}%`;
}
// Standard -110 vig: a win nets units/1.1, a loss costs the full unit stake, a push is flat.
function netUnitsFor(gradedPicks) {
  return gradedPicks.reduce((sum, p) => {
    const u = parseFloat(p.units) || 0;
    if (p.result === 'win') return sum + u / 1.1;
    if (p.result === 'loss') return sum - u;
    return sum;
  }, 0);
}
function bucketBy(graded, keyFn, order) {
  const map = new Map();
  for (const m of graded) {
    const k = keyFn(m);
    const row = map.get(k) || { label: k, results: [] };
    row.results.push(m.pg.ats_result);
    map.set(k, row);
  }
  return Array.from(map.values()).map((r) => ({ label: r.label, record: tally(r.results) })).sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

// ---------------------------------------------------------------------------
// My Card modal
// ---------------------------------------------------------------------------
function MyCardModal({ rows, picksByGame, season, onClose }) {
  const [tab, setTab] = useState('week');
  const entries = rows.map((r) => {
    const plays = picksByGame[r.game.id] || [];
    return { r, plays };
  }).filter((e) => e.plays.length > 0);

  const totalUnits = entries.flatMap((e) => e.plays).reduce((sum, p) => sum + (parseFloat(p.units) || 0), 0);

  return (
    <Modal title="My card" onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
        {[['week', 'This week'], ['results', "Bobby's Pick Results"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...FM, fontSize: 12, background: 'none', border: 'none', cursor: 'pointer',
            color: tab === t ? C.pss : C.sub, borderBottom: `2px solid ${tab === t ? C.pss : 'transparent'}`,
            padding: '8px 14px', fontWeight: tab === t ? 700 : 400,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'week' && (
        <>
          <div style={{ ...FM, fontSize: 12, color: C.sub, marginBottom: 16 }}>
            {entries.length} games · {entries.reduce((n, e) => n + e.plays.length, 0)} plays · {totalUnits.toFixed(1)}u total exposure
          </div>
          {entries.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub }}>No plays logged yet — use "+ Add Pick" on any game card.</div>}
          {entries.map(({ r, plays }) => {
            const home = r.game.home_team, away = r.game.away_team;
            return (
              <div key={r.game.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <div style={{ ...FH, fontSize: 13, color: C.text }}>{away} @ {home}</div>
                  <span style={{ ...FM, fontSize: 11, color: C.sub }}>{fmtKickoff(r.game.kickoff_at)}</span>
                  {r.game.tv_network && <span style={{ ...FM, fontSize: 11, color: C.sub }}>{r.game.tv_network}</span>}
                </div>
                {plays.map((pk) => (
                  <div key={pk.id} style={{
                    ...FM, fontSize: 12, color: C.sub, display: 'flex', gap: 10, alignItems: 'center', padding: '2px 6px',
                    ...(pk.is_lock ? { background: 'rgba(212,167,60,0.12)', border: '1px solid rgba(212,167,60,0.35)', borderRadius: 4 } : {}),
                  }}>
                    {pk.is_lock && <span style={{ fontSize: 11 }}>🔒</span>}
                    <span style={{ color: C.agree }}>{(parseFloat(pk.units) || 1).toFixed(pk.units % 1 === 0 ? 0 : 1)}u</span>
                    <span style={{ color: pk.is_lock ? C.pss : C.text, fontWeight: pk.is_lock ? 700 : 400 }}>{playLabel(pk, home, away)}</span>
                    {pk.note && <span style={{ fontSize: 10.5, color: C.dim }}>· {pk.note}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}

      {tab === 'results' && <PickResultsTab season={season} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bobby's Pick Results — season record, net units, week-by-week breakdown.
// Net units assumes standard -110 vig on every pick (win=+units/1.1,
// loss=-units, push=0) since user_picks has no stored odds/price field.
// ---------------------------------------------------------------------------
function PickResultsTab({ season }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [picks, setPicks] = useState([]);
  const [expandedWeeks, setExpandedWeeks] = useState(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const rows = await sbFetch(`user_picks?select=*,games(home_team,away_team)&season=eq.${season}&pick_type=neq.note&status=neq.lean&order=week.desc,created_at.asc`);
        if (!cancelled) setPicks(rows);
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [season]);

  const graded = picks.filter((p) => p.result === 'win' || p.result === 'loss' || p.result === 'push');
  const record = tally(graded.map((p) => p.result));
  const netUnits = netUnitsFor(graded);

  const byWeek = useMemo(() => {
    const map = new Map();
    for (const p of picks) {
      if (!map.has(p.week)) map.set(p.week, []);
      map.get(p.week).push(p);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [picks]);

  function toggleWeek(w) {
    setExpandedWeeks((prev) => { const n = new Set(prev); n.has(w) ? n.delete(w) : n.add(w); return n; });
  }

  if (loading) return <div style={{ ...FM, fontSize: 12, color: C.sub }}>Loading…</div>;
  if (error) return <div style={{ ...FM, fontSize: 12, color: C.warn }}>{error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 28, marginBottom: 20 }}>
        <Stat label="SEASON RECORD" value={recordStr(record)} size={18} />
        <Stat label="ATS %" value={pctStr(record)} size={18} color={C.agree} />
        <Stat label="NET UNITS" value={`${netUnits >= 0 ? '+' : ''}${netUnits.toFixed(2)}u`} size={18} color={netUnits >= 0 ? C.agree : C.warn} />
      </div>
      {byWeek.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub }}>No picks logged this season yet.</div>}
      {byWeek.map(([w, weekPicks]) => {
        const weekGraded = weekPicks.filter((p) => p.result === 'win' || p.result === 'loss' || p.result === 'push');
        const weekRecord = tally(weekGraded.map((p) => p.result));
        const weekNetUnits = netUnitsFor(weekGraded);
        const expanded = expandedWeeks.has(w);
        return (
          <div key={w} style={{ borderBottom: `1px solid ${C.border}` }}>
            <button onClick={() => toggleWeek(w)} style={{
              width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 0', color: C.text,
            }}>
              <span style={{ ...FH, fontSize: 13 }}>Week {w}</span>
              <span style={{ ...FM, fontSize: 12, color: C.sub, display: 'flex', gap: 10, alignItems: 'center' }}>
                {weekPicks.length} pick{weekPicks.length !== 1 ? 's' : ''} · {recordStr(weekRecord)} ·{' '}
                <span style={{ color: weekNetUnits >= 0 ? C.agree : C.warn }}>{weekNetUnits >= 0 ? '+' : ''}{weekNetUnits.toFixed(2)}u</span>
                <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: expanded ? 'rotate(180deg)' : 'none' }}>▼</span>
              </span>
            </button>
            {expanded && (
              <div style={{ paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {weekPicks.map((p) => {
                  const g = p.games;
                  const home = g?.home_team, away = g?.away_team;
                  const resultColor = p.result === 'win' ? C.agree : p.result === 'loss' ? C.warn : p.result === 'push' ? C.pss : C.dim;
                  return (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', ...FM, fontSize: 12 }}>
                      <span style={{ color: C.text }}>
                        {p.is_custom
                          ? p.custom_label
                          : (home && away ? `${playLabel(p, home, away)} — ${away} @ ${home}` : playLabel(p, home || '', away || ''))}
                      </span>
                      <span style={{ color: resultColor, fontWeight: 700 }}>{p.result ? p.result.toUpperCase() : 'PENDING'}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit pick modal — writes to user_picks.
// ---------------------------------------------------------------------------
function PickModal({ game, existing, onClose, onSaved, onDeleted }) {
  const [pickType, setPickType] = useState(existing?.pick_type || 'spread');
  const [side, setSide] = useState(existing?.side || null);
  const [line, setLine] = useState(existing?.line_played != null ? String(existing.line_played) : '');
  const [units, setUnits] = useState(existing?.units || 1);
  const [notes, setNotes] = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);

  const vegasLine = game.current_line != null ? parseFloat(game.current_line) : null;
  const homeSpread = vegasLine != null ? spreadForSide(vegasLine, 'home') : null;
  const awaySpread = vegasLine != null ? spreadForSide(vegasLine, 'away') : null;

  useEffect(() => {
    if (existing) return;
    if (pickType === 'total') { setLine(game.over_under != null ? String(game.over_under) : ''); return; }
    if (side === 'home' && homeSpread != null) setLine(homeSpread.toFixed(1));
    else if (side === 'away' && awaySpread != null) setLine(awaySpread.toFixed(1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, pickType]);

  function fmtSpread(n) { if (n == null) return '—'; return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1); }

  async function handleSave() {
    if (!side) return;
    setSaving(true);
    try {
      await onSaved({ pick_type: pickType, side, line_played: line.trim() === '' ? null : parseFloat(line), units, note: notes.trim() || null });
    } finally { setSaving(false); }
  }
  async function handleDelete() {
    setSaving(true);
    try { await onDeleted(); } finally { setSaving(false); }
  }

  const seg = (active) => ({
    flex: 1, padding: '7px 0', borderRadius: 6, border: `1px solid ${active ? C.pss : C.border}`,
    background: active ? `${C.pss}1F` : C.bg, color: active ? C.pss : C.sub, cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const teamBtn = (active) => ({
    flex: 1, padding: '12px 10px', borderRadius: 8, border: `1px solid ${active ? C.agree : C.border}`,
    background: active ? `${C.agree}1F` : C.bg, color: active ? C.agree : C.text, cursor: 'pointer', textAlign: 'center', fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const unitBtn = (active) => ({
    width: 34, height: 34, borderRadius: 6, border: `1px solid ${active ? C.agree : C.border}`,
    background: active ? C.agree : C.bg, color: active ? '#0F1412' : C.sub, cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const inputStyle = { ...FM, fontSize: 13, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', color: C.text, width: '100%', boxSizing: 'border-box' };

  return (
    <Modal title={`${game.away_team} @ ${game.home_team}`} onClose={onClose}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <button style={seg(pickType === 'spread')} onClick={() => { setPickType('spread'); setSide(null); }}>Spread</button>
        <button style={seg(pickType === 'total')} onClick={() => { setPickType('total'); setSide(null); }}>Total</button>
      </div>

      {pickType === 'spread' ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button style={teamBtn(side === 'away')} onClick={() => setSide('away')}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 3 }}>{game.away_team}</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{fmtSpread(awaySpread)}</div>
          </button>
          <button style={teamBtn(side === 'home')} onClick={() => setSide('home')}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 3 }}>{game.home_team}</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{fmtSpread(homeSpread)}</div>
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button style={teamBtn(side === 'over')} onClick={() => setSide('over')}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 3 }}>Over</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{game.over_under ?? '—'}</div>
          </button>
          <button style={teamBtn(side === 'under')} onClick={() => setSide('under')}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 3 }}>Under</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{game.over_under ?? '—'}</div>
          </button>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Line you got</div>
        <input style={inputStyle} type="number" step="0.5" value={line} onChange={(e) => setLine(e.target.value)} placeholder="e.g. -3.5" />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Units</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 2, 3, 4, 5].map((u) => <button key={u} style={unitBtn(units === u)} onClick={() => setUnits(u)}>{u}</button>)}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Notes (optional)</div>
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 56 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Injuries, weather, matchup notes…" />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {existing && <button onClick={handleDelete} disabled={saving} style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${C.warn}`, background: 'transparent', color: C.warn, cursor: 'pointer', fontSize: 13 }}>Remove</button>}
        <button onClick={onClose} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleSave} disabled={saving || !side} style={{ flex: 2, padding: '9px 0', borderRadius: 8, border: 'none', background: side ? C.agree : C.border, color: side ? '#0F1412' : C.dim, cursor: side && !saving ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
          {saving ? 'Saving…' : 'Save Pick'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Research pick modal — same field set/write path as "Record a Pick from
// Research" on /cfb/research (research_picks table), Game pre-filled to the
// card's game.
// ---------------------------------------------------------------------------
function ResearchPickModal({ game, onClose, onSaved }) {
  const [pickSide, setPickSide] = useState('home');
  const [pickType, setPickType] = useState('spread');
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSaved({ pick_side: pickSide, pick_type: pickType, source_label: source.trim() || null, note: note.trim() || null });
    } finally { setSaving(false); }
  }

  const selStyle = { ...FM, fontSize: 13, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', color: C.text, width: '100%', boxSizing: 'border-box' };

  return (
    <Modal title={`Research pick — ${game.away_team} @ ${game.home_team}`} onClose={onClose}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Side</div>
        <select style={selStyle} value={pickSide} onChange={(e) => setPickSide(e.target.value)}>
          <option value="home">{game.home_team} (Home)</option>
          <option value="away">{game.away_team} (Away)</option>
          <option value="over">Over{game.over_under != null ? ` ${game.over_under}` : ''}</option>
          <option value="under">Under{game.over_under != null ? ` ${game.over_under}` : ''}</option>
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Type</div>
        <select style={selStyle} value={pickType} onChange={(e) => setPickType(e.target.value)}>
          <option value="spread">Spread (ATS)</option>
          <option value="total">Total (O/U)</option>
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Source</div>
        <input style={selStyle} placeholder="e.g. Action Network" value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Note</div>
        <input style={selStyle} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: '9px 0', borderRadius: 8, border: 'none', background: C.pss, color: '#0F1412', cursor: saving ? 'default' : 'pointer', fontSize: 13, fontWeight: 700 }}>
          {saving ? 'Saving…' : 'Save Pick'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Game card
// ---------------------------------------------------------------------------
function GameCard({ row, rank, expanded, onToggle, logos, plays, research, onOpenPickModal, onOpenResearchModal, onRemoveResearch }) {
  const { game, pm } = row;
  const home = game.home_team, away = game.away_team;
  const pp = pssPick(pm, home, away);
  const isElite = pm?.pss_bin === 'Elite';
  const isBet = pm?.decision === 'BET';
  const showBinBadge = pm?.pss_bin && pm.pss_bin !== 'No Play';
  const showDecisionBadge = ['BET', 'CONSIDER', 'WATCH'].includes(pm?.decision);
  const borderColor = isElite && isBet ? C.pss : isBet ? C.agree : C.border;
  const fav = favorite(game.current_line);

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 12 }}>
      <div style={{ ...FM, fontSize: 12, color: C.dim, width: 26, flexShrink: 0, textAlign: 'right', paddingTop: 14 }}>
        {rank ? `#${rank}` : '—'}
      </div>
      <div style={{
        flex: 1, minWidth: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
        borderLeft: `4px solid ${borderColor}`, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Row 1 — matchup */}
            <div style={{ padding: '14px 16px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                <TeamMark logoUrl={logos[away]} name={away} />
                <span style={{ ...FH, fontSize: 14.5, color: C.text }}>
                  {away}{fav?.side === 'away' && <span style={{ color: C.sub, fontWeight: 400 }}> (-{fav.amt.toFixed(1)})</span>}
                </span>
                <span style={{ color: C.dim, fontSize: 12 }}>@</span>
                <TeamMark logoUrl={logos[home]} name={home} />
                <span style={{ ...FH, fontSize: 14.5, color: C.text }}>
                  {home}{fav?.side === 'home' && <span style={{ color: C.sub, fontWeight: 400 }}> (-{fav.amt.toFixed(1)})</span>}
                </span>
              </div>
              <div style={{ ...FM, fontSize: 11, color: C.sub, textAlign: 'right', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <span>{fmtKickoff(game.kickoff_at)}</span>
                {game.tv_network && <span>{game.tv_network}</span>}
                <span>O/U {game.over_under != null ? fmt(game.over_under, 1) : '—'}</span>
              </div>
            </div>

            <div style={{ height: 1, background: C.border, margin: '0 16px' }} />

            {/* Row 2 — pick + tags */}
            <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {pm ? (
                  <>
                    <span style={{ ...FH, fontSize: 10.5, color: C.sub }}>PSS PICK</span>
                    <span style={{ ...FM, fontSize: 13, color: C.text }}>{pp ? favored(pp.team, pp.num) : '—'}</span>
                    <Badge color={DECISION_COLOR[pm.decision] || C.dim} filled>{fmt(pm.pss, 1)}</Badge>
                    <span style={{ ...FM, fontSize: 11, color: C.sub }}>Edge {fmt(pm.edge, 1)} · STD {fmt(pm.stddev, 1)}</span>
                  </>
                ) : (
                  <span style={{ ...FM, fontSize: 12, color: C.dim }}>PSS not computed yet</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {showBinBadge && <Badge color={PSS_BIN_COLOR[pm.pss_bin]} filled>{pm.pss_bin.toUpperCase()}</Badge>}
                {showDecisionBadge && <Badge color={DECISION_COLOR[pm.decision]} filled>MODEL - {pm.decision}</Badge>}
                {(research || []).map((r) => (
                  <span key={r.id} style={{ ...FM, fontSize: 10.5, padding: '2px 6px 2px 8px', borderRadius: 10, border: `1px solid ${C.border}`, color: C.sub, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {researchSideLabel(r, home, away)}{r.source_label ? ` · ${r.source_label}` : ''}
                    <button onClick={() => onRemoveResearch(r.id)} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 10, padding: 0, lineHeight: 1 }}>✕</button>
                  </span>
                ))}
                {(plays || []).length === 0 ? (
                  <button onClick={() => onOpenPickModal(null)} style={{ ...FM, fontSize: 10.5, padding: '3px 9px', borderRadius: 10, border: `1px dashed ${C.agree}`, background: 'transparent', color: C.agree, cursor: 'pointer' }}>
                    + Add Pick
                  </button>
                ) : (
                  (plays || []).map((p) => (
                    <button key={p.id} onClick={() => onOpenPickModal(p)} style={{ ...FM, fontSize: 10.5, padding: '3px 9px', borderRadius: 10, border: `1px solid ${C.mine}`, background: `${C.mine}14`, color: C.mine, cursor: 'pointer' }}>
                      BOBBY PICK · {(parseFloat(p.units) || 1).toFixed(p.units % 1 === 0 ? 0 : 1)}u {playLabel(p, home, away)}
                    </button>
                  ))
                )}
                <button onClick={onOpenResearchModal} style={{ ...FM, fontSize: 10.5, padding: '3px 9px', borderRadius: 10, border: `1px dashed ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>
                  + Research
                </button>
              </div>
            </div>
          </div>

          <button onClick={onToggle} aria-label="Toggle details" style={{
            width: 40, flexShrink: 0, border: 'none', borderLeft: `1px solid ${C.border}`,
            background: expanded ? C.surface2 : 'transparent', color: C.sub, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
          }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: expanded ? 'rotate(180deg)' : 'none' }}>▼</span>
          </button>
        </div>

        {expanded && pm && (
          <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface2, padding: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px 16px', marginBottom: 16 }}>
              <Stat label="PICK" value={pp ? favored(pp.team, pp.num) : '—'} size={14} />
              <Stat label="PSS SCORE" value={fmt(pm.pss, 1)} size={14} color={DECISION_COLOR[pm.decision]} />
              <Stat label="BIN / DECISION" value={`${pm.pss_bin || '—'} / ${pm.decision || '—'}`} color={PSS_BIN_COLOR[pm.pss_bin]} />
              <Stat label="TOP-K TIER" value={pm.qualifying_tier ? `${TIER_LABEL[pm.qualifying_tier]} · ${pm.signal_type}` : `No tier (eval. to Top-${pm.selected_k})`} />
              <Stat label="EDGE / AGREEMENT" value={`${fmt(pm.edge, 2)} / ${pm.agreement != null ? `${Math.round(pm.agreement * 100)}%` : '—'}`} />
              <Stat label="STDDEV" value={fmt(pm.stddev, 2)} />
              <Stat label="MSS COMPONENT / MARKET ALIGNMENT" value={`${fmt(pm.mss_score, 1)} / ${pm.market_alignment || '—'}`} />
              <Stat label="HISTORICAL TIER" value={pm.historical_tier || '—'} />
              <Stat label="PSS RANK" value={rank ? `#${rank}` : '—'} />
            </div>

            <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 6 }}>DRIVERS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {pm.pss_drivers?.length ? pm.pss_drivers.map((d, i) => <span key={i} style={{ ...FM, fontSize: 11, padding: '3px 8px', borderRadius: 3, background: `${C.agree}1F`, color: C.agree }}>+ {d}</span>) : <span style={{ ...FM, fontSize: 11, color: C.dim }}>None</span>}
            </div>
            <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 6 }}>WARNINGS</div>
            <div style={{ ...FM, fontSize: 11.5, color: pm.warnings?.length ? C.warn : C.dim, marginBottom: 16 }}>
              {pm.warnings?.length ? pm.warnings.join(', ') : 'None'}
            </div>

            <ModelBreakdownTable row={row} />
          </div>
        )}
        {expanded && !pm && (
          <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface2, padding: '16px', ...FM, fontSize: 12, color: C.dim }}>
            No PSS data for this game yet.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-select filter dropdown (PSS Bin / PSS Play)
// ---------------------------------------------------------------------------
function MultiSelectFilter({ label, options, selected, onToggle, counts }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const active = selected.size > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        ...FM, fontSize: 11.5, padding: '6px 12px', borderRadius: 3, cursor: 'pointer',
        border: `1px solid ${active ? C.pss : C.border}`,
        background: active ? `${C.pss}1A` : 'transparent',
        color: active ? C.pss : C.sub,
      }}>{label}{active ? ` (${selected.size})` : ''} ▾</button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20, minWidth: 180,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: 6,
          boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
        }}>
          {options.map((opt) => {
            const isChecked = selected.has(opt.value);
            return (
              <label key={opt.value} style={{
                ...FM, fontSize: 11.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                padding: '6px 8px', borderRadius: 3, cursor: 'pointer', color: isChecked ? C.pss : C.text,
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={isChecked} onChange={() => onToggle(opt.value)} style={{ margin: 0, cursor: 'pointer' }} />
                  {opt.label}
                </span>
                <span style={{ color: C.sub }}>{counts[opt.value] ?? 0}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level dashboard
// ---------------------------------------------------------------------------
const FILTERS = [
  { key: 'all', label: 'All Games' },
  { key: 'model', label: 'Model Plays' },
  { key: 'mine', label: "Bobby's Plays" },
];
const PSS_BIN_FILTER_OPTIONS = PSS_BIN_ORDER.filter((b) => b !== 'No Play').map((b) => ({ value: b, label: b }));
const PSS_PLAY_FILTER_OPTIONS = [
  { value: 'BET', label: 'Bet' },
  { value: 'CONSIDER', label: 'Consider' },
  { value: 'WATCH', label: 'Watch' },
];

export default function Dashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const [rows, setRows] = useState([]);
  const [logos, setLogos] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [expandedIds, setExpandedIds] = useState(new Set());
  const [filter, setFilter] = useState('all');
  const [pssBinFilter, setPssBinFilter] = useState(new Set());
  const [pssPlayFilter, setPssPlayFilter] = useState(new Set());
  const [teamSearch, setTeamSearch] = useState('');
  const [sortBy, setSortBy] = useState('pss');

  const [picksByGame, setPicksByGame] = useState({});
  const [researchByGame, setResearchByGame] = useState({});
  const [pickModal, setPickModal] = useState(null); // { row, existing }
  const [researchModalRow, setResearchModalRow] = useState(null);
  const [showLegend, setShowLegend] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sbFetch(`games?select=week&season=eq.${season}&order=week.desc&limit=1`)
      .then((r) => { if (!cancelled) setWeek(r.length ? r[0].week : 1); })
      .catch(() => { if (!cancelled) setWeek(1); });
    return () => { cancelled = true; };
  }, [season]);

  async function loadWeek() {
    setLoading(true); setError(null);
    try {
      const [games, logoRows] = await Promise.all([
        sbFetch(
          `games?select=id,home_team,away_team,kickoff_at,current_line,opening_line,over_under,tv_network,status,` +
          `pss_game_metrics(pss,pss_bin,decision,qualifies,qualifying_tier,signal_type,selected_k,agreement,agreement_count,agreement_k,stddev,edge,consensus_spread,vegas_line,suggested_side,suggested_line,pss_drivers,warnings,raw_mss,mss_score,edge_score,agreement_score,stddev_score,historical_score,market_alignment,historical_tier,selected_model_ids)` +
          `&season=eq.${season}&week=eq.${week}`
        ),
        sbFetch(`team_logos?select=team_name,logo_url`),
      ]);
      const logoMap = {};
      for (const l of logoRows) logoMap[l.team_name] = l.logo_url;
      const built = games.map((g) => ({
        game: g,
        pm: Array.isArray(g.pss_game_metrics) ? g.pss_game_metrics[0] : g.pss_game_metrics,
      }));
      setRows(built);
      setLogos(logoMap);

      if (games.length > 0) {
        const ids = games.map((g) => g.id).join(',');
        try {
          const picks = await sbFetch(`user_picks?select=*&game_id=in.(${ids})&pick_type=neq.note&status=neq.lean&order=created_at.asc`);
          const grouped = {};
          for (const p of picks) {
            if (!grouped[p.game_id]) grouped[p.game_id] = [];
            grouped[p.game_id].push(p);
          }
          setPicksByGame(grouped);
        } catch (e) { console.error('Failed to load picks:', e); setPicksByGame({}); }
        try {
          const research = await sbFetch(`research_picks?select=*&game_id=in.(${ids})&order=created_at.asc`);
          const grouped = {};
          for (const r of research) {
            if (!grouped[r.game_id]) grouped[r.game_id] = [];
            grouped[r.game_id].push(r);
          }
          setResearchByGame(grouped);
        } catch (e) { console.error('Failed to load research picks:', e); setResearchByGame({}); }
      } else {
        setPicksByGame({});
        setResearchByGame({});
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (week != null) loadWeek(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [season, week]);

  const toggle = (id) => setExpandedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function savePick(gameId, data) {
    const existing = pickModal?.existing;
    if (existing) {
      const [updated] = await sbFetch(`user_picks?id=eq.${existing.id}`, {
        method: 'PATCH', body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: (prev[gameId] || []).map((p) => p.id === existing.id ? updated : p) }));
    } else {
      const [created] = await sbFetch(`user_picks`, {
        method: 'POST',
        body: JSON.stringify({ game_id: gameId, season, week, played: true, status: 'official', ...data }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: [...(prev[gameId] || []), created] }));
    }
    setPickModal(null);
  }
  async function deletePick(gameId) {
    const existing = pickModal?.existing;
    if (existing) {
      await sbFetch(`user_picks?id=eq.${existing.id}`, { method: 'DELETE' });
      setPicksByGame((prev) => ({ ...prev, [gameId]: (prev[gameId] || []).filter((p) => p.id !== existing.id) }));
    }
    setPickModal(null);
  }

  async function saveResearchPick(gameId, home, away, data) {
    const [created] = await sbFetch(`research_picks`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gameId, season, week, home_team: home, away_team: away, ...data }),
    });
    setResearchByGame((prev) => ({ ...prev, [gameId]: [...(prev[gameId] || []), created] }));
    setResearchModalRow(null);
  }
  async function removeResearchPick(gameId, id) {
    await sbFetch(`research_picks?id=eq.${id}`, { method: 'DELETE' });
    setResearchByGame((prev) => ({ ...prev, [gameId]: (prev[gameId] || []).filter((r) => r.id !== id) }));
  }

  const pssRankMap = useMemo(() => {
    const ranked = [...rows].filter((r) => r.pm != null).sort((a, b) => b.pm.pss - a.pm.pss);
    const map = {};
    ranked.forEach((r, i) => { map[r.game.id] = i + 1; });
    return map;
  }, [rows]);

  const counts = useMemo(() => ({
    all: rows.length,
    model: rows.filter((r) => r.pm?.decision === 'BET').length,
    mine: rows.filter((r) => (picksByGame[r.game.id] || []).length > 0).length,
  }), [rows, picksByGame]);

  const pssBinCounts = useMemo(() => {
    const c = {};
    for (const opt of PSS_BIN_FILTER_OPTIONS) c[opt.value] = rows.filter((r) => r.pm?.pss_bin === opt.value).length;
    return c;
  }, [rows]);
  const pssPlayCounts = useMemo(() => {
    const c = {};
    for (const opt of PSS_PLAY_FILTER_OPTIONS) c[opt.value] = rows.filter((r) => r.pm?.decision === opt.value).length;
    return c;
  }, [rows]);

  function toggleSetValue(setter, value) {
    setter((prev) => { const n = new Set(prev); n.has(value) ? n.delete(value) : n.add(value); return n; });
  }

  const displayed = useMemo(() => {
    let list = rows.filter((r) => {
      if (filter === 'model' && r.pm?.decision !== 'BET') return false;
      if (filter === 'mine' && (picksByGame[r.game.id] || []).length === 0) return false;
      if (pssBinFilter.size > 0 && !pssBinFilter.has(r.pm?.pss_bin)) return false;
      if (pssPlayFilter.size > 0 && !pssPlayFilter.has(r.pm?.decision)) return false;
      if (teamSearch.trim()) {
        const q = teamSearch.trim().toLowerCase();
        if (!r.game.home_team.toLowerCase().includes(q) && !r.game.away_team.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      if (sortBy === 'kickoff') return new Date(a.game.kickoff_at || 0) - new Date(b.game.kickoff_at || 0);
      if (sortBy === 'team') return a.game.away_team.localeCompare(b.game.away_team);
      return (b.pm?.pss ?? -Infinity) - (a.pm?.pss ?? -Infinity);
    });
    return list;
  }, [rows, filter, pssBinFilter, pssPlayFilter, teamSearch, sortBy, picksByGame]);

  const selectStyle = { ...FM, fontSize: 11.5, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '7px 9px', color: C.text, cursor: 'pointer' };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '24px 16px', color: C.text }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap'); select option { background: ${C.surface}; }`}</style>

      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        {showLegend && <LegendModal onClose={() => setShowLegend(false)} />}
        {showStats && week != null && <SeasonStatsModal season={season} week={week} onClose={() => setShowStats(false)} />}
        {showCard && <MyCardModal rows={rows} picksByGame={picksByGame} season={season} onClose={() => setShowCard(false)} />}
        {pickModal && (
          <PickModal
            game={pickModal.row.game}
            existing={pickModal.existing}
            onClose={() => setPickModal(null)}
            onSaved={(data) => savePick(pickModal.row.game.id, data)}
            onDeleted={() => deletePick(pickModal.row.game.id)}
          />
        )}
        {researchModalRow && (
          <ResearchPickModal
            game={researchModalRow.game}
            onClose={() => setResearchModalRow(null)}
            onSaved={(data) => saveResearchPick(researchModalRow.game.id, researchModalRow.game.home_team, researchModalRow.game.away_team, data)}
          />
        )}

        {/* Top bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ ...FH, fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>BobbyModels</div>
            <div style={{ ...FM, fontSize: 12, color: C.sub, marginTop: 2, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>Season</span>
              <input type="number" value={season} onChange={(e) => setSeason(parseInt(e.target.value) || season)} style={{ ...selectStyle, width: 68 }} />
              <span>Week</span>
              <input type="number" value={week ?? ''} onChange={(e) => setWeek(parseInt(e.target.value) || week)} style={{ ...selectStyle, width: 50 }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setShowLegend(true)} style={{ ...FM, fontSize: 11.5, padding: '7px 12px', borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>? Legend</button>
            <button onClick={() => setShowStats(true)} style={{ ...FM, fontSize: 11.5, padding: '7px 12px', borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>📊 Season stats</button>
            <button onClick={() => setShowCard(true)} style={{ ...FM, fontSize: 11.5, padding: '7px 12px', borderRadius: 4, border: `1px solid ${C.pss}`, background: `${C.pss}1A`, color: C.pss, cursor: 'pointer' }}>🎯 My card</button>
          </div>
        </div>

        {error && <div style={{ ...FM, fontSize: 12, color: C.warn, background: `${C.warn}14`, border: `1px solid ${C.warn}`, borderRadius: 4, padding: '10px 14px', marginBottom: 16 }}>{error}</div>}

        {!loading && !error && (
          <>
            {/* Filters + search + sort */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              {FILTERS.map((f) => (
                <button key={f.key} onClick={() => setFilter(f.key)} style={{
                  ...FM, fontSize: 11.5, padding: '6px 12px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${filter === f.key ? C.pss : C.border}`,
                  background: filter === f.key ? `${C.pss}1A` : 'transparent',
                  color: filter === f.key ? C.pss : C.sub,
                }}>{f.label} ({counts[f.key]})</button>
              ))}
              <MultiSelectFilter
                label="PSS Bin"
                options={PSS_BIN_FILTER_OPTIONS}
                selected={pssBinFilter}
                onToggle={(v) => toggleSetValue(setPssBinFilter, v)}
                counts={pssBinCounts}
              />
              <MultiSelectFilter
                label="PSS Play"
                options={PSS_PLAY_FILTER_OPTIONS}
                selected={pssPlayFilter}
                onToggle={(v) => toggleSetValue(setPssPlayFilter, v)}
                counts={pssPlayCounts}
              />
              <input
                type="text" placeholder="Search team…" value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
                style={{ ...selectStyle, width: 140, outline: 'none' }}
              />
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...selectStyle, marginLeft: 'auto' }}>
                <option value="pss">Sort: PSS Score</option>
                <option value="kickoff">Sort: Game time</option>
                <option value="team">Sort: Team</option>
              </select>
            </div>

            {displayed.map((r) => (
              <GameCard
                key={r.game.id}
                row={r}
                rank={pssRankMap[r.game.id]}
                expanded={expandedIds.has(r.game.id)}
                onToggle={() => toggle(r.game.id)}
                logos={logos}
                plays={picksByGame[r.game.id]}
                research={researchByGame[r.game.id]}
                onOpenPickModal={(existing) => setPickModal({ row: r, existing })}
                onOpenResearchModal={() => setResearchModalRow(r)}
                onRemoveResearch={(id) => removeResearchPick(r.game.id, id)}
              />
            ))}
            {displayed.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub, padding: '20px 0' }}>No games match these filters.</div>}
          </>
        )}

        {loading && <div style={{ ...FM, fontSize: 12, color: C.sub, padding: '40px 0', textAlign: 'center' }}>Loading week {week ?? '…'}…</div>}
      </div>
    </div>
  );
}
