'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sbFetch, fmt, fmtLine, fmtKickoff, CONFIDENCE_ORDER, CONF_BADGE_CLASS } from '../lib/supabase';

// ─── tooltips ────────────────────────────────────────────────────────────────
const TIPS = {
  matchup: 'Away team @ home team. Click any row for full game detail.',
  kickoff_at: 'Scheduled kickoff in Eastern Time. "TBD" until CFBD data is loaded.',
  vegas_line: 'Current market spread. Positive = home favored (BobbyCFB sign convention). Use ATS filters to find games where the home team is favored by a specific range.',
  over_under: 'Market total from CFBD lines data. Use the O/U filter to find games with a specific total range.',
  consensus_spread: "BobbyCFB's weighted-average predicted spread from the Top-7 ranked models.",
  edge: 'Consensus minus Vegas line. This is the core signal — the model\'s disagreement with the market.',
  agreement: 'Percentage of Top-7 models agreeing on the favored side. ≥85% is the qualification threshold.',
  stddev: 'Spread of predictions across Top-7 models. ≤2.5 is the qualification threshold.',
  mss: 'Model Strength Score — composite of edge, agreement, and variance.',
  confidence_bin: 'Qualitative bucket from MSS. For display only — qualification uses the raw filter criteria.',
  suggested_play: 'Passes Edge ≥1.5 + StdDev ≤2.5 + Agreement ≥85%. Historically ~58% ATS (2021–2025).',
  valid_model_count: 'Number of source models with a usable prediction for this game.',
  tv_network: 'Broadcast network from CFBD media data.',
};

function InfoIcon({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-wrap" style={{ position: 'relative' }}>
      <span
        className="info-icon"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >i</span>
      {open && <span className="tooltip-box">{text}</span>}
    </span>
  );
}

const COLS = [
  { key: 'rank', label: '#', sortable: true, sticky: true },
  { key: 'matchup', label: 'Matchup', sortable: false, sticky: true },
  { key: 'kickoff_at', label: 'Kickoff', sortable: true },
  { key: 'vegas_line', label: 'Vegas', sortable: true },
  { key: 'over_under', label: 'O/U', sortable: true },
  { key: 'consensus_spread', label: 'Consensus', sortable: true },
  { key: 'edge', label: 'Edge', sortable: true },
  { key: 'agreement', label: 'Agree%', sortable: true },
  { key: 'stddev', label: 'StdDev', sortable: true },
  { key: 'mss', label: 'MSS', sortable: true },
  { key: 'confidence_bin', label: 'Confidence', sortable: true },
  { key: 'suggested_play', label: 'Model Play', sortable: true },
  { key: 'valid_model_count', label: '#Mdls', sortable: true },
  { key: 'tv_network', label: 'TV', sortable: false },
  { key: 'my_pick', label: 'My Pick', sortable: false },
];

