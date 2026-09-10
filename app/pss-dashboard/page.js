'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWeek } from '../../lib/supabase';

const SUPABASE_URL = 'https://zpmdrazbqgzheqkvfltv.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag';

const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Formatting helpers (same conventions as the original dashboard)
// ---------------------------------------------------------------------------
function fmt(n, digits = 1) {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return '—';
  return num.toFixed(digits);
}
function fmtLine(n) {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return '—';
  return num > 0 ? `+${num}` : `${num}`;
}
function fmtPct(frac, digits = 0) {
  if (frac === null || frac === undefined) return '—';
  return `${(parseFloat(frac) * 100).toFixed(digits)}%`;
}
function fmtKickoff(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  return (
    d.toLocaleString('en-US', {
      timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) + ' ET'
  );
}
function spreadForSide(vegasLine, side) {
  if (vegasLine === null || vegasLine === undefined) return null;
  const v = parseFloat(vegasLine);
  if (Number.isNaN(v)) return null;
  return side === 'home' ? -v : v;
}
function favoredDisplay(line, homeTeam, awayTeam) {
  if (line === null || line === undefined) return '—';
  const v = parseFloat(line);
  if (Number.isNaN(v)) return '—';
  if (v === 0) return "Pick'em";
  return v > 0 ? `${homeTeam} -${v}` : `${awayTeam} -${Math.abs(v)}`;
}
function useOutsideClose(ref, onClose) {
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClose]);
}

// ---------------------------------------------------------------------------
// PSS visual scales
// ---------------------------------------------------------------------------
const PSS_BIN_ORDER = ['Elite', 'Very Strong', 'Strong', 'Moderate', 'No Play'];
const PSS_BIN_COLOR = {
  'Elite': { fg: '#c4b5fd', bg: 'rgba(167,139,250,.20)' },
  'Very Strong': { fg: '#38bd94', bg: 'rgba(56,189,148,.20)' },
  'Strong': { fg: '#38bd94', bg: 'rgba(56,189,148,.10)' },
  'Moderate': { fg: '#facc15', bg: 'rgba(250,204,21,.15)' },
  'No Play': { fg: '#6b7280', bg: 'rgba(107,114,128,.12)' },
};
const DECISION_ORDER = ['BET', 'CONSIDER', 'WATCH', 'REVIEW', 'PASS'];
const DECISION_COLOR = {
  BET: { fg: '#38bd94', bg: 'rgba(56,189,148,.20)' },
  CONSIDER: { fg: '#2dd4bf', bg: 'rgba(45,212,191,.16)' },
  WATCH: { fg: '#facc15', bg: 'rgba(250,204,21,.15)' },
  REVIEW: { fg: '#fb923c', bg: 'rgba(251,146,60,.18)' },
  PASS: { fg: '#6b7280', bg: 'rgba(107,114,128,.12)' },
};
const TIER_LABEL = { top3: 'Top 3', top5: 'Top 5', top7: 'Top 7' };
const SIGNAL_ICON = { Conviction: '🎯', Confirmation: '🔁', Consensus: '🌐' };

