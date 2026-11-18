'use client';

// THE Bobby Model — CFB full game breakdown, opened from the board.
//
// Same shape as the NFL panel (app/nfl/_ui/GameDetail.js): verdict, the read
// (reasons for and against, each traceable to a number further down), a
// number line, line movement, systems, team form. Plus what only the CFB board
// has: research tags with each source's season record, my plays and notes, the
// tier checklist and vote split, and the top-k hits / Bobcat read.
//
// Week-level data comes in as props from the board. Season-level context
// (research tags, signals + grades, results) is loaded once per season on the
// first open and cached for the rest of the visit.

import { useEffect, useMemo, useRef, useState } from 'react';
import { sbFetch, sbFetchAll, sbRpc, fmtKickoff } from '../../../lib/supabase';
import { TIER_COLOR, TIER_UNITS, defFor, fmtSpread, nearMiss, teamLine, tierChecklist } from '../../../lib/bobby-model';
import { buildReport, normalizeSources, recStr, recPct } from '../../../lib/research-report';
import { pickDescription, researchDescription } from '../../../lib/bet-types';
import { shortTeam } from '../../../lib/team-short';

const FH = { fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif" };
const FM = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };
const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', gold: '#D4A73C', green: '#6FBF73',
  blue: '#5B9BD4', warn: '#E07A62', lav: '#B39DDB',
};

// Variants of one underlying rating, grouped so repeated hits are visible.
const SYSTEM_FAMILIES = [
  { name: 'Sagarin', cols: ['linesagpred', 'linesaggm', 'linesag', 'linesagr'] },
  { name: 'Pi-Rate', cols: ['linepimean', 'linepiratings', 'linepibias'] },
];
const FAMILY_OF = {};
for (const f of SYSTEM_FAMILIES) for (const c of f.cols) FAMILY_OF[c] = f.name;

const box = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' };
const h3 = { ...FH, fontSize: 13.5, margin: '0 0 8px', color: C.text, display: 'flex', alignItems: 'center', gap: 6 };
const lab = { ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, textTransform: 'uppercase' };
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const f1 = (v, d = 1) => (num(v) === null ? '—' : num(v).toFixed(d));
const signed = (v, d = 1) => (num(v) === null ? '—' : `${num(v) > 0 ? '+' : ''}${num(v).toFixed(d)}`);
const pctStr = (w, l) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : '—');
const fmtU = (u) => `${u > 0 ? '+' : ''}${u.toFixed(1)}u`;
const blank = () => ({ w: 0, l: 0, p: 0, u: 0 });

// ---------------------------------------------------------------------------
// Season context, loaded once per season
// ---------------------------------------------------------------------------
const seasonCache = {};
function loadSeason(season) {
  if (!seasonCache[season]) {
    seasonCache[season] = Promise.all([
      sbFetchAll(`research_picks?select=*&season=eq.${season}&order=created_at.asc`),
      sbFetchAll(`games?select=id,week,home_team,away_team,kickoff_at,opening_line,current_line,closing_line,over_under,home_score,away_score,actual_margin,status&season=eq.${season}&order=id.asc`),
      sbFetchAll(`cfb_game_signals?select=id,game_id,week,computed_at,pick_side,vegas_line,consensus,edge,vote_share,std_dev,conviction,tier,units,hit_count,hit_side,bobcat,coverage&season=eq.${season}&order=id.asc`),
      sbFetchAll('cfb_signal_grades?select=signal_id,ats_result,units_pl&order=signal_id.asc'),
    ]).then(([tags, games, signals, grades]) => {
      const gradeBy = new Map(grades.map((g) => [g.signal_id, g]));
      const sig = signals.map((s) => ({ ...s, grade: gradeBy.get(s.id) || null }));
      return { tags, games, signals: sig, report: buildReport({ tags, games, signals }) };
    }).catch((e) => { delete seasonCache[season]; throw e; });
  }
  return seasonCache[season];
}

const edgeBucket = (e) => (e < 1.5 ? 0 : e < 3 ? 1 : e < 5 ? 2 : 3);
const voteBucket = (v) => (v < 0.7 ? 0 : v < 0.85 ? 1 : 2);
const EDGE_LABEL = ['under 1.5', '1.5–3', '3–5', '5+'];
const VOTE_LABEL = ['under 70%', '70–85%', '85%+'];

function recordOf(signals) {
  const r = blank();
  for (const s of signals) {
    const res = s.grade?.ats_result;
    if (res === 'win') r.w += 1; else if (res === 'loss') r.l += 1; else if (res === 'push') r.p += 1;
    r.u += num(s.grade?.units_pl) || 0;
  }
  return r;
}

