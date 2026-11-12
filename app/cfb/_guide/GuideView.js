'use client';
import { fmtSigned } from '../../../lib/research-report';

export const FORWARD_FROM = 11;

const kick = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(' AM', 'a').replace(' PM', 'p');
};
const rec = (r) => `${r.w}-${r.l}${r.p ? `-${r.p}` : ''}`;
const u = (n) => `${n > 0 ? '+' : ''}${n}u`;
const SECTION_COLOR = { core: '#0f7a5a', lean: '#1f5fbf', three: '#8a6d1a', two: '#8a6d1a', model: '#555', against: '#b3412c', other: '#555' };
const SECTION_NAME = { core: 'Core card', lean: 'Leans', three: 'Model 3U', two: 'Model 2U', model: 'Model only', against: 'Research vs model', other: 'Other tag' };


function Header({ guide, stamp, asOf }) {
  const c = guide.counts;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="g-title">Week {guide.week} Weekend Guide</div>
        <div className="g-meta">Signals as of {asOf} · built {stamp} ET</div>
      </div>
      <div className="g-meta">{c.games} games · {c.tiered} model plays · {c.tagsThisWeek} research tags · {c.myPlays} of your plays</div>
    </div>
  );
}

function Evidence({ s }) {
  const e = s.evidence;
  return (
    <span className="g-ev">
      wk 1-{guide0(s)}: {rec(e.backfill)} ({u(e.backfill.units)}) · forward: {e.forward.w + e.forward.l + e.forward.p ? `${rec(e.forward)} (${u(e.forward.units)})` : 'none yet'}
    </span>
  );
}
const guide0 = () => FORWARD_FROM - 1;

function Section({ s, compact, full, limit }) {
  if (!s) return null;
  const color = SECTION_COLOR[s.id];
  return (
    <div className="g-sec" style={full ? { borderColor: color } : null}>
      <div className="g-sec-h">
        <span style={{ color, fontWeight: 800 }}>{s.title} ({s.plays.length})</span>
        <Evidence s={s} />
      </div>
      <div className="g-rule">{s.rule}</div>
      {s.plays.length === 0 && <div className="g-none">None this week.</div>}
      {(limit ? s.plays.slice(0, limit) : s.plays).map((p) => (compact ? <CompactRow key={p.key} p={p} /> : <PlayRow key={p.key} p={p} color={color} />))}
      {limit && s.plays.length > limit && <div className="g-none">+{s.plays.length - limit} more on Play Finder.</div>}
    </div>
  );
}

function PlayRow({ p, color }) {
  return (
    <div className="g-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div><span className="g-pick" style={{ color }}>{p.pick}</span> <span className="g-vs">{p.atHome ? 'vs' : '@'} {p.opp}</span></div>
        <div className="g-kick">{kick(p.kickoff)}</div>
      </div>
      <div className="g-chips">
        {p.tier && <Chip c="#8a6d1a">Model {p.tier}</Chip>}
        {p.kam && <Chip c="#1f5fbf">{p.kam}</Chip>}
        {p.labels.filter((l) => !/^KAM/i.test(l)).map((l) => <Chip key={l} c="#444">{l}</Chip>)}
        {p.flags.map((f) => <Chip key={f} c="#b3412c">{f}</Chip>)}
        {p.mine.length > 0 && <Chip c="#0f7a5a" solid>MY PLAY</Chip>}
      </div>
    </div>
  );
}

function CompactRow({ p }) {
  return (
    <div className="g-compact">
      <b>{p.pick}</b> <span className="g-vs">{p.atHome ? 'vs' : '@'} {p.opp}</span>
      <span className="g-vs"> · {p.tier ? `Model ${p.tier}` : ''}{p.labels.length ? `${p.tier ? ' · ' : ''}${p.labels.join(', ')}` : ''}</span>
      {p.mine.length > 0 && <Chip c="#0f7a5a" solid>MY PLAY</Chip>}
      <span className="g-kick" style={{ float: 'right' }}>{kick(p.kickoff)}</span>
    </div>
  );
}

function MyCard({ rows }) {
  return (
    <div className="g-sec">
      <div className="g-sec-h"><span style={{ fontWeight: 800 }}>My card ({rows.length})</span></div>
      {rows.length === 0 && <div className="g-none">Nothing logged yet. Use + Bobby Pick on THE Bobby Model.</div>}
      {rows.map((m) => (
        <div key={m.id} className="g-compact">
          {m.lock && <span title="Lock">🔒 </span>}<b>{m.desc}</b> <span className="g-vs">{m.matchup}{m.units ? ` · ${m.units}u` : ''}</span>
          {m.relation && <Chip c={m.relation.kind === 'with' ? '#0f7a5a' : '#b3412c'}>{m.relation.kind === 'with' ? 'with' : 'against'} {SECTION_NAME[m.relation.section] || ''}</Chip>}
          {m.result && <Chip c={m.result === 'win' ? '#0f7a5a' : m.result === 'loss' ? '#b3412c' : '#555'}>{m.result.toUpperCase()}</Chip>}
          <span className="g-kick" style={{ float: 'right' }}>{kick(m.kickoff)}</span>
        </div>
      ))}
    </div>
  );
}

