'use client';

// Full breakdown for one game and one market, opened from the board.
//
// Everything here is either on the signal row (snapshotted by nfl2_compute) or
// loaded on open: line history, prediction changes, the historical record of
// similar spots, and both teams' season so far. "The read" at the top turns
// those numbers into plain reasons for and against, each traceable to a number
// further down the panel.

import { useEffect, useMemo, useState } from 'react';
import ScoutGameSection from '../../_scout/ScoutGameSection';
import {
  C, FH, FM, TIER_COLOR, buildRead, f1, fmtET, fmtKick, lineLabel, loadGameContext, modelLabel,
  pickLabel, signed, spreadFor, teamForm, units,
} from '../../../lib/nfl2';

const SPREAD_KEYS = [3, 7];
const TOTAL_KEYS = [37, 41, 43, 44, 47, 51];

const box = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' };
const h3 = { ...FH, fontSize: 13.5, margin: '0 0 8px', color: C.text };
const lab = { ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, textTransform: 'uppercase' };

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

// Where the line, the opener, the model and every system sit on one axis.
// Spreads are drawn as the home team's sportsbook line so left = home favored more.
function NumberLine({ row }) {
  const isTot = row.market === 'total';
  const tx = (v) => (isTot ? v : -v);
  const sys = row.systems.filter((s) => s.pred !== null && !s.out);
  const pts = [row.line_now ?? row.line, row.open_line, row.consensus, row.taken_line, ...sys.map((s) => Number(s.pred))]
    .filter((v) => v !== null && v !== undefined).map(tx);
  if (!pts.length) return null;
  let lo = Math.floor(Math.min(...pts)) - 1;
  let hi = Math.ceil(Math.max(...pts)) + 1;
  if (hi - lo < 8) { const m = (hi + lo) / 2; lo = Math.floor(m - 4); hi = Math.ceil(m + 4); }
  const W = 640; const H = 118; const pad = 18;
  const x = (v) => pad + ((v - lo) / (hi - lo)) * (W - 2 * pad);
  const keys = (isTot ? TOTAL_KEYS : SPREAD_KEYS.flatMap((k) => [k, -k])).filter((k) => k > lo && k < hi);
  const maxShare = Math.max(1, ...sys.map((s) => Number(s.share) || 0));
  const ticks = [];
  const step = hi - lo > 24 ? 4 : hi - lo > 12 ? 2 : 1;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const fmtTick = (t) => (isTot ? t : t === 0 ? 'PK' : t > 0 ? `+${t}` : `${t}`);
  const marker = (v, label, color, y, dash) => v === null || v === undefined ? null : (
    <g key={label}>
      <line x1={x(tx(v))} x2={x(tx(v))} y1={22} y2={84} stroke={color} strokeWidth={2} strokeDasharray={dash ? '4 3' : undefined} />
      <text x={x(tx(v))} y={y} fill={color} fontSize={10.5} textAnchor="middle" style={FM}>{label}</text>
    </g>
  );
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 460, display: 'block' }} role="img"
        aria-label="Line, opener, model and each system on one scale">
        {keys.map((k) => (
          <rect key={k} x={x(k - 0.5)} y={30} width={x(k + 0.5) - x(k - 0.5)} height={50} fill={C.gold} opacity={0.12} />
        ))}
        <line x1={pad} x2={W - pad} y1={80} y2={80} stroke={C.border} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={80} y2={85} stroke={C.sub} />
            <text x={x(t)} y={98} fill={C.sub} fontSize={10} textAnchor="middle" style={FM}>{fmtTick(t)}</text>
          </g>
        ))}
        {sys.map((s, i) => {
          const r = 2.5 + 5 * Math.sqrt((Number(s.share) || 0) / maxShare);
          const on = Math.sign(Number(s.pred) - row.line) === Math.sign(row.edge);
          return (
            <circle key={i} cx={x(tx(Number(s.pred)))} cy={56 + ((i % 5) - 2) * 4} r={Number(s.share) > 0 ? r : 2}
              fill={Number(s.share) > 0 ? (on ? C.green : C.warn) : C.sub} opacity={Number(s.share) > 0 ? 0.75 : 0.35}>
              <title>{s.name}: {f1(s.pred)} ({f1(s.share)}% weight)</title>
            </circle>
          );
        })}
        {marker(row.open_line, 'open', C.sub, 14, true)}
        {marker(row.line_now ?? row.line, 'line', C.text, 26)}
        {row.taken_line !== null && row.taken_line !== (row.line_now ?? row.line) && marker(row.taken_line, 'taken', C.blue, 14)}
        {marker(row.consensus, 'model', C.green, 26)}
        <text x={pad} y={H - 4} fill={C.sub} fontSize={9.5} style={FM}>
          {isTot ? 'total points' : `${row.home_abbr} line (left = ${row.home_abbr} favored by more)`} · shaded = key numbers · dot size = system weight
        </text>
      </svg>
    </div>
  );
}

