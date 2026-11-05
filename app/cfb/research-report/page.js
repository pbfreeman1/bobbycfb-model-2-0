'use client';
// Research Report: review and analyze the research tags (research_picks)
// next to THE Bobby Model's signal for each game. Mobile first: one column of
// tappable cards, a sticky filter bar, and horizontally scrollable tabs.
//
// Reads only. Tags are still added and removed on the dashboard (+ Research)
// and the Research page. Aggregation lives in lib/research-report.js.
import { useEffect, useMemo, useState } from 'react';
import { sbFetchAll } from '../../../lib/supabase';
import { shortTeam } from '../../../lib/team-short';
import { buildReport, recStr, recPct, sideLabel, fmtSigned } from '../../../lib/research-report';

const C = {
  bg: '#0F1412', surface: '#161D1A', surface2: '#1B2320', border: '#2A332E',
  text: '#EDEFE8', sub: '#8B9992', gold: '#D4A73C', green: '#6FBF73',
  blue: '#5B9BD4', warn: '#E07A62', lav: '#B39DDB',
};
const NUM = { fontVariantNumeric: 'tabular-nums' };
const SEASON = 2026;

const TYPE_OPTS = [
  { v: 'all', label: 'All' },
  { v: 'ats', label: 'ATS' },
  { v: 'ou', label: 'O/U' },
];
const TABS = [
  { v: 'sides', label: 'Sides' },
  { v: 'games', label: 'Games' },
  { v: 'sources', label: 'Sources' },
  { v: 'weeks', label: 'Weeks' },
];

const typeMatch = (t, f) => f === 'all' || (f === 'ats' ? (t.pick_type || 'spread') !== 'total' && (t.pick_type || 'spread') !== 'custom' : (t.pick_type || 'spread') === 'total');

const fmtPct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const fmtKick = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); }
  catch { return ''; }
};

