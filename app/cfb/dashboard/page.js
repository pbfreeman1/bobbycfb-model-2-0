'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sbFetch, fmtKickoff } from '../../../lib/supabase';
import {
  TIER_COLOR, TIER_UNITS, fmtSpread, teamLine, nearMiss, tierChecklist,
  DEFINITIONS, TIER_THRESHOLDS_DISPLAY,
} from '../../../lib/bobby-model';
import { attachBobbyRank } from '../../../lib/bobby-rank';
import { shortTeam, teamSearchText } from '../../../lib/team-short';

const FH = { fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif" };
const FM = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };
const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', gold: '#D4A73C', green: '#6FBF73',
  blue: '#5B9BD4', warn: '#E07A62', lav: '#B39DDB',
};

const TIER_ORDER = ['3U', '2U', '1U', 'Lean', 'No tier'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function sbFetchAll(basePath) {
  const pageSize = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const rows = await sbFetch(`${basePath}${sep}limit=${pageSize}&offset=${offset}`);
    all = all.concat(rows);
    if (!rows.length || rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function abbrFor(name) {
  if (!name) return '???';
  const words = name.replace(/[^\w\s&']/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  const skip = new Set(['of']);
  const letters = words.filter((w) => !skip.has(w.toLowerCase())).map((w) => w[0]).join('');
  return (letters || words[0].slice(0, 4)).slice(0, 4).toUpperCase();
}

// Decides whether a card can show full team names.
//
// The probe element always holds the FULL names on one unwrapped line, so the
// measurement never depends on what is currently rendered — that is what stops
// the shorten/fit/lengthen/overflow flip-flop. The box it is compared against
// is laid out so its width is independent of the text inside it (see
// .bm-match-row: one nowrap row on desktop, a stretched column on mobile), so
// switching names can never change the width we measure. One state update per
// layout, coalesced into a single animation frame.
function useFullNamesFit(key) {
  const boxRef = useRef(null);
  const probeRef = useRef(null);
  const [fits, setFits] = useState(true);

  const measure = useCallback(() => {
    const box = boxRef.current, probe = probeRef.current;
    if (!box || !probe) return;
    const needed = probe.scrollWidth;
    const avail = box.clientWidth;
    if (!needed || !avail) return;
    setFits((prev) => {
      const next = needed <= avail + 0.5;
      return next === prev ? prev : next;
    });
  }, []);

  useEffect(() => {
    measure();
    let raf = 0;
    const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    window.addEventListener('orientationchange', onResize);
    // Web fonts land after first paint and change every width.
    if (typeof document !== 'undefined' && document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    return () => {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('orientationchange', onResize);
    };
  }, [measure, key]);

  return { boxRef, probeRef, fits };
}

function tally(results) {
  return results.reduce((acc, r) => {
    if (r === 'win') acc.wins++;
    else if (r === 'loss') acc.losses++;
    else if (r === 'push') acc.pushes++;
    return acc;
  }, { wins: 0, losses: 0, pushes: 0 });
}
function recordStr(t) { return `${t.wins}-${t.losses}${t.pushes ? `-${t.pushes}` : ''}`; }
function fmtU(u) {
  if (u == null) return '—';
  const n = Number(u);
  const sign = n > 0.001 ? '+' : n < -0.001 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(1)}u`;
}
function uColor(u) {
  const n = Number(u);
  return n > 0.001 ? C.green : n < -0.001 ? C.warn : C.sub;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function TeamMark({ logoUrl, name }) {
  if (logoUrl) return <img src={logoUrl} alt={name} style={{ width: 24, height: 24, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
  return (
    <div style={{ width: 24, height: 24, borderRadius: '50%', background: C.surface2, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7.5, ...FM, color: C.sub, flexShrink: 0 }}>
      {abbrFor(name).slice(0, 4)}
    </div>
  );
}

// Locks page scroll behind any overlay (modal or bottom sheet). Counted so two
// overlays open at once can't unlock each other.
let scrollLocks = 0;
function useLockBodyScroll(active) {
  useEffect(() => {
    if (!active) return undefined;
    scrollLocks += 1;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      scrollLocks -= 1;
      if (scrollLocks <= 0) { scrollLocks = 0; document.body.style.overflow = prev || ''; }
    };
  }, [active]);
}

function Modal({ title, onClose, children, wide }) {
  useLockBodyScroll(true);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto',
      padding: 'calc(5vh + env(safe-area-inset-top)) 16px calc(5vh + env(safe-area-inset-bottom))',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
        width: '100%', maxWidth: wide ? 820 : 420, padding: 22, boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ ...FH, fontSize: 18, fontWeight: 700, color: C.text }}>{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, width: 32, height: 32, color: C.sub, cursor: 'pointer', fontSize: 15 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function InfoIcon({ defKey, active, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(defKey)}
      aria-label="Explain"
      className="bm-info"
      style={{
        padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: '50%', border: `1px solid ${active ? C.gold : C.sub}`,
        color: active ? C.gold : C.sub, ...FM, fontSize: 9, lineHeight: '13px', textAlign: 'center',
      }}>i</span>
    </button>
  );
}

function DefBox({ defKey, onClose }) {
  const d = DEFINITIONS[defKey];
  if (!d) return null;
  return (
    <div style={{ borderTop: `1px solid ${C.gold}`, background: C.surface2, padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ ...FH, fontWeight: 700, fontSize: 14, color: C.gold }}>{d[0]}</span>
        <span style={{ ...FM, fontSize: 12.5, lineHeight: 1.5, color: '#C9CFC8' }}>{d[1]}</span>
      </div>
      <button onClick={onClose} aria-label="Close definition" style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer', fontSize: 14 }}>✕</button>
    </div>
  );
}

function TierBadge({ tier, small }) {
  const col = TIER_COLOR[tier] || TIER_COLOR['No tier'];
  return (
    <span style={{
      ...FM, fontSize: small ? 10.5 : 11, fontWeight: 700, padding: small ? '2px 7px' : '3px 9px',
      borderRadius: 3, border: `1px solid ${col}`, color: col, background: `${col}1F`, whiteSpace: 'nowrap',
    }}>{tier}</span>
  );
}

// One badge shape for the whole status row: same height, same padding, same
// radius, whatever the colour or content. `as` lets an interactive badge render
// as a button while keeping the identical box.
function Badge({ color, dashed, filled, children, as = 'span', className = '', ...rest }) {
  const col = color || C.border;
  const Tag = as;
  return (
    <Tag
      {...rest}
      className={`bm-badge ${className}`}
      style={{
        ...FM, fontSize: 11, fontWeight: 600, borderRadius: 4, whiteSpace: 'nowrap',
        border: `1px ${dashed ? 'dashed' : 'solid'} ${col}`,
        background: filled ? `${col}1A` : 'transparent',
        color: color || C.sub,
        display: 'inline-flex', alignItems: 'center', gap: 2,
        cursor: as === 'button' ? 'pointer' : 'default',
      }}
    >{children}</Tag>
  );
}

// Slide-up drawer used for the mobile filter panel.
function BottomSheet({ title, onClose, children, footer }) {
  useLockBodyScroll(true);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 250, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          background: C.surface, borderTop: `1px solid ${C.border}`, borderRadius: '14px 14px 0 0',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div style={{ padding: '10px 0 2px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border }} />
        </div>
        <div style={{ padding: '4px 16px 10px', ...FH, fontSize: 16, fontWeight: 700, flexShrink: 0 }}>{title}</div>
        <div style={{ overflowY: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {children}
        </div>
        {footer && (
          <div style={{ flexShrink: 0, borderTop: `1px solid ${C.border}`, padding: 12, display: 'flex', gap: 10 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend modal
// ---------------------------------------------------------------------------
function LegendModal({ onClose }) {
  return (
    <Modal title="How to use THE Bobby Model" onClose={onClose} wide>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.5, color: '#C9CFC8' }}>
        <li>Each game shows the <b style={{ color: C.text }}>Bobby Model pick</b>: the side where the best-performing 2026 systems agree against the Vegas line, with the model's own line and the edge.</li>
        <li>Games are binned <b style={{ color: C.text }}>3U, 2U, 1U or Lean</b>. Tap the unit cards at the top to filter the board to those tiers — tap again to turn one off.</li>
        <li><b style={{ color: C.text }}>Bobby Rank (#N)</b> orders the whole week best play to worst: unit tier first, then a strength score from weighted vote share, edge and tightness, with edge tapered past 3 points and ignored past 5 (bigger edges have not held up ATS). It is fixed per game — searching, filtering or re-sorting never changes a game's number.</li>
        <li>Open a card with the arrow for the full breakdown: stats, tier checklist, how the vote splits, every system's prediction and weight, and your notes.</li>
        <li>Log your own play with <b style={{ color: C.blue }}>+ Bobby Pick</b> and tag outside opinions with <b style={{ color: C.text }}>+ Research</b>. Your picks roll into My card.</li>
        <li>Tap any <span style={{ display: 'inline-block', width: 13, height: 13, borderRadius: '50%', border: `1px solid ${C.sub}`, color: C.sub, ...FM, fontSize: 9, lineHeight: '11px', textAlign: 'center' }}>i</span> for a definition.</li>
      </ol>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 18 }}>
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>TIERS (ALL MUST PASS)</span>
          <div style={{ display: 'grid', gridTemplateColumns: '54px repeat(4, 1fr)', gap: 6, ...FM, fontSize: 11.5, color: C.sub }}>
            <span></span><span>Vote</span><span>Edge</span><span>STD</span><span>Conv</span>
          </div>
          {TIER_THRESHOLDS_DISPLAY.map((t) => (
            <div key={t.t} style={{ display: 'grid', gridTemplateColumns: '54px repeat(4, 1fr)', gap: 6, ...FM, fontSize: 12 }}>
              <span style={{ color: TIER_COLOR[t.t], fontWeight: 700 }}>{t.t}</span><span>{t.vs}</span><span>{t.edge}</span><span>{t.sd}</span><span>{t.conv}</span>
            </div>
          ))}
          <span style={{ fontSize: 12, color: C.sub }}>Every tier also needs 5+ voting systems.</span>
        </div>
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, color: '#C9CFC8', lineHeight: 1.45 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>COLORS AND CHIPS</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: C.gold, marginRight: 6 }}></span>Card edge = tier color</span>
          <span><b style={{ color: C.blue }}>MY PLAY</b> = your logged play · <b style={{ color: C.text }}>Bobby Pick:</b> = the model's side</span>
          <span><b style={{ color: C.sub }}>Grey chips</b> = research tags (side · source)</span>
          <span><b style={{ color: C.warn }}>Orange chip</b> = flag: 6+ edge, fade watch, thin pool, split top</span>
          <span><b style={{ color: C.green }}>Green</b> / <b style={{ color: C.warn }}>orange</b> in breakdowns = with / against the pick</span>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: C.sub, marginTop: 14 }}>Units are paper units graded weekly at −110. System weights update after every graded week.</div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pick / research modals (writes to user_picks / research_picks — same
// tables and flows the PSS dashboard uses).
// ---------------------------------------------------------------------------
function PickModal({ game, signal, existing, onClose, onSaved, onDeleted }) {
  const [side, setSide] = useState(existing?.side || signal?.pick_side || null);
  const [line, setLine] = useState(existing?.line_played != null ? String(existing.line_played) : '');
  const [units, setUnits] = useState(existing?.units || TIER_UNITS[signal?.tier] || 1);
  const [saving, setSaving] = useState(false);

  const vegasLine = game.current_line != null ? parseFloat(game.current_line) : null;
  const homeSpread = vegasLine != null ? parseFloat(teamLine(vegasLine, 'home')) : null;
  const awaySpread = vegasLine != null ? parseFloat(teamLine(vegasLine, 'away')) : null;

  useEffect(() => {
    if (existing) return;
    if (side === 'home' && homeSpread != null) setLine(homeSpread.toFixed(1));
    else if (side === 'away' && awaySpread != null) setLine(awaySpread.toFixed(1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  async function handleSave() {
    if (!side) return;
    setSaving(true);
    try {
      await onSaved({ pick_type: 'spread', side, line_played: line.trim() === '' ? null : parseFloat(line), units, is_custom: false });
    } finally { setSaving(false); }
  }
  async function handleDelete() {
    setSaving(true);
    try { await onDeleted(); } finally { setSaving(false); }
  }

  const teamBtn = (active) => ({
    flex: 1, padding: '12px 10px', borderRadius: 8, border: `1px solid ${active ? C.green : C.border}`,
    background: active ? `${C.green}1F` : C.bg, color: active ? C.green : C.text, cursor: 'pointer', textAlign: 'center', fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const unitBtn = (active) => ({
    width: 34, height: 34, borderRadius: 6, border: `1px solid ${active ? C.green : C.border}`,
    background: active ? C.green : C.bg, color: active ? '#0F1412' : C.sub, cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 400,
  });
  const inputStyle = { ...FM, fontSize: 13, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', color: C.text, width: '100%', boxSizing: 'border-box' };

  return (
    <Modal title={`${game.away_team} @ ${game.home_team}`} onClose={onClose}>
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
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Line you got</div>
        <input style={inputStyle} type="number" step="0.5" value={line} onChange={(e) => setLine(e.target.value)} placeholder="e.g. -3.5" />
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Units</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 2, 3, 4, 5].map((u) => <button key={u} style={unitBtn(units === u)} onClick={() => setUnits(u)}>{u}</button>)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {existing && <button onClick={handleDelete} disabled={saving} style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${C.warn}`, background: 'transparent', color: C.warn, cursor: 'pointer', fontSize: 13 }}>Remove</button>}
        <button onClick={onClose} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleSave} disabled={saving || !side} style={{ flex: 2, padding: '9px 0', borderRadius: 8, border: 'none', background: side ? C.blue : C.border, color: side ? '#0F1412' : C.sub, cursor: side && !saving ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
          {saving ? 'Saving…' : 'Save Bobby Pick'}
        </button>
      </div>
    </Modal>
  );
}

function ResearchPickModal({ game, onClose, onSaved }) {
  const [pickSide, setPickSide] = useState('home');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try { await onSaved({ pick_side: pickSide, pick_type: 'spread', source_label: source.trim() || null }); }
    finally { setSaving(false); }
  }

  const selStyle = { ...FM, fontSize: 13, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', color: C.text, width: '100%', boxSizing: 'border-box' };

  return (
    <Modal title={`Research pick — ${game.away_team} @ ${game.home_team}`} onClose={onClose}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Side</div>
        <select style={selStyle} value={pickSide} onChange={(e) => setPickSide(e.target.value)}>
          <option value="home">{game.home_team} (Home)</option>
          <option value="away">{game.away_team} (Away)</option>
        </select>
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Source</div>
        <input style={selStyle} placeholder="e.g. Action Network" value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: '9px 0', borderRadius: 8, border: 'none', background: C.gold, color: '#0F1412', cursor: saving ? 'default' : 'pointer', fontSize: 13, fontWeight: 700 }}>
          {saving ? 'Saving…' : 'Save Tag'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Game card
// ---------------------------------------------------------------------------
function GameCard({
  g, rank, config, logos, preds, weightsByModel, picks, research, expanded, onToggle,
  onOpenPick, onOpenResearch, onRemoveResearch, onSaveNote,
}) {
  const { game, signal } = g;
  const home = game.home_team, away = game.away_team;
  const tier = signal?.tier || 'No tier';
  const tierColor = TIER_COLOR[tier];
  const homeAbbr = abbrFor(home), awayAbbr = abbrFor(away);
  const [defKey, setDefKey] = useState(null);
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const toggleDef = (k) => setDefKey((prev) => (prev === k ? null : k));

  const vegasLine = game.current_line != null ? parseFloat(game.current_line) : null;
  const favSide = vegasLine != null && Math.abs(vegasLine) > 0.05 ? (vegasLine > 0 ? 'home' : 'away') : null;

  // Full names unless they demonstrably do not fit on this card.
  const { boxRef, probeRef, fits } = useFullNamesFit(`${away}@${home}`);
  const useShort = !fits;
  const homeDisp = useShort ? shortTeam(home) : home;
  const awayDisp = useShort ? shortTeam(away) : away;
  const teamAttrs = (full, disp) => (disp === full ? {} : { title: full, 'aria-label': full });

  // Rendered twice: once visibly, once inside the hidden probe with the full
  // names and no ellipsis, which is what the fit test measures.
  const teamPair = (short, isProbe = false) => {
    const a = short ? shortTeam(away) : away;
    const h = short ? shortTeam(home) : home;
    const nameStyle = isProbe
      ? { fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }
      : { fontSize: 15, fontWeight: 600 };
    return (
      <>
        <TeamMark logoUrl={logos[away]} name={away} />
        <span className={isProbe ? undefined : 'bm-team'} style={nameStyle} {...(isProbe ? {} : teamAttrs(away, a))}>
          {a}{favSide === 'away' && <span style={{ color: C.sub, fontWeight: 400 }}> (-{Math.abs(vegasLine).toFixed(1)})</span>}
        </span>
        <span style={{ color: C.sub, fontSize: 12, flexShrink: 0 }}>@</span>
        <TeamMark logoUrl={logos[home]} name={home} />
        <span className={isProbe ? undefined : 'bm-team'} style={nameStyle} {...(isProbe ? {} : teamAttrs(home, h))}>
          {h}{favSide === 'home' && <span style={{ color: C.sub, fontWeight: 400 }}> (-{Math.abs(vegasLine).toFixed(1)})</span>}
        </span>
      </>
    );
  };

  const nm = signal ? nearMiss({ ...signal, edge: signal.edge, tier }, config) : null;
  const flags = signal?.flags || [];
  const hasBadges = !!signal || !!nm || flags.length > 0 || (research || []).length > 0 || (picks || []).length > 0;

  const pickTeam = signal?.pick_side === 'home' ? home : signal?.pick_side === 'away' ? away : null;
  const pickTeamDisp = pickTeam && useShort ? shortTeam(pickTeam) : pickTeam;
  const pickAbbr = signal?.pick_side === 'home' ? homeAbbr : awayAbbr;

  // Individual system breakdown for this game, sorted by weight desc.
  const systemRows = useMemo(() => {
    if (!signal) return [];
    const rows = (preds || [])
      .map((p) => ({ ...p, w: weightsByModel[p.model_id] }))
      .filter((p) => p.w && p.w.weight > 0);
    rows.sort((a, b) => b.w.weight - a.w.weight);
    const sw = rows.reduce((a, r) => a + r.w.weight, 0) || 1;
    return rows.map((r) => {
      const pm = parseFloat(r.predicted_margin);
      const on = Math.sign(pm - signal.vegas_line) === Math.sign(signal.edge);
      const side = on ? pickAbbr : (signal.pick_side === 'home' ? awayAbbr : homeAbbr);
      return {
        name: r.w.system_name,
        pred: `${teamLine(pm, signal.pick_side)} ${pickAbbr}`,
        on, side,
        share: (r.w.weight / sw) * 100,
        rec: `${r.w.wins}-${r.w.losses}${r.w.pushes ? `-${r.w.pushes}` : ''}`,
      };
    });
  }, [signal, preds, weightsByModel, pickAbbr, awayAbbr, homeAbbr]);

  const onCount = systemRows.filter((s) => s.on).length;
  const checklist = signal ? tierChecklist({ ...signal, tier }, config) : null;

  const stats = signal ? [
    { k: 'pick', label: 'Bobby Model pick', val: `${pickTeam} ${teamLine(signal.vegas_line, signal.pick_side)}` },
    { k: 'modelLine', label: 'Model line', val: `${pickAbbr} ${teamLine(signal.consensus, signal.pick_side)}` },
    { k: 'vegas', label: 'Vegas line', val: favSide ? `${favSide === 'home' ? homeAbbr : awayAbbr} ${fmtSpread(-Math.abs(vegasLine))}` : 'PK' },
    { k: 'edge', label: 'Edge', val: `+${Math.abs(signal.edge).toFixed(1)} pts` },
    { k: 'vs', label: 'Vote share', val: `${Math.round(signal.vote_share * 100)}% (${onCount} of ${signal.voters})` },
    { k: 'sd', label: 'Std dev', val: `${signal.std_dev.toFixed(1)} pts` },
    { k: 'conv', label: 'Conviction', val: signal.conviction.toFixed(2) },
    { k: 'move', label: 'Line move', val: `${signal.opening_line != null ? fmtSpread(signal.opening_line) : '—'} → ${fmtSpread(signal.vegas_line)}` },
    { k: 'ou', label: 'Total (O/U)', val: game.over_under != null ? String(game.over_under) : '—' },
  ] : [];

  async function handleSaveNote() {
    if (!note.trim()) return;
    setSavingNote(true);
    try { await onSaveNote(note.trim()); setNote(''); } finally { setSavingNote(false); }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 12 }} className="bm-card-row">
      <div className="bm-rank" style={{ ...FM, fontSize: 12, color: C.sub, flexShrink: 0, textAlign: 'right', paddingTop: 16 }} title="Bobby Rank">{rank ? `#${rank}` : '—'}</div>
      <div style={{
        flexGrow: 1, minWidth: 0, background: C.surface, border: `1px solid ${C.border}`,
        borderLeft: `4px solid ${tier === 'No tier' ? C.border : tierColor}`, borderRadius: 6, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            {/* Row 1 — matchup. Full names by default; the card falls back to
                short names only when the full pair cannot fit. */}
            <div className="bm-match-row" style={{ padding: '14px 16px 10px' }}>
              <div ref={boxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 auto' }}>
                {teamPair(useShort)}
                {/* Hidden, never-wrapped copy of the full names — the yardstick. */}
                <div
                  ref={probeRef}
                  aria-hidden="true"
                  style={{
                    position: 'absolute', top: 0, left: 0, height: 0, overflow: 'hidden', visibility: 'hidden',
                    pointerEvents: 'none', whiteSpace: 'nowrap', width: 'max-content',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  {teamPair(false, true)}
                </div>
              </div>
              <div className="bm-match-meta" style={{ ...FM, fontSize: 11, color: C.sub, display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
                <span>{fmtKickoff(game.kickoff_at)}</span>
                {game.tv_network && <span>{game.tv_network}</span>}
                <span>O/U {game.over_under != null ? game.over_under : '—'}</span>
              </div>
            </div>

            {/* Row 2 — every status badge, on its own row. Skipped entirely when
                there is nothing to show. */}
            {hasBadges && (
              <div style={{ padding: '0 16px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {signal && <Badge color={tier === 'No tier' ? C.sub : TIER_COLOR[tier]} filled>{tier}</Badge>}
                {nm && (
                  <Badge color={C.gold} dashed>
                    Near miss · {nm}
                    <InfoIcon defKey="near" active={defKey === 'near'} onToggle={toggleDef} />
                  </Badge>
                )}
                {flags.map((f) => <Badge key={f} color={C.warn} filled>{f}</Badge>)}
                {(research || []).map((r) => (
                  <Badge key={r.id} color={C.sub} className="bm-badge-tap">
                    {useShort ? shortTeam(r.pick_side === 'home' ? home : away) : (r.pick_side === 'home' ? home : away)}{r.source_label ? ` · ${r.source_label}` : ''}
                    <button onClick={() => onRemoveResearch(r.id)} aria-label="Remove research tag" className="bm-badge-x" style={{ padding: 0, border: 'none', background: 'none', color: C.sub, cursor: 'pointer', fontSize: 14 }}>×</button>
                  </Badge>
                ))}
                {(picks || []).map((p) => (
                  <Badge key={p.id} as="button" onClick={() => onOpenPick(p)} color={C.blue} filled className="bm-badge-tap" title={p.side === 'home' ? home : away}>
                    MY PLAY · {(parseFloat(p.units) || 1)}u {useShort ? shortTeam(p.side === 'home' ? home : away) : (p.side === 'home' ? home : away)} {teamLine(p.line_played, p.side)}
                  </Badge>
                ))}
              </div>
            )}

            <div style={{ height: 1, background: C.border, margin: '0 16px' }} />

            {/* Row 3 — the one consolidated pick line, plus actions */}
            <div style={{ padding: '12px 16px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              {signal ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: '1 1 260px' }}>
                  <span style={{ ...FM, fontSize: 14, color: C.text }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>BOBBY PICK: </span>
                    <span className="bm-team" style={{ fontWeight: 700, display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' }} {...teamAttrs(pickTeam, pickTeamDisp)}>{pickTeamDisp} {teamLine(signal.vegas_line, signal.pick_side)}</span>
                    <span style={{ color: C.sub }}> (BM Line: <b style={{ color: C.text, fontWeight: 700 }}>{teamLine(signal.consensus, signal.pick_side)}</b>)</span>
                  </span>
                  <span style={{ ...FM, fontSize: 11.5, color: '#C9CFC8' }}>
                    <span style={{ color: C.green, fontWeight: 700 }}>Edge +{Math.abs(signal.edge).toFixed(1)}</span> · Vote {Math.round(signal.vote_share * 100)}% · STD {signal.std_dev.toFixed(1)} · Conv {signal.conviction.toFixed(2)}
                  </span>
                </div>
              ) : (
                <span style={{ ...FM, fontSize: 12, color: C.sub, flex: '1 1 auto' }}>Not computed yet</span>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {(picks || []).length === 0 && (
                  <Badge as="button" onClick={() => onOpenPick(null)} color={C.blue} dashed className="bm-badge-tap">+ Bobby Pick</Badge>
                )}
                <Badge as="button" onClick={onOpenResearch} color={C.sub} dashed className="bm-badge-tap">+ Research</Badge>
              </div>
            </div>
          </div>
          <button onClick={onToggle} aria-expanded={expanded} aria-label="Toggle full breakdown" style={{ width: 44, flexShrink: 0, border: 'none', borderLeft: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
        </div>

        {defKey && <DefBox defKey={defKey} onClose={() => setDefKey(null)} />}

        {expanded && signal && (
          <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface2, padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px 18px' }} className="bm-stat-grid">
              {stats.map((s) => (
                <div key={s.k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <span style={{ ...FM, fontSize: 10, color: C.sub, letterSpacing: 0.4, textTransform: 'uppercase' }}>{s.label}</span>
                    <InfoIcon defKey={s.k} active={defKey === s.k} onToggle={toggleDef} />
                  </div>
                  <span style={{ ...FM, fontSize: 14, color: C.text }}>{s.val}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 18 }} className="bm-detail-grid">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>TIER CHECKLIST · {checklist.title}</span>
                    <InfoIcon defKey="checks" active={defKey === 'checks'} onToggle={toggleDef} />
                  </div>
                  {checklist.rows.map((r, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 70px 44px', gap: 8, padding: '6px 0', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12 }}>
                      <span style={{ color: '#C9CFC8' }}>{r.label}</span>
                      <span style={{ textAlign: 'right' }}>{r.value}</span>
                      <span style={{ fontWeight: 700, color: r.pass ? C.green : C.warn }}>{r.pass ? 'Pass' : 'Miss'}</span>
                    </div>
                  ))}
                </div>

                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>HOW THE VOTE BREAKS</span>
                    <InfoIcon defKey="vs" active={defKey === 'vs'} onToggle={toggleDef} />
                  </div>
                  <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(signal.vote_share * 100).toFixed(1)}%`, background: C.green }} />
                    <div style={{ height: '100%', width: `${((1 - signal.vote_share) * 100).toFixed(1)}%`, background: C.warn }} />
                  </div>
                  <div style={{ ...FM, fontSize: 11, color: C.green }}>{pickAbbr} {teamLine(signal.vegas_line, signal.pick_side)} · {(signal.vote_share * 100).toFixed(1)}% of weight · {onCount} systems</div>
                  <div style={{ ...FM, fontSize: 11, color: C.warn }}>{signal.pick_side === 'home' ? awayAbbr : homeAbbr} · {((1 - signal.vote_share) * 100).toFixed(1)}% · {signal.voters - onCount} systems</div>
                </div>

                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>NOTES</label>
                  <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Injuries, weather, line shopping, why you played it or passed…" style={{ ...FM, fontSize: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, padding: 10, resize: 'vertical' }} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={handleSaveNote} disabled={savingNote || !note.trim()} style={{ ...FM, fontSize: 12, minHeight: 36, padding: '0 14px', borderRadius: 4, border: `1px solid ${C.gold}`, background: `${C.gold}1A`, color: C.gold, cursor: 'pointer' }}>
                      {savingNote ? 'Saving…' : 'Save note'}
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>INDIVIDUAL BREAKDOWN · {signal.voters} VOTING SYSTEMS</span>
                  <InfoIcon defKey="weight" active={defKey === 'weight'} onToggle={toggleDef} />
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px 54px 130px 60px', gap: 10, padding: '7px 14px', background: C.surface2, ...FM, fontSize: 10, color: C.sub, letterSpacing: 0.4, minWidth: 480 }}>
                    <span>SYSTEM</span><span>PREDICTS</span><span>SIDE</span><span>WEIGHT</span><span>2026 ATS</span>
                  </div>
                  {systemRows.map((m, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px 54px 130px 60px', gap: 10, alignItems: 'center', padding: '7px 14px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12, minWidth: 480 }}>
                      <span style={{ ...FH, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                      <span style={{ color: '#C9CFC8' }}>{m.pred}</span>
                      <span style={{ fontWeight: 700, color: m.on ? C.green : C.warn }}>{m.side}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flexGrow: 1, height: 6, background: C.bg, borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, (m.share / 16) * 100)}%`, background: m.on ? C.green : C.warn }} />
                        </div>
                        <span style={{ width: 44, textAlign: 'right', color: '#C9CFC8' }}>{m.share.toFixed(1)}%</span>
                      </div>
                      <span style={{ color: C.sub }}>{m.rec}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        {expanded && !signal && (
          <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface2, padding: 16, ...FM, fontSize: 12, color: C.sub }}>No Bobby Model data for this game yet — run Compute for this week on the Ingest page.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My card modal (This week / Season stats)
// ---------------------------------------------------------------------------
function MyCardModal({ initialTab, season, rows, picksByGame, onClose }) {
  const [tab, setTab] = useState(initialTab || 'week');
  const [detail, setDetail] = useState(null); // { who: 'bm'|'me', wk }
  const [seasonData, setSeasonData] = useState(null);
  const [loadingSeason, setLoadingSeason] = useState(false);

  useEffect(() => {
    if (tab !== 'season' || seasonData) return;
    let cancelled = false;
    (async () => {
      setLoadingSeason(true);
      try {
        const signals = await sbFetchAll(`cfb_game_signals?select=id,week,tier,units,edge,pick_side,vegas_line,game_id,games(home_team,away_team,home_score,away_score,actual_margin)&season=eq.${season}&order=week.asc`);
        const ids = signals.map((s) => s.id);
        let grades = [];
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          if (!chunk.length) continue;
          const rows2 = await sbFetch(`cfb_signal_grades?select=*&signal_id=in.(${chunk.join(',')})`);
          grades = grades.concat(rows2);
        }
        const gradeBySignal = {};
        for (const g of grades) gradeBySignal[g.signal_id] = g;
        const bm = signals.map((s) => {
          const gr = gradeBySignal[s.id];
          return {
            wk: s.week, tier: s.tier, units: s.units,
            pick: `${s.pick_side === 'home' ? s.games?.home_team : s.games?.away_team} ${teamLine(s.vegas_line, s.pick_side)}`,
            final: s.games ? `${s.games.away_team} ${s.games.home_score != null ? `${s.games.away_score ?? ''} – ${s.games.home_score ?? ''}` : ''} ${s.games.home_team}`.replace(/\s+/g, ' ').trim() : '—',
            res: gr ? (gr.ats_result === 'push' ? 'P' : gr.ats_result === 'win' ? 'W' : 'L') : null,
            unitsPl: gr ? parseFloat(gr.units_pl) || 0 : 0,
            graded: !!gr,
          };
        });

        const picks = await sbFetch(`user_picks?select=*,games(home_team,away_team,home_score,away_score)&season=eq.${season}&status=eq.official&is_custom=eq.false&side=not.is.null&order=week.asc`);
        const me = picks.map((p) => {
          const g = p.games;
          const team = p.side === 'home' ? g?.home_team : g?.away_team;
          const pickTxt = p.pick_type === 'total' ? `${p.side === 'over' ? 'Over' : 'Under'} ${p.line_played ?? ''}` : `${team || ''} ${teamLine(p.line_played, p.side)}`;
          const u = parseFloat(p.units) || 0;
          const net = p.result === 'win' ? u : p.result === 'loss' ? -1.1 * u : 0;
          return {
            wk: p.week, u, lock: !!p.is_lock,
            pick: pickTxt, final: g ? `${g.away_team} ${g.home_score != null ? `${g.away_score ?? ''} – ${g.home_score ?? ''}` : ''} ${g.home_team}`.replace(/\s+/g, ' ').trim() : '—',
            res: p.result === 'push' ? 'P' : p.result === 'win' ? 'W' : p.result === 'loss' ? 'L' : null,
            unitsPl: net, graded: !!p.result,
          };
        });

        if (!cancelled) setSeasonData({ bm, me });
      } catch (e) { console.error(e); }
      finally { if (!cancelled) setLoadingSeason(false); }
    })();
    return () => { cancelled = true; };
  }, [tab, season, seasonData]);

  const entries = rows.map((r) => ({ r, plays: picksByGame[r.game.id] || [] })).filter((e) => e.plays.length > 0);
  const totalUnits = entries.flatMap((e) => e.plays).reduce((s, p) => s + (parseFloat(p.units) || 0), 0);

  function agg(list) {
    const decided = list.filter((x) => x.graded);
    const t = tally(decided.map((x) => x.res === 'P' ? 'push' : x.res === 'W' ? 'win' : 'loss'));
    const u = decided.reduce((a, x) => a + x.unitsPl, 0);
    return { rec: recordStr(t), u, ut: fmtU(u) };
  }

  const bmUnitPlays = seasonData ? seasonData.bm.filter((x) => x.tier !== 'Lean' && x.tier !== 'No tier') : [];
  const bmLeans = seasonData ? seasonData.bm.filter((x) => x.tier === 'Lean') : [];
  const meOfficial = seasonData ? seasonData.me : [];

  const weeks = seasonData ? Array.from(new Set(seasonData.bm.map((x) => x.wk).concat(seasonData.me.map((x) => x.wk)))).sort((a, b) => a - b) : [];

  const tabBtn = (active) => ({ ...FM, fontSize: 12, background: 'none', border: 'none', minHeight: 40, padding: '0 14px', cursor: 'pointer', borderBottom: `2px solid ${active ? C.gold : 'transparent'}`, color: active ? C.gold : C.sub, fontWeight: active ? 700 : 400 });

  return (
    <Modal title="My card" onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        <button style={tabBtn(tab === 'week')} onClick={() => { setTab('week'); setDetail(null); }}>This week</button>
        <button style={tabBtn(tab === 'season')} onClick={() => { setTab('season'); setDetail(null); }}>Season stats</button>
      </div>

      {tab === 'week' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ ...FM, fontSize: 12, color: C.sub }}>{entries.length} games · {entries.reduce((n, e) => n + e.plays.length, 0)} plays · {totalUnits.toFixed(1)}u total exposure</div>
          {entries.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub }}>No plays logged yet — use "+ Bobby Pick" on any game card.</div>}
          {entries.map(({ r, plays }) => {
            const home = r.game.home_team, away = r.game.away_team;
            const sig = r.signal;
            return (
              <div key={r.game.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{away} @ {home}</span>
                  <span style={{ ...FM, fontSize: 11, color: C.sub }}>{fmtKickoff(r.game.kickoff_at)}{r.game.tv_network ? ` · ${r.game.tv_network}` : ''}</span>
                </div>
                {plays.map((p) => {
                  const agrees = sig && sig.pick_side === p.side;
                  return (
                    <div key={p.id} style={{ ...FM, fontSize: 12.5, display: 'flex', gap: 10 }}>
                      <span style={{ color: C.green }}>{parseFloat(p.units) || 1}u</span>
                      <span>{p.side === 'home' ? home : away} {teamLine(p.line_played, p.side)}</span>
                      <span style={{ color: C.sub }}>· {sig ? `Bobby Model ${sig.tier} · ${agrees ? 'agrees' : 'disagrees'}` : 'no Bobby Model signal'}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'season' && !detail && (
        loadingSeason || !seasonData ? <div style={{ ...FM, fontSize: 12, color: C.sub }}>Loading…</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 10 }}>
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderTop: `3px solid ${C.gold}`, borderRadius: 6, padding: 12 }}>
                <div style={{ ...FM, fontSize: 10, color: C.sub }}>THE BOBBY MODEL · UNIT PLAYS</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{agg(bmUnitPlays).rec} <span style={{ fontSize: 15, color: uColor(agg(bmUnitPlays).u) }}>({agg(bmUnitPlays).ut})</span></div>
                <div style={{ ...FM, fontSize: 11, color: C.sub }}>3U + 2U + 1U, paper units at −110</div>
              </div>
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderTop: `3px solid ${C.sub}`, borderRadius: 6, padding: 12 }}>
                <div style={{ ...FM, fontSize: 10, color: C.sub }}>THE BOBBY MODEL · LEANS</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{agg(bmLeans).rec}</div>
                <div style={{ ...FM, fontSize: 11, color: C.sub }}>ATS only, no units</div>
              </div>
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderTop: `3px solid ${C.blue}`, borderRadius: 6, padding: 12 }}>
                <div style={{ ...FM, fontSize: 10, color: C.sub }}>MY PICKS · OFFICIAL</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{agg(meOfficial).rec} <span style={{ fontSize: 15, color: uColor(agg(meOfficial).u) }}>({agg(meOfficial).ut})</span></div>
                <div style={{ ...FM, fontSize: 11, color: C.sub }}>real units at −110</div>
              </div>
            </div>

            <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '70px minmax(0,1fr) 40px minmax(0,1fr) 40px', gap: 10, padding: '8px 14px', background: C.surface2, ...FM, fontSize: 10.5, color: C.sub }}>
                <span>WEEK</span><span>THE BOBBY MODEL</span><span></span><span>MY PICKS</span><span></span>
              </div>
              {weeks.map((wk) => {
                const bmW = bmUnitPlays.filter((x) => x.wk === wk);
                const meW = meOfficial.filter((x) => x.wk === wk);
                const bmA = agg(bmW), meA = agg(meW);
                return (
                  <div key={wk} style={{ display: 'grid', gridTemplateColumns: '70px minmax(0,1fr) 40px minmax(0,1fr) 40px', gap: 10, alignItems: 'center', padding: '6px 14px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12.5 }}>
                    <span>Week {wk}</span>
                    <span>{bmW.length ? `${bmA.rec} (${bmA.ut})` : '—'}</span>
                    <button onClick={() => setDetail({ who: 'bm', wk })} aria-label="Show THE Bobby Model plays for this week" style={{ width: 30, height: 30, borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>☰</button>
                    <span>{meW.length ? `${meA.rec} (${meA.ut})` : '—'}</span>
                    <button onClick={() => setDetail({ who: 'me', wk })} aria-label="Show my plays for this week" style={{ width: 30, height: 30, borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.blue, cursor: 'pointer' }}>☰</button>
                  </div>
                );
              })}
              <div style={{ display: 'grid', gridTemplateColumns: '70px minmax(0,1fr) 40px minmax(0,1fr) 40px', gap: 10, alignItems: 'center', padding: '12px 14px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12.5, fontWeight: 700, background: C.surface2 }}>
                <span>Season</span><span>{agg(bmUnitPlays).rec} ({agg(bmUnitPlays).ut})</span><span></span><span>{agg(meOfficial).rec} ({agg(meOfficial).ut})</span><span></span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 10 }} className="bm-detail-grid">
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 14px' }}>
                <div style={{ ...FM, fontSize: 10, color: C.sub, marginBottom: 4 }}>THE BOBBY MODEL BY UNIT SIZE</div>
                {['3U', '2U', '1U', 'Lean'].map((t) => {
                  const list = seasonData.bm.filter((x) => x.tier === t);
                  const decided = list.filter((x) => x.graded && x.res !== null);
                  const a = tally(decided.map((x) => x.res === 'P' ? 'push' : x.res === 'W' ? 'win' : 'loss'));
                  const u = decided.reduce((s, x) => s + x.unitsPl, 0);
                  const wins = a.wins, dec = a.wins + a.losses;
                  const pct = dec ? `${((wins / dec) * 100).toFixed(1)}%` : '—';
                  return (
                    <div key={t} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0,1fr) 90px 58px', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12.5 }}>
                      <TierBadge tier={t} small /><span>{recordStr(a)}</span><span style={{ color: t === 'Lean' ? C.sub : uColor(u) }}>{t === 'Lean' ? 'ATS only' : fmtU(u)}</span><span style={{ color: C.sub, textAlign: 'right' }}>{pct}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 14px' }}>
                <div style={{ ...FM, fontSize: 10, color: C.sub, marginBottom: 4 }}>MY PICKS BY UNIT SIZE</div>
                {[['1u plays', (x) => x.u === 1], ['2u plays', (x) => x.u === 2], ['Locks', (x) => x.lock]].map(([label, f]) => {
                  const list = meOfficial.filter(f);
                  const decided = list.filter((x) => x.graded);
                  const a = tally(decided.map((x) => x.res === 'P' ? 'push' : x.res === 'W' ? 'win' : 'loss'));
                  const u = decided.reduce((s, x) => s + x.unitsPl, 0);
                  return (
                    <div key={label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 60px 70px', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12.5 }}>
                      <span style={{ color: '#C9CFC8' }}>{label}</span><span>{recordStr(a)}</span><span style={{ color: uColor(u) }}>{fmtU(u)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )
      )}

      {tab === 'season' && detail && seasonData && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setDetail(null)} style={{ ...FM, fontSize: 12, minHeight: 36, padding: '0 12px', borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>← Season stats</button>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Week {detail.wk} · {detail.who === 'bm' ? 'THE Bobby Model plays' : 'My picks'}</div>
            </div>
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) minmax(0,1.3fr) 44px 80px', gap: 10, padding: '8px 14px', background: C.surface2, ...FM, fontSize: 10.5, color: C.sub }}>
              <span>PLAY</span><span>PICK</span><span>FINAL</span><span>W/L</span><span>UNITS</span>
            </div>
            {(detail.who === 'bm' ? seasonData.bm.filter((x) => x.wk === detail.wk) : seasonData.me.filter((x) => x.wk === detail.wk)).map((r, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) minmax(0,1.3fr) 44px 80px', gap: 10, alignItems: 'center', padding: '7px 14px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12 }}>
                <span>{detail.who === 'bm' ? <TierBadge tier={r.tier} small /> : (r.lock ? <span style={{ color: C.gold, fontWeight: 700 }}>{r.u}u · L</span> : <span>{r.u}u</span>)}</span>
                <span style={{ color: C.text }}>{r.pick}</span>
                <span style={{ color: '#C9CFC8' }}>{r.final}</span>
                <span style={{ fontWeight: 700, color: r.res === 'W' ? C.green : r.res === 'L' ? C.warn : C.sub }}>{r.res || 'PEND'}</span>
                <span style={{ fontWeight: 700, color: uColor(r.unitsPl) }}>{r.graded ? (r.tier === 'Lean' ? 'Lean' : fmtU(r.unitsPl)) : 'not counted'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------------
const SORTS = [
  { v: 'rank', label: 'Bobby Rank', short: 'Rank' },
  { v: 'conv', label: 'Conviction', short: 'Conv' },
  { v: 'vs', label: 'Vote share', short: 'Vote' },
  { v: 'edge', label: 'Edge', short: 'Edge' },
  { v: 'sd', label: 'Std dev (tightest)', short: 'STD' },
  { v: 'tier', label: 'Tier', short: 'Tier' },
  { v: 'time', label: 'Game time', short: 'Time' },
  { v: 'team', label: 'Team', short: 'Team' },
];

// Search field: 16px on mobile so iOS doesn't zoom, search keyboard, blurs on
// Enter/Go so the keyboard drops and the results are visible, own clear button.
function SearchField({ value, onChange, style }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', ...style }}>
      <input
        type="text"
        inputMode="search"
        enterKeyHint="search"
        aria-label="Search team"
        placeholder="Search team…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        className="bm-input"
        style={{
          ...FM, width: '100%', minWidth: 0, minHeight: 44, background: C.surface,
          border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: '0 42px 0 12px',
        }}
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{
            position: 'absolute', right: 2, width: 40, height: 40, border: 'none', background: 'transparent',
            color: C.sub, cursor: 'pointer', fontSize: 18, lineHeight: 1, borderRadius: 6,
          }}
        >×</button>
      )}
    </div>
  );
}

export default function BobbyModelDashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const [rows, setRows] = useState([]);
  const [config, setConfig] = useState({});
  const [weightsByModel, setWeightsByModel] = useState({});
  const [predsByGame, setPredsByGame] = useState({});
  const [logos, setLogos] = useState({});
  const [totalSystems, setTotalSystems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [expandedId, setExpandedId] = useState(null);
  // Unit / Lean summary cards are the tier filter now — multi-select, empty
  // array means "all games".
  const [tierSel, setTierSel] = useState([]);
  const [flagsOnly, setFlagsOnly] = useState(false);
  const [minePlusOnly, setMinePlusOnly] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');
  const [sortBy, setSortBy] = useState('rank');
  const [sheetOpen, setSheetOpen] = useState(false);

  const [picksByGame, setPicksByGame] = useState({});
  const [researchByGame, setResearchByGame] = useState({});
  const [pickModal, setPickModal] = useState(null);
  const [researchModalRow, setResearchModalRow] = useState(null);
  const [showLegend, setShowLegend] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [cardTab, setCardTab] = useState('week');
  const [headerTip, setHeaderTip] = useState(null);

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
      const [games, signals, weights, logoRows, cfgRows] = await Promise.all([
        sbFetch(`games?select=id,home_team,away_team,kickoff_at,current_line,opening_line,over_under,tv_network,status&season=eq.${season}&week=eq.${week}`),
        sbFetch(`cfb_game_signals?select=*&season=eq.${season}&week=eq.${week}`),
        sbFetch(`cfb_system_weights?select=model_id,weight,wins,losses,pushes,source_models(system_name,colname)&season=eq.${season}&as_of_week=eq.${week}&weight=gt.0`),
        sbFetch(`team_logos?select=team_name,logo_url`),
        sbFetch(`cfb_tracker_config?select=key,value`),
      ]);

      const cfg = {};
      for (const r of cfgRows) cfg[r.key] = parseFloat(r.value);
      setConfig(cfg);

      const wMap = {};
      for (const w of weights) wMap[w.model_id] = { weight: parseFloat(w.weight), wins: w.wins, losses: w.losses, pushes: w.pushes, system_name: w.source_models?.system_name || 'Unknown' };
      setWeightsByModel(wMap);

      sbFetch(`cfb_system_weights?select=model_id&season=eq.${season}&as_of_week=eq.${week}`)
        .then((allW) => setTotalSystems(allW.length))
        .catch(() => setTotalSystems(null));

      const signalByGame = {};
      for (const s of signals) signalByGame[s.game_id] = { ...s, edge: parseFloat(s.edge), vegas_line: parseFloat(s.vegas_line), opening_line: s.opening_line != null ? parseFloat(s.opening_line) : null, consensus: parseFloat(s.consensus), vote_share: parseFloat(s.vote_share), std_dev: parseFloat(s.std_dev), conviction: parseFloat(s.conviction) };

      const built = games.map((game) => ({ game, signal: signalByGame[game.id] || null }));
      built.sort((a, b) => (b.signal?.conviction ?? -1) - (a.signal?.conviction ?? -1));
      setRows(built);

      const logoMap = {};
      for (const l of logoRows) logoMap[l.team_name] = l.logo_url;
      setLogos(logoMap);

      if (games.length && weights.length) {
        const voterIds = weights.map((w) => w.model_id);
        const idList = voterIds.join(',');
        const preds = await sbFetchAll(`raw_predictions?select=game_id,model_id,predicted_margin&season=eq.${season}&week=eq.${week}&model_id=in.(${idList})`);
        const byGame = {};
        for (const p of preds) { if (!byGame[p.game_id]) byGame[p.game_id] = []; byGame[p.game_id].push(p); }
        setPredsByGame(byGame);
      } else {
        setPredsByGame({});
      }

      if (games.length) {
        const ids = games.map((g) => g.id).join(',');
        try {
          const picks = await sbFetch(`user_picks?select=*&game_id=in.(${ids})&status=eq.official&is_custom=eq.false&side=not.is.null&order=created_at.asc`);
          const grouped = {};
          for (const p of picks) { if (!grouped[p.game_id]) grouped[p.game_id] = []; grouped[p.game_id].push(p); }
          setPicksByGame(grouped);
        } catch (e) { console.error(e); setPicksByGame({}); }
        try {
          const research = await sbFetch(`research_picks?select=*&game_id=in.(${ids})&order=created_at.asc`);
          const grouped = {};
          for (const r of research) { if (!grouped[r.game_id]) grouped[r.game_id] = []; grouped[r.game_id].push(r); }
          setResearchByGame(grouped);
        } catch (e) { console.error(e); setResearchByGame({}); }
      } else {
        setPicksByGame({}); setResearchByGame({});
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (week != null) loadWeek(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [season, week]);

  async function savePick(gameId, signal, data) {
    const existing = pickModal?.existing;
    if (existing) {
      const [updated] = await sbFetch(`user_picks?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }) });
      setPicksByGame((prev) => ({ ...prev, [gameId]: (prev[gameId] || []).map((p) => p.id === existing.id ? updated : p) }));
    } else {
      const [created] = await sbFetch(`user_picks`, { method: 'POST', body: JSON.stringify({ game_id: gameId, season, week, played: true, status: 'official', ...data }) });
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
    const [created] = await sbFetch(`research_picks`, { method: 'POST', body: JSON.stringify({ game_id: gameId, season, week, home_team: home, away_team: away, ...data }) });
    setResearchByGame((prev) => ({ ...prev, [gameId]: [...(prev[gameId] || []), created] }));
    setResearchModalRow(null);
  }
  async function removeResearchPick(gameId, id) {
    await sbFetch(`research_picks?id=eq.${id}`, { method: 'DELETE' });
    setResearchByGame((prev) => ({ ...prev, [gameId]: (prev[gameId] || []).filter((r) => r.id !== id) }));
  }
  // A standalone note is stored as an un-played, non-graded user_picks row
  // (is_custom=true, custom_type='other') so /api/grade skips it and it
  // never counts toward record/units.
  async function saveNote(gameId, text) {
    await sbFetch(`user_picks`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gameId, season, week, played: false, status: 'official', pick_type: 'spread', is_custom: true, custom_type: 'other', custom_label: 'Note', note: text }),
    });
  }

  // Bobby Rank is attached here — over every game on the board, before any
  // search, filter or sort. Each game carries its own rank from this point on.
  const rankedRows = useMemo(() => attachBobbyRank(rows, config), [rows, config]);

  // Counts are always over the full week so the unit cards never collapse to
  // zero while a filter is on.
  const counts = useMemo(() => {
    const c = { All: rows.length, '3U': 0, '2U': 0, '1U': 0, Lean: 0, 'No tier': 0 };
    for (const r of rows) { const t = r.signal?.tier || 'No tier'; c[t] = (c[t] || 0) + 1; }
    return c;
  }, [rows]);

  const displayed = useMemo(() => {
    let list = rankedRows.filter((r) => {
      const t = r.signal?.tier || 'No tier';
      if (tierSel.length && !tierSel.includes(t)) return false;
      if (flagsOnly && !(r.signal?.flags?.length > 0)) return false;
      if (minePlusOnly && (picksByGame[r.game.id] || []).length === 0) return false;
      if (teamSearch.trim()) {
        const q = teamSearch.trim().toLowerCase();
        // Matches the full name and the short one, so "Jacksonville" still
        // finds a card that is displaying "Jax State".
        const hay = `${teamSearchText(r.game.home_team)} ${teamSearchText(r.game.away_team)}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const TR = { '3U': 0, '2U': 1, '1U': 2, Lean: 3, 'No tier': 4 };
    const sorters = {
      rank: (a, b) => a.bobbyRank - b.bobbyRank,
      conv: (a, b) => (b.signal?.conviction ?? -1) - (a.signal?.conviction ?? -1) || (b.signal?.vote_share ?? -1) - (a.signal?.vote_share ?? -1),
      vs: (a, b) => (b.signal?.vote_share ?? -1) - (a.signal?.vote_share ?? -1),
      edge: (a, b) => Math.abs(b.signal?.edge ?? 0) - Math.abs(a.signal?.edge ?? 0),
      sd: (a, b) => (a.signal?.std_dev ?? 999) - (b.signal?.std_dev ?? 999),
      tier: (a, b) => TR[a.signal?.tier || 'No tier'] - TR[b.signal?.tier || 'No tier'],
      time: (a, b) => new Date(a.game.kickoff_at || 0) - new Date(b.game.kickoff_at || 0),
      team: (a, b) => a.game.away_team.localeCompare(b.game.away_team),
    };
    list = [...list].sort(sorters[sortBy] || sorters.rank);
    return list;
  }, [rankedRows, tierSel, flagsOnly, minePlusOnly, teamSearch, sortBy, picksByGame]);

  const toggleTier = (t) => setTierSel((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);

  // Active filters, surfaced as removable chips under the sticky row.
  const activeChips = [
    ...tierSel.map((t) => ({ key: `tier-${t}`, label: t, color: TIER_COLOR[t], clear: () => toggleTier(t) })),
    ...(flagsOnly ? [{ key: 'flags', label: 'Flags', color: C.warn, clear: () => setFlagsOnly(false) }] : []),
    ...(minePlusOnly ? [{ key: 'mine', label: 'My picks only', color: C.blue, clear: () => setMinePlusOnly(false) }] : []),
    ...(teamSearch.trim() ? [{ key: 'search', label: `"${teamSearch.trim()}"`, color: C.gold, clear: () => setTeamSearch('') }] : []),
  ];
  const activeCount = activeChips.length;
  function resetFilters() {
    setTierSel([]); setFlagsOnly(false); setMinePlusOnly(false); setTeamSearch('');
  }

  const votingCount = Object.keys(weightsByModel).length;
  const myPlaysThisWeek = Object.values(picksByGame).reduce((n, arr) => n + arr.length, 0);

  const chipStyle = (active, color) => ({
    ...FM, fontSize: 13, minHeight: 44, padding: '0 14px', borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${active ? color : C.border}`, background: active ? `${color}1A` : 'transparent', color: active ? color : C.sub,
  });
  const selectStyle = {
    ...FM, minHeight: 44, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
    color: C.text, padding: '0 8px', cursor: 'pointer', maxWidth: '100%',
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '24px 16px', color: C.text }} className="bm-page">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;700&display=swap');
        select option { background: ${C.surface}; }
        .bm-page { -webkit-text-size-adjust: 100%; }
        .bm-team { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        /* Widths here must not depend on the text inside, or the fit test would
           oscillate: one nowrap row on desktop, a full-width column on mobile. */
        .bm-match-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: nowrap; }
        .bm-rank { width: 34px; }
        .bm-badge { min-height: 28px; padding: 0 9px; }
        .bm-badge-tap { min-height: 32px; }
        .bm-badge-x { width: 22px; height: 22px; }
        .bm-info { width: 26px; height: 26px; }
        .bm-input { font-size: 14px; }
        .bm-only-mobile { display: none; }
        @media (max-width: 767px) {
          .bm-only-mobile { display: flex; }
          .bm-only-desktop { display: none !important; }
          /* iOS zooms any field under 16px on focus. */
          input, select, textarea, .bm-input { font-size: 16px !important; }
          .bm-rank { width: 26px; }
          .bm-badge, .bm-badge-tap { min-height: 44px; padding: 0 10px; font-size: 12px; }
          .bm-badge-x { width: 32px; height: 32px; }
          .bm-info { width: 44px; height: 44px; }
          .bm-match-row { flex-direction: column; align-items: stretch; gap: 6px; }
          .bm-match-meta { flex-wrap: wrap; }
          .bm-tier-strip { gap: 6px !important; }
          .bm-tier-strip > button { padding: 8px 6px !important; }
          .bm-tier-count { font-size: 20px !important; }
          .bm-tier-sub { display: none !important; }
          .bm-stat-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .bm-detail-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        {showLegend && <LegendModal onClose={() => setShowLegend(false)} />}
        {showCard && <MyCardModal initialTab={cardTab} season={season} rows={rows} picksByGame={picksByGame} onClose={() => setShowCard(false)} />}
        {pickModal && (
          <PickModal
            game={pickModal.row.game} signal={pickModal.row.signal} existing={pickModal.existing}
            onClose={() => setPickModal(null)}
            onSaved={(data) => savePick(pickModal.row.game.id, pickModal.row.signal, data)}
            onDeleted={() => deletePick(pickModal.row.game.id)}
          />
        )}
        {researchModalRow && (
          <ResearchPickModal
            game={researchModalRow.game} onClose={() => setResearchModalRow(null)}
            onSaved={(data) => saveResearchPick(researchModalRow.game.id, researchModalRow.game.home_team, researchModalRow.game.away_team, data)}
          />
        )}

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ ...FM, fontSize: 11, color: C.sub, letterSpacing: 1 }}>BOBBYMODELS · CFB</div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: -0.3 }}>THE Bobby Model</h1>
            <div style={{ ...FM, fontSize: 12, color: C.sub, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label htmlFor="season">Season</label>
              <input id="season" type="number" value={season} onChange={(e) => setSeason(parseInt(e.target.value) || season)} style={{ ...FM, fontSize: 12, width: 72, minHeight: 32, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, padding: '0 8px' }} />
              <label htmlFor="week">Week</label>
              <input id="week" type="number" value={week ?? ''} onChange={(e) => setWeek(parseInt(e.target.value) || week)} style={{ ...FM, fontSize: 12, width: 52, minHeight: 32, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, padding: '0 8px' }} />
              <span style={{ padding: '5px 10px', border: `1px solid ${C.border}`, borderRadius: 4, background: C.surface, display: 'flex', alignItems: 'center', gap: 4 }}>
                Weights as of Week {week} · {votingCount} of {totalSystems ?? '—'} systems voting
                <InfoIcon defKey="weight" active={headerTip === 'weight'} onToggle={(k) => setHeaderTip((p) => p === k ? null : k)} />
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setShowLegend(true)} style={{ ...FM, fontSize: 12, minHeight: 40, padding: '0 14px', borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>? How to use</button>
            <button onClick={() => { setCardTab('season'); setShowCard(true); }} style={{ ...FM, fontSize: 12, minHeight: 40, padding: '0 14px', borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>Season stats</button>
            <button onClick={() => { setCardTab('week'); setShowCard(true); }} style={{ ...FM, fontSize: 12, fontWeight: 700, minHeight: 40, padding: '0 16px', borderRadius: 4, border: `1px solid ${C.gold}`, background: `${C.gold}1A`, color: C.gold, cursor: 'pointer' }}>My card · {myPlaysThisWeek} plays</button>
          </div>
        </div>
        {headerTip && (
          <div style={{ background: C.surface2, border: `1px solid ${C.gold}`, borderRadius: 8, padding: '14px 16px', marginBottom: 16, display: 'flex', gap: 12 }}>
            <div style={{ flexGrow: 1 }}>
              <div style={{ ...FH, fontWeight: 700, fontSize: 14, color: C.gold, marginBottom: 4 }}>{DEFINITIONS[headerTip][0]}</div>
              <div style={{ ...FM, fontSize: 12.5, color: '#C9CFC8' }}>{DEFINITIONS[headerTip][1]}</div>
            </div>
            <button onClick={() => setHeaderTip(null)} style={{ width: 28, height: 28, borderRadius: 4, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>✕</button>
          </div>
        )}

        {/* Unit / Lean summary cards — also the tier filter. Multi-select;
            none selected means every game. Counts are for the full week. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12, marginBottom: 12 }} className="bm-tier-strip">
          {TIER_ORDER.filter((t) => t !== 'No tier').map((t) => {
            const on = tierSel.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTier(t)}
                aria-pressed={on}
                aria-label={`${t} — ${counts[t] || 0} this week${on ? ', filter on' : ''}`}
                style={{
                  textAlign: 'left', cursor: 'pointer', minHeight: 44, color: C.text,
                  background: on ? `${TIER_COLOR[t]}1F` : C.surface,
                  border: `${on ? 2 : 1}px solid ${on ? TIER_COLOR[t] : C.border}`,
                  borderTop: `3px solid ${TIER_COLOR[t]}`,
                  borderRadius: 6, padding: '10px 14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span style={{ color: TIER_COLOR[t], fontWeight: 700, ...FM, fontSize: 12 }}>{t}</span>
                  <span style={{ ...FM, fontSize: 12, fontWeight: 700, color: on ? TIER_COLOR[t] : C.sub }}>{on ? '✓' : '+'}</span>
                </div>
                <div className="bm-tier-count" style={{ fontSize: 26, fontWeight: 700 }}>
                  {counts[t] || 0} <span className="bm-tier-sub" style={{ fontSize: 12, fontWeight: 400, color: C.sub }}>this week</span>
                </div>
              </button>
            );
          })}
        </div>

        {error && <div style={{ ...FM, fontSize: 12, color: C.warn, background: `${C.warn}14`, border: `1px solid ${C.warn}`, borderRadius: 4, padding: '10px 14px', marginBottom: 16 }}>{error}</div>}

        {!loading && !error && (
          <>
            {/* Desktop filter row */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }} className="bm-only-desktop">
              <button onClick={() => setFlagsOnly((v) => !v)} style={chipStyle(flagsOnly, C.warn)}>Flags</button>
              <button onClick={() => setMinePlusOnly((v) => !v)} style={chipStyle(minePlusOnly, C.blue)}>My picks only</button>
              <SearchField value={teamSearch} onChange={setTeamSearch} style={{ width: 200 }} />
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="sort" style={{ ...FM, fontSize: 12, color: C.sub }}>Sort</label>
                <select id="sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...selectStyle, fontSize: 13, padding: '0 10px' }}>
                  {SORTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                </select>
                <InfoIcon defKey="rank" active={headerTip === 'rank'} onToggle={(k) => setHeaderTip((p) => p === k ? null : k)} />
              </div>
            </div>

            {/* Mobile: one compact sticky row — search, Filters, sort */}
            <div
              className="bm-only-mobile"
              style={{
                position: 'sticky', top: 0, zIndex: 60, gap: 8, alignItems: 'center',
                background: C.bg, margin: '0 -16px', borderBottom: `1px solid ${C.border}`,
                padding: 'calc(8px + env(safe-area-inset-top)) 16px 8px',
              }}
            >
              <SearchField value={teamSearch} onChange={setTeamSearch} style={{ flex: '1 1 auto', minWidth: 0 }} />
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                style={{ ...chipStyle(activeCount > 0, C.gold), flexShrink: 0, whiteSpace: 'nowrap', padding: '0 12px' }}
              >
                Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
              </button>
              <select
                aria-label="Sort board"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{ ...selectStyle, flexShrink: 0, width: 88 }}
              >
                {SORTS.map((s) => <option key={s.v} value={s.v}>{s.short}</option>)}
              </select>
            </div>

            {/* Active filters, removable without opening the sheet */}
            {activeCount > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 0 2px' }}>
                {activeChips.map((c) => (
                  <Badge key={c.key} as="button" onClick={c.clear} color={c.color} filled className="bm-badge-tap" aria-label={`Remove filter ${c.label}`}>
                    {c.label}<span style={{ marginLeft: 4, fontSize: 14 }}>×</span>
                  </Badge>
                ))}
                <button onClick={resetFilters} style={{ ...FM, fontSize: 12, minHeight: 32, padding: '0 10px', borderRadius: 6, border: 'none', background: 'transparent', color: C.sub, cursor: 'pointer', textDecoration: 'underline' }}>Clear all</button>
              </div>
            )}

            {sheetOpen && (
              <BottomSheet
                title="Filters"
                onClose={() => setSheetOpen(false)}
                footer={(
                  <>
                    <button onClick={resetFilters} style={{ flex: 1, ...FM, fontSize: 14, minHeight: 48, borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}>Reset</button>
                    <button onClick={() => setSheetOpen(false)} style={{ flex: 2, ...FM, fontSize: 14, fontWeight: 700, minHeight: 48, borderRadius: 8, border: 'none', background: C.gold, color: '#0F1412', cursor: 'pointer' }}>Done</button>
                  </>
                )}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ ...FM, fontSize: 11, color: C.sub, letterSpacing: 0.5, textTransform: 'uppercase' }}>Game flags</span>
                  <button onClick={() => setFlagsOnly((v) => !v)} style={{ ...chipStyle(flagsOnly, C.warn), minHeight: 48, width: '100%', textAlign: 'left' }}>
                    {flagsOnly ? '✓ ' : ''}Flagged games only
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ ...FM, fontSize: 11, color: C.sub, letterSpacing: 0.5, textTransform: 'uppercase' }}>My plays</span>
                  <button onClick={() => setMinePlusOnly((v) => !v)} style={{ ...chipStyle(minePlusOnly, C.blue), minHeight: 48, width: '100%', textAlign: 'left' }}>
                    {minePlusOnly ? '✓ ' : ''}Games I have logged a pick on
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label htmlFor="sheet-sort" style={{ ...FM, fontSize: 11, color: C.sub, letterSpacing: 0.5, textTransform: 'uppercase' }}>Sort by</label>
                  <select id="sheet-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...selectStyle, minHeight: 48, width: '100%', padding: '0 12px' }}>
                    {SORTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                  </select>
                </div>
                <div style={{ ...FM, fontSize: 12, color: C.sub, lineHeight: 1.5 }}>
                  Tiers are filtered with the 3U / 2U / 1U / Lean cards above the board — tap to add, tap again to remove.
                </div>
              </BottomSheet>
            )}

            <div style={{ height: 8 }} />

            {displayed.map((r) => (
              <GameCard
                key={r.game.id}
                g={r} rank={r.bobbyRank} config={config} logos={logos}
                preds={predsByGame[r.game.id]} weightsByModel={weightsByModel}
                picks={picksByGame[r.game.id]} research={researchByGame[r.game.id]}
                expanded={expandedId === r.game.id}
                onToggle={() => setExpandedId((prev) => prev === r.game.id ? null : r.game.id)}
                onOpenPick={(existing) => setPickModal({ row: r, existing })}
                onOpenResearch={() => setResearchModalRow(r)}
                onRemoveResearch={(id) => removeResearchPick(r.game.id, id)}
                onSaveNote={(text) => saveNote(r.game.id, text)}
              />
            ))}
            {displayed.length === 0 && <div style={{ ...FM, fontSize: 12, color: C.sub, padding: '20px 0' }}>No games match these filters.</div>}
            <div style={{ ...FM, fontSize: 11, color: C.sub, paddingLeft: 38 }}>{displayed.length} of {rows.length} Week {week} games shown</div>
          </>
        )}

        {loading && <div style={{ ...FM, fontSize: 12, color: C.sub, padding: '40px 0', textAlign: 'center' }}>Loading week {week ?? '…'}…</div>}
      </div>
    </div>
  );
}