// One team's season before this week: ATS vs the closing line, O/U, form.
function teamForm(team, games, beforeWeek) {
  const out = { ats: [0, 0, 0], ou: [0, 0, 0], last: [], pf: 0, pa: 0, n: 0 };
  const played = games
    .filter((g) => g.week < beforeWeek && g.home_score != null && g.away_score != null && (g.home_team === team || g.away_team === team))
    .sort((a, b) => a.week - b.week);
  for (const g of played) {
    const home = g.home_team === team;
    const mine = home ? g.home_score : g.away_score;
    const theirs = home ? g.away_score : g.home_score;
    out.pf += mine; out.pa += theirs; out.n += 1;
    const line = num(g.closing_line) ?? num(g.current_line);
    if (line !== null) {
      const homeCover = g.home_score - g.away_score - line;
      const c = home ? homeCover : -homeCover;
      out.ats[c > 0 ? 0 : c < 0 ? 1 : 2] += 1;
    }
    if (num(g.over_under) !== null) {
      const t = g.home_score + g.away_score - num(g.over_under);
      out.ou[t > 0 ? 0 : t < 0 ? 1 : 2] += 1;
    }
    out.last.push({ week: g.week, opp: home ? g.away_team : g.home_team, home, mine, theirs });
  }
  out.last = out.last.slice(-4).reverse();
  return out;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------
function Info({ k, config }) {
  const [open, setOpen] = useState(false);
  const d = defFor(k, config);
  if (!d) return null;
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} aria-label={`What is ${d[0]}?`} style={{
        width: 16, height: 16, borderRadius: 8, border: `1px solid ${open ? C.gold : C.border}`, background: 'transparent',
        color: open ? C.gold : C.sub, fontSize: 10, lineHeight: '14px', padding: 0, cursor: 'pointer', ...FM,
      }}>i</button>
      {open && (
        <span style={{
          position: 'absolute', top: 20, left: -8, zIndex: 5, width: 260, background: C.surface2, border: `1px solid ${C.gold}`,
          borderRadius: 6, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.5, color: C.text, ...FH, fontWeight: 400, textTransform: 'none', letterSpacing: 0,
        }}><b style={{ color: C.gold }}>{d[0]}.</b> {d[1]}</span>
      )}
    </span>
  );
}

function Stat({ k, v, note, color, info, config }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ ...lab, display: 'flex', alignItems: 'center', gap: 4 }}>{k}{info && <Info k={info} config={config} />}</span>
      <span style={{ ...FM, fontSize: 14, color: color || C.text }}>{v}</span>
      {note && <span style={{ fontSize: 10.5, color: C.sub }}>{note}</span>}
    </div>
  );
}

function Badge({ color, children, filled, dashed, onClick, title }) {
  const El = onClick ? 'button' : 'span';
  return (
    <El onClick={onClick} title={title} style={{
      ...FM, fontSize: 10.5, padding: '3px 7px', borderRadius: 4, border: `1px ${dashed ? 'dashed' : 'solid'} ${color}`,
      background: filled ? `${color}22` : 'transparent', color, whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : 'default',
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>{children}</El>
  );
}

// Line, opener, model and every weighted system on one axis, as the home
// team's sportsbook line (left = home favored by more).
function NumberLine({ signal, systems, homeAbbr, currentLine }) {
  const tx = (v) => -v;
  const vals = [signal.vegas_line, signal.opening_line, signal.consensus, currentLine, ...systems.map((s) => s.pm)]
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v)).map(tx);
  if (!vals.length) return null;
  let lo = Math.floor(Math.min(...vals)) - 1;
  let hi = Math.ceil(Math.max(...vals)) + 1;
  if (hi - lo < 10) { const m = (hi + lo) / 2; lo = Math.floor(m - 5); hi = Math.ceil(m + 5); }
  const W = 640; const H = 118; const pad = 18;
  const x = (v) => pad + ((v - lo) / (hi - lo)) * (W - 2 * pad);
  const keys = [3, 7, 10, 14].flatMap((k) => [k, -k]).filter((k) => k > lo && k < hi);
  const maxShare = Math.max(1, ...systems.map((s) => s.share));
  const step = hi - lo > 40 ? 8 : hi - lo > 24 ? 4 : hi - lo > 12 ? 2 : 1;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const fmtTick = (t) => (t === 0 ? 'PK' : t > 0 ? `+${t}` : `${t}`);
  const marker = (v, label, color, y, dash) => (v === null || v === undefined || !Number.isFinite(v) ? null : (
    <g key={label}>
      <line x1={x(tx(v))} x2={x(tx(v))} y1={22} y2={84} stroke={color} strokeWidth={2} strokeDasharray={dash ? '4 3' : undefined} />
      <text x={x(tx(v))} y={y} fill={color} fontSize={10.5} textAnchor="middle" style={FM}>{label}</text>
    </g>
  ));
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 460, display: 'block' }} role="img"
        aria-label="Vegas line, opener, model and each system on one scale">
        {keys.map((k) => (
          <rect key={k} x={x(k - 0.5)} y={30} width={x(k + 0.5) - x(k - 0.5)} height={50} fill={C.gold} opacity={Math.abs(k) <= 7 ? 0.12 : 0.06} />
        ))}
        <line x1={pad} x2={W - pad} y1={80} y2={80} stroke={C.border} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={80} y2={85} stroke={C.sub} />
            <text x={x(t)} y={98} fill={C.sub} fontSize={10} textAnchor="middle" style={FM}>{fmtTick(t)}</text>
          </g>
        ))}
        {systems.map((s, i) => (
          <circle key={s.id} cx={x(tx(s.pm))} cy={56 + ((i % 5) - 2) * 4} r={2.5 + 5 * Math.sqrt(s.share / maxShare)}
            fill={s.on ? C.green : C.warn} opacity={0.75}>
            <title>{s.name}: {homeAbbr} {fmtSpread(-s.pm)} ({s.share.toFixed(1)}% weight)</title>
          </circle>
        ))}
        {marker(signal.opening_line, 'open', C.sub, 14, true)}
        {marker(signal.vegas_line, 'line', C.text, 26)}
        {currentLine !== null && currentLine !== signal.vegas_line && marker(currentLine, 'now', C.blue, 14)}
        {marker(signal.consensus, 'model', C.green, 26)}
        <text x={pad} y={H - 4} fill={C.sub} fontSize={9.5} style={FM}>
          {homeAbbr} line (left = {homeAbbr} favored by more) · shaded = 3, 7, 10, 14 · dot size = system weight
        </text>
      </svg>
    </div>
  );
}