function Badge({ text, colors, title }) {
  if (!text) return <span style={{ color: '#5b6272' }}>—</span>;
  return (
    <span
      title={title}
      style={{
        display: 'inline-block', padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700,
        color: colors?.fg || '#b8bfcc', background: colors?.bg || '#232838', whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Info / hint icon (desktop uses portal tooltip, mobile uses inline tooltip)
// ---------------------------------------------------------------------------
function InfoIcon({ text }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  function show() {
    const rect = ref.current.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    x = Math.max(120, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 120));
    setPos({ x, y: rect.bottom + 8 });
  }
  function hide() { setPos(null); }
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={(e) => { e.stopPropagation(); pos ? hide() : show(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14,
        borderRadius: '50%', background: '#232838', color: '#8a92a3', fontSize: 9, fontStyle: 'italic',
        fontWeight: 700, cursor: 'help', marginLeft: 4, flexShrink: 0,
      }}
    >
      i
      {pos && typeof document !== 'undefined' && createPortal(
        <div style={{
          position: 'fixed', left: pos.x, top: pos.y, transform: 'translateX(-50%)', width: 230,
          background: '#1a1e2b', border: '1px solid #2a3042', color: '#d3d8e2', fontSize: 11,
          fontWeight: 400, lineHeight: 1.55, padding: '9px 11px', borderRadius: 8,
          boxShadow: '0 4px 20px rgba(0,0,0,.5)', zIndex: 999, whiteSpace: 'normal',
        }}>
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

function MobInfoIcon({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle', marginLeft: 3 }}>
      <span
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 13, height: 13, borderRadius: '50%', background: '#2a3042', color: '#8a92a3', fontSize: 8, fontStyle: 'italic', fontWeight: 700, cursor: 'help', flexShrink: 0 }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onTouchStart={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >i</span>
      {open && (
        <span style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', width: 200, background: '#1a1e2b', border: '1px solid #2a3042', color: '#d3d8e2', fontSize: 11, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,.5)', zIndex: 50, whiteSpace: 'normal', pointerEvents: 'none' }}>
          {text}
        </span>
      )}
    </span>
  );
}

function TeamLogo({ src, alt }) {
  if (!src) return null;
  return <img src={src} alt={alt} style={{ width: 20, height: 20, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
}

const TOOLTIPS = {
  rank: 'Games ranked 1–N by Play Strength Score (PSS) descending — the primary ranking metric for BobbyPSSModel.',
  matchup: 'Away team @ home team.',
  market_spread: 'Current actionable market spread.',
  model_pick: "The side the PSS ensemble favors, and the model's implied fair spread for that side.",
  edge: 'Model Spread vs current market line — the magnitude of pricing disagreement driving the play.',
  pss: 'Play Strength Score (0–100): 30% Edge + 25% MSS + 20% Agreement + 15% Dispersion Quality + 10% Historical Confidence. The primary ranking metric.',
  topk: 'How the play qualified. Top 3 = Conviction (concentrated strength), Top 5 = Confirmation (survives a broader committee), Top 7 = Consensus (broad agreement required).',
  mss: 'Model Signal Strength Score (0–100, normalized) — composite quality of the underlying signal for the selected model pool.',
  agreement: 'Share of the selected K models favoring the same side as the edge.',
  stddev: 'Standard deviation of predicted spreads across the selected models. Lower means tighter consensus.',
  historical: 'Calibration/performance tier for the selected models (from backtested + in-season ATS performance), one of the five PSS components.',
  line_move: 'Opening line → current line movement, in points.',
  market_alignment: "Whether the market is moving toward the model's fair line, staying stable, or moving against it.",
  decision: 'Model-assisted action layer: BET (PSS ≥82, no material warning), CONSIDER (74–81.9), WATCH (66–73.9), REVIEW (strong score with a material conflict), PASS (<66 or a hard veto).',
  drivers: 'Short auto-generated reasons for the PSS score — the strongest positive factors.',
  warnings: 'Reasons to investigate before acting — dispersion, minority opposition, edge erosion, or adverse market movement.',
  lean: 'A quick, informal flag for games you’re leaning toward but haven’t committed to.',
  play: 'Your official PSS play for this game — the side, bet type, and unit size you’re tracking.',
  notes: 'Your private notes on this game.',
};

// ---------------------------------------------------------------------------
// Pick / Note modals (write to pss_user_picks — fully independent of the
// original model's user_picks table)
// ---------------------------------------------------------------------------
function PickModal({ game, existing, defaultStatus, onClose, onSaved, onDeleted }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const [pickType, setPickType] = useState(existing?.pick_type || 'spread');
  const [side, setSide] = useState(existing?.side || null);
  const [units, setUnits] = useState(existing?.units || 1);
  const [status, setStatus] = useState(existing?.status || defaultStatus || 'official');
  const [saving, setSaving] = useState(false);

  const homeLine = game.vegas_line;
  const homeDisplay = spreadForSide(homeLine, 'home');
  const awayDisplay = spreadForSide(homeLine, 'away');

  async function handleSave() {
    if (!side) return;
    setSaving(true);
    const linePlayed = pickType === 'total' ? game.over_under : (homeLine != null ? parseFloat(homeLine) : null);
    const body = {
      game_id: game.id,
      pss_game_metrics_id: game.pss_id || null,
      played: true,
      pick_type: pickType,
      side,
      line_played: linePlayed,
      units,
      status,
      season: game.season,
      week: game.week,
    };
    if (existing?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks?id=eq.${existing.id}`, {
        method: 'PATCH', headers: { ...SB_HEADERS, Prefer: 'return=representation' }, body: JSON.stringify(body),
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks`, {
        method: 'POST', headers: { ...SB_HEADERS, Prefer: 'return=representation' }, body: JSON.stringify(body),
      });
    }
    setSaving(false);
    onSaved();
  }
  async function handleDelete() {
    setSaving(true);
    if (existing?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks?id=eq.${existing.id}`, { method: 'DELETE', headers: SB_HEADERS });
    }
    setSaving(false);
    onDeleted();
  }

  return createPortal(
    <div className="pss-overlay">
      <div className="pss-modal" ref={ref}>
        <h3>{game.away_team} @ {game.home_team}</h3>
        <div className="pss-seg">
          <button className={pickType === 'spread' ? 'on' : ''} onClick={() => { setPickType('spread'); setSide(null); }}>Spread</button>
          <button className={pickType === 'total' ? 'on' : ''} onClick={() => { setPickType('total'); setSide(null); }}>Total</button>
        </div>
        {pickType === 'spread' ? (
          <div className="pss-sidepick">
            <button className={side === 'away' ? 'on' : ''} onClick={() => setSide('away')}>{game.away_team}<span>{fmtLine(awayDisplay)}</span></button>
            <button className={side === 'home' ? 'on' : ''} onClick={() => setSide('home')}>{game.home_team}<span>{fmtLine(homeDisplay)}</span></button>
          </div>
        ) : (
          <div className="pss-sidepick">
            <button className={side === 'over' ? 'on' : ''} onClick={() => setSide('over')}>Over<span>{game.over_under ?? '—'}</span></button>
            <button className={side === 'under' ? 'on' : ''} onClick={() => setSide('under')}>Under<span>{game.over_under ?? '—'}</span></button>
          </div>
        )}
        <div className="pss-row">
          <label>Units</label>
          <div className="pss-units">{[1, 2, 3, 4, 5].map((u) => (<button key={u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>{u}</button>))}</div>
        </div>
        <div className="pss-row">
          <label>Status</label>
          <div className="pss-seg small">
            <button className={status === 'lean' ? 'on' : ''} onClick={() => setStatus('lean')}>Lean</button>
            <button className={status === 'official' ? 'on' : ''} onClick={() => setStatus('official')}>Official</button>
          </div>
        </div>
        <div className="pss-actions">
          {existing && <button className="danger" onClick={handleDelete} disabled={saving}>Remove</button>}
          <button className="ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={handleSave} disabled={saving || !side}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function NoteModal({ game, existing, onClose, onSaved }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const [text, setText] = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);
  async function handleSave() {
    setSaving(true);
    if (existing?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks?id=eq.${existing.id}`, {
        method: 'PATCH', headers: { ...SB_HEADERS, Prefer: 'return=representation' }, body: JSON.stringify({ note: text }),
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks`, {
        method: 'POST', headers: { ...SB_HEADERS, Prefer: 'return=representation' },
        body: JSON.stringify({ game_id: game.id, pss_game_metrics_id: game.pss_id || null, note: text, season: game.season, week: game.week }),
      });
    }
    setSaving(false);
    onSaved(text);
  }
  return createPortal(
    <div className="pss-overlay">
      <div className="pss-modal" ref={ref}>
        <h3>Notes — {game.away_team} @ {game.home_team}</h3>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Injuries, weather, matchup notes…" />
        <div className="pss-actions">
          <button className="ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Detail panel — Recommendation header, PSS breakdown, model predictions,
// market context, historical profile (spec section 10)
// ---------------------------------------------------------------------------
function DetailPanel({ game, onClose }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const [models, setModels] = useState(null);
  const [hist, setHist] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setModels(null);
      setHist(null);
      const ids = (game.selected_model_ids || []).join(',');
      if (ids) {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/raw_predictions?select=model_id,predicted_margin,source_models(system_name)&game_id=eq.${game.id}&model_id=in.(${ids})`,
          { headers: SB_HEADERS }
        );
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setModels(data);
      }
      // Historical profile: record for games with the same PSS bin, this season
      if (game.season && game.pss_bin) {
        const idsRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pss_game_metrics?select=id&season=eq.${game.season}&pss_bin=eq.${encodeURIComponent(game.pss_bin)}`,
          { headers: SB_HEADERS }
        );
        const idRows = idsRes.ok ? await idsRes.json() : [];
        const metricIds = idRows.map((r) => r.id).join(',');
        if (metricIds) {
          const gradesRes = await fetch(
            `${SUPABASE_URL}/rest/v1/pss_pick_grades?select=ats_result&pss_game_metrics_id=in.(${metricIds})`,
            { headers: SB_HEADERS }
          );
          const grades = gradesRes.ok ? await gradesRes.json() : [];
          const w = grades.filter((g) => g.ats_result === 'win').length;
          const l = grades.filter((g) => g.ats_result === 'loss').length;
          const p = grades.filter((g) => g.ats_result === 'push').length;
          if (!cancelled) setHist({ w, l, p, n: grades.length });
        } else if (!cancelled) setHist({ w: 0, l: 0, p: 0, n: 0 });
      }
    }
    load();
    return () => { cancelled = true; };
  }, [game.id]);

  const binColor = PSS_BIN_COLOR[game.pss_bin] || {};
  const decColor = DECISION_COLOR[game.decision] || {};

  const modelStats = useMemo(() => {
    if (!models || models.length === 0) return null;
    const vals = models.map((m) => parseFloat(m.predicted_margin)).filter((v) => !Number.isNaN(v));
    if (!vals.length) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const variance = vals.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / vals.length;
    return { mean, median, std: Math.sqrt(variance), min: sorted[0], max: sorted[sorted.length - 1] };
  }, [models]);

  const components = [
    { label: 'Edge', actual: `${fmtLine(fmt(game.edge, 1))}`, score: game.edge_score, weight: 30 },
    { label: 'MSS', actual: fmt(game.raw_mss, 1), score: game.mss_score, weight: 25 },
    { label: 'Agreement', actual: `${game.agreement_count}/${game.agreement_k}`, score: game.agreement_score, weight: 20 },
    { label: 'STD', actual: fmt(game.stddev, 2), score: game.stddev_score, weight: 15 },
    { label: 'Historical', actual: game.historical_tier, score: game.historical_score, weight: 10 },
  ];
  const totalContribution = components.reduce((a, c) => a + (c.score * c.weight) / 100, 0);

  const explanation = game.qualifies
    ? `${TIER_LABEL[game.qualifying_tier] || 'Broad'} qualification (${game.signal_type}) supported by ${game.pss_bin.toLowerCase()} overall signal strength${game.warnings?.length ? ', though some warnings are worth reviewing below' : ''}.`
    : `Did not clear the ${TIER_LABEL[game.qualifying_tier] || 'Top 7'} qualification bar this week — shown for reference at ${fmt(game.pss, 1)} PSS.`;

  return createPortal(
    <div className="pss-overlay" style={{ alignItems: 'flex-start', paddingTop: '4vh' }}>
      <div className="pss-detail" ref={ref}>
        <button className="pss-detail-close" onClick={onClose}>✕</button>

        {/* A. Recommendation header */}
        <div className="pss-detail-header">
          <div className="pss-detail-matchup">{game.away_team} @ {game.home_team}</div>
          <div className="pss-detail-badges">
            <Badge text={game.pss_bin} colors={binColor} />
            <Badge text={`${TIER_LABEL[game.qualifying_tier] || TIER_LABEL[game.attempted_tier] || '—'} · ${game.signal_type || 'No Play'}`} colors={{ fg: '#8a92a3', bg: '#1a1e2b' }} />
            <Badge text={game.decision} colors={decColor} />
          </div>
          <div className="pss-detail-stats">
            <div><span>PSS</span><b>{fmt(game.pss, 1)}</b></div>
            <div><span>Model Pick</span><b>{game.suggested_side === 'home' ? game.home_team : game.away_team} {fmtLine(fmt(game.suggested_line, 1))}</b></div>
            <div><span>Current Line</span><b>{favoredDisplay(game.vegas_line, game.home_team, game.away_team)}</b></div>
            <div><span>Edge</span><b>{fmtLine(fmt(game.edge, 1))}</b></div>
          </div>
          <p className="pss-detail-explain">{explanation}</p>
        </div>

        {/* B. PSS component breakdown */}
        <div className="pss-detail-section">
          <h4>PSS Component Breakdown</h4>
          <table className="pss-mini-table">
            <thead><tr><th>Component</th><th>Actual</th><th>Score</th><th>Weight</th><th>Contribution</th></tr></thead>
            <tbody>
              {components.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td><td>{c.actual}</td><td>{fmt(c.score, 0)}</td><td>{c.weight}%</td><td>{fmt((c.score * c.weight) / 100, 1)}</td>
                </tr>
              ))}
              <tr className="pss-mini-total"><td colSpan={4}>TOTAL</td><td>{fmt(totalContribution, 1)}</td></tr>
            </tbody>
          </table>
        </div>

        {/* C. Individual model predictions */}
        <div className="pss-detail-section">
          <h4>Individual Model Predictions ({game.selected_model_ids?.length || 0})</h4>
          {models === null ? (
            <p className="pss-detail-empty">Loading…</p>
          ) : models.length === 0 ? (
            <p className="pss-detail-empty">No model-level predictions found.</p>
          ) : (
            <>
              <table className="pss-mini-table">
                <thead><tr><th>Model</th><th>Predicted Spread</th><th>Edge vs Market</th><th>Selected Side</th></tr></thead>
                <tbody>
                  {models.map((m) => {
                    const pred = parseFloat(m.predicted_margin);
                    const modelEdge = pred - parseFloat(game.vegas_line);
                    const side = pred > parseFloat(game.vegas_line) ? game.home_team : pred < parseFloat(game.vegas_line) ? game.away_team : 'Even';
                    return (
                      <tr key={m.model_id}>
                        <td>{m.source_models?.system_name || 'Unknown'}</td>
                        <td>{fmtLine(fmt(pred, 1))}</td>
                        <td>{fmtLine(fmt(modelEdge, 1))}</td>
                        <td>{side}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {modelStats && (
                <div className="pss-model-stats">
                  <span>Mean <b>{fmt(modelStats.mean, 2)}</b></span>
                  <span>Median <b>{fmt(modelStats.median, 2)}</b></span>
                  <span>STD <b>{fmt(modelStats.std, 2)}</b></span>
                  <span>Range <b>{fmt(modelStats.max - modelStats.min, 2)}</b></span>
                </div>
              )}
            </>
          )}
        </div>

        {/* D. Market context */}
        <div className="pss-detail-section">
          <h4>Market Context</h4>
          <div className="pss-market-grid">
            <div><span>Opening Line</span><b>{game.opening_line != null ? favoredDisplay(game.opening_line, game.home_team, game.away_team) : '—'}</b></div>
            <div><span>Current Line</span><b>{favoredDisplay(game.current_line, game.home_team, game.away_team)}</b></div>
            <div><span>Line Move</span><b>{game.line_move != null ? fmtLine(fmt(game.line_move, 1)) : '—'}</b></div>
            <div><span>Edge at Open</span><b>{game.edge_at_open != null ? fmtLine(fmt(game.edge_at_open, 1)) : '—'}</b></div>
            <div><span>Edge Retention</span><b>{game.edge_retention != null ? fmtPct(game.edge_retention) : '—'}</b></div>
            <div><span>Market Alignment</span><b>{game.market_alignment || '—'}</b></div>
            <div><span>Edge Cushion</span><b>{game.edge_cushion != null ? fmt(game.edge_cushion, 1) : '—'}</b></div>
          </div>
        </div>

        {/* Drivers & Warnings */}
        <div className="pss-detail-section">
          <h4>PSS Drivers &amp; Warnings</h4>
          <div className="pss-chip-row">
            {(game.pss_drivers || []).map((d, i) => <span key={i} className="pss-chip pss-chip-pos">✓ {d}</span>)}
            {(!game.pss_drivers || game.pss_drivers.length === 0) && <span className="pss-detail-empty">No standout positive drivers.</span>}
          </div>
          <div className="pss-chip-row" style={{ marginTop: 8 }}>
            {(game.warnings || []).map((w, i) => <span key={i} className="pss-chip pss-chip-warn">⚠ {w}</span>)}
            {(!game.warnings || game.warnings.length === 0) && <span className="pss-detail-empty">No warnings flagged.</span>}
          </div>
        </div>

        {/* E. Historical profile */}
        <div className="pss-detail-section">
          <h4>Historical Profile — {game.pss_bin} plays, {game.season}</h4>
          {hist === null ? (
            <p className="pss-detail-empty">Loading…</p>
          ) : hist.n === 0 ? (
            <p className="pss-detail-empty">No graded {game.pss_bin} plays yet this season (N=0). This builds up as weeks are graded.</p>
          ) : (
            <p className="pss-detail-record">
              {hist.w}-{hist.l}{hist.p ? `-${hist.p}` : ''} ATS ({((hist.w / Math.max(1, hist.w + hist.l)) * 100).toFixed(1)}%), N={hist.n}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
const QUICK_FILTERS = ['All', 'Elite', 'Very Strong+', 'Top 3', 'Top 5', 'Top 7', 'Warnings', 'Model Picks Only'];

export default function PSSDashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const [rows, setRows] = useState([]);
  const [logos, setLogos] = useState({});
  const [picksByGame, setPicksByGame] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [sortKey, setSortKey] = useState('pss');
  const [sortDir, setSortDir] = useState('desc');
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState('All');
  const [minEdge, setMinEdge] = useState('');

  const [pickModalGame, setPickModalGame] = useState(null);
  const [pickModalDefaultStatus, setPickModalDefaultStatus] = useState('official');
  const [noteModalGame, setNoteModalGame] = useState(null);
  const [detailGame, setDetailGame] = useState(null);

  const [showMobileTable, setShowMobileTable] = useState(false);
  const [mobileSort, setMobileSort] = useState('pss');

  async function loadWeek() {
    setLoading(true); setError(null);
    try {
      const gamesUrl = `${SUPABASE_URL}/rest/v1/games?select=id,home_team,away_team,kickoff_at,current_line,opening_line,closing_line,over_under,tv_network,status,home_score,away_score&season=eq.${season}&week=eq.${week}`;
      const logosUrl = `${SUPABASE_URL}/rest/v1/team_logos?select=team_name,logo_url`;
      const [gamesRes, logosRes] = await Promise.all([
        fetch(gamesUrl, { headers: SB_HEADERS }),
        fetch(logosUrl, { headers: SB_HEADERS }),
      ]);
      if (!gamesRes.ok) throw new Error(`Supabase error ${gamesRes.status}`);
      const gamesData = await gamesRes.json();
      const logosData = logosRes.ok ? await logosRes.json() : [];
      const logoMap = {};
      for (const l of logosData) logoMap[l.team_name] = l.logo_url;

      let metricsByGame = {};
      let picksData = [];
      if (gamesData.length > 0) {
        const ids = gamesData.map((g) => g.id).join(',');
        const [metricsRes, picksRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/pss_game_metrics?select=*&game_id=in.(${ids})`, { headers: SB_HEADERS }),
          fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks?select=*&game_id=in.(${ids})`, { headers: SB_HEADERS }),
        ]);
        if (metricsRes.ok) {
          const metrics = await metricsRes.json();
          for (const m of metrics) metricsByGame[m.game_id] = m;
        }
        if (picksRes.ok) picksData = await picksRes.json();
      }
      const byGame = {};
      for (const p of picksData) byGame[p.game_id] = p;

      setRows(gamesData.map((g) => ({ ...g, _m: metricsByGame[g.id] || null })));
      setLogos(logoMap);
      setPicksByGame(byGame);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    getCurrentWeek(season).then((w) => { if (!cancelled) setWeek(w); });
    return () => { cancelled = true; };
  }, [season]);

  useEffect(() => { if (week != null) loadWeek(); }, [season, week]);

  function refreshAfterPickChange() {
    setPickModalGame(null);
    loadWeek();
  }

  async function toggleLean(row) {
    if (row.pick?.status === 'official') return;
    if (row.pick?.status === 'lean') {
      if (row.pick?.id) await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks?id=eq.${row.pick.id}`, { method: 'DELETE', headers: SB_HEADERS });
    } else {
      const side = row.suggested_side || 'home';
      const line = row.vegas_line != null ? parseFloat(row.vegas_line) : null;
      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks`, {
        method: 'POST', headers: { ...SB_HEADERS, Prefer: 'return=representation' },
        body: JSON.stringify({ game_id: row.id, pss_game_metrics_id: row.pss_id, played: true, pick_type: 'spread', side, line_played: line, units: 1, status: 'lean', season, week }),
      });
    }
    loadWeek();
  }

  // Flatten games + pss metrics into display rows
  const flat = useMemo(() => {
    return rows.map((g) => {
      const m = g._m;
      const pick = picksByGame[g.id] || null;
      return {
        id: g.id,
        pss_id: m?.id ?? null,
        season, week,
        matchup: `${g.away_team} @ ${g.home_team}`,
        away_team: g.away_team,
        home_team: g.home_team,
        kickoff_at: g.kickoff_at,
        status: g.status,
        home_score: g.home_score,
        away_score: g.away_score,
        tv_network: g.tv_network,
        over_under: g.over_under,
        vegas_line: m?.vegas_line ?? g.current_line,
        current_line: m?.current_line ?? g.current_line,
        opening_line: m?.opening_line ?? g.opening_line,
        consensus_spread: m?.consensus_spread ?? null,
        edge: m?.edge ?? null,
        pss: m?.pss ?? null,
        pss_bin: m?.pss_bin ?? null,
        selected_k: m?.selected_k ?? null,
        selected_model_ids: m?.selected_model_ids ?? [],
        signal_type: m?.signal_type ?? null,
        qualifies: !!m?.qualifies,
        qualifying_tier: m?.qualifying_tier ?? null,
        attempted_tier: m?.qualifying_tier ?? (m?.selected_k === 3 ? 'top3' : m?.selected_k === 5 ? 'top5' : 'top7'),
        agreement: m?.agreement ?? null,
        agreement_count: m?.agreement_count ?? null,
        agreement_k: m?.agreement_k ?? null,
        stddev: m?.stddev ?? null,
        model_range: m?.model_range ?? null,
        raw_mss: m?.raw_mss ?? null,
        edge_score: m?.edge_score ?? null,
        mss_score: m?.mss_score ?? null,
        agreement_score: m?.agreement_score ?? null,
        stddev_score: m?.stddev_score ?? null,
        historical_tier: m?.historical_tier ?? null,
        historical_score: m?.historical_score ?? null,
        veto_triggered: !!m?.veto_triggered,
        veto_reasons: m?.veto_reasons ?? [],
        decision: m?.decision ?? null,
        suggested_side: m?.suggested_side ?? null,
        suggested_line: m?.suggested_line ?? null,
        line_move: m?.line_move ?? null,
        edge_at_open: m?.edge_at_open ?? null,
        edge_retention: m?.edge_retention ?? null,
        edge_cushion: m?.edge_cushion ?? null,
        market_alignment: m?.market_alignment ?? null,
        pss_drivers: m?.pss_drivers ?? [],
        warnings: m?.warnings ?? [],
        pick,
      };
    });
  }, [rows, picksByGame, season, week]);

  const filtered = useMemo(() => {
    let out = flat.filter((r) => r.pss != null); // only games PSS has computed
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => r.home_team.toLowerCase().includes(q) || r.away_team.toLowerCase().includes(q));
    }
    if (quickFilter === 'Elite') out = out.filter((r) => r.pss_bin === 'Elite');
    else if (quickFilter === 'Very Strong+') out = out.filter((r) => ['Elite', 'Very Strong'].includes(r.pss_bin));
    else if (quickFilter === 'Top 3') out = out.filter((r) => r.qualifying_tier === 'top3');
    else if (quickFilter === 'Top 5') out = out.filter((r) => r.qualifying_tier === 'top5');
    else if (quickFilter === 'Top 7') out = out.filter((r) => r.qualifying_tier === 'top7');
    else if (quickFilter === 'Warnings') out = out.filter((r) => (r.warnings || []).length > 0);
    else if (quickFilter === 'Model Picks Only') out = out.filter((r) => r.qualifies);
    if (minEdge !== '') {
      const threshold = parseFloat(minEdge);
      if (!Number.isNaN(threshold)) out = out.filter((r) => r.edge !== null && Math.abs(parseFloat(r.edge)) >= threshold);
    }
    return out;
  }, [flat, search, quickFilter, minEdge]);

  const rankByGameId = useMemo(() => {
    const ranked = [...flat].filter((r) => r.pss != null).sort((a, b) => (b.pss ?? -Infinity) - (a.pss ?? -Infinity));
    const map = {};
    ranked.forEach((r, i) => { map[r.id] = i + 1; });
    return map;
  }, [flat]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av = sortKey === 'rank' ? rankByGameId[a.id] : a[sortKey];
      let bv = sortKey === 'rank' ? rankByGameId[b.id] : b[sortKey];
      if (sortKey === 'pss_bin') {
        av = PSS_BIN_ORDER.indexOf(av); bv = PSS_BIN_ORDER.indexOf(bv);
        if (av === -1) av = 99; if (bv === -1) bv = 99;
      } else if (sortKey === 'decision') {
        av = DECISION_ORDER.indexOf(av); bv = DECISION_ORDER.indexOf(bv);
        if (av === -1) av = 99; if (bv === -1) bv = 99;
      } else if (sortKey === 'kickoff_at') {
        av = av ? new Date(av).getTime() : Infinity; bv = bv ? new Date(bv).getTime() : Infinity;
      } else if (typeof av === 'string' && av !== null && !Number.isNaN(parseFloat(av))) {
        av = parseFloat(av); bv = parseFloat(bv);
      }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir, rankByGameId]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'kickoff_at' ? 'asc' : 'desc'); }
  }

  const COLUMNS = [
    { key: 'rank', label: 'Rank' },
    { key: 'matchup', label: 'Matchup', sticky: true },
    { key: 'kickoff_at', label: 'Kickoff' },
    { key: 'market_spread', label: 'Market Spread', sortKey: 'vegas_line' },
    { key: 'model_pick', label: 'Model Pick', sortKey: 'suggested_side' },
    { key: 'edge', label: 'Edge' },
    { key: 'pss', label: 'PSS' },
    { key: 'pss_bin', label: 'Bin' },
    { key: 'topk', label: 'Top-K', sortKey: 'selected_k' },
    { key: 'mss_score', label: 'MSS' },
    { key: 'agreement', label: 'Agreement' },
    { key: 'stddev', label: 'STD' },
    { key: 'historical_tier', label: 'Hist. Conf' },
    { key: 'line_move', label: 'Move' },
    { key: 'market_alignment', label: 'Alignment' },
    { key: 'decision', label: 'Decision' },
    { key: 'drivers', label: 'Drivers' },
    { key: 'warnings', label: 'Warnings' },
    { key: 'lean', label: 'Lean' },
    { key: 'play', label: 'My Play' },
    { key: 'notes', label: 'Notes' },
  ];

  return (
    <div className="page pss-page">
      <div className="page-header">
        <h1>🧠 BobbyPSSModel — PSS Dashboard</h1>
        <p>Dynamic Top-K qualification (3/5/7) &amp; Play Strength Score — ranked, weighted signals across all games</p>
      </div>

      {/* Controls */}
      <div className="card pss-controls">
        <div className="pss-controls-row">
          <label>Season</label>
          <input type="number" value={season} onChange={(e) => setSeason(+e.target.value)} className="pss-input" style={{ width: 90 }} />
          <label>Week</label>
          <input type="number" value={week ?? ''} onChange={(e) => setWeek(+e.target.value)} className="pss-input" style={{ width: 70 }} />
          <input type="text" placeholder="Search team…" value={search} onChange={(e) => setSearch(e.target.value)} className="pss-input" style={{ flex: 1, minWidth: 160 }} />
          <label>Min |Edge|</label>
          <input type="number" step="0.5" value={minEdge} onChange={(e) => setMinEdge(e.target.value)} className="pss-input" style={{ width: 80 }} />
        </div>
        <div className="pss-quickfilters">
          {QUICK_FILTERS.map((f) => (
            <button key={f} className={`pss-chip-btn ${quickFilter === f ? 'active' : ''}`} onClick={() => setQuickFilter(f)}>{f}</button>
          ))}
        </div>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <>
          {/* ═══ DESKTOP TABLE ═══ */}
          <div className="tbl-wrap pss-desktop-only">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={`sortable ${c.sticky ? 'sticky-col' : ''}`}
                      onClick={() => toggleSort(c.sortKey || c.key)}
                    >
                      {c.label}
                      {TOOLTIPS[c.key] && <InfoIcon text={TOOLTIPS[c.key]} />}
                      {sortKey === (c.sortKey || c.key) && (sortDir === 'asc' ? ' ▲' : ' ▼')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const decColor = DECISION_COLOR[r.decision] || {};
                  const binColor = PSS_BIN_COLOR[r.pss_bin] || {};
                  const awayLogo = logos[r.away_team];
                  const homeLogo = logos[r.home_team];
                  const rowClass = r.decision === 'BET' ? 'pss-row-bet' : r.decision === 'CONSIDER' ? 'pss-row-consider' : r.decision === 'REVIEW' ? 'pss-row-review' : '';
                  return (
                    <tr key={r.id} className={rowClass} onClick={() => setDetailGame(r)} style={{ cursor: 'pointer' }}>
                      <td>#{rankByGameId[r.id]}</td>
                      <td className="sticky-col" onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer' }} onClick={() => setDetailGame(r)}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><TeamLogo src={awayLogo} alt="" />{r.away_team}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><TeamLogo src={homeLogo} alt="" />{r.home_team}</div>
                        </div>
                      </td>
                      <td>{fmtKickoff(r.kickoff_at)}</td>
                      <td>{favoredDisplay(r.vegas_line, r.home_team, r.away_team)}</td>
                      <td>{r.suggested_side ? `${r.suggested_side === 'home' ? r.home_team : r.away_team} ${fmtLine(fmt(r.suggested_line, 1))}` : '—'}</td>
                      <td>{fmtLine(fmt(r.edge, 1))}</td>
                      <td style={{ fontWeight: 800 }}>{fmt(r.pss, 1)}</td>
                      <td><Badge text={r.pss_bin} colors={binColor} /></td>
                      <td>{r.selected_k ? `${SIGNAL_ICON[r.signal_type] || ''} ${TIER_LABEL[r.attempted_tier] || `Top ${r.selected_k}`}` : '—'}</td>
                      <td>{fmt(r.mss_score, 0)}</td>
                      <td>{r.agreement_count}/{r.agreement_k} ({fmtPct(r.agreement)})</td>
                      <td>{fmt(r.stddev, 2)}</td>
                      <td>{r.historical_tier || '—'}</td>
                      <td>{r.line_move != null ? fmtLine(fmt(r.line_move, 1)) : '—'}</td>
                      <td>{r.market_alignment || '—'}</td>
                      <td><Badge text={r.decision} colors={decColor} /></td>
                      <td style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 11, color: '#8a92a3' }}>{(r.pss_drivers || []).join(' • ') || '—'}</td>
                      <td>{(r.warnings || []).length > 0 ? <Badge text={`${r.warnings.length} ⚠`} colors={{ fg: '#fb923c', bg: 'rgba(251,146,60,.15)' }} title={r.warnings.join(', ')} /> : '—'}</td>
                      <td className="center" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn btn-outline"
                          style={{ padding: '3px 10px', fontSize: 11, opacity: r.pick?.status === 'official' ? 0.4 : 1 }}
                          disabled={r.pick?.status === 'official'}
                          onClick={() => toggleLean(r)}
                        >
                          {r.pick?.status === 'lean' ? '★ Lean' : '☆ Lean'}
                        </button>
                      </td>
                      <td className="center" onClick={(e) => e.stopPropagation()}>
                        {r.pick?.status === 'official' ? (
                          <button className="play-badge" onClick={() => { setPickModalDefaultStatus('official'); setPickModalGame(r); }}>
                            {r.pick.pick_type === 'total'
                              ? `${r.pick.side === 'over' ? 'O' : 'U'} ${r.pick.line_played}`
                              : `${r.pick.side === 'home' ? r.home_team : r.away_team} ${fmtLine(spreadForSide(r.pick.line_played, r.pick.side))}`} {r.pick.units}u
                          </button>
                        ) : (
                          <button className="btn btn-outline" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => { setPickModalDefaultStatus('official'); setPickModalGame(r); }}>+</button>
                        )}
                      </td>
                      <td className="center" onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-outline" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setNoteModalGame(r)}>
                          {r.pick?.note ? '📝' : '+'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {sorted.length === 0 && <tr><td colSpan={COLUMNS.length} className="empty">No games match the current filters, or PSS hasn't been computed for this week yet.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* ═══ MOBILE CARDS ═══ */}
          <div className="pss-mobile-only">
            <div className="pss-mob-toolbar">
              <select className="pss-input" value={mobileSort} onChange={(e) => setMobileSort(e.target.value)}>
                <option value="pss">PSS</option>
                <option value="kickoff_at">Kickoff</option>
                <option value="edge">Edge</option>
                <option value="agreement">Agreement</option>
              </select>
            </div>
            {(() => {
              let mobileRows = [...sorted];
              mobileRows.sort((a, b) => {
                if (mobileSort === 'kickoff_at') {
                  const at = a.kickoff_at ? new Date(a.kickoff_at).getTime() : Infinity;
                  const bt = b.kickoff_at ? new Date(b.kickoff_at).getTime() : Infinity;
                  return at - bt;
                }
                const av = a[mobileSort] != null ? parseFloat(a[mobileSort]) : -Infinity;
                const bv = b[mobileSort] != null ? parseFloat(b[mobileSort]) : -Infinity;
                return bv - av;
              });
              if (mobileRows.length === 0) return <div className="empty">No games match the current filters.</div>;
              return mobileRows.map((r) => {
                const binColor = PSS_BIN_COLOR[r.pss_bin] || {};
                const decColor = DECISION_COLOR[r.decision] || {};
                const awayLogo = logos[r.away_team];
                const homeLogo = logos[r.home_team];
                return (
                  <div key={r.id} className="pss-mcard" onClick={() => setDetailGame(r)}>
                    <div className="pss-mcard-header">
                      <span className="pss-mcard-rank">#{rankByGameId[r.id]}</span>
                      <div className="pss-mcard-teams">
                        <div><TeamLogo src={awayLogo} alt="" /> {r.away_team}</div>
                        <div><TeamLogo src={homeLogo} alt="" /> {r.home_team}</div>
                      </div>
                      <Badge text={r.pss_bin} colors={binColor} />
                    </div>
                    <div className="pss-mcard-meta">
                      <span>{fmtKickoff(r.kickoff_at)}</span>
                      {r.tv_network && <span>{r.tv_network}</span>}
                    </div>
                    <div className="pss-mcard-grid">
                      <div><span>Market<MobInfoIcon text={TOOLTIPS.market_spread} /></span><b>{favoredDisplay(r.vegas_line, r.home_team, r.away_team)}</b></div>
                      <div><span>Model Pick<MobInfoIcon text={TOOLTIPS.model_pick} /></span><b>{r.suggested_side ? `${r.suggested_side === 'home' ? r.home_team : r.away_team} ${fmtLine(fmt(r.suggested_line, 1))}` : '—'}</b></div>
                      <div><span>Edge<MobInfoIcon text={TOOLTIPS.edge} /></span><b>{fmtLine(fmt(r.edge, 1))}</b></div>
                      <div><span>PSS<MobInfoIcon text={TOOLTIPS.pss} /></span><b>{fmt(r.pss, 1)}</b></div>
                      <div><span>Top-K<MobInfoIcon text={TOOLTIPS.topk} /></span><b>{r.selected_k ? `${TIER_LABEL[r.attempted_tier] || `Top ${r.selected_k}`}` : '—'}</b></div>
                      <div><span>Agreement<MobInfoIcon text={TOOLTIPS.agreement} /></span><b>{r.agreement_count}/{r.agreement_k}</b></div>
                      <div><span>STD<MobInfoIcon text={TOOLTIPS.stddev} /></span><b>{fmt(r.stddev, 2)}</b></div>
                      <div><span>Decision<MobInfoIcon text={TOOLTIPS.decision} /></span><b><Badge text={r.decision} colors={decColor} /></b></div>
                    </div>
                    {r.pss_drivers?.length > 0 && (
                      <div className="pss-mcard-drivers">{r.pss_drivers.join(' • ')}</div>
                    )}
                    {r.warnings?.length > 0 && (
                      <div className="pss-mcard-warnings">⚠ {r.warnings.join(' • ')}</div>
                    )}
                    <div className="pss-mcard-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn btn-outline"
                        style={{ fontSize: 11, padding: '4px 10px', opacity: r.pick?.status === 'official' ? 0.4 : 1 }}
                        disabled={r.pick?.status === 'official'}
                        onClick={() => toggleLean(r)}
                      >
                        {r.pick?.status === 'lean' ? '★ Lean' : '☆ Lean'}
                      </button>
                      {r.pick?.status === 'official' ? (
                        <button className="play-badge" onClick={() => { setPickModalDefaultStatus('official'); setPickModalGame(r); }}>
                          {r.pick.pick_type === 'total'
                            ? `${r.pick.side === 'over' ? 'O' : 'U'} ${r.pick.line_played}`
                            : `${r.pick.side === 'home' ? r.home_team : r.away_team} ${fmtLine(spreadForSide(r.pick.line_played, r.pick.side))}`} {r.pick.units}u
                        </button>
                      ) : (
                        <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => { setPickModalDefaultStatus('official'); setPickModalGame(r); }}>+ Play</button>
                      )}
                      <button className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setNoteModalGame(r)}>{r.pick?.note ? '📝 Note' : '+ Note'}</button>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </>
      )}

      {pickModalGame && (
        <PickModal
          game={pickModalGame}
          existing={pickModalGame.pick}
          defaultStatus={pickModalDefaultStatus}
          onClose={() => setPickModalGame(null)}
          onSaved={refreshAfterPickChange}
          onDeleted={refreshAfterPickChange}
        />
      )}
      {noteModalGame && (
        <NoteModal
          game={noteModalGame}
          existing={noteModalGame.pick}
          onClose={() => setNoteModalGame(null)}
          onSaved={() => { setNoteModalGame(null); loadWeek(); }}
        />
      )}
      {detailGame && <DetailPanel game={detailGame} onClose={() => setDetailGame(null)} />}

      <style jsx>{`
        .pss-controls { margin-bottom: 16px; display: flex; flex-direction: column; gap: 12px; }
        .pss-controls-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pss-controls-row label { font-size: 12px; color: #8a92a3; }
        .pss-quickfilters { display: flex; gap: 6px; flex-wrap: wrap; }
        .pss-chip-btn { padding: 5px 12px; border-radius: 20px; border: 1px solid #2a3042; background: transparent; color: #8a92a3; font-size: 12px; cursor: pointer; font-family: inherit; }
        .pss-chip-btn.active { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 700; }
        .pss-chip-btn:hover:not(.active) { color: #e6e9ef; border-color: #8a92a3; }
        .pss-row-bet > td { background: rgba(56,189,148,.06); }
        .pss-row-bet:hover > td { background: rgba(56,189,148,.12); }
        .pss-row-consider > td { background: rgba(45,212,191,.05); }
        .pss-row-review > td { background: rgba(251,146,60,.06); }

        .pss-mobile-only { display: none; }
        @media (max-width: 900px) {
          .pss-desktop-only { display: none; }
          .pss-mobile-only { display: block; }
        }
        .pss-mob-toolbar { margin-bottom: 10px; }
        .pss-mcard { background: #131722; border: 1px solid #1e2535; border-radius: 12px; padding: 14px; margin-bottom: 12px; cursor: pointer; }
        .pss-mcard-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
        .pss-mcard-rank { font-size: 11px; font-weight: 800; color: #5b6272; }
        .pss-mcard-teams { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
        .pss-mcard-teams > div { display: flex; align-items: center; gap: 6px; }
        .pss-mcard-meta { display: flex; gap: 10px; font-size: 11px; color: #8a92a3; margin-bottom: 10px; }
        .pss-mcard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-bottom: 8px; }
        .pss-mcard-grid > div { display: flex; flex-direction: column; gap: 2px; }
        .pss-mcard-grid span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #5b6272; display: flex; align-items: center; }
        .pss-mcard-grid b { font-size: 13px; font-weight: 700; }
        .pss-mcard-drivers { font-size: 11px; color: #38bd94; margin-bottom: 4px; }
        .pss-mcard-warnings { font-size: 11px; color: #fb923c; margin-bottom: 8px; }
        .pss-mcard-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid #1e2535; }
      `}</style>
      <style jsx global>{`
        .pss-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; overflow-y: auto; padding: 20px 0; }
        .pss-modal { background: #131722; border: 1px solid #2a3042; border-radius: 12px; padding: 20px; width: 340px; max-width: 90vw; }
        .pss-modal h3 { margin: 0 0 14px; font-size: 15px; color: #e6e9ef; }
        .pss-modal textarea { width: 100%; background: #0b0e14; border: 1px solid #2a3042; border-radius: 8px; color: #e6e9ef; padding: 10px; font-size: 13px; resize: vertical; font-family: inherit; }
        .pss-seg { display: flex; gap: 6px; margin-bottom: 12px; }
        .pss-seg button { flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #2a3042; background: #0b0e14; color: #8a92a3; cursor: pointer; font-size: 13px; font-family: inherit; }
        .pss-seg.small button { padding: 5px; font-size: 12px; }
        .pss-seg button.on { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 600; }
        .pss-sidepick { display: flex; gap: 8px; margin-bottom: 14px; }
        .pss-sidepick button { flex: 1; padding: 10px 6px; border-radius: 8px; border: 1px solid #2a3042; background: #0b0e14; color: #e6e9ef; cursor: pointer; text-align: center; display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; font-family: inherit; }
        .pss-sidepick button span { font-weight: 400; color: #8a92a3; font-size: 12px; }
        .pss-sidepick button.on { border-color: #38bd94; background: rgba(56,189,148,0.1); }
        .pss-sidepick button.on span { color: #38bd94; }
        .pss-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .pss-row label { font-size: 12px; color: #8a92a3; text-transform: uppercase; letter-spacing: 0.04em; }
        .pss-units { display: flex; gap: 4px; }
        .pss-units button { width: 28px; height: 28px; border-radius: 6px; border: 1px solid #2a3042; background: #0b0e14; color: #8a92a3; cursor: pointer; font-size: 13px; font-family: inherit; }
        .pss-units button.on { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 700; }
        .pss-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
        .pss-actions button { padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid #2a3042; font-family: inherit; }
        .pss-actions .primary { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 600; }
        .pss-actions .primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .pss-actions .ghost { background: transparent; color: #8a92a3; }
        .pss-actions .danger { background: transparent; color: #f87171; border-color: #f87171; margin-right: auto; }
        .pss-input { background: #0b0e14; border: 1px solid #2a3042; color: #e6e9ef; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-family: inherit; }

        .pss-detail { background: #131722; border: 1px solid #2a3042; border-radius: 14px; padding: 24px; width: 620px; max-width: 94vw; max-height: 90vh; overflow-y: auto; position: relative; }
        .pss-detail-close { position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #8a92a3; font-size: 16px; cursor: pointer; }
        .pss-detail-matchup { font-size: 18px; font-weight: 800; margin-bottom: 8px; }
        .pss-detail-badges { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
        .pss-detail-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 10px; }
        .pss-detail-stats div { display: flex; flex-direction: column; gap: 2px; }
        .pss-detail-stats span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #5b6272; }
        .pss-detail-stats b { font-size: 15px; }
        .pss-detail-explain { font-size: 12px; color: #8a92a3; line-height: 1.5; margin: 8px 0 0; }
        .pss-detail-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid #1e2535; }
        .pss-detail-section h4 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #8a92a3; }
        .pss-detail-empty { font-size: 12px; color: #5b6272; margin: 0; }
        .pss-detail-record { font-size: 14px; font-weight: 700; margin: 0; }
        .pss-mini-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .pss-mini-table th { text-align: left; padding: 6px 8px; color: #5b6272; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid #1e2535; }
        .pss-mini-table td { padding: 6px 8px; border-bottom: 1px solid #131722; }
        .pss-mini-total td { font-weight: 800; color: #38bd94; border-top: 1px solid #2a3042; }
        .pss-model-stats { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: #8a92a3; }
        .pss-model-stats b { color: #e6e9ef; }
        .pss-market-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
        .pss-market-grid div { display: flex; flex-direction: column; gap: 2px; }
        .pss-market-grid span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #5b6272; }
        .pss-market-grid b { font-size: 13px; }
        .pss-chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
        .pss-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
        .pss-chip-pos { background: rgba(56,189,148,.15); color: #38bd94; }
        .pss-chip-warn { background: rgba(251,146,60,.15); color: #fb923c; }
      `}</style>
    </div>
  );
}