export default function Dashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const [games, setGames] = useState([]);
  const [userPicks, setUserPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState('mss');
  const [sortDir, setSortDir] = useState('desc');

  // Filters
  const [search, setSearch] = useState('');
  const [confFilter, setConfFilter] = useState('All');
  const [playOnly, setPlayOnly] = useState(false);
  const [minEdge, setMinEdge] = useState('');
  const [maxEdge, setMaxEdge] = useState('');
  const [minOU, setMinOU] = useState('');
  const [maxOU, setMaxOU] = useState('');
  const [minLine, setMinLine] = useState('');
  const [maxLine, setMaxLine] = useState('');
  const [maxStdDev, setMaxStdDev] = useState('');
  const [minAgree, setMinAgree] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // My Card expand
  const [cardExpanded, setCardExpanded] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [gData, pData] = await Promise.all([
        sbFetch(`games?select=id,home_team,away_team,kickoff_at,current_line,over_under,tv_network,status,game_metrics(vegas_line,consensus_spread,edge,agreement,stddev,mss,confidence_bin,suggested_play,suggested_side,suggested_line,valid_model_count)&season=eq.${season}&week=eq.${week}&order=home_team.asc`),
        sbFetch(`user_picks?select=*&season=eq.${season}&week=eq.${week}&is_custom=eq.false`),
      ]);
      setGames(gData);
      setUserPicks(pData);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [season, week]);

  const flat = useMemo(() => {
    const pickByGame = {};
    for (const p of userPicks) pickByGame[p.game_id] = p;
    return games.map((g, i) => {
      const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
      const agree = m?.agreement != null ? parseFloat(m.agreement) * 100 : null;
      return {
        _idx: i + 1,
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        kickoff_at: g.kickoff_at,
        status: g.status,
        vegas_line: m?.vegas_line ?? g.current_line,
        over_under: g.over_under ?? null,
        tv_network: g.tv_network ?? null,
        consensus_spread: m?.consensus_spread ?? null,
        edge: m?.edge ?? null,
        agreement: agree,
        stddev: m?.stddev ?? null,
        mss: m?.mss ?? null,
        confidence_bin: m?.confidence_bin ?? null,
        suggested_play: !!m?.suggested_play,
        suggested_side: m?.suggested_side ?? null,
        suggested_line: m?.suggested_line ?? null,
        valid_model_count: m?.valid_model_count ?? null,
        pick: pickByGame[g.id] ?? null,
      };
    });
  }, [games, userPicks]);

  const filtered = useMemo(() => {
    let out = flat;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(r => r.home_team.toLowerCase().includes(q) || r.away_team.toLowerCase().includes(q));
    }
    if (confFilter !== 'All') out = out.filter(r => r.confidence_bin === confFilter);
    if (playOnly) out = out.filter(r => r.suggested_play);
    if (minEdge !== '') { const t = parseFloat(minEdge); if (!isNaN(t)) out = out.filter(r => r.edge !== null && parseFloat(r.edge) >= t); }
    if (maxEdge !== '') { const t = parseFloat(maxEdge); if (!isNaN(t)) out = out.filter(r => r.edge !== null && parseFloat(r.edge) <= t); }
    if (minOU !== '') { const t = parseFloat(minOU); if (!isNaN(t)) out = out.filter(r => r.over_under !== null && parseFloat(r.over_under) >= t); }
    if (maxOU !== '') { const t = parseFloat(maxOU); if (!isNaN(t)) out = out.filter(r => r.over_under !== null && parseFloat(r.over_under) <= t); }
    if (minLine !== '') { const t = parseFloat(minLine); if (!isNaN(t)) out = out.filter(r => r.vegas_line !== null && parseFloat(r.vegas_line) >= t); }
    if (maxLine !== '') { const t = parseFloat(maxLine); if (!isNaN(t)) out = out.filter(r => r.vegas_line !== null && parseFloat(r.vegas_line) <= t); }
    if (maxStdDev !== '') { const t = parseFloat(maxStdDev); if (!isNaN(t)) out = out.filter(r => r.stddev !== null && parseFloat(r.stddev) <= t); }
    if (minAgree !== '') { const t = parseFloat(minAgree); if (!isNaN(t)) out = out.filter(r => r.agreement !== null && parseFloat(r.agreement) >= t); }
    return out;
  }, [flat, search, confFilter, playOnly, minEdge, maxEdge, minOU, maxOU, minLine, maxLine, maxStdDev, minAgree]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'confidence_bin') {
        av = CONFIDENCE_ORDER.indexOf(av); bv = CONFIDENCE_ORDER.indexOf(bv);
        if (av < 0) av = 99; if (bv < 0) bv = 99;
      } else if (sortKey === 'kickoff_at') {
        av = av ? new Date(av).getTime() : Infinity;
        bv = bv ? new Date(bv).getTime() : Infinity;
      } else if (sortKey === 'suggested_play') {
        av = av ? 1 : 0; bv = bv ? 1 : 0;
      } else {
        const na = parseFloat(av), nb = parseFloat(bv);
        if (!isNaN(na)) av = na;
        if (!isNaN(nb)) bv = nb;
      }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key) {
    if (!COLS.find(c => c.key === key)?.sortable) return;
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const myPicks = useMemo(() => userPicks.filter(p => p.played || p.status === 'official'), [userPicks]);
  const lockPick = useMemo(() => userPicks.find(p => p.is_lock), [userPicks]);

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>📊 Weekly Dashboard</h1>
          <p>All games for the selected week — sortable, filterable, with model consensus signals</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
            <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inputStyle} />
            <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
            <input type="number" value={week} onChange={e => setWeek(+e.target.value)} style={{ ...inputStyle, width: 60 }} />
          </div>
        </div>
      </div>

      {/* My Card banner */}
      <div className="card" style={{ marginBottom: 16, cursor: 'pointer' }} onClick={() => setCardExpanded(e => !e)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 800 }}>🎯 My Card</span>
            <span style={{ fontSize: 13, color: '#8a92a3' }}>Week {week}</span>
            {lockPick && <span className="lock-badge">🔒 Lock: {lockPick.note || 'BRLW'}</span>}
            <span style={{ fontSize: 12, color: '#8a92a3' }}>{myPicks.length} pick{myPicks.length !== 1 ? 's' : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href="/my-card" className="btn btn-primary" onClick={e => e.stopPropagation()} style={{ fontSize: 12, padding: '6px 12px' }}>Full Card</a>
            <span style={{ color: '#5b6272', fontSize: 13 }}>{cardExpanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {cardExpanded && (
          <div style={{ marginTop: 16, borderTop: '1px solid #1e2535', paddingTop: 16 }}>
            {myPicks.length === 0
              ? <p style={{ color: '#5b6272', margin: 0 }}>No picks added yet. Click "My Pick" buttons in the table below to add picks, or go to My Card to manage your full card.</p>
              : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {myPicks.map(p => {
                  const g = games.find(gm => gm.id === p.game_id);
                  const teamName = p.side === 'home' ? g?.home_team : g?.away_team;
                  return (
                    <div key={p.id} className="card" style={{ padding: '10px 14px', background: p.is_lock ? 'rgba(251,191,36,.08)' : 'rgba(56,189,148,.06)', border: `1px solid ${p.is_lock ? 'rgba(251,191,36,.25)' : 'rgba(56,189,148,.2)'}`, minWidth: 160 }}>
                      {p.is_lock && <div style={{ fontSize: 10, color: '#fbbf24', fontWeight: 800, marginBottom: 2 }}>🔒 BRLW LOCK</div>}
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{teamName || 'Custom'} {p.line_played != null ? fmtLine(p.line_played) : ''}</div>
                      <div style={{ fontSize: 11, color: '#8a92a3' }}>{g ? `${g.away_team} @ ${g.home_team}` : p.custom_label}</div>
                    </div>
                  );
                })}
              </div>
            }
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="card" style={{ marginBottom: 12, padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="fc">
            <label>Search team</label>
            <input type="text" placeholder="e.g. Auburn" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, width: 150 }} />
          </div>
          <div className="fc">
            <label>Confidence</label>
            <select value={confFilter} onChange={e => setConfFilter(e.target.value)} style={inputStyle}>
              <option>All</option>
              {CONFIDENCE_ORDER.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="fc checkbox-fc">
            <label style={{ flexDirection: 'row', gap: 6 }}>
              <input type="checkbox" checked={playOnly} onChange={e => setPlayOnly(e.target.checked)} />
              Model plays only
            </label>
          </div>
          <button className="btn btn-outline" onClick={() => setShowFilters(f => !f)} style={{ fontSize: 12, padding: '7px 12px' }}>
            {showFilters ? '▲ Hide filters' : '▼ More filters'}
          </button>
          <button className="btn btn-outline" onClick={load} style={{ fontSize: 12, padding: '7px 12px' }}>↻ Refresh</button>
        </div>

        {showFilters && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #1e2535', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <span style={{ fontSize: 11, color: '#5b6272', width: '100%', marginBottom: -6 }}>ADVANCED FILTERS — find trends like "home fav −6.5+ with O/U ≤55"</span>
            <RangeFilter label="Edge" minVal={minEdge} maxVal={maxEdge} onMin={setMinEdge} onMax={setMaxEdge} step="0.5" placeholder="e.g. 1.5" />
            <RangeFilter label="Vegas Line" minVal={minLine} maxVal={maxLine} onMin={setMinLine} onMax={setMaxLine} step="0.5" placeholder="e.g. -6.5" />
            <RangeFilter label="O/U" minVal={minOU} maxVal={maxOU} onMin={setMinOU} onMax={setMaxOU} step="0.5" placeholder="e.g. 45" />
            <div className="fc">
              <label>Max StdDev</label>
              <input type="number" step="0.5" placeholder="e.g. 2.5" value={maxStdDev} onChange={e => setMaxStdDev(e.target.value)} style={{ ...inputStyle, width: 90 }} />
            </div>
            <div className="fc">
              <label>Min Agree %</label>
              <input type="number" step="1" placeholder="e.g. 85" value={minAgree} onChange={e => setMinAgree(e.target.value)} style={{ ...inputStyle, width: 90 }} />
            </div>
            <button className="btn btn-outline" style={{ fontSize: 12, padding: '7px 12px' }} onClick={() => { setMinEdge(''); setMaxEdge(''); setMinOU(''); setMaxOU(''); setMinLine(''); setMaxLine(''); setMaxStdDev(''); setMinAgree(''); }}>Clear</button>
          </div>
        )}
      </div>

      {loading && <div className="loading">Loading games…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <>
          <div style={{ fontSize: 12, color: '#5b6272', marginBottom: 8 }}>
            {sorted.length} of {flat.length} game{flat.length !== 1 ? 's' : ''}
            {sorted.length < flat.length ? ' (filtered)' : ''}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  {COLS.map(c => (
                    <th
                      key={c.key}
                      className={`${c.sortable ? 'sortable' : ''} ${c.sticky ? (c.key === 'rank' ? 'sticky-col' : 'sticky-col-2') : ''}`}
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      {TIPS[c.key] && <InfoIcon text={TIPS[c.key]} />}
                      {sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <GameRow key={r.id} row={r} rank={i + 1} season={season} week={week} onPickChange={load} />
                ))}
                {sorted.length === 0 && (
                  <tr><td colSpan={COLS.length} className="empty">No games match current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <style jsx>{`
        .fc { display: flex; flex-direction: column; gap: 3px; }
        .fc label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8a92a3; }
        .checkbox-fc { justify-content: flex-end; }
        .checkbox-fc label { flex-direction: row; align-items: center; gap: 6px; font-size: 13px; color: #e6e9ef; text-transform: none; cursor: pointer; padding-bottom: 7px; }

        @media (max-width: 768px) {
          .tbl-wrap { font-size: 12px; }
        }
      `}</style>
    </div>
  );
}

function RangeFilter({ label, minVal, maxVal, onMin, onMax, step, placeholder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: '#8a92a3' }}>{label}</label>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="number" step={step} placeholder={placeholder} value={minVal} onChange={e => onMin(e.target.value)} style={{ ...inputStyle, width: 80 }} />
        <span style={{ color: '#5b6272', fontSize: 11 }}>to</span>
        <input type="number" step={step} placeholder={placeholder} value={maxVal} onChange={e => onMax(e.target.value)} style={{ ...inputStyle, width: 80 }} />
      </div>
    </div>
  );
}

function GameRow({ row: r, rank, season, week, onPickChange }) {
  const [saving, setSaving] = useState(false);

  const sideLabel = r.suggested_side === 'home' ? r.home_team : r.away_team;
  const confClass = CONF_BADGE_CLASS[r.confidence_bin] || '';
  const hasMyPick = !!r.pick?.played || r.pick?.status === 'official';
  const isLock = !!r.pick?.is_lock;

  async function togglePlay() {
    setSaving(true);
    try {
      if (r.pick) {
        // toggle off
        const resp = await fetch(`https://zpmdrazbqgzheqkvfltv.supabase.co/rest/v1/user_picks?id=eq.${r.pick.id}`, {
          method: 'DELETE',
          headers: { apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag', Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag' },
        });
      } else if (r.suggested_play) {
        // add suggested play
        await fetch('https://zpmdrazbqgzheqkvfltv.supabase.co/rest/v1/user_picks', {
          method: 'POST',
          headers: { apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag', Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag', 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_id: r.id, season, week, played: true, status: 'official', side: r.suggested_side, line_played: r.suggested_line, pick_type: 'spread' }),
        });
      }
      onPickChange();
    } finally { setSaving(false); }
  }

  return (
    <tr className={isLock ? 'is-lock' : r.suggested_play ? 'is-play' : ''}>
      <td className="sticky-col" style={{ color: '#5b6272', fontWeight: 600, width: 44, minWidth: 44 }}>{rank}</td>
      <td className="sticky-col-2" style={{ minWidth: 200 }}>
        <div style={{ fontWeight: 700 }}>{r.away_team}</div>
        <div style={{ fontSize: 11, color: '#8a92a3' }}>@ {r.home_team}</div>
      </td>
      <td style={{ color: '#8a92a3', fontSize: 12 }}>{fmtKickoff(r.kickoff_at)}</td>
      <td>{fmtLine(r.vegas_line)}</td>
      <td>{r.over_under ?? '—'}</td>
      <td>{fmtLine(r.consensus_spread)}</td>
      <td style={{ color: r.edge !== null && Math.abs(parseFloat(r.edge)) >= 1.5 ? '#38bd94' : 'inherit', fontWeight: r.edge !== null && Math.abs(parseFloat(r.edge)) >= 1.5 ? 700 : 400 }}>
        {fmtLine(r.edge)}
      </td>
      <td>{r.agreement !== null ? `${fmt(r.agreement, 0)}%` : '—'}</td>
      <td>{fmt(r.stddev, 2)}</td>
      <td>{fmt(r.mss, 1)}</td>
      <td><span className={`badge ${confClass}`}>{r.confidence_bin ?? '—'}</span></td>
      <td>
        {r.suggested_play
          ? <span className="play-badge">{sideLabel} {fmtLine(r.suggested_line)}</span>
          : <span style={{ color: '#3a404e' }}>—</span>}
      </td>
      <td style={{ color: '#5b6272' }}>{r.valid_model_count ?? '—'}</td>
      <td style={{ color: '#5b6272', fontSize: 12 }}>{r.tv_network ?? '—'}</td>
      <td>
        {hasMyPick
          ? <div style={{ display: 'flex', gap: 4 }}>
            <span className={isLock ? 'lock-badge' : 'play-badge'} style={{ fontSize: 11 }}>
              {isLock ? '🔒 ' : ''}{r.pick?.side === 'home' ? r.home_team : r.away_team}
            </span>
            <button className="btn btn-danger" style={{ fontSize: 10, padding: '3px 8px' }} onClick={togglePlay} disabled={saving}>✕</button>
          </div>
          : r.suggested_play
            ? <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={togglePlay} disabled={saving}>+ Add</button>
            : <a href="/my-card" style={{ fontSize: 11, color: '#3a404e' }}>Manual</a>
        }
      </td>
    </tr>
  );
}

const inputStyle = {
  background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef',
  padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110,
};
