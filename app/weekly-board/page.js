'use client';
import { useEffect, useState } from 'react';
import { sbFetch, fmt, fmtLine, fmtKickoff, CONFIDENCE_ORDER, CONF_BADGE_CLASS } from '../../lib/supabase';

export default function WeeklyBoard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const data = await sbFetch(`games?select=id,home_team,away_team,kickoff_at,current_line,over_under,tv_network,status,home_score,away_score,game_metrics(vegas_line,consensus_spread,edge,agreement,stddev,mss,confidence_bin,suggested_play,suggested_side,suggested_line,valid_model_count,topk_model_ids),user_picks(*)&season=eq.${season}&week=eq.${week}&order=kickoff_at.asc.nullslast,home_team.asc`);
      setGames(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [season, week]);

  const plays = games.filter(g => {
    const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
    return m?.suggested_play;
  });

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>📋 Weekly Board</h1>
          <p>Detailed per-game view with full model consensus breakdown</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
          <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inp} />
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
          <input type="number" value={week} onChange={e => setWeek(+e.target.value)} style={{ ...inp, width: 60 }} />
          <button className="btn btn-outline" onClick={load} style={{ fontSize: 12 }}>↻ Refresh</button>
        </div>
      </div>

      {plays.length > 0 && (
        <div className="card" style={{ marginBottom: 20, background: 'rgba(56,189,148,.04)', border: '1px solid rgba(56,189,148,.2)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#38bd94', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Model Plays This Week ({plays.length})
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {plays.map(g => {
              const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
              const team = m.suggested_side === 'home' ? g.home_team : g.away_team;
              return (
                <div key={g.id} className="card" style={{ padding: '8px 14px', background: 'rgba(56,189,148,.08)', border: '1px solid rgba(56,189,148,.2)', cursor: 'pointer' }} onClick={() => setExpanded(g.id === expanded ? null : g.id)}>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>{team} {fmtLine(m.suggested_line)}</div>
                  <div style={{ fontSize: 11, color: '#8a92a3' }}>{g.away_team} @ {g.home_team}</div>
                  <div style={{ fontSize: 11, color: '#38bd94', marginTop: 2 }}>MSS {fmt(m.mss, 1)} · Edge {fmtLine(m.edge)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading && <div className="loading">Loading…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {games.map(g => <GameCard key={g.id} game={g} expanded={expanded === g.id} onToggle={() => setExpanded(g.id === expanded ? null : g.id)} />)}
          {games.length === 0 && <div className="empty">No games found for Season {season} Week {week}.</div>}
        </div>
      )}
    </div>
  );
}

function GameCard({ game: g, expanded, onToggle }) {
  const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
  const isPlay = !!m?.suggested_play;
  const isLock = g.user_picks?.some(p => p.is_lock);
  const myPick = g.user_picks?.[0];

  const agree = m?.agreement != null ? parseFloat(m.agreement) * 100 : null;
  const confClass = m?.confidence_bin ? CONF_BADGE_CLASS[m.confidence_bin] || '' : '';
  const sideTeam = m?.suggested_side === 'home' ? g.home_team : g.away_team;

  const statusColor = g.status === 'final' ? '#38bd94' : g.status === 'in_progress' ? '#facc15' : '#5b6272';
  const scoreStr = g.status === 'final' || g.status === 'in_progress'
    ? `${g.home_score ?? '?'} – ${g.away_score ?? '?'}`
    : null;

  return (
    <div className={`card ${isLock ? 'is-lock' : isPlay ? 'is-play' : ''}`} style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header row */}
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', cursor: 'pointer', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 2, minWidth: 180 }}>
          {isPlay && <div style={{ fontSize: 10, color: '#38bd94', fontWeight: 800, marginBottom: 3, letterSpacing: '.06em' }}>★ MODEL PLAY</div>}
          {isLock && <div style={{ fontSize: 10, color: '#fbbf24', fontWeight: 800, marginBottom: 3, letterSpacing: '.06em' }}>🔒 BRLW LOCK</div>}
          <div style={{ fontWeight: 800, fontSize: 15 }}>{g.away_team}</div>
          <div style={{ fontSize: 13, color: '#8a92a3' }}>@ {g.home_team}</div>
        </div>
        <div style={{ fontSize: 12, color: '#8a92a3', minWidth: 120 }}>{fmtKickoff(g.kickoff_at)}</div>
        {scoreStr && <div style={{ fontSize: 14, fontWeight: 700, color: statusColor }}>{scoreStr}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 13 }}>Vegas: {fmtLine(m?.vegas_line ?? g.current_line)}</span>
          {g.over_under && <span style={{ fontSize: 13, color: '#8a92a3' }}>O/U {g.over_under}</span>}
          {m?.mss != null && <span style={{ fontSize: 12, color: '#8a92a3' }}>MSS {fmt(m.mss, 1)}</span>}
          <span className={`badge ${confClass}`}>{m?.confidence_bin ?? '—'}</span>
          {isPlay && <span className="play-badge">{sideTeam} {fmtLine(m.suggested_line)}</span>}
        </div>
        <span style={{ color: '#5b6272', marginLeft: 'auto' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: '1px solid #1e2535', padding: '16px 18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 16 }}>
          <Stat label="Consensus" value={fmtLine(m?.consensus_spread)} />
          <Stat label="Edge" value={fmtLine(m?.edge)} highlight={m?.edge != null && Math.abs(parseFloat(m.edge)) >= 1.5} />
          <Stat label="Agreement" value={agree != null ? `${fmt(agree, 0)}%` : '—'} highlight={agree != null && agree >= 85} />
          <Stat label="StdDev" value={fmt(m?.stddev, 2)} />
          <Stat label="MSS" value={fmt(m?.mss, 1)} />
          <Stat label="Models Used" value={m?.valid_model_count ?? '—'} />
          <Stat label="Vegas Line" value={fmtLine(m?.vegas_line ?? g.current_line)} />
          <Stat label="O/U" value={g.over_under ?? '—'} />
          {g.tv_network && <Stat label="TV" value={g.tv_network} />}
          {myPick && (
            <Stat label="My Pick" value={`${myPick.side === 'home' ? g.home_team : g.away_team} ${fmtLine(myPick.line_played)}`} highlight />
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#5b6272', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: highlight ? '#38bd94' : '#e6e9ef' }}>{value}</div>
    </div>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110 };