function SystemsTable({ row }) {
  const isTot = row.market === 'total';
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? row.systems : row.systems.filter((s) => Number(s.share) > 0 || s.out);
  const cols = 'minmax(0,1.4fr) 40px 104px 72px 64px 54px 70px 52px';
  return (
    <div style={{ ...box, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 13px', gap: 8 }}>
        <span style={h3}>Systems ({row.systems.filter((s) => Number(s.share) > 0).length} weighted of {row.systems.length})</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setShowAll((v) => !v)} style={{
          background: 'transparent', border: `1px solid ${C.border}`, color: C.sub, borderRadius: 5, padding: '3px 8px', fontSize: 11, cursor: 'pointer',
        }}>{showAll ? 'Weighted only' : 'Show all'}</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '6px 13px', background: C.surface2, minWidth: 600, ...lab }}>
          <span>System</span><span>Rank</span><span>Weight</span><span>Predicts</span><span>vs line</span><span>Side</span><span>Season ATS</span><span>Avg err</span>
        </div>
        {list.map((s) => {
          const d = Number(s.pred) - row.line;
          const on = Math.sign(d) === Math.sign(row.edge) && d !== 0;
          const weighted = Number(s.share) > 0;
          const side = isTot ? (d > 0 ? 'OVER' : d < 0 ? 'UNDER' : '—') : d > 0 ? row.home_abbr : d < 0 ? row.away_abbr : '—';
          return (
            <div key={s.id} style={{
              display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '6px 13px',
              borderTop: `1px solid ${C.border}`, ...FM, fontSize: 11.5, minWidth: 600, opacity: weighted || s.out ? 1 : 0.5,
            }}>
              <span style={{ ...FH, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.name}{s.out ? <span style={{ color: C.warn }}> · ignored (outlier)</span> : ''}
              </span>
              <span style={{ color: C.sub }}>{s.rank ? `#${s.rank}` : '—'}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ flexGrow: 1, height: 5, background: C.bg, borderRadius: 3, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(100, 4 * Number(s.share || 0))}%`, background: on ? C.green : C.warn }} />
                </span>
                <span style={{ width: 38, textAlign: 'right', color: '#C9CFC8' }}>{weighted ? `${f1(s.share)}%` : '—'}</span>
              </span>
              <span>{isTot ? f1(s.pred) : `${row.home_abbr} ${spreadFor('home', s.pred)}`}</span>
              <span style={{ color: on ? C.green : C.warn }}>{signed(isTot ? d : -d)}</span>
              <span style={{ fontWeight: 700, color: on ? C.green : C.warn }}>{side}</span>
              <span style={{ color: C.sub }}>{s.w != null ? `${s.w}-${s.l}${s.p ? `-${s.p}` : ''}` : '—'}</span>
              <span style={{ color: C.sub }}>{s.mae != null ? f1(s.mae) : '—'}</span>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '8px 13px', fontSize: 11, color: C.sub, borderTop: `1px solid ${C.border}` }}>
        Weight goes to systems whose errors this season (blended with last season) beat the median system's, game by game.
        {' '}vs line is in {isTot ? 'total points (+ = higher than the line)' : `${row.home_abbr} line points (− = more ${row.home_abbr})`}.
      </div>
    </div>
  );
}

function TeamCard({ name, abbr, form, rest }) {
  const rec = (a) => `${a[0]}-${a[1]}${a[2] ? `-${a[2]}` : ''}`;
  return (
    <div style={{ ...box, flex: 1, minWidth: 220 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ ...FH, fontSize: 14, fontWeight: 700 }}>{name}</span>
        {rest !== null && rest !== undefined && <span style={{ ...FM, fontSize: 11, color: C.sub }}>{rest} days rest</span>}
      </div>
      <div style={{ ...FM, fontSize: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, margin: '8px 0' }}>
        <Stat k="ATS" v={rec(form.ats)} />
        <Stat k="O/U" v={rec(form.ou)} />
        <Stat k="Pts for/against" v={form.n ? `${f1(form.pf / form.n)} / ${f1(form.pa / form.n)}` : '—'} />
      </div>
      <div style={{ ...FM, fontSize: 11.5, color: '#C9CFC8', lineHeight: 1.6 }}>
        {form.last.length ? form.last.map((g) => (
          <div key={g.week}>
            <span style={{ color: C.sub }}>Wk {g.week}</span> {g.home ? 'vs' : '@'} {g.opp}{' '}
            <span style={{ color: g.mine > g.theirs ? C.green : g.mine < g.theirs ? C.warn : C.sub }}>
              {g.mine > g.theirs ? 'W' : g.mine < g.theirs ? 'L' : 'T'} {g.mine}-{g.theirs}
            </span>
          </div>
        )) : <span style={{ color: C.sub }}>No games yet this season.</span>}
      </div>
      <div style={{ fontSize: 10.5, color: C.sub, marginTop: 4 }}>{abbr} records are against the closing line.</div>
    </div>
  );
}

export default function GameDetail({ row, other, onClose }) {
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    setCtx(null);
    loadGameContext(row).then((c) => { if (live) setCtx(c); }).catch((e) => { if (live) setErr(e.message); });
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { live = false; window.removeEventListener('keydown', onKey); };
  }, [row, onClose]);

  const read = useMemo(() => buildRead(row, ctx), [row, ctx]);
  const isTot = row.market === 'total';
  const final = row.home_score !== null && row.home_score !== undefined;
  const graded = row.result && row.result !== 'NP';
  const tierColor = TIER_COLOR[row.tier] || C.sub;
  const lineNow = row.line_now ?? row.line;

  const homeForm = ctx ? teamForm(row.home, ctx.seasonGames, row.week) : null;
  const awayForm = ctx ? teamForm(row.away, ctx.seasonGames, row.week) : null;

  const predMoves = useMemo(() => {
    if (!ctx?.preds?.length) return null;
    const names = Object.fromEntries(row.systems.map((s) => [s.id, s.name]));
    const last = {};
    for (const p of ctx.preds) {
      if (!last[p.model_id]) last[p.model_id] = { first: Number(p.prev_value), now: Number(p.value) };
      else last[p.model_id].now = Number(p.value);
    }
    const toward = Object.entries(last).filter(([, v]) => Math.sign(v.now - v.first) === Math.sign(row.edge));
    return { n: Object.keys(last).length, toward: toward.length, list: Object.entries(last).slice(0, 8).map(([id, v]) => ({ name: names[id] || `#${id}`, ...v })) };
  }, [ctx, row]);

  return (
    <div role="dialog" aria-modal="true" aria-label={`${row.away} at ${row.home} detail`}
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)' }} />
      <div style={{
        position: 'relative', width: 'min(760px, 100%)', height: '100%', overflowY: 'auto', background: C.bg,
        borderLeft: `1px solid ${C.border}`, padding: '16px 16px 60px', color: C.text,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ ...FH, fontSize: 19, fontWeight: 700 }}>{row.away} @ {row.home}</div>
            <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginTop: 3 }}>
              Week {row.week} · {fmtKick(row.kickoff)} ET{row.tv_network ? ` · ${row.tv_network}` : ''}
              {final ? ` · Final ${row.away_abbr} ${row.away_score}, ${row.home_abbr} ${row.home_score}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
              {row.is_divisional && <Badge color={C.sub}>Divisional</Badge>}
              {row.is_primetime && <Badge color={C.sub}>Primetime</Badge>}
              {row.neutral_site && <Badge color={C.sub}>Neutral site</Badge>}
              {row.flags.map((f) => <Badge key={f} color={f.includes('with pick') ? C.green : C.gold}>{f}</Badge>)}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, width: 34, height: 34, cursor: 'pointer', fontSize: 16,
          }}>✕</button>
        </div>

        {/* verdict */}
        <div style={{ ...box, borderLeft: `4px solid ${row.taken_side ? C.green : tierColor}`, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.5 }}>{isTot ? 'TOTAL' : 'SPREAD'} · BOBBY PICK</span>
            <span style={{ ...FM, fontSize: 11, fontWeight: 700, color: tierColor }}>{row.tier}</span>
            {row.taken_side && <span style={{ ...FM, fontSize: 11, color: C.blue }}>taken {fmtET(row.taken_at)} ET</span>}
          </div>
          <div style={{ ...FH, fontSize: 22, fontWeight: 700, margin: '4px 0' }}>
            {row.taken_side ? pickLabel(row, row.taken_side, row.taken_line) : pickLabel(row, row.pick_side, lineNow)}
            {graded && (
              <span style={{ ...FM, fontSize: 14, marginLeft: 10, color: row.result === 'W' ? C.green : row.result === 'L' ? C.warn : C.sub }}>
                {row.result}{row.taken_side ? ` ${units(row.units_result)}` : ''} ({signed(row.cover_by)})
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: '#C9CFC8' }}>
            Model {modelLabel(row)} vs line {lineLabel(row, lineNow)}
            {row.open_line !== null ? ` (opened ${lineLabel(row, row.open_line)})` : ''}
            {row.taken_side && row.taken_line !== lineNow ? ` · now ${pickLabel(row, row.taken_side, lineNow)}` : ''}
          </div>
          {other && (
            <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6 }}>
              {other.market === 'total' ? 'Total' : 'Spread'}: {other.taken_side ? `${pickLabel(other, other.taken_side, other.taken_line)} (Play)` : `${pickLabel(other, other.pick_side, other.line_now ?? other.line)} (${other.tier})`}
            </div>
          )}
        </div>

        <div style={{ ...box, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px 16px', marginBottom: 12 }}>
          <Stat k="Raw edge" v={`${f1(Math.abs(row.edge))} pts`} />
          <Stat k="Key-adjusted edge" v={f1(row.kedge)} note="Play needs 2.0+" color={row.kedge >= 2 ? C.green : undefined} />
          <Stat k="Agreement" v={`${f1(100 * row.vote_share, 0)}%`} note="share of weight; Play needs 85%" color={row.vote_share >= 0.85 ? C.green : undefined} />
          <Stat k="Top 5 systems" v={row.top5_side_share === null ? '—' : `${Math.round(5 * row.top5_side_share)} of 5`} note="on this side" />
          <Stat k="System spread" v={f1(row.std_dev)} note="pts (lower = tighter)" />
          <Stat k="Pool" v={`${row.voters} systems`} note={`${f1(100 * row.coverage, 0)}% of weight present`} />
          <Stat k="Keys crossed" v={row.keys_crossed.length ? row.keys_crossed.join(', ') : 'none'} />
          {row.clv !== null && <Stat k="Closing line value" v={`${signed(row.clv)} pts`} note={row.clv > 0 ? 'beat the close' : row.clv < 0 ? 'close moved against' : 'same as close'} color={row.clv > 0 ? C.green : row.clv < 0 ? C.warn : undefined} />}
        </div>

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
          </div>
        </div>

        <ScoutGameSection sport="nfl" gameId={row.game_id} names={{ home: row.home, away: row.away }}
          model={{
            side: (isTot ? other : row)?.pick_side ?? null,
            total: (isTot ? row : other)?.pick_side ?? null,
          }}
          now={{
            side: isTot ? (other ? other.line_now ?? other.line : null) : lineNow,
            total: isTot ? lineNow : (other ? other.line_now ?? other.line : null),
          }} />

        <div style={{ ...box, marginBottom: 12 }}>
          <div style={h3}>Where everyone sits</div>
          <NumberLine row={row} />
        </div>

        <div style={{ ...box, marginBottom: 12 }}>
          <div style={h3}>Line movement</div>
          {!ctx && !err && <div style={{ fontSize: 12, color: C.sub }}>Loading…</div>}
          {err && <div style={{ fontSize: 12, color: C.warn }}>{err}</div>}
          {ctx && (
            <div style={{ ...FM, fontSize: 12, lineHeight: 1.7 }}>
              <div><span style={{ color: C.sub }}>Opener</span> {lineLabel(row, row.open_line)}</div>
              {ctx.lines.map((l) => (
                <div key={l.id}>
                  <span style={{ color: C.sub }}>{fmtET(l.captured_at)}</span>{' '}
                  {l.prev_line === null ? 'first seen at ' : `${lineLabel(row, Number(l.prev_line))} → `}{lineLabel(row, Number(l.line))}
                </div>
              ))}
              {row.close_line !== null && <div><span style={{ color: C.sub }}>Close</span> {lineLabel(row, row.close_line)}</div>}
              {!ctx.lines.length && row.line_basis === 'open' && (
                <div style={{ color: C.sub }}>Backfill week: only the opener and the close are known. This pick was scored at the opener.</div>
              )}
              {predMoves && (
                <div style={{ marginTop: 8, color: '#C9CFC8' }}>
                  {predMoves.n} system{predMoves.n === 1 ? '' : 's'} changed their number this week; {predMoves.toward} moved toward the pick.
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}><SystemsTable row={row} /></div>

        {ctx && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <TeamCard name={row.away} abbr={row.away_abbr} form={awayForm} rest={row.away_rest_days} />
            <TeamCard name={row.home} abbr={row.home_abbr} form={homeForm} rest={row.home_rest_days} />
          </div>
        )}

        <p style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6 }}>
          Tracking and research with paper units, not a recommendation. Against the closing line the consensus has been a coin flip
          since 2022; the edge in the backtest came from taking Plays early, before the line moves. The forward record on the Results
          page is the real test.
        </p>
      </div>
    </div>
  );
}
