'use client';

// THE Bobby Model — college basketball full game breakdown, opened from the
// daily board. Same shape as the NFL and CFB panels: verdict, the read
// (reasons for and against, each traceable to a number lower down), stat grid,
// the opening-line read that the CBB backtest points to, a number line, line
// and prediction movement, every system with its season accuracy, both teams'
// form and rest, and how similar spots have done this season.

import { useEffect, useMemo, useState } from 'react';
import ScoutGameSection from '../../_scout/ScoutGameSection';
import {
  C, FH, FM, EDGE_B, EDGE_LABEL, OPEN_B, OPEN_LABEL, TIER_COLOR, VOTE_B, VOTE_LABEL, f1, fmtDay, fmtET,
  loadGameContext, spreadFor, teamForm, units,
} from '../../../lib/cbb';

const box = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' };
const h3 = { ...FH, fontSize: 13.5, margin: '0 0 8px', color: C.text };
const lab = { ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, textTransform: 'uppercase' };
const signed = (v, d = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}`);
const rec = (w, l, p) => `${w}-${l}${p ? `-${p}` : ''}`;
const pct = (w, l) => (w + l ? (100 * w) / (w + l) : null);

// Thresholds mirror cbb_config (play_edge 1.5, play_vs 0.70, min_voters 3,
// min_coverage 0.70, big_edge 5, line_move 1.5).
const RULE = { edge: 1.5, vote: 0.7, voters: 3, coverage: 0.7, leanEdge: 1, leanVote: 0.6, big: 5, move: 1.5 };

function Stat({ k, v, note, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={lab}>{k}</span>
      <span style={{ ...FM, fontSize: 14, color: color || C.text }}>{v}</span>
      {note && <span style={{ fontSize: 10.5, color: C.sub }}>{note}</span>}
    </div>
  );
}

function Badge({ color, children }) {
  return (
    <span style={{ ...FM, fontSize: 10.5, padding: '3px 7px', borderRadius: 4, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

// The line, opener, model and every system on one axis, drawn as the home
// team's line (left = home favored by more).
function NumberLine({ row, systems }) {
  const tx = (v) => -v;
  const pts = [row.line, row.open_line, row.line_first, row.consensus, ...systems.map((s) => s.margin)]
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v)).map(tx);
  if (!pts.length) return null;
  let lo = Math.floor(Math.min(...pts)) - 1;
  let hi = Math.ceil(Math.max(...pts)) + 1;
  if (hi - lo < 10) { const m = (hi + lo) / 2; lo = Math.floor(m - 5); hi = Math.ceil(m + 5); }
  const W = 640; const H = 118; const pad = 18;
  const x = (v) => pad + ((v - lo) / (hi - lo)) * (W - 2 * pad);
  const maxW = Math.max(0.0001, ...systems.map((s) => s.weight));
  const step = hi - lo > 40 ? 8 : hi - lo > 24 ? 4 : hi - lo > 12 ? 2 : 1;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const marker = (v, label, color, y, dash) => (v === null || v === undefined ? null : (
    <g key={label}>
      <line x1={x(tx(v))} x2={x(tx(v))} y1={22} y2={84} stroke={color} strokeWidth={2} strokeDasharray={dash ? '4 3' : undefined} />
      <text x={x(tx(v))} y={y} fill={color} fontSize={10.5} textAnchor="middle" style={FM}>{label}</text>
    </g>
  ));
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 460, display: 'block' }} role="img"
        aria-label="Line, opener, model and each system on one scale">
        <line x1={pad} x2={W - pad} y1={80} y2={80} stroke={C.border} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={80} y2={85} stroke={C.sub} />
            <text x={x(t)} y={98} fill={C.sub} fontSize={10} textAnchor="middle" style={FM}>{t === 0 ? 'PK' : t > 0 ? `+${t}` : t}</text>
          </g>
        ))}
        {systems.map((s, i) => (
          <circle key={s.system} cx={x(tx(s.margin))} cy={56 + ((i % 5) - 2) * 4}
            r={s.weight > 0 ? 2.5 + 5 * Math.sqrt(s.weight / maxW) : 2}
            fill={s.weight > 0 ? (s.on ? C.green : C.warn) : C.sub} opacity={s.weight > 0 ? 0.75 : 0.35}>
            <title>{s.system}: {spreadFor('home', s.margin)} ({s.share.toFixed(1)}% weight)</title>
          </circle>
        ))}
        {marker(row.open_line, 'open', C.sub, 14, true)}
        {marker(row.line, 'line', C.text, 26)}
        {marker(row.consensus, 'model', C.green, 26)}
        <text x={pad} y={H - 4} fill={C.sub} fontSize={9.5} style={FM}>
          {row.home} line (left = favored by more) · dot size = system weight · grey = no weight
        </text>
      </svg>
    </div>
  );
}

function TeamCard({ name, form, isHome, neutral }) {
  return (
    <div style={{ ...box, flex: 1, minWidth: 240 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...FH, fontSize: 14, fontWeight: 700 }}>{name}</span>
        <span style={{ ...FM, fontSize: 11, color: C.sub }}>{neutral ? 'neutral' : isHome ? 'home' : 'road'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4, margin: '8px 0' }}>
        <Stat k="Record" v={rec(form.su[0], form.su[1])} />
        <Stat k="ATS" v={rec(...form.ats)} />
        <Stat k="Pts for/agst" v={form.n ? `${f1(form.pf / form.n)}/${f1(form.pa / form.n)}` : '—'} />
        <Stat k="Rest" v={form.rest === null ? '—' : `${form.rest} day${form.rest === 1 ? '' : 's'}`}
          color={form.rest !== null && form.rest <= 1 ? C.gold : undefined} />
      </div>
      <div style={{ ...FM, fontSize: 11.5, color: '#C9CFC8', lineHeight: 1.6 }}>
        {form.last.length ? form.last.map((g) => (
          <div key={`${g.date}-${g.opp}`}>
            <span style={{ color: C.sub }}>{fmtDay(g.date)}</span> {g.neutral ? 'vs' : g.home ? 'vs' : '@'} {g.opp}{' '}
            <span style={{ color: g.pts > g.opp_pts ? C.green : C.warn }}>{g.pts > g.opp_pts ? 'W' : 'L'} {g.pts}-{g.opp_pts}</span>
          </div>
        )) : <span style={{ color: C.sub }}>No results yet this season.</span>}
        {form.next && <div style={{ color: C.sub, marginTop: 4 }}>Next: {fmtDay(form.next.date)} vs {form.next.opp}</div>}
      </div>
      <div style={{ fontSize: 10.5, color: C.sub, marginTop: 4 }}>ATS is against each game&rsquo;s final line.</div>
    </div>
  );
}

function buildRead(row, systems, ctx, homeForm, roadForm) {
  const pros = [];
  const cons = [];
  const ae = Math.abs(row.edge ?? 0);
  const sg = Math.sign(row.edge ?? 0);
  const vote = row.vote_share ?? 0;

  // tier rule
  const misses = [];
  if (ae < RULE.edge) misses.push(`edge ${f1(ae)} (needs ${RULE.edge})`);
  if (vote < RULE.vote) misses.push(`agreement ${f1(100 * vote, 0)}% (needs 70%)`);
  if ((row.voters ?? 0) < RULE.voters) misses.push(`${row.voters} weighted systems (needs ${RULE.voters})`);
  if ((row.coverage ?? 0) < RULE.coverage) misses.push(`coverage ${f1(100 * (row.coverage ?? 0), 0)}% (needs 70%)`);
  if (row.tier === 'Play') pros.push(`Play: edge ${f1(ae)} with ${f1(100 * vote, 0)}% of system weight on this side and ${row.voters} weighted systems.`);
  else cons.push(`${row.tier === 'Lean' ? 'Lean (record only)' : 'No tier'}: short on ${misses.join(', ') || 'the Play rule'}.`);

  // the opening-line read
  if (row.open_line !== null && row.consensus !== null && sg) {
    const og = sg * (row.consensus - row.open_line);
    const mv = sg * (row.line - row.open_line);
    if (og >= 1 && mv < 0.5) {
      pros.push(`The model is ${f1(og)} away from the opener on this side and the line has not moved toward it yet. That is the one pattern the 2025-26 backtest found: lines moved toward the consensus about 61% of the time, and the consensus side went 52.6% against the opener.`);
    } else if (og >= 1 && mv >= 0.5) {
      const captured = Math.min(100, (100 * mv) / og);
      (captured >= 66 ? cons : pros).push(`The line has already moved ${f1(mv)} toward the model since the open (${f1(captured, 0)}% of the ${f1(og)}-point gap). ${captured >= 66 ? 'Most of the early value is gone.' : 'Some value is left.'}`);
    }
    if (mv <= -RULE.move) cons.push(`The line has moved ${f1(-mv)} AWAY from the model since the open. Check injuries and lineup news.`);
    if (ctx?.spots) {
      const b = ctx.spots.find((s) => s.kind === 'og' && s.b1 === OPEN_B(og));
      if (b && Number(b.toward) + Number(b.away) >= 20) {
        const t = Number(b.toward); const a = Number(b.away);
        (t > a ? pros : cons).push(`This season, when the model sat ${OPEN_LABEL[OPEN_B(og)]} from the opener, the line moved toward it in ${t} of ${t + a} games that moved; against the opener the model side went ${rec(Number(b.ow), Number(b.ol))}.`);
      }
    }
  }

  if (ae >= RULE.big) cons.push(`Edge of ${f1(ae)} is flagged as big. Large CBB edges have not done better, and often mean missing players the systems have not priced.`);

  // systems
  const top = systems.filter((s) => s.weight > 0).slice(0, 5);
  if (top.length === 5) {
    const on = top.filter((s) => s.on).length;
    if (on === 5) pros.push('All five most-trusted systems are on this side.');
    else if (on <= 2) cons.push(`Only ${on} of the five most-trusted systems are on this side.`);
  }
  if ((row.std_dev ?? 0) >= 4) cons.push(`The systems disagree widely with each other (spread of ${f1(row.std_dev)} points).`);
  if ((row.coverage ?? 1) < RULE.coverage) cons.push(`Only ${f1(100 * row.coverage, 0)}% of the usual system weight has posted on this game.`);

  // similar spots
  if (ctx?.spots) {
    const b = ctx.spots.find((s) => s.kind === 'ev' && s.b1 === EDGE_B(ae) && s.b2 === VOTE_B(vote));
    if (b && Number(b.w) + Number(b.l) >= 20) {
      const p = pct(Number(b.w), Number(b.l));
      (p >= 52.4 ? pros : cons).push(`Similar spots this season (edge ${EDGE_LABEL[EDGE_B(ae)]}, agreement ${VOTE_LABEL[VOTE_B(vote)]}): ${rec(Number(b.w), Number(b.l), Number(b.p))} (${p.toFixed(1)}%). Breakeven is 52.4%.`);
    }
  }

  // rest
  if (homeForm && roadForm && homeForm.rest !== null && roadForm.rest !== null) {
    const pickForm = row.pick_side === 'home' ? homeForm : roadForm;
    const oppForm = row.pick_side === 'home' ? roadForm : homeForm;
    if (pickForm.rest <= 1 && oppForm.rest >= 2) cons.push(`${row.pick_team} is on ${pickForm.rest === 0 ? 'no' : 'one day of'} rest; the opponent has ${oppForm.rest}.`);
    else if (oppForm.rest <= 1 && pickForm.rest >= 2) pros.push(`The opponent is on ${oppForm.rest === 0 ? 'no' : 'one day of'} rest; ${row.pick_team} has ${pickForm.rest}.`);
  }
  return { pros, cons };
}

export default function GameDetail({ row, onClose }) {
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setCtx(null);
    loadGameContext(row).then((c) => { if (live) setCtx(c); }).catch((e) => { if (live) setErr(e.message); });
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { live = false; window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [row, onClose]);

  const sysBoard = useMemo(() => new Map((ctx?.systems || []).map((s) => [s.name, s])), [ctx]);
  const systems = useMemo(() => {
    const total = row.systems.reduce((a, s) => a + Number(s.weight || 0), 0) || 1;
    return row.systems
      .map((s) => {
        const margin = Number(s.margin);
        const d = margin - row.line;
        return { ...s, margin, weight: Number(s.weight || 0), share: (100 * Number(s.weight || 0)) / total, d,
          on: d !== 0 && Math.sign(d) === Math.sign(row.edge), board: sysBoard.get(s.system) };
      })
      .sort((a, b) => b.weight - a.weight || a.system.localeCompare(b.system));
  }, [row, sysBoard]);

  const homeForm = ctx ? teamForm(row.home, ctx.teamGames, row.game_date, row.game_id) : null;
  const roadForm = ctx ? teamForm(row.road, ctx.teamGames, row.game_date, row.game_id) : null;
  const read = useMemo(() => buildRead(row, systems, ctx, homeForm, roadForm), [row, systems, ctx, homeForm, roadForm]);

  const tierColor = TIER_COLOR[row.tier] || C.sub;
  const final = row.home_score !== null && row.home_score !== undefined;
  const sg = Math.sign(row.edge ?? 0);
  const og = row.open_line !== null && sg ? sg * (row.consensus - row.open_line) : null;
  const mv = row.open_line !== null && sg ? sg * (row.line - row.open_line) : null;
  const onCount = systems.filter((s) => s.weight > 0 && s.on).length;
  const list = showAll ? systems : systems.filter((s) => s.weight > 0);
  const cols = 'minmax(0,1.4fr) 40px 96px 70px 58px 64px 54px 50px';

  return (
    <div role="dialog" aria-modal="true" aria-label={`${row.road} at ${row.home} detail`}
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)' }} />
      <div style={{
        position: 'relative', width: 'min(760px, 100%)', height: '100%', overflowY: 'auto', background: C.bg,
        borderLeft: `1px solid ${C.border}`, padding: '16px 16px 60px', color: C.text,
      }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ ...FH, fontSize: 19, fontWeight: 700 }}>{row.road} {row.neutral ? 'vs' : '@'} {row.home}</div>
            <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginTop: 3 }}>
              {fmtDay(row.game_date)}{row.rank_in_day ? ` · rank #${row.rank_in_day} today` : ''}{row.neutral ? ' · neutral site' : ''}
              {final ? ` · Final ${row.road} ${row.road_score}, ${row.home} ${row.home_score}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
              <Badge color={tierColor}>{row.tier || 'No tier'}</Badge>
              <Badge color={C.sub}>{row.source === 'live' ? 'Forward (live)' : 'Backfill'}</Badge>
              {row.flags.map((f) => <Badge key={f} color={f.includes('with pick') ? C.green : C.gold}>{f}</Badge>)}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, width: 34, height: 34, cursor: 'pointer', fontSize: 16,
          }}>✕</button>
        </div>

        {/* verdict */}
        <div style={{ ...box, borderLeft: `4px solid ${tierColor}`, marginBottom: 12 }}>
          <div style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.5 }}>
            BOBBY PICK · <span style={{ color: tierColor, fontWeight: 700 }}>{row.tier}{row.tier === 'Play' ? ' · 1u' : ''}</span>
          </div>
          <div style={{ ...FH, fontSize: 22, fontWeight: 700, margin: '4px 0' }}>
            {row.pick_team ? `${row.pick_team} ${spreadFor(row.pick_side, row.line)}` : 'No side'}
            {row.result && row.result !== 'NP' && (
              <span style={{ ...FM, fontSize: 14, marginLeft: 10, color: row.result === 'W' ? C.green : row.result === 'L' ? C.warn : C.sub }}>
                {row.result}{row.tier === 'Play' ? ` ${units(row.units_result)}` : ''}{row.cover_by !== null && row.cover_by !== undefined ? ` (${signed(Number(row.cover_by))})` : ''}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: '#C9CFC8' }}>
            Model {row.pick_team} {spreadFor(row.pick_side, row.consensus)} vs line {spreadFor(row.pick_side, row.line)}
            {row.open_line !== null ? ` (opened ${spreadFor(row.pick_side, row.open_line)})` : ''}
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>
            Computed {fmtET(row.computed_at)} ET. Lines and predictions freeze at noon ET on game day; results grade against the frozen line.
          </div>
        </div>

        {/* stats */}
        <div style={{ ...box, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px 16px', marginBottom: 12 }}>
          <Stat k="Edge" v={`${f1(Math.abs(row.edge))} pts`} note="Play needs 1.5" color={Math.abs(row.edge) >= RULE.edge ? C.green : undefined} />
          <Stat k="Agreement" v={`${f1(100 * row.vote_share, 0)}%`} note={`${onCount} of ${row.voters} weighted systems`} color={row.vote_share >= RULE.vote ? C.green : undefined} />
          <Stat k="Top 5 systems" v={`${systems.filter((s) => s.weight > 0).slice(0, 5).filter((s) => s.on).length} of 5`} note="on this side" />
          <Stat k="System spread" v={f1(row.std_dev)} note="pts (lower = tighter)" />
          <Stat k="Coverage" v={`${f1(100 * row.coverage, 0)}%`} note="of weight posted" color={row.coverage < RULE.coverage ? C.warn : undefined} />
          <Stat k="Rank score" v={f1(row.score, 2)} note="sorting aid" />
          <Stat k="Gap to opener" v={og === null ? '—' : `${signed(og)} pts`} note="model vs opening line" color={og !== null && og >= 1 ? C.green : undefined} />
          <Stat k="Line move" v={mv === null ? '—' : `${signed(mv)} pts`} note="+ = toward the model" color={mv !== null && mv <= -RULE.move ? C.warn : undefined} />
        </div>

        {/* the read */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 12 }}>
          <div style={{ ...box, borderTop: `3px solid ${C.green}` }}>
            <div style={h3}>For this pick</div>
            {read.pros.length ? read.pros.map((p, i) => <p key={i} style={{ fontSize: 12.5, lineHeight: 1.55, margin: '0 0 7px' }}>{p}</p>)
              : <p style={{ fontSize: 12.5, color: C.sub, margin: 0 }}>Nothing stands out.</p>}
          </div>
          <div style={{ ...box, borderTop: `3px solid ${C.warn}` }}>
            <div style={h3}>Against / check first</div>
            {read.cons.length ? read.cons.map((p, i) => <p key={i} style={{ fontSize: 12.5, lineHeight: 1.55, margin: '0 0 7px' }}>{p}</p>)
              : <p style={{ fontSize: 12.5, color: C.sub, margin: 0 }}>No warning signs in the numbers.</p>}
            {!ctx && !err && <p style={{ fontSize: 11.5, color: C.sub, margin: 0 }}>Loading history…</p>}
            {err && <p style={{ fontSize: 11.5, color: C.warn, margin: 0 }}>History did not load: {err}</p>}
          </div>
        </div>

        {/* outside picks */}
        <ScoutGameSection sport="cbb" gameId={row.game_id} names={{ home: row.home, away: row.road }}
          model={{ side: row.edge > 0 ? 'home' : row.edge < 0 ? 'away' : null }} now={{ side: row.line }} />

        {/* number line */}
        <div style={{ ...box, marginBottom: 12 }}>
          <div style={h3}>Where everyone sits</div>
          <NumberLine row={row} systems={systems} />
        </div>

        {/* line + prediction movement */}
        <div style={{ ...box, marginBottom: 12 }}>
          <div style={h3}>Line movement</div>
          <div style={{ ...FM, fontSize: 12, lineHeight: 1.7 }}>
            <div><span style={{ color: C.sub }}>Opener</span> {row.home} {spreadFor('home', row.open_line)}</div>
            {row.line_first !== null && row.line_first !== undefined && (
              <div><span style={{ color: C.sub }}>First seen by the model</span> {row.home} {spreadFor('home', Number(row.line_first))}</div>
            )}
            {(ctx?.lines || []).map((l) => (
              <div key={l.id}><span style={{ color: C.sub }}>{fmtET(l.seen_at)}</span> {spreadFor('home', Number(l.prev_line))} → {spreadFor('home', Number(l.line))}</div>
            ))}
            <div><span style={{ color: C.sub }}>{final ? 'Graded at' : 'Now'}</span> {row.home} {spreadFor('home', row.line)}</div>
            {ctx && (
              <div style={{ marginTop: 6, color: '#C9CFC8' }}>
                {ctx.preds.length
                  ? `${new Set(ctx.preds.map((p) => p.system_id)).size} system${new Set(ctx.preds.map((p) => p.system_id)).size === 1 ? '' : 's'} changed their number since first posting.`
                  : 'No system has changed its number since first posting.'}
              </div>
            )}
          </div>
        </div>

        {/* systems */}
        <div style={{ ...box, padding: 0, overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 13px', gap: 8 }}>
            <span style={{ ...h3, margin: 0 }}>Systems ({row.voters} weighted of {systems.length})</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setShowAll((v) => !v)} style={{
              background: 'transparent', border: `1px solid ${C.border}`, color: C.sub, borderRadius: 5, padding: '3px 8px', fontSize: 11, cursor: 'pointer',
            }}>{showAll ? 'Weighted only' : 'Show all'}</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '6px 13px', background: C.surface2, minWidth: 640, ...lab }}>
              <span>System</span><span>Rank</span><span>Weight</span><span>Predicts</span><span>vs line</span><span>ATS %</span><span>Avg err</span><span>Bias</span>
            </div>
            {list.map((s) => (
              <div key={s.system} style={{
                display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '6px 13px',
                borderTop: `1px solid ${C.border}`, ...FM, fontSize: 11.5, minWidth: 640, opacity: s.weight > 0 ? 1 : 0.5,
              }}>
                <span style={{ ...FH, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.system}</span>
                <span style={{ color: C.sub }}>{s.board?.rank ? `#${s.board.rank}` : '—'}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ flexGrow: 1, height: 5, background: C.bg, borderRadius: 3, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${Math.min(100, 5 * s.share)}%`, background: s.on ? C.green : C.warn }} />
                  </span>
                  <span style={{ width: 34, textAlign: 'right', color: '#C9CFC8' }}>{s.weight > 0 ? `${f1(s.share)}%` : '—'}</span>
                </span>
                <span>{spreadFor('home', s.margin)}</span>
                <span style={{ color: s.on ? C.green : C.warn }}>{signed(-s.d)}</span>
                <span style={{ color: C.sub }}>{s.board?.ats_pct != null ? `${f1(100 * Number(s.board.ats_pct))}%` : '—'}</span>
                <span style={{ color: C.sub }}>{s.board?.mae != null ? f1(s.board.mae) : '—'}</span>
                <span style={{ color: C.sub }}>{s.board?.bias != null ? signed(Number(s.board.bias)) : '—'}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '8px 13px', fontSize: 11, color: C.sub, borderTop: `1px solid ${C.border}` }}>
            Predictions and vs line are in {row.home} line points (− = more {row.home}). Weight goes to systems with lower error than the
            median system this season. ATS %, average error and bias are season to date; bias is the system&rsquo;s average lean toward the home team.
          </div>
        </div>

        {/* team form */}
        {ctx && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <TeamCard name={row.road} form={roadForm} isHome={false} neutral={row.neutral} />
            <TeamCard name={row.home} form={homeForm} isHome neutral={row.neutral} />
          </div>
        )}

        {/* similar spots */}
        {ctx?.spots && (
          <div style={{ ...box, marginBottom: 12 }}>
            <div style={h3}>How similar spots have done this season</div>
            {(() => {
              const ae = Math.abs(row.edge ?? 0);
              const eb = EDGE_B(ae); const vb = VOTE_B(row.vote_share ?? 0);
              const rows = ctx.spots.filter((s) => s.kind === 'ev' && s.b1 === eb);
              const ob = og !== null ? ctx.spots.find((s) => s.kind === 'og' && s.b1 === OPEN_B(og)) : null;
              return (
                <div style={{ ...FM, fontSize: 12, lineHeight: 1.8 }}>
                  <div style={{ color: C.sub }}>Edge {EDGE_LABEL[eb]}, by agreement (graded at the line the model used):</div>
                  {rows.sort((a, b) => a.b2 - b.b2).map((s) => {
                    const p = pct(Number(s.w), Number(s.l));
                    return (
                      <div key={s.b2} style={{ fontWeight: s.b2 === vb ? 700 : 400, color: s.b2 === vb ? C.text : '#C9CFC8' }}>
                        {s.b2 === vb ? '▸ ' : '  '}{VOTE_LABEL[s.b2]}: {rec(Number(s.w), Number(s.l), Number(s.p))}
                        <span style={{ color: p === null ? C.sub : p >= 52.4 ? C.green : C.warn }}>{p === null ? '' : ` (${p.toFixed(1)}%)`}</span>
                      </div>
                    );
                  })}
                  {ob && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ color: C.sub }}>Model {OPEN_LABEL[OPEN_B(og)]} from the opener:</span>{' '}
                      line moved toward the model {ob.toward} times, away {ob.away}; model side vs the opener {rec(Number(ob.ow), Number(ob.ol))}.
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        <p style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6 }}>
          Tracking and research with paper units, not a recommendation. Against the closing line no single system or the consensus has beaten
          52.4% over a full season; the one consistent pattern is the line moving toward the consensus after the open.
        </p>
      </div>
    </div>
  );
}