function TeamCard({ name, logo, form }) {
  const rec = (a) => `${a[0]}-${a[1]}${a[2] ? `-${a[2]}` : ''}`;
  return (
    <div style={{ ...box, flex: 1, minWidth: 230 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {logo && <img src={logo} alt="" width={20} height={20} style={{ objectFit: 'contain' }} />}
        <span style={{ ...FH, fontSize: 14, fontWeight: 700 }}>{name}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, margin: '8px 0' }}>
        <Stat k="ATS" v={rec(form.ats)} />
        <Stat k="O/U" v={rec(form.ou)} />
        <Stat k="Pts for/agst" v={form.n ? `${f1(form.pf / form.n)} / ${f1(form.pa / form.n)}` : '—'} />
      </div>
      <div style={{ ...FM, fontSize: 11.5, color: '#C9CFC8', lineHeight: 1.6 }}>
        {form.last.length ? form.last.map((g) => (
          <div key={g.week}>
            <span style={{ color: C.sub }}>Wk {g.week}</span> {g.home ? 'vs' : '@'} {shortTeam(g.opp)}{' '}
            <span style={{ color: g.mine > g.theirs ? C.green : g.mine < g.theirs ? C.warn : C.sub }}>
              {g.mine > g.theirs ? 'W' : g.mine < g.theirs ? 'L' : 'T'} {g.mine}-{g.theirs}
            </span>
          </div>
        )) : <span style={{ color: C.sub }}>No results yet this season.</span>}
      </div>
      <div style={{ fontSize: 10.5, color: C.sub, marginTop: 4 }}>ATS is against the closing line.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------
function buildRead({ signal, tier, game, config, systems, research, picks, ctx, homeAbbr, awayAbbr, pickAbbr, split, hitCount, hitOpp }) {
  const pros = [];
  const cons = [];
  const ae = Math.abs(signal.edge);
  const checklist = tierChecklist({ ...signal, tier }, config);
  const misses = checklist.rows.filter((r) => !r.pass);

  if (['3U', '2U', '1U'].includes(tier)) {
    pros.push(`${tier} play: clears every ${tier} threshold (vote ${Math.round(signal.vote_share * 100)}%, edge ${ae.toFixed(1)}, std dev ${signal.std_dev.toFixed(1)}, conviction ${signal.conviction.toFixed(2)}).`);
  } else if (tier === 'Lean') {
    cons.push('Lean only: record-only tier, no units.');
  } else {
    cons.push('No tier: the systems do not agree strongly enough for a play.');
  }
  if (misses.length && tier !== '3U') {
    const nm = nearMiss({ ...signal, tier }, config);
    const what = misses.map((m) => `${m.label.replace(/ [≥≤].*/, '').toLowerCase()} ${m.value}`).join(', ');
    (nm ? pros : cons).push(nm
      ? `Near miss for ${(checklist.title.match(/reach (\w+)/) || [])[1] || 'the next tier'}: short only on ${what}.`
      : `Short of ${(checklist.title.match(/reach (\w+)/) || [])[1] || 'the next tier'} on ${what}.`);
  }
  if (ae >= 6) cons.push(`Edge of ${ae.toFixed(1)} is flagged as unusually large. Big college edges have not held up ATS; check for injuries or a quarterback change.`);

  // top systems
  const top = systems.slice(0, 5);
  if (top.length === 5) {
    const onTop = top.filter((s) => s.on).length;
    if (onTop === 5) pros.push('All five highest-weighted systems are on this side.');
    else if (onTop <= 2) cons.push(`Only ${onTop} of the five highest-weighted systems are on this side.`);
  }
  if (signal.coverage != null && signal.coverage < (config.min_coverage ?? 0.7)) {
    cons.push(`Only ${Math.round(signal.coverage * 100)}% of system weight posted on this game (low coverage caps it at 1U).`);
  }

  // line movement since the open
  const cur = num(game.current_line);
  if (signal.opening_line != null && cur !== null) {
    const moved = cur - signal.opening_line;
    if (Math.abs(moved) >= 1.5) {
      const toward = Math.sign(moved) === Math.sign(signal.edge);
      (toward ? pros : cons).push(toward
        ? `The line has moved ${Math.abs(moved).toFixed(1)} from the opener toward the model (${fmtSpread(-signal.opening_line)} → ${fmtSpread(-cur)} ${homeAbbr}). Some value is gone, but the market agrees.`
        : `The line has moved ${Math.abs(moved).toFixed(1)} from the opener AWAY from the model (${fmtSpread(-signal.opening_line)} → ${fmtSpread(-cur)} ${homeAbbr}). Check injuries and news.`);
    }
    if (Math.abs(cur - signal.vegas_line) >= 0.5) {
      cons.push(`The model was computed against ${pickAbbr} ${teamLine(signal.vegas_line, signal.pick_side)}; the line is now ${pickAbbr} ${teamLine(cur, signal.pick_side)}. Re-check the edge at the new number.`);
    }
  }

  // Bobcat / hits
  if (signal.bobcat) {
    const rec = ctx ? recordOf(ctx.signals.filter((s) => s.bobcat && s.week < signal.week)) : null;
    pros.push(`Bobcat Formula Pick (experimental)${rec && rec.w + rec.l ? `: ${rec.w}-${rec.l}${rec.p ? `-${rec.p}` : ''} on Bobcat picks so far this season` : ''}.`);
  }
  if (split) cons.push(`Split top-k read: ${hitCount} systems flag one side, ${hitOpp} the other.`);

  // research
  const spreadTags = (research || []).filter((t) => (t.pick_type || 'spread') === 'spread' && (t.pick_side === 'home' || t.pick_side === 'away'));
  const withBobby = spreadTags.filter((t) => t.pick_side === signal.pick_side);
  const against = spreadTags.filter((t) => t.pick_side !== signal.pick_side);
  const srcName = (t) => normalizeSources(t.source_label).join('/');
  if (withBobby.length) pros.push(`Research on this side: ${withBobby.map(srcName).join(', ')}.`);
  if (against.length) cons.push(`Research on the other side: ${against.map(srcName).join(', ')}.`);
  if (ctx && spreadTags.length) {
    const agreeSides = ctx.report.sides.filter((s) => s.type === 'spread' && s.bobby && s.result && s.week < signal.week);
    const rec = blank();
    for (const s of agreeSides.filter((x) => x.bobby === (withBobby.length ? 'agree' : 'oppose'))) {
      if (s.result === 'win') rec.w += 1; else if (s.result === 'loss') rec.l += 1; else rec.p += 1;
    }
    if (rec.w + rec.l >= 10) {
      const p = rec.w / (rec.w + rec.l);
      const line = withBobby.length
        ? `This season, research sides that agreed with Bobby went ${rec.w}-${rec.l} (${(100 * p).toFixed(1)}%).`
        : `This season, research sides that went against Bobby went ${rec.w}-${rec.l} (${(100 * p).toFixed(1)}%).`;
      (withBobby.length ? (p >= 0.524 ? pros : cons) : (p >= 0.524 ? cons : pros)).push(line);
    }
  }
  const mine = (picks || []).filter((p) => (p.pick_type || 'spread') === 'spread' && (p.side === 'home' || p.side === 'away'));
  if (mine.some((p) => p.side !== signal.pick_side)) cons.push('Your own play on this game is on the other side.');

  // similar spots this season
  if (ctx) {
    const prior = ctx.signals.filter((s) => s.week < signal.week && s.grade);
    const same = recordOf(prior.filter((s) => s.tier === tier));
    if (same.w + same.l >= 10) {
      const p = same.w / (same.w + same.l);
      (p >= 0.524 ? pros : cons).push(`${tier} games this season: ${same.w}-${same.l}${same.p ? `-${same.p}` : ''} (${(100 * p).toFixed(1)}%).`);
    }
    const eb = edgeBucket(ae); const vb = voteBucket(signal.vote_share);
    const sim = recordOf(prior.filter((s) => edgeBucket(Math.abs(num(s.edge))) === eb && voteBucket(num(s.vote_share)) === vb));
    if (sim.w + sim.l >= 10) {
      const p = sim.w / (sim.w + sim.l);
      (p >= 0.524 ? pros : cons).push(`Similar spots this season (edge ${EDGE_LABEL[eb]}, vote ${VOTE_LABEL[vb]}): ${sim.w}-${sim.l}${sim.p ? `-${sim.p}` : ''} (${(100 * p).toFixed(1)}%).`);
    }
  }
  if (signal.std_dev >= 4) cons.push(`The systems are spread out (std dev ${signal.std_dev.toFixed(1)}).`);
  return { pros, cons, checklist };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export default function GameDetail({
  row, rank, config, logos, preds, weightsByModel, picks, research, season, week,
  onClose, onOpenPick, onOpenResearch, onRemoveResearch, onSaveNote,
}) {
  const { game, signal } = row;
  const home = game.home_team; const away = game.away_team;
  const homeAbbr = shortTeam(home); const awayAbbr = shortTeam(away);
  const tier = signal?.tier || 'No tier';
  const tierColor = TIER_COLOR[tier] || C.sub;
  const pickAbbr = signal?.pick_side === 'home' ? homeAbbr : awayAbbr;
  const pickTeam = signal?.pick_side === 'home' ? home : away;
  const currentLine = num(game.current_line);

  const [ctx, setCtx] = useState(null);
  const [ctxErr, setCtxErr] = useState(null);
  const [notes, setNotes] = useState(null);
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [topk, setTopk] = useState(null);
  const [topkErr, setTopkErr] = useState(null);
  const panelRef = useRef(null);

  useEffect(() => {
    let live = true;
    loadSeason(season).then((c) => { if (live) setCtx(c); }).catch((e) => { if (live) setCtxErr(e.message); });
    sbFetch(`user_picks?select=id,note,created_at&game_id=eq.${game.id}&played=eq.false&order=created_at.desc`)
      .then((r) => { if (live) setNotes(r.filter((n) => n.note)); }).catch(() => { if (live) setNotes([]); });
    if (signal) {
      sbRpc('cfb_topk_detail', { p_game_id: game.id })
        .then((rows) => { if (live) setTopk(rows.map((r) => ({ ...r, predicted_margin: parseFloat(r.predicted_margin), model_edge: parseFloat(r.model_edge), weight: r.weight != null ? parseFloat(r.weight) : null }))); })
        .catch((e) => { if (live) setTopkErr(e.message); });
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (panelRef.current) panelRef.current.scrollTop = 0;
    return () => { live = false; window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [game.id, season, signal, onClose]);

  const systems = useMemo(() => {
    if (!signal) return [];
    const rows = (preds || []).map((p) => ({ ...p, w: weightsByModel[p.model_id] })).filter((p) => p.w && p.w.weight > 0);
    const sw = rows.reduce((a, r) => a + r.w.weight, 0) || 1;
    return rows.sort((a, b) => b.w.weight - a.w.weight).map((r) => {
      const pm = parseFloat(r.predicted_margin);
      return {
        id: r.model_id, name: r.w.system_name, pm, share: (r.w.weight / sw) * 100,
        on: Math.sign(pm - signal.vegas_line) === Math.sign(signal.edge) && pm !== signal.vegas_line,
        rec: `${r.w.wins}-${r.w.losses}${r.w.pushes ? `-${r.w.pushes}` : ''}`, mae: r.w.mae, rank: r.w.rank,
      };
    });
  }, [signal, preds, weightsByModel]);

  const hitCount = signal?.hit_count ?? null;
  const hitOpp = signal?.hit_opp ?? null;
  const oppMin = Number.isFinite(config?.bobcat_opp_conflict) ? config.bobcat_opp_conflict : 3;
  const split = hitOpp != null && hitOpp >= oppMin;
  const topkPct = Math.round((Number.isFinite(config?.bobcat_topk_pct) ? config.bobcat_topk_pct : 0.1) * 100);
  const nm = signal ? nearMiss({ ...signal, tier }, config) : null;
  const flags = signal?.flags || [];

  const read = useMemo(() => (signal ? buildRead({
    signal, tier, game, config, systems, research, picks, ctx, homeAbbr, awayAbbr, pickAbbr, split, hitCount, hitOpp,
  }) : null), [signal, tier, game, config, systems, research, picks, ctx, homeAbbr, awayAbbr, pickAbbr, split, hitCount, hitOpp]);

  // result, if final
  const fin = ctx?.games.find((g) => g.id === game.id);
  const margin = fin ? (num(fin.actual_margin) ?? (fin.home_score != null && fin.away_score != null ? fin.home_score - fin.away_score : null)) : null;
  const coverBy = signal && margin !== null ? (signal.pick_side === 'home' ? margin - signal.vegas_line : signal.vegas_line - margin) : null;

  const homeForm = ctx ? teamForm(home, ctx.games, week ?? signal?.week ?? 99) : null;
  const awayForm = ctx ? teamForm(away, ctx.games, week ?? signal?.week ?? 99) : null;

  const sourceRec = useMemo(() => {
    const m = new Map();
    if (ctx) for (const s of ctx.report.sources) m.set(s.name, s);
    return m;
  }, [ctx]);

  const topkGroups = useMemo(() => {
    if (!topk) return [];
    const order = [...SYSTEM_FAMILIES.map((f) => f.name), 'Other'];
    const by = {};
    for (const r of topk) { const fam = FAMILY_OF[r.colname] || 'Other'; (by[fam] = by[fam] || []).push(r); }
    for (const k of Object.keys(by)) by[k].sort((a, b) => (b.flagged === a.flagged ? a.rn - b.rn : b.flagged - a.flagged));
    return order.filter((k) => by[k]?.length).map((k) => ({ family: k, rows: by[k] }));
  }, [topk]);

  const teamFor = (sd) => (sd === 'home' ? home : away);

  async function handleSaveNote() {
    if (!note.trim()) return;
    setSavingNote(true);
    try {
      await onSaveNote(note.trim());
      setNotes((n) => [{ id: `new-${Date.now()}`, note: note.trim(), created_at: new Date().toISOString() }, ...(n || [])]);
      setNote('');
    } finally { setSavingNote(false); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`${away} at ${home} detail`}
      style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)' }} />
      <div ref={panelRef} style={{
        position: 'relative', width: 'min(780px, 100%)', height: '100%', overflowY: 'auto', background: C.bg,
        borderLeft: `1px solid ${C.border}`, padding: '16px 16px 60px', color: C.text,
      }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {logos[away] && <img src={logos[away]} alt="" width={22} height={22} style={{ objectFit: 'contain' }} />}
              <span style={{ ...FH, fontSize: 19, fontWeight: 700 }}>{away} @ {home}</span>
              {logos[home] && <img src={logos[home]} alt="" width={22} height={22} style={{ objectFit: 'contain' }} />}
            </div>
            <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginTop: 3 }}>
              {rank ? `Bobby Rank #${rank} · ` : ''}{fmtKickoff(game.kickoff_at)}{game.tv_network ? ` · ${game.tv_network}` : ''}
              {game.over_under != null ? ` · O/U ${game.over_under}` : ''}
              {fin && fin.home_score != null ? ` · Final ${awayAbbr} ${fin.away_score}, ${homeAbbr} ${fin.home_score}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
              {signal && <Badge color={tier === 'No tier' ? C.sub : tierColor} filled>{tier}</Badge>}
              {nm && <Badge color={C.gold} dashed>Near miss · {nm}</Badge>}
              {signal?.bobcat && <Badge color={C.gold}>Bobcat Formula Pick</Badge>}
              {split && <Badge color={C.lav} filled>Split {hitCount} vs {hitOpp}</Badge>}
              {flags.map((f) => <Badge key={f} color={C.warn} filled>{f}</Badge>)}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, width: 34, height: 34, cursor: 'pointer', fontSize: 16,
          }}>✕</button>
        </div>

        {!signal && (
          <div style={{ ...box, color: C.sub, fontSize: 13 }}>No Bobby Model data for this game yet. Run Compute for this week on the Ingest page.</div>
        )}

        {signal && (
          <>
            {/* verdict */}
            <div style={{ ...box, borderLeft: `4px solid ${tier === 'No tier' ? C.border : tierColor}`, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.5 }}>BOBBY PICK</span>
                <span style={{ ...FM, fontSize: 11, fontWeight: 700, color: tierColor }}>{tier}{TIER_UNITS[tier] ? ` · ${TIER_UNITS[tier]}u` : ''}</span>
              </div>
              <div style={{ ...FH, fontSize: 22, fontWeight: 700, margin: '4px 0' }}>
                {pickTeam} {teamLine(signal.vegas_line, signal.pick_side)}
                {coverBy !== null && (
                  <span style={{ ...FM, fontSize: 14, marginLeft: 10, color: coverBy > 0 ? C.green : coverBy < 0 ? C.warn : C.sub }}>
                    {coverBy > 0 ? 'W' : coverBy < 0 ? 'L' : 'P'} ({signed(coverBy)})
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: '#C9CFC8' }}>
                Model {pickAbbr} {teamLine(signal.consensus, signal.pick_side)} vs Vegas {pickAbbr} {teamLine(signal.vegas_line, signal.pick_side)}
                {signal.opening_line != null ? ` (opened ${pickAbbr} ${teamLine(signal.opening_line, signal.pick_side)})` : ''}
                {currentLine !== null && currentLine !== signal.vegas_line ? ` · now ${pickAbbr} ${teamLine(currentLine, signal.pick_side)}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {(picks || []).map((p) => (
                  <Badge key={p.id} color={C.blue} filled onClick={() => onOpenPick(p)} title="Edit this play">
                    MY PLAY · {(parseFloat(p.units) || 1)}u {pickDescription(p, teamFor)}{p.result ? ` · ${p.result}` : ''}
                  </Badge>
                ))}
                <Badge color={C.blue} dashed onClick={() => onOpenPick(null)}>{(picks || []).length ? '+ Bet' : '+ Bobby Pick'}</Badge>
                <Badge color={C.sub} dashed onClick={onOpenResearch}>+ Research</Badge>
              </div>
            </div>

            {/* stat grid */}
            <div style={{ ...box, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: '12px 16px', marginBottom: 12 }}>
              <Stat k="Edge" v={`+${Math.abs(signal.edge).toFixed(1)} pts`} info="edge" config={config} />
              <Stat k="Vote share" v={`${Math.round(signal.vote_share * 100)}%`} note={`${systems.filter((s) => s.on).length} of ${signal.voters} systems`} info="vs" config={config} />
              <Stat k="Std dev" v={`${signal.std_dev.toFixed(1)} pts`} info="sd" config={config} />
              <Stat k="Conviction" v={signal.conviction.toFixed(2)} info="conv" config={config} />
              <Stat k="Top 5 systems" v={systems.length >= 5 ? `${systems.slice(0, 5).filter((s) => s.on).length} of 5` : '—'} note="on this side" />
              <Stat k="Coverage" v={signal.coverage != null ? `${Math.round(signal.coverage * 100)}%` : '—'} note="of weight posted" info="lowcov" config={config} />
              <Stat k={`Top-${topkPct}% hits`} v={hitCount == null ? '—' : `${hitCount}/${signal.models_n ?? '—'}${signal.hit_side ? ` ${signal.hit_side === 'home' ? homeAbbr : awayAbbr}` : ''}`} info="hits" config={config} />
              <Stat k="Line move" v={`${signal.opening_line != null ? fmtSpread(-signal.opening_line) : '—'} → ${fmtSpread(-(currentLine ?? signal.vegas_line))}`} note={`${homeAbbr} line`} info="move" config={config} />
            </div>

            {/* the read */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 12, marginBottom: 12 }}>
              <div style={{ ...box, borderTop: `3px solid ${C.green}` }}>
                <div style={h3}>For this pick</div>
                {read.pros.length ? read.pros.map((p, i) => <p key={i} style={{ fontSize: 12.5, lineHeight: 1.55, margin: '0 0 7px' }}>{p}</p>)
                  : <p style={{ fontSize: 12.5, color: C.sub, margin: 0 }}>Nothing stands out.</p>}
              </div>
              <div style={{ ...box, borderTop: `3px solid ${C.warn}` }}>
                <div style={h3}>Against / check first</div>
                {read.cons.length ? read.cons.map((p, i) => <p key={i} style={{ fontSize: 12.5, lineHeight: 1.55, margin: '0 0 7px' }}>{p}</p>)
                  : <p style={{ fontSize: 12.5, color: C.sub, margin: 0 }}>No warning signs in the numbers.</p>}
                {!ctx && !ctxErr && <p style={{ fontSize: 11.5, color: C.sub, margin: 0 }}>Loading season history…</p>}
                {ctxErr && <p style={{ fontSize: 11.5, color: C.warn, margin: 0 }}>Season history did not load: {ctxErr}</p>}
              </div>
            </div>

            {/* research */}
            <div style={{ ...box, marginBottom: 12 }}>
              <div style={h3}>
                Research tags ({(research || []).length})
                <span style={{ flex: 1 }} />
                <Badge color={C.sub} dashed onClick={onOpenResearch}>+ Research</Badge>
              </div>
              {!(research || []).length && <div style={{ fontSize: 12, color: C.sub }}>No research tags on this game yet.</div>}
              {(research || []).map((t) => {
                const names = normalizeSources(t.source_label);
                const type = t.pick_type || 'spread';
                const agrees = type === 'spread' && (t.pick_side === 'home' || t.pick_side === 'away') ? t.pick_side === signal.pick_side : null;
                return (
                  <div key={t.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ ...FH, fontSize: 13.5, fontWeight: 700 }}>{researchDescription(t, teamFor)}</span>
                        <span style={{ ...FM, fontSize: 11.5, color: C.gold }}>{t.source_label || 'Unlabeled'}</span>
                        {agrees !== null && (
                          <span style={{ ...FM, fontSize: 10.5, color: agrees ? C.green : C.warn }}>{agrees ? 'with Bobby' : 'against Bobby'}</span>
                        )}
                      </div>
                      {t.note && <div style={{ fontSize: 12, color: '#C9CFC8', marginTop: 3 }}>{t.note}</div>}
                      <div style={{ ...FM, fontSize: 11, color: C.sub, marginTop: 3 }}>
                        {names.map((n) => {
                          const s = sourceRec.get(n);
                          if (!s) return null;
                          const p = recPct(s.rec);
                          return (
                            <span key={n} style={{ marginRight: 12 }}>
                              {n} this season: <span style={{ color: p === null ? C.sub : p >= 0.524 ? C.green : C.warn }}>{recStr(s.rec)}{p !== null ? ` (${(100 * p).toFixed(1)}%)` : ''}</span>
                              {s.agree + s.oppose ? ` · sided with Bobby ${s.agree} of ${s.agree + s.oppose}` : ''}
                            </span>
                          );
                        })}
                        {t.line_at_tag != null && <span>tagged at {homeAbbr} {fmtSpread(-num(t.line_at_tag))}</span>}
                      </div>
                    </div>
                    <button onClick={() => onRemoveResearch(t.id)} aria-label="Remove research tag" style={{
                      alignSelf: 'start', background: 'transparent', border: `1px solid ${C.border}`, color: C.sub, borderRadius: 5, width: 26, height: 26, cursor: 'pointer',
                    }}>×</button>
                  </div>
                );
              })}
            </div>

            {/* number line */}
            <div style={{ ...box, marginBottom: 12 }}>
              <div style={h3}>Where everyone sits</div>
              <NumberLine signal={signal} systems={systems} homeAbbr={homeAbbr} currentLine={currentLine} />
            </div>

            {/* checklist + vote split */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 12, marginBottom: 12 }}>
              <div style={box}>
                <div style={h3}>Tier checklist <Info k="checks" config={config} /></div>
                <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 6 }}>{read.checklist.title}</div>
                {read.checklist.rows.map((r, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 64px 40px', gap: 8, padding: '5px 0', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 12 }}>
                    <span style={{ color: '#C9CFC8' }}>{r.label}</span>
                    <span style={{ textAlign: 'right' }}>{r.value}</span>
                    <span style={{ fontWeight: 700, color: r.pass ? C.green : C.warn }}>{r.pass ? 'Pass' : 'Miss'}</span>
                  </div>
                ))}
              </div>
              <div style={box}>
                <div style={h3}>How the vote breaks <Info k="vs" config={config} /></div>
                <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', margin: '4px 0 8px' }}>
                  <div style={{ width: `${(signal.vote_share * 100).toFixed(1)}%`, background: C.green }} />
                  <div style={{ width: `${((1 - signal.vote_share) * 100).toFixed(1)}%`, background: C.warn }} />
                </div>
                <div style={{ ...FM, fontSize: 11.5, color: C.green }}>{pickAbbr} · {(signal.vote_share * 100).toFixed(1)}% of weight · {systems.filter((s) => s.on).length} systems</div>
                <div style={{ ...FM, fontSize: 11.5, color: C.warn }}>{signal.pick_side === 'home' ? awayAbbr : homeAbbr} · {((1 - signal.vote_share) * 100).toFixed(1)}% · {systems.filter((s) => !s.on).length} systems</div>
              </div>
            </div>

            {/* systems */}
            <div style={{ ...box, padding: 0, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ ...h3, padding: '10px 13px', margin: 0 }}>Systems ({systems.length} voting) <Info k="weight" config={config} /></div>
              <div style={{ overflowX: 'auto' }}>
                {(() => {
                  const cols = 'minmax(0,1.3fr) 92px 118px 56px 92px 80px 50px';
                  return (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '6px 13px', background: C.surface2, minWidth: 640, ...lab }}>
                        <span>System</span><span>Weight</span><span>Predicts</span><span>vs line</span><span>Side</span><span>2026 ATS</span><span>Avg err</span>
                      </div>
                      {systems.map((s) => {
                        const d = s.pm - signal.vegas_line;
                        return (
                          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '6px 13px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 11.5, minWidth: 640 }}>
                            <span style={{ ...FH, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ flexGrow: 1, height: 5, background: C.bg, borderRadius: 3, overflow: 'hidden' }}>
                                <span style={{ display: 'block', height: '100%', width: `${Math.min(100, (s.share / 16) * 100)}%`, background: s.on ? C.green : C.warn }} />
                              </span>
                              <span style={{ width: 36, textAlign: 'right', color: '#C9CFC8' }}>{s.share.toFixed(1)}%</span>
                            </span>
                            <span>{homeAbbr} {fmtSpread(-s.pm)}</span>
                            <span style={{ color: s.on ? C.green : C.warn }}>{signed(-d)}</span>
                            <span style={{ fontWeight: 700, color: s.on ? C.green : C.warn, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.on ? pickAbbr : (signal.pick_side === 'home' ? awayAbbr : homeAbbr)}</span>
                            <span style={{ color: C.sub }}>{s.rec}</span>
                            <span style={{ color: C.sub }}>{s.mae != null ? f1(s.mae) : '—'}</span>
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
              <div style={{ padding: '8px 13px', fontSize: 11, color: C.sub, borderTop: `1px solid ${C.border}` }}>
                vs line is in {homeAbbr} line points (− = more {homeAbbr}). Only systems with weight this week are shown.
              </div>
            </div>

            {/* top-k hits / Bobcat */}
            <div style={{ ...box, border: `1px solid ${signal.bobcat ? C.gold : C.border}`, marginBottom: 12 }}>
              <div style={h3}>
                Top-{topkPct}% hits <Info k="hits" config={config} />
                {signal.bobcat && <Badge color={C.gold}>Bobcat Formula Pick <Info k="bobcat" config={config} /></Badge>}
                {split && <Badge color={C.lav} filled>Split {hitCount} vs {hitOpp}</Badge>}
              </div>
              <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginBottom: 8 }}>
                {hitCount != null ? `${hitCount} of ${signal.models_n ?? '—'} systems put this game in their own top ${topkPct}% of edges${signal.hit_side ? `, majority on ${signal.hit_side === 'home' ? homeAbbr : awayAbbr}` : ''}.` : 'No hit data.'}
              </div>
              {topkErr && <span style={{ ...FM, fontSize: 11, color: C.warn }}>Could not load system detail: {topkErr}</span>}
              {!topk && !topkErr && <span style={{ ...FM, fontSize: 11, color: C.sub }}>Loading system detail…</span>}
              {topkGroups.map((grp) => (
                <div key={grp.family} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                  <span style={lab}>{grp.family} · {grp.rows.filter((r) => r.flagged).length} of {grp.rows.length} flagged</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {grp.rows.map((r) => (
                      <span key={r.model_id}
                        title={`${r.system_name} — edge ${r.model_edge > 0 ? '+' : ''}${r.model_edge.toFixed(1)}, its own rank ${r.rn} of ${r.n} games${r.weight != null ? `, weight ${(r.weight * 100).toFixed(1)}%` : ', unweighted'}`}
                        style={{
                          ...FM, fontSize: 10.5, padding: '3px 7px', borderRadius: 4, whiteSpace: 'nowrap', display: 'inline-flex', gap: 5,
                          border: `1px solid ${r.flagged ? C.gold : C.border}`, background: r.flagged ? `${C.gold}1A` : 'transparent',
                          color: r.flagged ? C.text : C.sub, opacity: r.flagged ? 1 : 0.55,
                        }}>
                        <span>{r.colname.replace(/^line/, '')}</span>
                        {r.side && <span style={{ fontWeight: 700, color: r.flagged ? C.gold : C.sub }}>{r.side === 'home' ? 'H' : 'A'}</span>}
                        <span>{r.rn} of {r.k}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* team form */}
        {ctx && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <TeamCard name={away} logo={logos[away]} form={awayForm} />
            <TeamCard name={home} logo={logos[home]} form={homeForm} />
          </div>
        )}

        {/* notes */}
        <div style={{ ...box, marginBottom: 12 }}>
          <div style={h3}>Notes</div>
          {(notes || []).map((n) => (
            <div key={n.id} style={{ fontSize: 12.5, lineHeight: 1.5, padding: '6px 0', borderTop: `1px solid ${C.border}` }}>
              <span style={{ ...FM, fontSize: 10.5, color: C.sub, marginRight: 8 }}>
                {new Date(n.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
              {n.note}
            </div>
          ))}
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Injuries, weather, line shopping, why you played it or passed…"
            style={{ ...FM, fontSize: 12, width: '100%', boxSizing: 'border-box', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, padding: 10, resize: 'vertical', marginTop: 6 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button onClick={handleSaveNote} disabled={savingNote || !note.trim()} style={{
              ...FM, fontSize: 12, minHeight: 34, padding: '0 14px', borderRadius: 4, border: `1px solid ${C.gold}`, background: `${C.gold}1A`, color: C.gold, cursor: 'pointer',
            }}>{savingNote ? 'Saving…' : 'Save note'}</button>
          </div>
        </div>

        <p style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6 }}>
          Tracking and research with paper units, not a recommendation. Season records above use games before this week.
        </p>
      </div>
    </div>
  );
}
