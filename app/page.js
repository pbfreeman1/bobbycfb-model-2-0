'use client';

import { useEffect, useMemo, useState } from 'react';
import { sbFetch, getCurrentWeek, fmt, fmtKickoff, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase';

const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

const FH = { fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif" };
const FM = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };
const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', mss: '#5B8F63', pss: '#D4A73C',
  agree: '#6FBF73', warn: '#C4573F', dim: '#5B655F',
};

const PSS_BIN_ORDER = ['Elite', 'Very Strong', 'Strong', 'Moderate', 'No Play'];
const MSS_BIN_ORDER = ['Very Strong', 'Strong', 'Moderate', 'Weak', 'Very Weak'];
const DECISION_COLOR = { BET: C.agree, CONSIDER: C.pss, WATCH: C.sub, REVIEW: C.warn, PASS: C.dim };
const MSS_BIN_COLOR = { 'Very Strong': C.agree, Strong: C.mss, Moderate: C.pss, Weak: '#8B7355', 'Very Weak': C.dim };
const PSS_BIN_COLOR = { Elite: C.agree, 'Very Strong': C.pss, Strong: '#C4933A', Moderate: '#8B7355', 'No Play': C.dim };
const TIER_LABEL = { top3: 'Top-3', top5: 'Top-5', top7: 'Top-7' };