function Totals({ rows }) {
  return (
    <div className="g-sec">
      <div className="g-sec-h"><span style={{ fontWeight: 800 }}>Totals tags ({rows.length})</span><span className="g-ev">track only: totals tags were a net loser in weeks 1-10</span></div>
      {rows.length === 0 && <div className="g-none">None this week.</div>}
      {rows.slice(0, 8).map((t) => (
        <div key={`${t.game_id}${t.side}`} className="g-compact">
          <b>{t.side === 'over' ? 'Over' : 'Under'} {t.total ?? ''}</b> <span className="g-vs">{t.matchup} · {t.labels.join(', ')}</span>
          <span className="g-kick" style={{ float: 'right' }}>{kick(t.kickoff)}</span>
        </div>
      ))}
      {rows.length > 8 && <div className="g-none">+{rows.length - 8} more totals tags (fewer sources each).</div>}
    </div>
  );
}

function Chip({ c, solid, children }) {
  return <span className="g-chip" style={solid ? { background: c, color: '#fff', borderColor: c } : { color: c, borderColor: c }}>{children}</span>;
}


export function GuideSheets({ guide, stamp, asOf, p1, p2 }) {
  const sec = (id) => guide.sections.find((s) => s.id === id);
  return (
    <>
      <style>{PRINT_CSS}</style>
      <div ref={p1} className="guide-sheet">
        <Header guide={guide} stamp={stamp} asOf={asOf} />
        {guide.warnings.map((w, i) => <div key={i} className="g-warn">{w}</div>)}
        <Section s={sec('core')} full />
        <Section s={sec('lean')} />
        <MyCard rows={guide.myCard} />
      </div>

      <div ref={p2} className="guide-sheet guide-page2">
        <div className="g-h2">Model, research and totals (track-only unless noted)</div>
        <Section s={sec('three')} compact />
        <Section s={sec('two')} compact />
        <Section s={sec('against')} compact limit={6} />
        <Section s={sec('model')} compact limit={8} />
        <Section s={sec('other')} compact limit={8} />
        <Totals rows={guide.totals} />
        <div className="g-foot">
          Paper units: flat 1u, win +1 / loss −1.1. Rules were found by slicing weeks 1-{FORWARD_FROM - 1}, so those records are hypotheses; only forward weeks ({FORWARD_FROM}+) count as proof, and buckets need 30+ forward games. Confirm the line at your book before betting.
        </div>
      </div>
    </>
  );
}

const PRINT_CSS = `
.guide-sheet{background:#fff;color:#161a22;border-radius:10px;padding:18px 20px;margin:0 auto 16px;max-width:820px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.g-title{font-size:22px;font-weight:900}
.g-meta{font-size:11px;color:#667}
.g-h2{font-size:15px;font-weight:800;margin-bottom:6px}
.g-warn{background:#fff4e0;border:1px solid #e5a64f;color:#7a4b00;font-size:12px;padding:6px 8px;border-radius:6px;margin:6px 0}
.g-sec{border:1px solid #d8dde6;border-radius:8px;padding:8px 10px;margin:8px 0}
.g-sec-h{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:14px}
.g-ev{font-size:11px;color:#667}
.g-rule{font-size:11px;color:#667;margin:1px 0 4px}
.g-none{font-size:12px;color:#889;padding:2px 0}
.g-row{padding:6px 0;border-top:1px solid #eef0f4}
.g-pick{font-size:17px;font-weight:900}
.g-vs{font-size:12px;color:#556}
.g-kick{font-size:12px;color:#556;white-space:nowrap}
.g-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
.g-chip{display:inline-block;border:1px solid;border-radius:4px;padding:0 5px;font-size:10.5px;font-weight:700;margin-left:4px}
.g-chips .g-chip{margin-left:0}
.g-compact{font-size:12.5px;padding:3px 0;border-top:1px solid #eef0f4}
.g-foot{font-size:10.5px;color:#667;margin-top:8px;line-height:1.4}
@media print{
  nav,.guide-controls{display:none !important}
  body{background:#fff !important}
  .page{padding:0 !important;margin:0 !important;max-width:none !important}
  .guide-sheet{box-shadow:none;border-radius:0;margin:0;padding:6px 10px;max-width:none;zoom:.82}
  .guide-page2{page-break-before:always;break-before:page;zoom:.68}
  .g-row{padding:3px 0}
  .g-pick{font-size:15px}
  @page{size:letter;margin:.4in}
}
`;
