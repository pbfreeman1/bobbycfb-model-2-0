'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sbFetch, sbFetchAll } from '../../../lib/supabase';
import { buildGuide } from '../../../lib/weekend-guide';
import { GuideSheets, FORWARD_FROM } from '../_guide/GuideView';

const SEASON = 2026;

export default function WeekendGuide() {
  const [raw, setRaw] = useState(null);
  const [week, setWeek] = useState(null);
  const [mine, setMine] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState(null); // timestamp of the last Generate click
  const p1 = useRef(null), p2 = useRef(null);

  async function load(wk) {
    setBusy(true); setError(null);
    try {
      const [tags, games, signals] = await Promise.all([
        sbFetchAll(`research_picks?select=*&season=eq.${SEASON}&order=created_at.asc`),
        sbFetchAll(`games?select=id,week,home_team,away_team,kickoff_at,current_line,over_under,home_score,away_score,actual_margin,status&season=eq.${SEASON}&order=id.asc`),
        sbFetchAll(`cfb_game_signals?select=game_id,computed_at,pick_side,vegas_line,edge,tier,units,coverage&season=eq.${SEASON}&order=game_id.asc,computed_at.asc`),
      ]);
      const w = wk ?? (signals.length ? Math.max(...games.filter((g) => signals.some((s) => s.game_id === g.id)).map((g) => g.week)) : Math.max(...games.map((g) => g.week)));
      const sel = 'select=*,games(home_team,away_team,kickoff_at)';
      const [a, b] = await Promise.all([
        sbFetch(`user_picks?${sel}&season=eq.${SEASON}&week=eq.${w}&order=created_at.asc`).catch(() => []),
        sbFetch(`pss_user_picks?${sel}&season=eq.${SEASON}&week=eq.${w}&order=created_at.asc`).catch(() => []),
      ]);
      setRaw({ tags, games, signals });
      setWeek(w);
      setMine([...a.map((p) => ({ ...p, _model: 'THE Bobby Model' })), ...b.map((p) => ({ ...p, _model: 'PSS' }))].filter((p) => p.result !== 'void'));
      setGenerated(new Date());
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const guide = useMemo(() => (raw && week != null ? buildGuide({ week, ...raw, userPicks: mine, forwardFrom: FORWARD_FROM }) : null), [raw, week, mine]);
  const weeks = useMemo(() => (raw ? [...new Set(raw.games.map((g) => g.week))].sort((a, b) => b - a) : []), [raw]);

  async function savePngs() {
    const { toPng } = await import('html-to-image');
    for (const [ref, name] of [[p1, 'page1'], [p2, 'page2']]) {
      if (!ref.current) continue;
      const url = await toPng(ref.current, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true });
      const a = document.createElement('a');
      a.href = url; a.download = `weekend-guide-wk${week}-${name}.png`; a.click();
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (error) return <div className="page"><div className="error-msg">{error}</div></div>;
  if (!guide) return <div className="page"><div className="loading">Building the guide…</div></div>;

  const stamp = generated ? generated.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const asOf = guide.computedAt ? new Date(guide.computedAt).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'no signals';

  return (
    <div className="page">
      <div className="guide-controls" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <h1 style={{ margin: 0, marginRight: 12 }}>📖 Weekend Guide</h1>
        <label style={lbl}>Week</label>
        <select style={inp} value={week} onChange={(e) => load(+e.target.value)}>
          {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <button style={btn(true)} disabled={busy} onClick={() => load(week)}>{busy ? 'Generating…' : 'Generate'}</button>
        <button style={btn(false)} onClick={() => window.print()}>Print / Save PDF</button>
        <button style={btn(false)} onClick={savePngs}>Download images</button>
        <span style={{ fontSize: 12, color: '#8a92a3' }}>Run Compute first. Generate re-reads tags, signals and My Card.</span>
      </div>

      <GuideSheets guide={guide} stamp={stamp} asOf={asOf} p1={p1} p2={p2} />
    </div>
  );
}


const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13 };
const lbl = { fontSize: 11, color: '#8a92a3', textTransform: 'uppercase', letterSpacing: '.04em' };
const btn = (primary) => ({ background: primary ? '#38bd94' : '#151a26', color: primary ? '#06251c' : '#e6e9ef', border: '1px solid ' + (primary ? '#38bd94' : '#2a3042'), padding: '7px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer' });