// ---------------------------------------------------------------------------
// Line-sign helpers — stored lines are positive = home favored (see
// lib domain convention). Mirrors consensusPick()/modelPick() already used
// on /mss-dashboard and /pss-dashboard, so display math stays identical
// across all three pages.
// ---------------------------------------------------------------------------
function spreadForSide(line, side) {
  if (line === null || line === undefined) return null;
  const v = parseFloat(line);
  if (Number.isNaN(v)) return null;
  return side === 'home' ? -v : v;
}
function favoredMarket(line, homeTeam, awayTeam) {
  if (line === null || line === undefined) return '—';
  const v = parseFloat(line);
  if (Number.isNaN(v)) return '—';
  if (v === 0) return "Pick'em";
  return v > 0 ? `${homeTeam} -${v}` : `${awayTeam} -${Math.abs(v)}`;
}
function favored(team, num) {
  if (num === null || num === undefined || Number.isNaN(num)) return `${team} —`;
  return `${team} -${Math.abs(num).toFixed(1)}`;
}
// MSS doesn't always populate suggested_side (only when suggested_play is
// true), so its "pick" — unlike PSS's — is derived from edge sign, same as
// the original dashboard's consensusPick().
function mssPick(gm, homeTeam, awayTeam) {
  if (gm?.consensus_spread == null || gm?.edge == null) return null;
  const side = parseFloat(gm.edge) >= 0 ? 'home' : 'away';
  const team = side === 'home' ? homeTeam : awayTeam;
  return { side, team, num: spreadForSide(gm.consensus_spread, side) };
}
// PSS always populates suggested_side, qualifying or not.
function pssPick(pm, homeTeam, awayTeam) {
  if (pm?.consensus_spread == null || pm?.suggested_side == null) return null;
  const side = pm.suggested_side;
  const team = side === 'home' ? homeTeam : awayTeam;
  return { side, team, num: spreadForSide(pm.consensus_spread, side) };
}
function fmtLineMove(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------
function Stat({ label, value, color, size = 14 }) {
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
function Move({ v }) {
  if (v === null) return <span style={{ ...FM, color: C.dim }}>—</span>;
  if (v > 0) return <span style={{ color: C.agree, ...FM, display: 'inline-flex', alignItems: 'center', gap: 2 }}>▲ +{v}</span>;
  if (v < 0) return <span style={{ color: C.warn, ...FM, display: 'inline-flex', alignItems: 'center', gap: 2 }}>▼ {v}</span>;
  return <span style={{ color: C.sub, ...FM }}>— 0</span>;
}
function TeamMark({ logoUrl, name }) {
  if (logoUrl) return <img src={logoUrl} alt={name} style={{ width: 24, height: 24, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
  return (
    <div style={{ width: 24, height: 24, borderRadius: '50%', background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8.5, ...FM, color: C.sub, flexShrink: 0 }}>
      {name.slice(0, 3).toUpperCase()}
    </div>
  );
}
// Same fields as the quick-add form on /research (source, side, type) —
// this is a compact version for adding a tag without leaving the board.
function ResearchQuickAdd({ home, away, onAdd, onDone }) {
  const [source, setSource] = useState('');
  const [side, setSide] = useState('home');
  const [type, setType] = useState('spread');
  const [saving, setSaving] = useState(false);
  const inputStyle = { ...FM, fontSize: 11, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, padding: '5px 8px', color: C.text };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0' }}>
      <input placeholder="Source (e.g. Bill C.)" value={source} onChange={(e) => setSource(e.target.value)} style={{ ...inputStyle, width: 150 }} />
      <select value={side} onChange={(e) => setSide(e.target.value)} style={inputStyle}>
        <option value="home">{home}</option>
        <option value="away">{away}</option>
        <option value="over">Over</option>
        <option value="under">Under</option>
      </select>
      <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
        <option value="spread">Spread</option>
        <option value="total">Total</option>
        <option value="moneyline">ML</option>
      </select>
      <button disabled={saving || !source.trim()} onClick={async () => { setSaving(true); try { await onAdd(source.trim(), side, type); setSource(''); } finally { setSaving(false); } }}
        style={{ ...FM, fontSize: 11, padding: '5px 10px', borderRadius: 3, border: `1px solid ${C.pss}`, background: `${C.pss}1A`, color: C.pss, cursor: saving ? 'default' : 'pointer', opacity: saving || !source.trim() ? 0.6 : 1 }}>
        Add tag
      </button>
      <button onClick={onDone} style={{ background: 'none', border: 'none', color: C.sub, cursor: 'pointer', fontSize: 13 }}>✕</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell shared by Drilldown / Legend / Season Stats / My Card
// ---------------------------------------------------------------------------
function Modal({ title, onClose, children, wide }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
        width: '100%', maxWidth: wide ? 720 : 520, padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ ...FH, fontSize: 16, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.sub, cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function ModalTabs({ tab, setTab, tabs }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
      {tabs.map(([key, label, color]) => (
        <button key={key} onClick={() => setTab(key)} style={{
          ...FM, fontSize: 12, padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
          border: `1px solid ${tab === key ? color : C.border}`,
          background: tab === key ? `${color}1A` : 'transparent',
          color: tab === key ? color : C.sub,
        }}>{label}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-model prediction breakdown — fetches raw_predictions live for the
// top-K model IDs stored in game_metrics.topk_model_ids, then renders
// the PSS component breakdown table + individual model predictions table,
// matching the DetailPanel layout on the PSS dashboard page.
// ---------------------------------------------------------------------------
function ModelBreakdownTable({ row }) {
  const { game, gm, pm } = row;
  const home = game.home_team, away = game.away_team;
  const vegasLine = parseFloat(gm?.vegas_line ?? pm?.vegas_line ?? 0);
  const topkIds = gm?.topk_model_ids || pm?.topk_model_ids || [];

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

  // PSS component breakdown rows (mirrors PSS DetailPanel section B)
  const pssComponents = pm ? [
    { label: 'Edge',       actual: pm.edge != null ? (pm.edge > 0 ? `+${pm.edge.toFixed(1)}` : pm.edge.toFixed(1)) : '—', score: pm.edge_score,      weight: 30 },
    { label: 'MSS',        actual: pm.mss_score != null ? pm.mss_score.toFixed(1) : '—',                                   score: pm.mss_score,       weight: 25 },
    { label: 'Agreement',  actual: pm.agreement_count != null ? `${pm.agreement_count}/${pm.agreement_k}` : (pm.agreement != null ? `${Math.round(pm.agreement * 100)}%` : '—'), score: pm.agreement_score, weight: 20 },
    { label: 'STD',        actual: pm.stddev != null ? pm.stddev.toFixed(2) : '—',                                         score: pm.stddev_score,    weight: 15 },
    { label: 'Historical', actual: pm.historical_tier || '—',                                                               score: pm.historical_score, weight: 10 },
  ] : null;
  const pssTotal = pssComponents ? pssComponents.reduce((a, c) => a + ((c.score || 0) * c.weight) / 100, 0) : null;

  const thStyle = { ...FM, fontSize: 10, color: C.sub, padding: '6px 10px', background: C.surface2, letterSpacing: 0.3, textAlign: 'left', borderBottom: `1px solid ${C.border}` };
  const tdStyle = { ...FM, fontSize: 11.5, padding: '7px 10px', borderBottom: `1px solid ${C.border}` };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* PSS Component Breakdown — only shown when PSS data exists */}
      {pssComponents && (
        <div>
          <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 8 }}>PSS COMPONENT BREAKDOWN</div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['COMPONENT', 'ACTUAL', 'SCORE', 'WEIGHT', 'CONTRIBUTION'].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
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

      {/* Individual Model Predictions */}
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
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['MODEL', 'PREDICTED SPREAD', 'EDGE VS MARKET', 'SELECTED SIDE'].map((h) => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {models.map((m, i) => {
                    const pred = parseFloat(m.predicted_margin);
                    const edge = pred - vegasLine;
                    const side = edge > 0 ? home : edge < 0 ? away : 'Even';
                    const edgeColor = Math.abs(edge) >= 1.5 ? C.agree : C.sub;
                    return (
                      <tr key={m.model_id} style={{ background: i % 2 === 0 ? 'transparent' : C.surface2 }}>
                        <td style={{ ...tdStyle, color: C.text }}>{m.source_models?.system_name || 'Unknown'}</td>
                        <td style={{ ...tdStyle, color: C.sub }}>{pred > 0 ? `+${pred.toFixed(1)}` : pred.toFixed(1)}</td>
                        <td style={{ ...tdStyle, color: edgeColor }}>{edge > 0 ? `+${edge.toFixed(1)}` : edge.toFixed(1)}</td>
                        <td style={{ ...tdStyle, color: edge > 0 ? C.agree : C.pss }}>{side}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {modelStats && (
              <div style={{ ...FM, fontSize: 11, color: C.sub, marginTop: 8, display: 'flex', gap: 20 }}>
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
// Drilldown modal — every field the card trims out, for one game
// ---------------------------------------------------------------------------
function DrilldownModal({ row, range, agreementAll, onClose }) {
  const [tab, setTab] = useState('pss');
  const { game, gm, pm } = row;
  const home = game.home_team, away = game.away_team;
  const mp = mssPick(gm, home, away);
  const pp = pssPick(pm, home, away);
  return (
    <Modal title={`${away} @ ${home} — full breakdown`} onClose={onClose} wide>
      <ModalTabs tab={tab} setTab={setTab} tabs={[['pss', 'PSS Detail', C.pss], ['mss', 'MSS Detail', C.mss]]} />
      {tab === 'pss' ? (
        pm ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 16px', marginBottom: 16 }}>
              <Stat label="PICK" value={pp ? favored(pp.team, pp.num) : '—'} size={16} />
              <Stat label="PSS SCORE" value={fmt(pm.pss, 1)} size={16} color={DECISION_COLOR[pm.decision]} />
              <Stat label="BIN" value={pm.pss_bin || '—'} color={PSS_BIN_COLOR[pm.pss_bin]} />
              <Stat label="DECISION" value={pm.decision || '—'} color={DECISION_COLOR[pm.decision]} />
              <Stat label="TOP-K TIER" value={pm.qualifying_tier ? `${TIER_LABEL[pm.qualifying_tier]} · ${pm.signal_type}` : `No tier (eval. to Top-${pm.selected_k})`} />
              <Stat label="EDGE" value={fmt(pm.edge, 2)} />
              <Stat label="AGREEMENT" value={pm.agreement != null ? `${Math.round(pm.agreement * 100)}%` : '—'} />
              <Stat label="STDDEV" value={fmt(pm.stddev, 2)} />
              <Stat label="MSS COMPONENT" value={fmt(pm.mss_score, 1)} />
              <Stat label="MARKET ALIGNMENT" value={pm.market_alignment || '—'} />
              <Stat label="HISTORICAL TIER" value={pm.historical_tier || '—'} />
            </div>
            <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 6 }}>DRIVERS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {pm.pss_drivers?.length ? pm.pss_drivers.map((d, i) => <span key={i} style={{ ...FM, fontSize: 11, padding: '3px 8px', borderRadius: 3, background: `${C.agree}1F`, color: C.agree }}>+ {d}</span>) : <span style={{ ...FM, fontSize: 11, color: C.dim }}>None</span>}
            </div>
            <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 6 }}>WARNINGS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {pm.warnings?.length ? pm.warnings.map((w, i) => <span key={i} style={{ ...FM, fontSize: 11, padding: '3px 8px', borderRadius: 3, background: `${C.warn}1F`, color: C.warn }}>! {w}</span>) : <span style={{ ...FM, fontSize: 11, color: C.dim }}>None</span>}
            </div>
            <ModelBreakdownTable row={row} />
          </div>
        ) : <div style={{ ...FM, fontSize: 12, color: C.dim }}>No PSS data for this game.</div>
      ) : (
        gm ? (<>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 16px' }}>
            <Stat label="PICK" value={mp ? favored(mp.team, mp.num) : '—'} size={16} />
            <Stat label="MSS" value={fmt(gm.mss, 1)} size={16} color={MSS_BIN_COLOR[gm.confidence_bin]} />
            <Stat label="CONFIDENCE" value={gm.confidence_bin || '—'} color={MSS_BIN_COLOR[gm.confidence_bin]} />
            <Stat label="EDGE" value={fmt(gm.edge, 2)} />
            <Stat label="AGREEMENT (TOP-K)" value={gm.agreement != null ? `${Math.round(gm.agreement * 100)}%` : '—'} />
            <Stat label="AGREEMENT (ALL)" value={agreementAll ? `${Math.round(agreementAll.pct)}% (${agreementAll.count}/${agreementAll.total})` : '—'} />
            <Stat label="STDDEV" value={fmt(gm.stddev, 2)} />
            <Stat label="RANGE" value={range != null ? fmt(range, 2) : '—'} />
            <Stat label="# MODELS" value={gm.valid_model_count ?? '—'} />
            <Stat label="MODEL PLAY?" value={gm.suggested_play ? 'Yes' : 'No'} color={gm.suggested_play ? C.agree : C.dim} />
          </div>
          <div style={{ marginTop: 16 }}><ModelBreakdownTable row={row} /></div>
        </>) : <div style={{ ...FM, fontSize: 12, color: C.dim }}>No MSS data for this game.</div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Legend modal — static, values pulled directly from lib/pss-engine.js and
// app/api/compute/route.js rather than approximated.
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
      <Section title="PSS (BobbyPSSModel) — primary signal" color={C.pss}>
        <p><b style={{ color: C.text }}>PSS score (0–100):</b> 30% Edge + 25% MSS + 20% Agreement + 15% Dispersion(StdDev) + 10% Historical Tier.</p>
        <p><b style={{ color: C.text }}>Bins:</b> {PSS_BIN_ORDER.join(' → ')}, high to low.</p>
        <p><b style={{ color: C.text }}>Top-K tier:</b> Top-3 = Conviction, Top-5 = Confirmation, Top-7 = Consensus — the cascade tries 3 first and falls back to 5, then 7.</p>
        <p><b style={{ color: C.text }}>Decision:</b> BET (PSS ≥82) · CONSIDER (74–81.9) · WATCH (66–73.9) · PASS (&lt;66). A BET can downgrade to REVIEW if the market has moved against the model and edge retention has dropped below 50%.</p>
        <p><b style={{ color: C.text }}>Hard vetoes</b> force PASS regardless of score: StdDev &gt; 6, Agreement &lt; 70%, or |Edge| &lt; 2.</p>
      </Section>
      <Section title="BobbyModel (MSS) — secondary, supporting signal" color={C.mss}>
        <p><b style={{ color: C.text }}>Confidence bins:</b> {MSS_BIN_ORDER.join(' → ')}.</p>
        <p><b style={{ color: C.text }}>MODEL PLAY badge:</b> backtested qualification filter — Edge ≥1.5, StdDev ≤2.5, Agreement ≥85%.</p>
      </Section>
      <Section title="Shared terms" color={C.text}>
        <p><b style={{ color: C.text }}>Edge:</b> model spread minus the current market line.</p>
        <p><b style={{ color: C.text }}>Agreement:</b> share of the selected model pool favoring the same side as the edge.</p>
        <p><b style={{ color: C.text }}>StdDev:</b> spread in predictions across the selected models — lower means tighter consensus.</p>
      </Section>
      <Section title="Fastest way to find the best plays" color={C.agree}>
        <p>Sort by PSS rank (default). Look for <b style={{ color: C.text }}>BET</b>-decision games where the agreement banner shows the two models converged.</p>
      </Section>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Season stats modal — reuses the exact query pattern /bobby-results uses.
// Record/ATS% only; there's no units figure at the model-grading level.
// ---------------------------------------------------------------------------
function SeasonStatsModal({ season, week, onClose }) {
  const [tab, setTab] = useState('pss');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ pss: null, mss: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        // MSS: game_metrics has no season/week of its own — look games up first.
        const games = await sbFetch(`games?select=id&season=eq.${season}&week=lte.${week}`);
        const idList = games.length ? `(${games.map((g) => g.id).join(',')})` : '(00000000-0000-0000-0000-000000000000)';
        const mssMetrics = await sbFetch(`game_metrics?select=id,confidence_bin,suggested_play,pick_grades(ats_result)&game_id=in.${idList}`);
        const mssGraded = mssMetrics.map((m) => ({ ...m, pg: Array.isArray(m.pick_grades) ? m.pick_grades[0] : m.pick_grades })).filter((m) => m.pg);

        // PSS: pss_game_metrics carries season/week directly.
        const pssMetrics = await sbFetch(`pss_game_metrics?select=id,pss_bin,qualifies,pss_pick_grades(ats_result)&season=eq.${season}&week=lte.${week}`);
        const pssGraded = pssMetrics.map((m) => ({ ...m, pg: Array.isArray(m.pss_pick_grades) ? m.pss_pick_grades[0] : m.pss_pick_grades })).filter((m) => m.pg);

        if (cancelled) return;
        setData({
          mss: {
            overall: tally(mssGraded.filter((m) => m.suggested_play).map((m) => m.pg.ats_result)),
            rows: bucketBy(mssGraded, (m) => m.confidence_bin || 'Very Weak', MSS_BIN_ORDER),
          },
          pss: {
            overall: tally(pssGraded.filter((m) => m.qualifies).map((m) => m.pg.ats_result)),
            rows: bucketBy(pssGraded, (m) => m.pss_bin || 'No Play', PSS_BIN_ORDER),
          },
        });
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [season, week]);

  const d = data[tab];
  return (
    <Modal title="Season stats" onClose={onClose} wide>
      <ModalTabs tab={tab} setTab={setTab} tabs={[['pss', 'PSS Stats', C.pss], ['mss', 'MSS Stats', C.mss]]} />
      {loading && <div style={{ ...FM, fontSize: 12, color: C.sub }}>Loading…</div>}
      {error && <div style={{ ...FM, fontSize: 12, color: C.warn }}>{error}</div>}
      {!loading && !error && d && (
        <>
          <div style={{ display: 'flex', gap: 28, marginBottom: 20 }}>
            <Stat label="QUALIFIED PLAYS RECORD" value={recordStr(d.overall)} size={18} />
            <Stat label="ATS %" value={pctStr(d.overall)} size={18} color={C.agree} />
          </div>
          <div style={{ ...FH, fontSize: 11, color: C.sub, marginBottom: 8 }}>BY {tab === 'pss' ? 'BIN' : 'CONFIDENCE'} (all graded games, not just qualified)</div>
          {d.rows.map((r) => (
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
// My Card modal — this week's picks, straight from already-loaded state.
// ---------------------------------------------------------------------------
function MyCardModal({ rows, picksByGame, onClose }) {
  const withPicks = rows.filter((r) => {
    const p = picksByGame[r.game.id];
    return p && (p.plays.length > 0 || p.lean);
  });
  const totalUnits = withPicks.flatMap((r) => picksByGame[r.game.id].plays).reduce((s, p) => s + parseFloat(p.units || 0), 0);
  return (
    <Modal title="My card — this week" onClose={onClose} wide>
      <div style={{ ...FM, fontSize: 12, color: C.sub, marginBottom: 16 }}>{withPicks.length} games · {totalUnits.toFixed(1)}u total exposure</div>
      {withPicks.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub }}>No plays or leans logged yet — add one from any game card.</div>}
      {withPicks.map((r) => {
        const p = picksByGame[r.game.id];
        const home = r.game.home_team, away = r.game.away_team;
        return (
          <div key={r.game.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ ...FH, fontSize: 13, color: C.text, marginBottom: 6 }}>{away} @ {home}</div>
            {p.lean && <div style={{ ...FM, fontSize: 12, color: C.pss, marginBottom: 3 }}>Lean: {p.lean.side === 'home' ? home : away}</div>}
            {p.plays.map((pk) => (
              <div key={pk.id} style={{ ...FM, fontSize: 12, color: C.sub, display: 'flex', gap: 10 }}>
                <span style={{ color: C.agree }}>{pk.units}u</span>
                <span style={{ color: C.text }}>
                  {pk.pick_type === 'spread' ? `${pk.side === 'home' ? home : away} ATS` : pk.pick_type === 'total' ? `${pk.side === 'over' ? 'Over' : 'Under'} ${fmt(r.game.over_under, 1)}` : `${pk.side === 'home' ? home : away} ML`}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// DashPickModal — pick entry modal for the main dashboard, writes to
// user_picks (same table as MSS dashboard + My Card page) so all picks
// are centralized and visible on My Card from any dashboard.
// ---------------------------------------------------------------------------
function DashPickModal({ game, onClose, onSaved, onDeleted }) {
  const [pickType, setPickType] = useState('spread');
  const [side, setSide] = useState(null);
  const [units, setUnits] = useState(1);
  const [status, setStatus] = useState('official');
  const [saving, setSaving] = useState(false);

  const vegasLine = game.current_line != null ? parseFloat(game.current_line) : null;
  // home-positive convention: home spread = -line, away = +line
  const homeSpread = vegasLine != null ? (vegasLine > 0 ? -vegasLine : Math.abs(vegasLine)) : null;
  const awaySpread = vegasLine != null ? (vegasLine > 0 ? vegasLine : -Math.abs(vegasLine)) : null;
  function fmtSpread(n) { if (n == null) return '—'; return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1); }

  async function handleSave() {
    if (!side) return;
    setSaving(true);
    await onSaved(pickType, side, units, status);
    setSaving(false);
  }

  const overlayStyle = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 200,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  };
  const modalStyle = {
    background: '#131722', border: '1px solid #2a3042', borderRadius: 12,
    padding: 22, width: 340, maxWidth: '92vw',
  };
  const seg = (active) => ({
    flex: 1, padding: '7px 0', borderRadius: 6, border: `1px solid ${active ? '#D4A73C' : '#2a3042'}`,
    background: active ? 'rgba(212,167,60,0.12)' : '#0b0e14',
    color: active ? '#D4A73C' : '#8a92a3', cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const teamBtn = (active) => ({
    flex: 1, padding: '12px 10px', borderRadius: 8, border: `1px solid ${active ? '#6FBF73' : '#2a3042'}`,
    background: active ? 'rgba(111,191,115,0.12)' : '#0b0e14',
    color: active ? '#6FBF73' : '#e6e9ef', cursor: 'pointer', textAlign: 'center',
    fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const unitBtn = (active) => ({
    width: 36, height: 36, borderRadius: 6, border: `1px solid ${active ? '#6FBF73' : '#2a3042'}`,
    background: active ? '#6FBF73' : '#0b0e14', color: active ? '#0b0e14' : '#8a92a3',
    cursor: 'pointer', fontSize: 14, fontWeight: active ? 700 : 400,
  });

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e6e9ef' }}>{game.away_team} @ {game.home_team}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8a92a3', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        {/* Type toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          <button style={seg(pickType === 'spread')} onClick={() => { setPickType('spread'); setSide(null); }}>Spread</button>
          <button style={seg(pickType === 'total')} onClick={() => { setPickType('total'); setSide(null); }}>Total</button>
        </div>

        {/* Side picker */}
        {pickType === 'spread' ? (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button style={teamBtn(side === 'away')} onClick={() => setSide('away')}>
              <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 3 }}>{game.away_team}</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtSpread(awaySpread)}</div>
            </button>
            <button style={teamBtn(side === 'home')} onClick={() => setSide('home')}>
              <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 3 }}>{game.home_team}</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtSpread(homeSpread)}</div>
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button style={teamBtn(side === 'over')} onClick={() => setSide('over')}>
              <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 3 }}>Over</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{game.over_under ?? '—'}</div>
            </button>
            <button style={teamBtn(side === 'under')} onClick={() => setSide('under')}>
              <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 3 }}>Under</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{game.over_under ?? '—'}</div>
            </button>
          </div>
        )}

        {/* Units */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: '#8a92a3', marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Units</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[1, 2, 3, 4, 5].map((u) => (
              <button key={u} style={unitBtn(units === u)} onClick={() => setUnits(u)}>{u}</button>
            ))}
          </div>
        </div>

        {/* Status */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: '#8a92a3', marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Status</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={seg(status === 'lean')} onClick={() => setStatus('lean')}>Lean</button>
            <button style={seg(status === 'official')} onClick={() => setStatus('official')}>Official</button>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #2a3042', background: 'transparent', color: '#8a92a3', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !side} style={{ flex: 2, padding: '9px 0', borderRadius: 8, border: 'none', background: side ? '#6FBF73' : '#2a3042', color: side ? '#0b0e14' : '#5b6272', cursor: side && !saving ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
            {saving ? 'Saving…' : 'Save Pick'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game card
// ---------------------------------------------------------------------------
function GameCard({ row, expanded, onToggle, pssRank, mssRank, logos, picks, notesDraft, onSetLean, onSetNotesDraft, onCommitNotes, onAddPlay, onRemovePlay, researchTags, onAddResearchTag, onRemoveResearchTag, onOpenDrilldown }) {
  const { game, gm, pm } = row;
  const home = game.home_team, away = game.away_team;
  const mp = mssPick(gm, home, away);
  const pp = pssPick(pm, home, away);
  const agree = mp && pp && mp.side === pp.side;
  const isPssPlay = pm && ['BET', 'CONSIDER'].includes(pm.decision);
  const move = fmtLineMove(game.current_line != null && game.opening_line != null ? parseFloat(game.current_line) - parseFloat(game.opening_line) : null);

  const [playType, setPlayType] = useState('spread');
  const [playSide, setPlaySide] = useState('home');
  const [playUnits, setPlayUnits] = useState(1);
  const [showPickModal, setShowPickModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTagForm, setShowTagForm] = useState(false);

  const leanSide = picks?.lean?.side ?? null;
  const plays = picks?.plays ?? [];
  const tags = researchTags ?? [];
  const tagLabel = (t) => t.pick_side === 'home' ? home : t.pick_side === 'away' ? away : t.pick_side;
  const tagCounts = tags.reduce((acc, t) => { const k = tagLabel(t); acc[k] = (acc[k] || 0) + 1; return acc; }, {});

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4,
      borderLeft: `3px solid ${isPssPlay ? C.pss : gm?.suggested_play ? C.mss : C.border}`,
      marginBottom: 12, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '13px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {pssRank && <Badge color={C.pss} filled>PSS #{pssRank}</Badge>}
          {mssRank && <span style={{ ...FM, fontSize: 10, color: C.dim }}>MSS #{mssRank}</span>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TeamMark logoUrl={logos[away]} name={away} />
            <span style={{ ...FH, fontSize: 14.5, color: C.text }}>{away}</span>
            <span style={{ color: C.dim, fontSize: 12 }}>@</span>
            <span style={{ ...FH, fontSize: 14.5, color: C.text }}>{home}</span>
            <TeamMark logoUrl={logos[home]} name={home} />
          </div>
          <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>{fmtKickoff(game.kickoff_at)}</span>
          {game.tv_network && <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>{game.tv_network}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <Stat label="MARKET" value={favoredMarket(game.current_line, home, away)} />
          <Stat label="MOVE" value={<Move v={move} />} />
          <Stat label="O/U" value={game.over_under != null ? fmt(game.over_under, 1) : '—'} />
          <button onClick={onToggle} style={{
            background: expanded ? `${C.pss}1A` : C.surface2,
            border: `1px solid ${expanded ? C.pss : C.border}`,
            borderRadius: 6, cursor: 'pointer',
            color: expanded ? C.pss : C.sub,
            fontSize: 12, padding: '5px 10px', lineHeight: 1, flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 4,
            minWidth: 62, justifyContent: 'center', fontFamily: 'inherit',
          }}>
            {expanded ? '▲ Less' : '▼ More'}
          </button>
        </div>
      </div>

      {/* Always-visible PSS-forward summary strip */}
      <div style={{ padding: '0 18px 13px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {pm ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ ...FM, fontSize: 24, color: DECISION_COLOR[pm.decision] || C.text }}>{fmt(pm.pss, 1)}</span>
            <Badge color={DECISION_COLOR[pm.decision] || C.dim} filled>{pm.decision || '—'}</Badge>
            <Badge color={PSS_BIN_COLOR[pm.pss_bin] || C.dim}>{pm.pss_bin || '—'}</Badge>
          </div>
        ) : (
          <span style={{ ...FM, fontSize: 11.5, color: C.dim }}>PSS not computed for this game yet</span>
        )}
        <div style={{ width: 1, height: 20, background: C.border }} />
        {gm ? (
          <span style={{ ...FM, fontSize: 11.5, color: C.mss }}>MSS {fmt(gm.mss, 1)} · {gm.confidence_bin || '—'}{gm.suggested_play ? ' ✓' : ''}</span>
        ) : (
          <span style={{ ...FM, fontSize: 11.5, color: C.dim }}>MSS not computed for this game yet</span>
        )}
        {mp && pp && (
          agree
            ? <span style={{ ...FM, fontSize: 11, color: C.agree, display: 'inline-flex', alignItems: 'center', gap: 4 }}>✓ Models agree</span>
            : <span style={{ ...FM, fontSize: 11, color: C.sub, display: 'inline-flex', alignItems: 'center', gap: 4 }}>✕ Split</span>
        )}
        {tags.length > 0 && (
          <span style={{ ...FM, fontSize: 11, color: C.sub, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            🏷 {Object.entries(tagCounts).map(([k, v]) => `${k} ${v}`).join(', ')}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ borderTop: `2px solid ${C.pss}`, background: C.surface2, borderRadius: '0 0 8px 8px', margin: '0 0 2px' }}>
          {/* PSS panel — primary */}
          <div style={{ padding: '16px 18px', borderBottom: `1px solid ${C.border}`, background: `${C.pss}08` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.pss }} />
                <span style={{ ...FH, fontSize: 14, color: C.pss }}>BobbyPSS — primary model</span>
              </div>
              {(pm || gm) && (
                <button onClick={() => onOpenDrilldown(row)} style={{ ...FM, fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: `1px solid ${C.border}`, borderRadius: 3, padding: '4px 9px', color: C.sub, cursor: 'pointer' }}>
                  ⤢ Full breakdown
                </button>
              )}
            </div>
            {pm ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px 16px', marginBottom: 12 }}>
                  <Stat label="PICK" value={pp ? favored(pp.team, pp.num) : '—'} />
                  <Stat label="TOP-K TIER" value={pm.qualifying_tier ? `${TIER_LABEL[pm.qualifying_tier]} · ${pm.signal_type}` : `No tier (eval. to Top-${pm.selected_k})`} />
                  <Stat label="AGREEMENT" value={pm.agreement != null ? `${Math.round(pm.agreement * 100)}%` : '—'} />
                  <Stat label="STDDEV" value={fmt(pm.stddev, 2)} />
                </div>
                {(pm.pss_drivers?.length > 0 || pm.warnings?.length > 0) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {(pm.pss_drivers || []).map((d, i) => <span key={i} style={{ ...FM, fontSize: 10, padding: '2px 6px', borderRadius: 3, background: `${C.agree}1F`, color: C.agree }}>+ {d}</span>)}
                    {(pm.warnings || []).map((w, i) => <span key={i} style={{ ...FM, fontSize: 10, padding: '2px 6px', borderRadius: 3, background: `${C.warn}1F`, color: C.warn }}>! {w}</span>)}
                  </div>
                )}
              </>
            ) : (
              <div style={{ ...FM, fontSize: 12, color: C.dim }}>No PSS data for this game.</div>
            )}
          </div>

          {/* MSS panel — secondary, compact */}
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            {gm ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ ...FH, fontSize: 12, color: C.mss }}>BobbyModel (MSS) — supporting</span>
                <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>Pick: <span style={{ color: C.text }}>{mp ? favored(mp.team, mp.num) : '—'}</span></span>
                <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>Edge {fmt(gm.edge, 1)}</span>
                <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>Agree {gm.agreement != null ? `${Math.round(gm.agreement * 100)}%` : '—'}</span>
                <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>StdDev {fmt(gm.stddev, 2)}</span>
                {gm.suggested_play && <Badge color={C.mss} filled>MODEL PLAY</Badge>}
                <button onClick={() => onOpenDrilldown(row)} style={{ ...FM, fontSize: 10.5, background: 'none', border: 'none', color: C.dim, cursor: 'pointer', textDecoration: 'underline' }}>details</button>
              </div>
            ) : (
              <div style={{ ...FM, fontSize: 12, color: C.dim }}>No MSS data for this game.</div>
            )}
          </div>

          {/* Research tags */}
          <div style={{ padding: '10px 18px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ ...FH, fontSize: 10.5, color: C.sub }}>RESEARCH TAGS</span>
              {tags.map((t) => (
                <span key={t.id} style={{ ...FM, fontSize: 10.5, padding: '2px 7px', borderRadius: 3, background: C.surface2, color: C.sub, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {t.source_label || 'source'} → {tagLabel(t)}
                  <button onClick={() => onRemoveResearchTag(game.id, t.id)} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', padding: 0, fontSize: 10 }}>✕</button>
                </span>
              ))}
              <button onClick={() => setShowTagForm((s) => !s)} style={{ ...FM, fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: `1px dashed ${C.border}`, borderRadius: 3, padding: '3px 8px', color: C.sub, cursor: 'pointer' }}>
                + Tag
              </button>
            </div>
            {showTagForm && (
              <ResearchQuickAdd
                home={home} away={away}
                onAdd={async (source, side, type) => { await onAddResearchTag(game.id, source, side, type); setShowTagForm(false); }}
                onDone={() => setShowTagForm(false)}
              />
            )}
          </div>

          {/* Agreement banner */}
          {mp && pp && (
            <div style={{ padding: '8px 18px', borderBottom: `1px solid ${C.border}`, background: agree ? `${C.agree}12` : 'transparent', display: 'flex', alignItems: 'center', gap: 7 }}>
              {agree
                ? <span style={{ ...FM, fontSize: 11.5, color: C.agree }}>✓ Both models favor {mp.team} — converged signal</span>
                : <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>✕ Models split: PSS favors {pp.team}, MSS favors {mp.team}</span>}
            </div>
          )}

          {/* Lean / play / notes — persisted to user_picks (centralized) */}
          <div style={{ padding: '12px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ ...FH, fontSize: 10.5, color: C.sub }}>LEAN</span>
                {['away', 'home'].map((side) => (
                  <button key={side} disabled={saving} onClick={async () => { setSaving(true); try { await onSetLean(game.id, side); } finally { setSaving(false); } }} style={{
                    ...FM, fontSize: 11, padding: '4px 10px', borderRadius: 3, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
                    border: `1px solid ${leanSide === side ? C.pss : C.border}`,
                    background: leanSide === side ? `${C.pss}1F` : 'transparent',
                    color: leanSide === side ? C.pss : C.sub,
                  }}>{side === 'home' ? home : away}</button>
                ))}
              </div>
              <input placeholder="Add a note…" value={notesDraft ?? ''}
                onChange={(e) => onSetNotesDraft(game.id, e.target.value)}
                onBlur={(e) => onCommitNotes(game.id, e.target.value)}
                style={{ ...FM, fontSize: 11, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, padding: '5px 10px', color: C.text, flex: 1, minWidth: 160, outline: 'none' }} />
            </div>

            {plays.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <span style={{ color: C.agree }}>●</span>
                <span style={{ ...FM, fontSize: 12, color: C.text }}>
                  {p.units}u — {p.pick_type === 'spread' ? `${p.side === 'home' ? home : away} ATS` : p.pick_type === 'total' ? `${p.side === 'over' ? 'Over' : 'Under'} ${fmt(game.over_under, 1)}` : `${p.side === 'home' ? home : away} ML`}
                </span>
                <button onClick={() => onRemovePlay(game.id, p.id)} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer' }}>✕</button>
              </div>
            ))}

            <button
              onClick={() => setShowPickModal(true)}
              style={{ ...FM, fontSize: 11.5, marginTop: 8, padding: '6px 14px', borderRadius: 4, border: `1px solid ${C.agree}`, background: `${C.agree}1A`, color: C.agree, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              + Add Pick
            </button>
            {showPickModal && (
              <DashPickModal
                game={game}
                onClose={() => setShowPickModal(false)}
                onSaved={async (type, side, units, status) => {
                  setShowPickModal(false);
                  await onAddPlay(game.id, type, side, units, status);
                }}
                onDeleted={(pickId) => {
                  setShowPickModal(false);
                  onRemovePlay(game.id, pickId);
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level dashboard
// ---------------------------------------------------------------------------
export default function Dashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const [rows, setRows] = useState([]);
  const [logos, setLogos] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [expandedIds, setExpandedIds] = useState(new Set());
  const [filter, setFilter] = useState('all');
  const [mssBinFilter, setMssBinFilter] = useState('any');
  const [pssBinFilter, setPssBinFilter] = useState('any');
  const [teamSearch, setTeamSearch] = useState('');
  const [sortBy, setSortBy] = useState('pss');
  const [sortDir, setSortDir] = useState('desc');

  // Persisted picks (user_picks — same table as MSS/My Card), keyed by game id: { lean: row|null, note: row|null, plays: [row] }.
  // A per-game note and a lean are each stored as a single distinguishing
  // row (pick_type='note', or status='lean') rather than a separate table —
  // see PR4 handoff notes for why.
  const [picksByGame, setPicksByGame] = useState({});
  // Research tags (research_picks), keyed by game id: [row, ...].
  const [researchByGame, setResearchByGame] = useState({});
  // Text currently in each note input, separate from the committed row so
  // typing doesn't fire a request per keystroke — committed onBlur.
  const [notesDraftByGame, setNotesDraftByGame] = useState({});
  // MSS "range" and "agreement across all models" aren't stored columns —
  // both are derived from raw_predictions, same computation /mss-dashboard
  // already does. Computed once per week load, looked up by game id in the
  // drilldown modal rather than the main card (keeps the card itself light).
  const [rangeByGame, setRangeByGame] = useState({});
  const [agreementAllByGame, setAgreementAllByGame] = useState({});
  const [drilldownRow, setDrilldownRow] = useState(null);
  const [showLegend, setShowLegend] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Dashboard defaults to the latest week that has any games scheduled
    // (not just final games), so Week 2 shows up as soon as games are seeded.
    sbFetch(`games?select=week&season=eq.${season}&order=week.desc&limit=1`)
      .then((rows) => { if (!cancelled) setWeek(rows.length ? rows[0].week : 1); })
      .catch(() => { if (!cancelled) setWeek(1); });
    return () => { cancelled = true; };
  }, [season]);

  useEffect(() => {
    if (week == null) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [games, logoRows] = await Promise.all([
          sbFetch(
            `games?select=id,home_team,away_team,kickoff_at,current_line,opening_line,over_under,tv_network,status,` +
            `game_metrics(edge,agreement,stddev,mss,confidence_bin,suggested_play,suggested_side,suggested_line,consensus_spread,valid_model_count,topk_model_ids),` +
            `pss_game_metrics(pss,pss_bin,decision,qualifies,qualifying_tier,signal_type,selected_k,agreement,stddev,edge,consensus_spread,suggested_side,suggested_line,pss_drivers,warnings,mss_score,market_alignment,historical_tier)` +
            `&season=eq.${season}&week=eq.${week}`
          ),
          sbFetch(`team_logos?select=team_name,logo_url`),
        ]);
        if (cancelled) return;
        const logoMap = {};
        for (const l of logoRows) logoMap[l.team_name] = l.logo_url;
        const built = games.map((g) => ({
          game: g,
          gm: Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics,
          pm: Array.isArray(g.pss_game_metrics) ? g.pss_game_metrics[0] : g.pss_game_metrics,
        }));
        setRows(built);
        setLogos(logoMap);

        // Range (max-min across the Top-K pool) and full-pool agreement,
        // computed the same way /mss-dashboard does — restricted to each
        // game's own topk_model_ids, not just this game's edge sign.
        if (games.length > 0) {
          const ids = games.map((g) => g.id).join(',');
          try {
            const preds = await sbFetch(`raw_predictions?select=game_id,model_id,predicted_margin&game_id=in.(${ids})`);
            if (cancelled) return;
            const byGamePreds = {};
            for (const p of preds) {
              if (!byGamePreds[p.game_id]) byGamePreds[p.game_id] = [];
              byGamePreds[p.game_id].push(p);
            }
            const rangeMap = {}, agreeAllMap = {};
            for (const r of built) {
              const gm = r.gm;
              const topk = gm?.topk_model_ids || [];
              const gamePreds = byGamePreds[r.game.id] || [];
              const topkPreds = gamePreds.filter((p) => topk.includes(p.model_id)).map((p) => parseFloat(p.predicted_margin));
              if (topkPreds.length >= 2) rangeMap[r.game.id] = Math.max(...topkPreds) - Math.min(...topkPreds);

              const vegasLine = r.game.current_line != null ? parseFloat(r.game.current_line) : null;
              const edgeVal = gm?.edge != null ? parseFloat(gm.edge) : null;
              if (vegasLine != null && edgeVal != null && gamePreds.length > 0) {
                const edgePositive = edgeVal > 0;
                let agreeCount = 0;
                for (const p of gamePreds) {
                  const margin = parseFloat(p.predicted_margin);
                  if (Number.isNaN(margin)) continue;
                  if ((margin > vegasLine) === edgePositive) agreeCount++;
                }
                agreeAllMap[r.game.id] = { count: agreeCount, total: gamePreds.length, pct: (agreeCount / gamePreds.length) * 100 };
              }
            }
            setRangeByGame(rangeMap);
            setAgreementAllByGame(agreeAllMap);
          } catch (e) {
            console.error('Failed to load raw predictions for range/agreement-all:', e);
          }
        } else {
          setRangeByGame({});
          setAgreementAllByGame({});
        }

        // Load this week's picks in a second pass, once we have game ids —
        // failure here shouldn't block the board itself from rendering.
        if (games.length > 0) {
          const ids = games.map((g) => g.id).join(',');
          try {
            const picks = await sbFetch(`user_picks?select=*&game_id=in.(${ids})&order=created_at.asc`);
            if (cancelled) return;
            const grouped = {};
            for (const p of picks) {
              if (!grouped[p.game_id]) grouped[p.game_id] = { lean: null, note: null, plays: [] };
              if (p.status === 'lean') grouped[p.game_id].lean = p;
              else if (p.pick_type === 'note') grouped[p.game_id].note = p;
              else grouped[p.game_id].plays.push(p);
            }
            setPicksByGame(grouped);
            const drafts = {};
            for (const gid of Object.keys(grouped)) drafts[gid] = grouped[gid].note?.note ?? '';
            setNotesDraftByGame(drafts);
          } catch (e) {
            console.error('Failed to load picks:', e);
          }
          try {
            const tags = await sbFetch(`research_picks?select=*&game_id=in.(${ids})&order=created_at.asc`);
            if (cancelled) return;
            const groupedTags = {};
            for (const t of tags) {
              if (!groupedTags[t.game_id]) groupedTags[t.game_id] = [];
              groupedTags[t.game_id].push(t);
            }
            setResearchByGame(groupedTags);
          } catch (e) {
            console.error('Failed to load research tags:', e);
          }
        } else {
          setPicksByGame({});
          setNotesDraftByGame({});
          setResearchByGame({});
        }
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [season, week]);

  const toggle = (id) => setExpandedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // --- my_picks CRUD ---------------------------------------------------
  // Lean: at most one per game, stored as status='lean'. Clicking the
  // already-selected side toggles it off; clicking the other side moves it.
  async function setLean(gameId, side) {
    const current = picksByGame[gameId]?.lean;
    if (current && current.side === side) {
      await sbFetch(`user_picks?id=eq.${current.id}`, { method: 'DELETE' });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...(prev[gameId] || { note: null, plays: [] }), lean: null } }));
      return;
    }
    if (current) {
      const [updated] = await sbFetch(`user_picks?id=eq.${current.id}`, {
        method: 'PATCH', body: JSON.stringify({ side, updated_at: new Date().toISOString() }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], lean: updated } }));
    } else {
      const [created] = await sbFetch(`user_picks`, {
        method: 'POST',
        body: JSON.stringify({ game_id: gameId, season, week, pick_type: 'spread', side, status: 'lean', units: 0 }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...(prev[gameId] || { note: null, plays: [] }), lean: created } }));
    }
  }

  function setNotesDraft(gameId, text) {
    setNotesDraftByGame((prev) => ({ ...prev, [gameId]: text }));
  }

  // Note: at most one per game, stored as pick_type='note'. Committed on
  // blur rather than on every keystroke. Empty text deletes the row.
  async function commitNotes(gameId, text) {
    const current = picksByGame[gameId]?.note;
    if (!text.trim()) {
      if (current) {
        await sbFetch(`user_picks?id=eq.${current.id}`, { method: 'DELETE' });
        setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], note: null } }));
      }
      return;
    }
    if (current) {
      const [updated] = await sbFetch(`user_picks?id=eq.${current.id}`, {
        method: 'PATCH', body: JSON.stringify({ note: text, updated_at: new Date().toISOString() }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], note: updated } }));
    } else {
      const [created] = await sbFetch(`user_picks`, {
        method: 'POST',
        body: JSON.stringify({ game_id: gameId, season, week, pick_type: 'note', units: 0, status: 'official', note: text }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...(prev[gameId] || { lean: null, plays: [] }), note: created } }));
    }
  }

  // Plays: any number per game, each its own row.
  async function addPlay(gameId, type, side, units, status = 'official') {
    const row = rows.find((r) => r.game.id === gameId);
    const linePlayed = type === 'total'
      ? (row?.game.over_under ?? null)
      : (row?.game.current_line != null ? parseFloat(row.game.current_line) : null);
    const [created] = await sbFetch(`user_picks`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gameId, season, week, pick_type: type, side, units, status, played: true, line_played: linePlayed }),
    });
    setPicksByGame((prev) => ({
      ...prev,
      [gameId]: { ...(prev[gameId] || { lean: null, note: null, plays: [] }), plays: [...(prev[gameId]?.plays || []), created] },
    }));
  }
  async function removePlay(gameId, pickId) {
    await sbFetch(`user_picks?id=eq.${pickId}`, { method: 'DELETE' });
    setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], plays: prev[gameId].plays.filter((p) => p.id !== pickId) } }));
  }

  // Research tags: same table/shape as /research's research_picks, any
  // number per game.
  async function addResearchTag(gameId, source, side, type) {
    const row = rows.find((r) => r.game.id === gameId);
    const [created] = await sbFetch(`research_picks`, {
      method: 'POST',
      body: JSON.stringify({
        season, week, game_id: gameId,
        home_team: row?.game.home_team, away_team: row?.game.away_team,
        pick_side: side, pick_type: type, source_label: source,
      }),
    });
    setResearchByGame((prev) => ({ ...prev, [gameId]: [...(prev[gameId] || []), created] }));
  }
  async function removeResearchTag(gameId, tagId) {
    await sbFetch(`research_picks?id=eq.${tagId}`, { method: 'DELETE' });
    setResearchByGame((prev) => ({ ...prev, [gameId]: (prev[gameId] || []).filter((t) => t.id !== tagId) }));
  }

  // Ranks computed off the full fetched set, independent of filtering.
  const pssRanked = useMemo(() => [...rows].filter((r) => r.pm).sort((a, b) => b.pm.pss - a.pm.pss), [rows]);
  const mssRanked = useMemo(() => [...rows].filter((r) => r.gm).sort((a, b) => b.gm.mss - a.gm.mss), [rows]);
  const pssRankMap = Object.fromEntries(pssRanked.map((r, i) => [r.game.id, i + 1]));
  const mssRankMap = Object.fromEntries(mssRanked.map((r, i) => [r.game.id, i + 1]));

  const filtered = useMemo(() => {
    let list = rows.filter((r) => {
      if (filter === 'pss_plays' && !(r.pm && ['BET', 'CONSIDER'].includes(r.pm.decision))) return false;
      if (filter === 'mss_plays' && !r.gm?.suggested_play) return false;
      if (filter === 'agree') {
        const mp = mssPick(r.gm, r.game.home_team, r.game.away_team);
        const pp = pssPick(r.pm, r.game.home_team, r.game.away_team);
        if (!mp || !pp || mp.side !== pp.side) return false;
      }
      if (filter === 'mine') {
        const p = picksByGame[r.game.id];
        if (!p?.lean && !(p?.plays?.length > 0)) return false;
      }
      if (mssBinFilter !== 'any' && r.gm?.confidence_bin !== mssBinFilter) return false;
      if (pssBinFilter !== 'any' && r.pm?.pss_bin !== pssBinFilter) return false;
      if (teamSearch.trim()) {
        const q = teamSearch.trim().toLowerCase();
        if (!r.game.home_team.toLowerCase().includes(q) && !r.game.away_team.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    const dir = sortDir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      if (sortBy === 'pss') return dir * ((a.pm?.pss ?? -Infinity) - (b.pm?.pss ?? -Infinity));
      if (sortBy === 'mss') return dir * ((a.gm?.mss ?? -Infinity) - (b.gm?.mss ?? -Infinity));
      if (sortBy === 'kickoff') return dir * (new Date(a.game.kickoff_at || 0) - new Date(b.game.kickoff_at || 0));
      if (sortBy === 'team') return dir * a.game.away_team.localeCompare(b.game.away_team);
      return 0;
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, mssBinFilter, pssBinFilter, teamSearch, sortBy, sortDir, picksByGame]);

  const agreeCount = rows.filter((r) => {
    const mp = mssPick(r.gm, r.game.home_team, r.game.away_team);
    const pp = pssPick(r.pm, r.game.home_team, r.game.away_team);
    return mp && pp && mp.side === pp.side;
  }).length;
  const pssPlayCount = rows.filter((r) => r.pm && ['BET', 'CONSIDER'].includes(r.pm.decision)).length;
  const mssPlayCount = rows.filter((r) => r.gm?.suggested_play).length;

  const selectStyle = { ...FM, fontSize: 11.5, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, padding: '6px 8px', color: C.text, cursor: 'pointer' };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '28px 24px', color: C.text }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap'); select option { background: ${C.surface}; }`}</style>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        {drilldownRow && (
          <DrilldownModal
            row={drilldownRow}
            range={rangeByGame[drilldownRow.game.id]}
            agreementAll={agreementAllByGame[drilldownRow.game.id]}
            onClose={() => setDrilldownRow(null)}
          />
        )}
        {showLegend && <LegendModal onClose={() => setShowLegend(false)} />}
        {showStats && <SeasonStatsModal season={season} week={week} onClose={() => setShowStats(false)} />}
        {showCard && <MyCardModal rows={rows} picksByGame={picksByGame} onClose={() => setShowCard(false)} />}

        {/* Top bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ ...FH, fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>BobbyModels</div>
            <div style={{ ...FM, fontSize: 12, color: C.sub, marginTop: 2, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>Season</span>
              <input type="number" value={season} onChange={(e) => setSeason(parseInt(e.target.value) || season)} style={{ ...selectStyle, width: 68 }} />
              <span>Week</span>
              <input type="number" value={week ?? ''} onChange={(e) => setWeek(parseInt(e.target.value) || week)} style={{ ...selectStyle, width: 50 }} />
              <span>· sorted by PSS rank</span>
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
            {/* Summary strip */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 18, flexWrap: 'wrap' }}>
              <Stat label="GAMES" value={rows.length} />
              <Stat label="PSS PLAYS" value={pssPlayCount} color={C.pss} />
              <Stat label="MSS PLAYS" value={mssPlayCount} color={C.mss} />
              <Stat label="MODELS AGREE" value={`${agreeCount}/${rows.length}`} color={C.agree} />
            </div>

            {/* Filters + sort */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              {[['all', 'All games'], ['pss_plays', 'PSS plays'], ['mss_plays', 'MSS plays'], ['agree', 'Models agree'], ['mine', 'My leans/plays']].map(([key, label]) => (
                <button key={key} onClick={() => setFilter(key)} style={{
                  ...FM, fontSize: 11.5, padding: '6px 12px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${filter === key ? C.pss : C.border}`,
                  background: filter === key ? `${C.pss}1A` : 'transparent',
                  color: filter === key ? C.pss : C.sub,
                }}>{label}</button>
              ))}

              <select value={pssBinFilter} onChange={(e) => setPssBinFilter(e.target.value)} style={selectStyle}>
                <option value="any">PSS bin: Any</option>
                {PSS_BIN_ORDER.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <input
                type="text"
                placeholder="Search team…"
                value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
                style={{ ...selectStyle, width: 130, outline: 'none' }}
              />
              <select value={mssBinFilter} onChange={(e) => setMssBinFilter(e.target.value)} style={selectStyle}>
                <option value="any">MSS confidence: Any</option>
                {MSS_BIN_ORDER.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={selectStyle}>
                  <option value="pss">Sort: PSS rank</option>
                  <option value="mss">Sort: MSS score</option>
                  <option value="kickoff">Sort: Kickoff time</option>
                  <option value="team">Sort: Team name</option>
                </select>
                <button onClick={() => setSortDir((d) => d === 'desc' ? 'asc' : 'desc')} style={{ ...selectStyle, cursor: 'pointer' }}>{sortDir === 'desc' ? '↓' : '↑'}</button>
              </div>
            </div>

            {filtered.map((r) => (
              <GameCard
                key={r.game.id} row={r} expanded={expandedIds.has(r.game.id)} onToggle={() => toggle(r.game.id)}
                pssRank={pssRankMap[r.game.id]} mssRank={mssRankMap[r.game.id]} logos={logos}
                picks={picksByGame[r.game.id]} notesDraft={notesDraftByGame[r.game.id]}
                onSetLean={setLean} onSetNotesDraft={setNotesDraft} onCommitNotes={commitNotes}
                onAddPlay={addPlay} onRemovePlay={removePlay}
                researchTags={researchByGame[r.game.id]} onAddResearchTag={addResearchTag} onRemoveResearchTag={removeResearchTag}
                onOpenDrilldown={setDrilldownRow}
              />
            ))}
            {filtered.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub, padding: '20px 0' }}>No games match these filters.</div>}
          </>
        )}

        {loading && <div style={{ ...FM, fontSize: 12, color: C.sub, padding: '40px 0', textAlign: 'center' }}>Loading week {week ?? '…'}…</div>}
      </div>
    </div>
  );
}
