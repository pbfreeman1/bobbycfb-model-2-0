'use client';
import { useEffect, useMemo, useState } from 'react';
import { sbFetchAll } from '../../../lib/supabase';
import { buildPlays, scoreboard, BUCKETS, BUCKET_NAMES } from '../../../lib/research-plays';
import { fmtSigned } from '../../../lib/research-report';
import { shortTeam } from '../../../lib/team-short';

const SEASON = 2026;
const FORWARD_FROM = 11; // weeks before this are backfill (rule found by slicing them)

const BUCKET_HELP = {
  A: 'Model 1U/2U/3U play and a research tag on the same side. Best bucket in weeks 1-10 (in-sample): confirm line, then play.',
  B: 'Research agrees with a Lean / no-tier model side. Small sample, watch only.',
  M: 'Model 1U/2U/3U play with no research tag. Weaker than A in weeks 1-10; size it down.',
  X: 'Research tags the side the model is against. Information only, not a bet.',
  N: 'Tagged, but no model signal yet. Re-pull signals before deciding.',
};
const COLOR = { A: '#38bd94', B: '#6aa9ff', M: '#d4a64a', X: '#e5775f', N: '#5b6272' };

const rec = (r) => `${r.w}-${r.l}${r.p ? `-${r.p}` : ''}`;
const u = (n) => `${n > 0 ? '+' : ''}${n}u`;

export default function PlayFinder() {
  const [raw, setRaw] = useState(null);
  const [error, setError] = useState(null);
  const [week, setWeek] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tags, games, signals] = await Promise.all([
          sbFetchAll(`research_picks?select=*&season=eq.${SEASON}&order=created_at.asc`),
          sbFetchAll(`games?select=id,week,home_team,away_team,kickoff_at,current_line,over_under,home_score,away_score,actual_margin,status&season=eq.${SEASON}&order=id.asc`),
          sbFetchAll(`cfb_game_signals?select=game_id,computed_at,pick_side,vegas_line,edge,tier,units,coverage&season=eq.${SEASON}&order=game_id.asc,computed_at.asc`),
        ]);
        if (cancelled) return;
        setRaw({ tags, games, signals });
        const wks = tags.map((t) => t.week);
        setWeek(wks.length ? Math.max(...wks) : 1);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, []);

  const all = useMemo(() => (raw ? buildPlays({ ...raw, forwardFrom: FORWARD_FROM }) : []), [raw]);
  const board = useMemo(() => scoreboard(all), [all]);
  const weeks = useMemo(() => (raw ? [...new Set(raw.games.map((g) => g.week))].sort((a, b) => b - a) : []), [raw]);
  const plays = useMemo(() => all.filter((p) => p.week === week), [all, week]);

  if (error) return <div className="page"><div className="error-msg">{error}</div></div>;
  if (!raw) return <div className="page"><div className="loading">Loading…</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>🎯 Play Finder</h1>
        <p>This week&apos;s model plays and research tags sorted into buckets. Paper units: 1u flat, win +1, loss −1.1. Weeks before {FORWARD_FROM} are backfill: the rule was found there, so only forward weeks count as proof.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <label style={lbl}>Week</label>
        <select style={inp} value={week} onChange={(e) => setWeek(+e.target.value)}>
          {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>

      <div className="card" style={{ marginBottom: 20, overflowX: 'auto' }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Bucket scoreboard (season)</div>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#8a92a3', textAlign: 'left' }}>
              <th style={th}>Bucket</th><th style={th}>Forward (wk {FORWARD_FROM}+)</th><th style={th}>Backfill (wk 1-{FORWARD_FROM - 1})</th>
            </tr>
          </thead>
          <tbody>
            {BUCKETS.map((b) => (
              <tr key={b} style={{ borderTop: '1px solid #1e2535' }}>
                <td style={td}><b style={{ color: COLOR[b] }}>{b}</b> {BUCKET_NAMES[b]}</td>
                <td style={td}>{rec(board[b].forward)} <span style={{ color: '#8a92a3' }}>{u(board[b].forward.units)}</span></td>
                <td style={td}>{rec(board[b].backfill)} <span style={{ color: '#8a92a3' }}>{u(board[b].backfill.units)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {BUCKETS.map((b) => {
        const list = plays.filter((p) => p.bucket === b);
        if (!list.length) return null;
        return (
          <div key={b} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: COLOR[b] }}>{b} · {BUCKET_NAMES[b]} ({list.length})</div>
            <div style={{ fontSize: 12, color: '#8a92a3', margin: '2px 0 8px' }}>{BUCKET_HELP[b]}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((p) => <PlayRow key={p.key} p={p} />)}
            </div>
          </div>
        );
      })}
      {plays.length === 0 && <div className="empty">No tags or model plays for week {week}.</div>}
    </div>
  );
}

function PlayRow({ p }) {
  const g = p.game;
  const team = g ? shortTeam(p.side === 'home' ? g.home_team : g.away_team) : p.side;
  const opp = g ? shortTeam(p.side === 'home' ? g.away_team : g.home_team) : '';
  return (
    <div className="card" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontWeight: 800 }}>
          {team} {fmtSigned(p.spread)} <span style={{ fontWeight: 400, color: '#8a92a3' }}>vs {opp}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
          {p.tier && <Chip c="#d4a64a">{p.tier}</Chip>}
          {p.kamRank != null ? <Chip c="#6aa9ff">KAM #{p.kamRank}</Chip> : p.kamTop ? <Chip c="#6aa9ff">KAM Top</Chip> : p.kamTopish ? <Chip c="#6aa9ff">KAM Topish</Chip> : null}
          {p.moved && <Chip c="#e5a64f">Line moved</Chip>}
          {p.lowCoverage && <Chip c="#e5a64f">Low coverage</Chip>}
          {p.result && <Chip c={p.result === 'win' ? '#38bd94' : p.result === 'loss' ? '#e5775f' : '#8a92a3'}>{p.result.toUpperCase()}</Chip>}
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#8a92a3', marginTop: 4 }}>
        {p.sources.length ? `${p.sourceCount} source${p.sourceCount > 1 ? 's' : ''}: ${p.sources.join(', ')}` : 'No research tags'}
        {p.signal?.edge != null ? ` · edge ${Math.round(p.signal.edge * 10) / 10}` : ''}
      </div>
    </div>
  );
}

function Chip({ c, children }) {
  return <span style={{ border: `1px solid ${c}`, color: c, borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>{children}</span>;
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13 };
const lbl = { fontSize: 11, color: '#8a92a3', textTransform: 'uppercase', letterSpacing: '.04em' };
const th = { padding: '4px 8px 6px 0', fontWeight: 600 };
const td = { padding: '6px 8px 6px 0' };
