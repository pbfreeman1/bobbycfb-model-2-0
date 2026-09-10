'use client';

import { useEffect, useMemo, useState } from 'react';
import { sbFetch, getCurrentWeek, fmt, fmtKickoff } from '../lib/supabase';

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
// Game card
// ---------------------------------------------------------------------------
function GameCard({ row, expanded, onToggle, pssRank, mssRank, logos, picks, notesDraft, onSetLean, onSetNotesDraft, onCommitNotes, onAddPlay, onRemovePlay, researchTags, onAddResearchTag, onRemoveResearchTag }) {
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
          <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.sub, padding: 4, fontSize: 16 }}>
            {expanded ? '▲' : '▼'}
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
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          {/* PSS panel — primary */}
          <div style={{ padding: '16px 18px', borderBottom: `1px solid ${C.border}`, background: `${C.pss}08` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.pss }} />
              <span style={{ ...FH, fontSize: 14, color: C.pss }}>BobbyPSS — primary model</span>
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

          {/* Lean / play / notes — persisted to my_picks */}
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <select value={playType} onChange={(e) => setPlayType(e.target.value)} style={{ ...FM, fontSize: 11, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, padding: '5px 6px', color: C.text }}>
                <option value="spread">Spread</option>
                <option value="total">Total</option>
                <option value="moneyline">ML</option>
              </select>
              <select value={playSide} onChange={(e) => setPlaySide(e.target.value)} style={{ ...FM, fontSize: 11, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, padding: '5px 6px', color: C.text }}>
                {playType === 'total'
                  ? <><option value="over">Over</option><option value="under">Under</option></>
                  : <><option value="home">{home}</option><option value="away">{away}</option></>}
              </select>
              <input type="number" step="0.5" value={playUnits} onChange={(e) => setPlayUnits(parseFloat(e.target.value))}
                style={{ ...FM, fontSize: 11, width: 54, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, padding: '5px 6px', color: C.text }} />
              <button disabled={saving} onClick={async () => { setSaving(true); try { await onAddPlay(game.id, playType, playSide, playUnits); } finally { setSaving(false); } }} style={{ ...FM, fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 3, border: `1px solid ${C.agree}`, background: `${C.agree}1A`, color: C.agree, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                + Add pick
              </button>
            </div>
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
  const [sortBy, setSortBy] = useState('pss');
  const [sortDir, setSortDir] = useState('desc');

  // Persisted picks (my_picks), keyed by game id: { lean: row|null, note: row|null, plays: [row] }.
  // A per-game note and a lean are each stored as a single distinguishing
  // row (pick_type='note', or status='lean') rather than a separate table —
  // see PR4 handoff notes for why.
  const [picksByGame, setPicksByGame] = useState({});
  // Research tags (research_picks), keyed by game id: [row, ...].
  const [researchByGame, setResearchByGame] = useState({});
  // Text currently in each note input, separate from the committed row so
  // typing doesn't fire a request per keystroke — committed onBlur.
  const [notesDraftByGame, setNotesDraftByGame] = useState({});

  useEffect(() => {
    let cancelled = false;
    getCurrentWeek(season).then((w) => { if (!cancelled) setWeek(w); });
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
            `game_metrics(edge,agreement,stddev,mss,confidence_bin,suggested_play,suggested_side,suggested_line,consensus_spread,valid_model_count),` +
            `pss_game_metrics(pss,pss_bin,decision,qualifies,qualifying_tier,signal_type,selected_k,agreement,stddev,edge,consensus_spread,suggested_side,suggested_line,pss_drivers,warnings)` +
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

        // Load this week's picks in a second pass, once we have game ids —
        // failure here shouldn't block the board itself from rendering.
        if (games.length > 0) {
          const ids = games.map((g) => g.id).join(',');
          try {
            const picks = await sbFetch(`my_picks?select=*&game_id=in.(${ids})&order=created_at.asc`);
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
      await sbFetch(`my_picks?id=eq.${current.id}`, { method: 'DELETE' });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...(prev[gameId] || { note: null, plays: [] }), lean: null } }));
      return;
    }
    if (current) {
      const [updated] = await sbFetch(`my_picks?id=eq.${current.id}`, {
        method: 'PATCH', body: JSON.stringify({ side, updated_at: new Date().toISOString() }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], lean: updated } }));
    } else {
      const [created] = await sbFetch(`my_picks`, {
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
        await sbFetch(`my_picks?id=eq.${current.id}`, { method: 'DELETE' });
        setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], note: null } }));
      }
      return;
    }
    if (current) {
      const [updated] = await sbFetch(`my_picks?id=eq.${current.id}`, {
        method: 'PATCH', body: JSON.stringify({ note: text, updated_at: new Date().toISOString() }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...prev[gameId], note: updated } }));
    } else {
      const [created] = await sbFetch(`my_picks`, {
        method: 'POST',
        body: JSON.stringify({ game_id: gameId, season, week, pick_type: 'note', units: 0, status: 'official', note: text }),
      });
      setPicksByGame((prev) => ({ ...prev, [gameId]: { ...(prev[gameId] || { lean: null, plays: [] }), note: created } }));
    }
  }

  // Plays: any number per game, each its own row.
  async function addPlay(gameId, type, side, units) {
    const [created] = await sbFetch(`my_picks`, {
      method: 'POST',
      body: JSON.stringify({ game_id: gameId, season, week, pick_type: type, side, units, status: 'official' }),
    });
    setPicksByGame((prev) => ({
      ...prev,
      [gameId]: { ...(prev[gameId] || { lean: null, note: null, plays: [] }), plays: [...(prev[gameId]?.plays || []), created] },
    }));
  }
  async function removePlay(gameId, pickId) {
    await sbFetch(`my_picks?id=eq.${pickId}`, { method: 'DELETE' });
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
  }, [rows, filter, mssBinFilter, pssBinFilter, sortBy, sortDir, picksByGame]);

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