export default function ResearchReport() {
  const [raw, setRaw] = useState(null);       // { tags, games, signals }
  const [error, setError] = useState(null);
  const [week, setWeek] = useState(null);     // number | 'all'
  const [typeF, setTypeF] = useState('all');
  const [minTags, setMinTags] = useState(1);
  const [bobbyF, setBobbyF] = useState('all');   // all | agree | oppose
  const [statusF, setStatusF] = useState('all'); // all | open | graded
  const [sortBy, setSortBy] = useState('tags');  // tags | edge | kickoff
  const [srcSort, setSrcSort] = useState('tags'); // tags | pct
  const [tab, setTab] = useState('sides');
  const [openKey, setOpenKey] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tags, games, signals] = await Promise.all([
          sbFetchAll(`research_picks?select=*&season=eq.${SEASON}&order=created_at.asc`),
          sbFetchAll(`games?select=id,week,home_team,away_team,kickoff_at,current_line,over_under,home_score,away_score,actual_margin,status&season=eq.${SEASON}&order=id.asc`),
          sbFetchAll(`cfb_game_signals?select=game_id,computed_at,pick_side,vegas_line,consensus,edge,vote_share,std_dev,conviction,tier,units,hit_count,hit_side,bobcat,rank_in_week,coverage&season=eq.${SEASON}&order=game_id.asc,computed_at.asc`),
        ]);
        if (cancelled) return;
        setRaw({ tags, games, signals });
        const wks = tags.map((t) => t.week);
        setWeek(wks.length ? Math.max(...wks) : 'all');
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, []);

  const weeksWithTags = useMemo(() => (raw ? [...new Set(raw.tags.map((t) => t.week))].sort((a, b) => b - a) : []), [raw]);

  // Season-wide (type filter only) feeds the Weeks tab; the week filter feeds the rest.
  const reportSeason = useMemo(() => raw && buildReport({ ...raw, tags: raw.tags.filter((t) => typeMatch(t, typeF)) }), [raw, typeF]);
  const report = useMemo(
    () => raw && buildReport({ ...raw, tags: raw.tags.filter((t) => typeMatch(t, typeF) && (week === 'all' || t.week === week)) }),
    [raw, typeF, week],
  );

  const sides = useMemo(() => {
    if (!report) return [];
    let list = report.sides.filter((s) => s.count >= minTags);
    if (bobbyF !== 'all') list = list.filter((s) => s.bobby === bobbyF);
    if (statusF === 'open') list = list.filter((s) => s.result == null);
    if (statusF === 'graded') list = list.filter((s) => s.result != null);
    const edgeOf = (s) => (s.signal && s.bobby ? Math.abs(+s.signal.edge || 0) : -1);
    const kick = (s) => (s.game?.kickoff_at ? Date.parse(s.game.kickoff_at) : Infinity);
    list.sort((a, b) => {
      if (sortBy === 'edge') return edgeOf(b) - edgeOf(a) || b.count - a.count;
      if (sortBy === 'kickoff') return kick(a) - kick(b) || b.count - a.count;
      return b.count - a.count || b.sources.size - a.sources.size || edgeOf(b) - edgeOf(a);
    });
    return list;
  }, [report, minTags, bobbyF, statusF, sortBy]);

  const games = useMemo(() => {
    if (!report) return [];
    let list = report.games.filter((g) => g.total >= minTags);
    if (statusF === 'open') list = list.filter((g) => !isFinal(g.game));
    if (statusF === 'graded') list = list.filter((g) => isFinal(g.game));
    if (bobbyF !== 'all') {
      list = list.filter((g) => {
        const sig = g.signal;
        if (!sig) return false;
        const topSide = g.counts.home >= g.counts.away ? 'home' : 'away';
        if (g.counts.home + g.counts.away === 0) return false;
        return bobbyF === 'agree' ? sig.pick_side === topSide : sig.pick_side !== topSide;
      });
    }
    const kick = (g) => (g.game?.kickoff_at ? Date.parse(g.game.kickoff_at) : Infinity);
    list.sort((a, b) => (sortBy === 'kickoff' ? kick(a) - kick(b) : b.total - a.total || kick(a) - kick(b)));
    return list;
  }, [report, minTags, bobbyF, statusF, sortBy]);

  const sources = useMemo(() => {
    if (!report) return [];
    const list = [...report.sources];
    list.sort((a, b) => (srcSort === 'pct'
      ? (b.pct ?? -1) - (a.pct ?? -1) || (b.rec.w + b.rec.l) - (a.rec.w + a.rec.l)
      : b.tags - a.tags || a.name.localeCompare(b.name)));
    return list;
  }, [report, srcSort]);

  if (error) return <div className="page"><div className="error-msg">{error}</div></div>;
  if (!raw || !report) return <div className="page"><div className="loading">Loading research tags…</div></div>;

  const s = report.summary;
  const showSort = tab === 'sides' || tab === 'games';

  return (
    <div className="page rr-page">
      <style>{CSS}</style>
      <div className="page-header" style={{ marginBottom: 12 }}>
        <h1>📊 Research Report</h1>
        <p>Every research tag, counted by side, with THE Bobby Model alongside.</p>
      </div>

      {/* Sticky filter bar */}
      <div className="rr-bar">
        <div className="rr-row">
          <select className="rr-select" aria-label="Week" value={week} onChange={(e) => setWeek(e.target.value === 'all' ? 'all' : +e.target.value)}>
            <option value="all">All weeks</option>
            {weeksWithTags.map((w) => <option key={w} value={w}>Week {w}</option>)}
          </select>
          <Seg value={typeF} onChange={setTypeF} opts={TYPE_OPTS} />
        </div>
        <div className="rr-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.v} role="tab" aria-selected={tab === t.v} className={`rr-tab${tab === t.v ? ' on' : ''}`} onClick={() => setTab(t.v)}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="rr-stats">
        <Stat label="Tags" value={s.tags} />
        <Stat label="Sides" value={s.sides} />
        <Stat label="Games" value={s.games} />
        <Stat label="Sources" value={s.sources} />
      </div>
      {(s.sideRec.w + s.sideRec.l + s.sideRec.p) > 0 && (
        <div className="rr-rec" style={NUM}>
          Graded so far: <b>{recStr(s.sideRec)}</b> by side ({fmtPct(recPct(s.sideRec))}) · <b>{recStr(s.tagRec)}</b> by tag ({fmtPct(recPct(s.tagRec))})
        </div>
      )}

      {/* Secondary filters */}
      {(tab === 'sides' || tab === 'games') && (
        <div className="rr-filters">
          <Seg small value={minTags} onChange={setMinTags} opts={[{ v: 1, label: '1+ tags' }, { v: 2, label: '2+' }, { v: 3, label: '3+' }]} />
          <Seg small value={bobbyF} onChange={setBobbyF} opts={[{ v: 'all', label: 'Any Bobby' }, { v: 'agree', label: 'Agrees' }, { v: 'oppose', label: 'Opposes' }]} />
          <Seg small value={statusF} onChange={setStatusF} opts={[{ v: 'all', label: 'All' }, { v: 'open', label: 'Open' }, { v: 'graded', label: 'Graded' }]} />
          {showSort && (
            <Seg small value={sortBy} onChange={setSortBy} opts={[{ v: 'tags', label: 'Sort: tags' }, ...(tab === 'sides' ? [{ v: 'edge', label: 'Sort: edge' }] : []), { v: 'kickoff', label: 'Sort: kickoff' }]} />
          )}
        </div>
      )}

      {/* Views */}
      {tab === 'sides' && (
        sides.length === 0 ? <div className="empty">No tagged sides match these filters.</div> : (
          <div className="rr-list">
            {sides.map((sd, i) => (
              <SideCard key={sd.key} side={sd} rank={i + 1} open={openKey === sd.key} onToggle={() => setOpenKey(openKey === sd.key ? null : sd.key)} />
            ))}
          </div>
        )
      )}

      {tab === 'games' && (
        games.length === 0 ? <div className="empty">No tagged games match these filters.</div> : (
          <div className="rr-list">
            {games.map((g) => <GameCard key={g.game_id} g={g} />)}
          </div>
        )
      )}

      {tab === 'sources' && (
        <>
          <div className="rr-filters">
            <Seg small value={srcSort} onChange={setSrcSort} opts={[{ v: 'tags', label: 'Sort: tags' }, { v: 'pct', label: 'Sort: win %' }]} />
          </div>
          {sources.length === 0 ? <div className="empty">No sources yet.</div> : (
            <div className="rr-list">
              {sources.map((r) => <SourceRow key={r.name} r={r} />)}
            </div>
          )}
          <div className="rr-note">Similar labels are folded into one source (for example every “Kam - #n” is KAM). A tag naming several outlets credits each. Tags with no source are grouped under Unlabeled. Win % grades the tagged side against the line and counts each tag, so a side tagged by three sources is three results.</div>
        </>
      )}

      {tab === 'weeks' && (
        reportSeason.weeks.length === 0 ? <div className="empty">No tags yet.</div> : (
          <div className="rr-list">
            {reportSeason.weeks.map((w) => (
              <button key={w.week} className="rr-card rr-weekrow" onClick={() => { setWeek(w.week); setTab('sides'); }}>
                <div className="rr-wk">Wk {w.week}</div>
                <div className="rr-grow">
                  <div style={{ ...NUM, fontSize: 13 }}>{w.tags} tags · {w.games} games</div>
                  <div style={{ ...NUM, fontSize: 12, color: C.sub }}>
                    {(w.sideRec.w + w.sideRec.l + w.sideRec.p) ? `Sides ${recStr(w.sideRec)} (${fmtPct(w.pct)})` : 'Nothing graded yet'}
                  </div>
                </div>
                <div style={{ color: C.sub }}>›</div>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}

const isFinal = (g) => !!g && (g.status === 'final' || g.actual_margin != null);

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function Seg({ value, onChange, opts, small }) {
  return (
    <div className={`rr-seg${small ? ' sm' : ''}`} role="group">
      {opts.map((o) => (
        <button key={String(o.v)} className={value === o.v ? 'on' : ''} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rr-stat">
      <div className="rr-stat-n" style={NUM}>{value}</div>
      <div className="rr-stat-l">{label}</div>
    </div>
  );
}

function ResultBadge({ result }) {
  if (!result) return null;
  const map = { win: [C.green, 'WIN'], loss: [C.warn, 'LOSS'], push: [C.sub, 'PUSH'] };
  const [color, text] = map[result];
  return <span className="rr-badge" style={{ color, borderColor: color }}>{text}</span>;
}

function BobbyStrip({ signal, bobby, tagSide, game }) {
  if (!signal) return <div className="rr-bobby dim">No Bobby signal for this game yet</div>;
  const pickTeam = signal.pick_side === 'home' ? game?.home_team : game?.away_team;
  const sp = fmtSigned(signal.pick_side === 'home' ? -signal.vegas_line : +signal.vegas_line);
  const tier = signal.tier && signal.tier !== 'No tier' ? signal.tier : null;
  const bits = [
    tier && `${tier}`,
    signal.edge != null && `edge ${Math.abs(+signal.edge).toFixed(1)}`,
    signal.vote_share != null && `${Math.round(+signal.vote_share * 100)}% of weight`,
    signal.std_dev != null && `σ ${(+signal.std_dev).toFixed(1)}`,
    signal.hit_count != null && signal.hit_count > 0 && `${signal.hit_count} hits`,
  ].filter(Boolean);
  return (
    <div className="rr-bobby">
      <div className="rr-bobby-top">
        <span className="rr-bobby-l">Bobby</span>
        <b>{shortTeam(pickTeam || '')} {sp}</b>
        {signal.bobcat && <span title="Bobcat formula pick">🐾</span>}
        {bobby === 'agree' && <span className="rr-tag ok">✓ agrees</span>}
        {bobby === 'oppose' && <span className="rr-tag bad">✗ opposes</span>}
        {tagSide === 'total' && <span className="rr-tag dim">no total pick</span>}
      </div>
      {bits.length > 0 && <div className="rr-bobby-bits" style={NUM}>{bits.join(' · ')}</div>}
    </div>
  );
}

function SideCard({ side, rank, open, onToggle }) {
  const { game, signal } = side;
  const matchup = game ? `${shortTeam(game.away_team)} @ ${shortTeam(game.home_team)}` : '';
  const srcs = [...side.sources.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tagged = side.type === 'total' ? 'total' : 'side';
  return (
    <div className="rr-card">
      <button className="rr-card-head" onClick={onToggle} aria-expanded={open}>
        <div className="rr-count" style={NUM}>{side.count}</div>
        <div className="rr-grow">
          <div className="rr-title">{sideLabel({ pick_type: side.type, pick_side: side.side, note: side.tags[0]?.note, home_team: side.tags[0]?.home_team, away_team: side.tags[0]?.away_team }, game, signal, shortTeam)}</div>
          <div className="rr-sub">{matchup}{game?.kickoff_at ? ` · ${fmtKick(game.kickoff_at)}` : ''} · Wk {side.week}</div>
        </div>
        <div className="rr-right">
          <ResultBadge result={side.result} />
          <span className="rr-chev">{open ? '▾' : '▸'}</span>
        </div>
      </button>
      <div className="rr-chips">
        {srcs.map(([name, n]) => <span key={name} className="rr-chip">{name}{n > 1 ? ` ×${n}` : ''}</span>)}
      </div>
      {side.type !== 'custom' && <BobbyStrip signal={signal} bobby={side.bobby} tagSide={tagged} game={game} />}
      {open && (
        <div className="rr-tags">
          {side.tags.map((t) => (
            <div key={t.id} className="rr-tagrow">
              <span>{t.source_label || 'No source'}</span>
              {t.note && side.type !== 'custom' && <span className="rr-tagnote">{t.note}</span>}
              <span className="rr-tagtime">{new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SplitBar({ aLabel, bLabel, a, b }) {
  const t = a + b;
  if (!t) return null;
  const lead = a === b ? null : a > b ? 'a' : 'b';
  return (
    <div className="rr-split">
      <div className="rr-split-lbl"><span style={{ color: lead === 'a' ? C.gold : C.text }}>{aLabel}</span><b style={NUM}>{a}</b></div>
      <div className="rr-split-bar" aria-hidden="true">
        <div style={{ width: `${(a / t) * 100}%`, background: lead === 'a' ? C.gold : C.border }} />
        <div style={{ width: `${(b / t) * 100}%`, background: lead === 'b' ? C.gold : C.surface2 }} />
      </div>
      <div className="rr-split-lbl right"><b style={NUM}>{b}</b><span style={{ color: lead === 'b' ? C.gold : C.text }}>{bLabel}</span></div>
    </div>
  );
}

function GameCard({ g }) {
  const { game, signal } = g;
  const home = shortTeam(game?.home_team || g.home_team);
  const away = shortTeam(game?.away_team || g.away_team);
  const atsN = g.counts.home + g.counts.away;
  const ouN = g.counts.over + g.counts.under;
  const topSide = g.counts.home >= g.counts.away ? 'home' : 'away';
  const bobby = signal && atsN > 0 && g.counts.home !== g.counts.away ? (signal.pick_side === topSide ? 'agree' : 'oppose') : null;
  const line = signal?.vegas_line ?? game?.current_line;
  return (
    <div className="rr-card">
      <div className="rr-card-head static">
        <div className="rr-count" style={NUM}>{g.total}</div>
        <div className="rr-grow">
          <div className="rr-title">{away} @ {home}</div>
          <div className="rr-sub" style={NUM}>
            {game?.kickoff_at ? fmtKick(game.kickoff_at) : ''}{line != null ? ` · ${home} ${fmtSigned(-line)}` : ''}{game?.over_under != null ? ` · O/U ${game.over_under}` : ''} · {g.sources} source{g.sources === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      {atsN > 0 && <SplitBar aLabel={away} bLabel={home} a={g.counts.away} b={g.counts.home} />}
      {ouN > 0 && <SplitBar aLabel="Over" bLabel="Under" a={g.counts.over} b={g.counts.under} />}
      <BobbyStrip signal={signal} bobby={bobby} game={game} tagSide={atsN === 0 ? 'total' : 'side'} />
    </div>
  );
}

function SourceRow({ r }) {
  const graded = r.rec.w + r.rec.l + r.rec.p;
  return (
    <div className="rr-card">
      <div className="rr-card-head static">
        <div className="rr-count" style={NUM}>{r.tags}</div>
        <div className="rr-grow">
          <div className="rr-title">{r.name}</div>
          <div className="rr-sub" style={NUM}>{r.tags} tag{r.tags === 1 ? '' : 's'} · {r.sides} side{r.sides === 1 ? '' : 's'} · {r.games} game{r.games === 1 ? '' : 's'}</div>
        </div>
        <div className="rr-right" style={NUM}>
          <b style={{ fontSize: 15 }}>{graded ? fmtPct(r.pct) : '—'}</b>
          <span className="rr-sub">{graded ? recStr(r.rec) : 'no results'}</span>
        </div>
      </div>
      {r.agree + r.oppose > 0 && (
        <div className="rr-bobby" style={NUM}>
          <span className="rr-bobby-l">Bobby</span> agrees on {r.agree} of {r.agree + r.oppose} ATS tags ({fmtPct(r.agreePct)})
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
const CSS = `
  .rr-page { max-width: 760px; padding-top: 18px; }
  .rr-bar { position: sticky; top: 0; z-index: 20; background: ${C.bg}; padding: 8px 0 0; margin: 0 -4px 10px; border-bottom: 1px solid ${C.border}; }
  .rr-row { display: flex; gap: 8px; align-items: center; padding: 0 4px 8px; }
  .rr-select { flex: 0 0 auto; min-height: 44px; background: ${C.surface}; color: ${C.text}; border: 1px solid ${C.border}; border-radius: 8px; padding: 0 10px; font-size: 14px; }
  .rr-tabs { display: flex; overflow-x: auto; gap: 2px; padding: 0 4px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .rr-tabs::-webkit-scrollbar { display: none; }
  .rr-tab { flex: 1 0 auto; min-height: 44px; padding: 0 16px; background: none; border: none; border-bottom: 2px solid transparent; color: ${C.sub}; font-size: 14px; font-weight: 600; cursor: pointer; }
  .rr-tab.on { color: ${C.text}; border-bottom-color: ${C.gold}; }
  .rr-seg { display: inline-flex; border: 1px solid ${C.border}; border-radius: 8px; overflow: hidden; flex: 1 1 auto; }
  .rr-seg button { flex: 1 1 auto; min-height: 44px; padding: 0 12px; background: ${C.surface}; color: ${C.sub}; border: none; border-right: 1px solid ${C.border}; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .rr-seg button:last-child { border-right: none; }
  .rr-seg button.on { background: ${C.gold}22; color: ${C.gold}; }
  .rr-seg.sm { flex: 0 0 auto; }
  .rr-seg.sm button { min-height: 38px; padding: 0 10px; font-size: 12px; }
  .rr-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .rr-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
  .rr-stat { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 10px; padding: 10px 6px; text-align: center; }
  .rr-stat-n { font-size: 22px; font-weight: 800; color: ${C.text}; }
  .rr-stat-l { font-size: 11px; color: ${C.sub}; text-transform: uppercase; letter-spacing: .05em; }
  .rr-rec { font-size: 12.5px; color: ${C.sub}; margin: 0 0 12px; }
  .rr-rec b { color: ${C.text}; }
  .rr-list { display: flex; flex-direction: column; gap: 10px; }
  .rr-card { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 12px; padding: 12px; text-align: left; color: ${C.text}; }
  .rr-card-head { display: flex; align-items: center; gap: 12px; width: 100%; background: none; border: none; color: inherit; text-align: left; padding: 0; cursor: pointer; min-height: 44px; }
  .rr-card-head.static { cursor: default; }
  .rr-count { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 10px; background: ${C.gold}1F; border: 1px solid ${C.gold}; color: ${C.gold}; font-size: 20px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  .rr-grow { flex: 1 1 auto; min-width: 0; }
  .rr-title { font-size: 15px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
  .rr-sub { font-size: 12px; color: ${C.sub}; margin-top: 2px; }
  .rr-right { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .rr-chev { color: ${C.sub}; font-size: 14px; }
  .rr-badge { font-size: 10.5px; font-weight: 800; letter-spacing: .05em; border: 1px solid; border-radius: 6px; padding: 2px 6px; }
  .rr-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
  .rr-chip { font-size: 12px; padding: 4px 9px; border-radius: 999px; background: ${C.surface2}; border: 1px solid ${C.border}; color: ${C.text}; }
  .rr-bobby { margin-top: 10px; padding: 8px 10px; background: ${C.bg}; border: 1px solid ${C.border}; border-radius: 8px; font-size: 12.5px; }
  .rr-bobby.dim { color: ${C.sub}; }
  .rr-bobby-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .rr-bobby-l { color: ${C.blue}; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
  .rr-bobby-bits { color: ${C.sub}; margin-top: 4px; }
  .rr-tag { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px; border: 1px solid; }
  .rr-tag.ok { color: ${C.green}; border-color: ${C.green}; }
  .rr-tag.bad { color: ${C.warn}; border-color: ${C.warn}; }
  .rr-tag.dim { color: ${C.sub}; border-color: ${C.border}; }
  .rr-tags { margin-top: 10px; border-top: 1px solid ${C.border}; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .rr-tagrow { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12.5px; }
  .rr-tagnote { color: ${C.sub}; font-style: italic; }
  .rr-tagtime { margin-left: auto; color: ${C.sub}; font-size: 11.5px; }
  .rr-split { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; margin-top: 10px; font-size: 12.5px; }
  .rr-split-lbl { display: flex; gap: 6px; align-items: baseline; max-width: 110px; }
  .rr-split-lbl.right { justify-content: flex-end; }
  .rr-split-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: ${C.surface2}; }
  .rr-weekrow { display: flex; align-items: center; gap: 12px; cursor: pointer; width: 100%; min-height: 56px; }
  .rr-wk { flex: 0 0 auto; width: 52px; font-weight: 800; color: ${C.gold}; }
  .rr-note { margin-top: 14px; font-size: 12px; color: ${C.sub}; line-height: 1.5; }
  @media (min-width: 768px) { .rr-page { max-width: 860px; } }
`;
