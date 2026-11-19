'use client';

// THE Bobby Model — NFL weekly board (same layout as the college basketball board).
//
// Reads nfl2_board for one week. The database pulls ESPN and PredictionTracker
// on a schedule and recomputes, so there is nothing to upload or run here.
// Tap any game for the full breakdown. Tracking and research with paper units.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import RefreshButton from '../_ui/RefreshButton';
import GameDetail from '../_ui/GameDetail';
import TagsCell from '../../_scout/TagsCell';
import { crowdFor } from '../../../lib/scout-client';
import { tagSummary } from '../../../lib/scout-research';
import {
  C, FH, FM, MARKETS, TIER_COLOR, boardWeeks, defaultWeek, f1, fmtET, fmtKick, lastRun, lineLabel, loadBoard,
  modelLabel, pickLabel, units,
} from '../../../lib/nfl2';

const SEASON = 2026;
const TOP_N = 3;

const SORTS = {
  rank: { label: 'Rank', fn: (a, b) => (a.rank_in_week ?? 999) - (b.rank_in_week ?? 999) },
  kedge: { label: 'Key edge', fn: (a, b) => (b.kedge ?? 0) - (a.kedge ?? 0) },
  agree: { label: 'Agreement', fn: (a, b) => (b.vote_share ?? 0) - (a.vote_share ?? 0) },
  kick: { label: 'Kickoff', fn: (a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) },
  game: { label: 'Matchup', fn: (a, b) => a.home.localeCompare(b.home) },
  tags: { label: 'Outside picks', fn: (a, b) => (b._tags?.total ?? 0) - (a._tags?.total ?? 0) || (b._tags?.withN ?? 0) - (a._tags?.withN ?? 0) },
};

const grpOf = (market) => (market === 'total' ? 'total' : 'side');
const tagLabel = (r) => (s) => (s === 'over' ? 'Over' : s === 'under' ? 'Under' : s === 'home' ? r.home_abbr : r.away_abbr);

// Case- and punctuation-insensitive; matches full names or abbreviations.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '');

const cell = { padding: '9px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' };
const head = { ...cell, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: C.sub, textAlign: 'left' };
const btn = {
  background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6,
  padding: '7px 11px', fontSize: 13, cursor: 'pointer',
};

function ResultTag({ row }) {
  if (!row.result) return null;
  const color = row.result === 'W' ? C.green : row.result === 'L' ? C.warn : C.sub;
  return (
    <span style={{ ...FM, fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 6px' }}>
      {row.result}{row.taken_side ? ` ${units(row.units_result)}` : ''}
    </span>
  );
}

function Flags({ row }) {
  const items = [...row.flags, ...row.keys_crossed.map((k) => `Crosses ${k}`)];
  if (!items.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
      {items.map((f) => (
        <span key={f} style={{
          fontSize: 10.5, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px',
          color: f.startsWith('Crosses') ? C.blue : f.includes('with pick') ? C.green : C.gold,
        }}>{f}</span>
      ))}
    </span>
  );
}

function TopSpot({ row, n, onOpen }) {
  const lineNow = row.line_now ?? row.line;
  const t = row._tags;
  return (
    <button onClick={onOpen} style={{
      textAlign: 'left', cursor: 'pointer', color: C.text, background: C.surface, border: `1px solid ${C.border}`,
      borderLeft: `3px solid ${C.green}`, borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...FM, fontSize: 11, color: C.sub }}>#{n} · {fmtKick(row.kickoff)}</span>
        <ResultTag row={row} />
      </div>
      <div style={{ ...FH, fontSize: 17, fontWeight: 700, margin: '2px 0 2px' }}>
        <span style={{ color: C.green }}>{pickLabel(row, row.taken_side, row.taken_line)}</span>
      </div>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>
        {row.away} @ {row.home}
        {row.taken_line !== lineNow ? ` · now ${pickLabel(row, row.taken_side, lineNow)}` : ''}
      </div>
      <div style={{ ...FM, fontSize: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 3 }}>
        <span>Model {modelLabel(row)}</span>
        <span>Key edge {f1(row.kedge)}</span>
        <span>Agree {f1(100 * row.vote_share, 0)}%</span>
        <span>Top 5 {row.top5_side_share === null ? '—' : `${Math.round(5 * row.top5_side_share)}/5`}</span>
      </div>
      {t && t.withN !== null && (
        <div style={{ ...FM, fontSize: 11.5, marginTop: 6, color: t.tone === 'with' ? C.green : t.tone === 'against' ? C.warn : C.gold }}>
          Outside picks: {t.withN} with · {t.againstN} against
        </div>
      )}
      <div style={{ marginTop: 8 }}><Flags row={row} /></div>
    </button>
  );
}

function Board() {
  const params = useSearchParams();
  const [week, setWeek] = useState(null);
  const [weeks, setWeeks] = useState([]);
  const [market, setMarket] = useState(params.get('m') === 'total' ? 'total' : 'spread');
  const [rows, setRows] = useState([]);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('rank');
  const [tierFilter, setTierFilter] = useState('all');
  const [teamQuery, setTeamQuery] = useState('');
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);
  const [crowd, setCrowd] = useState(new Map());

  useEffect(() => {
    defaultWeek(SEASON).then(setWeek).catch(() => setWeek(1));
    boardWeeks(SEASON).then(setWeeks).catch(() => {});
    lastRun().then(setRun).catch(() => {});
  }, []);
  const onRefreshed = (r) => { setRun(r); setTick((t) => t + 1); };

  useEffect(() => {
    if (!week) return undefined;
    let live = true;
    setLoading(true);
    setError(null);
    loadBoard(SEASON, week)
      .then((r) => {
        if (!live) return;
        setRows(r);
        crowdFor('nfl', r.map((x) => x.game_id)).then((m) => { if (live) setCrowd(m); }).catch(() => {});
      })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [week, tick]);

  const mRows = useMemo(() => rows.filter((r) => r.market === market)
    .map((r) => ({ ...r, _tags: tagSummary(crowd.get(`${r.game_id}|${grpOf(r.market)}`), r.pick_side) })), [rows, market, crowd]);
  const taken = useMemo(() => mRows.filter((r) => r.taken_side), [mRows]);
  const top = useMemo(() => [...taken].sort(SORTS.rank.fn).slice(0, TOP_N), [taken]);
  const shown = useMemo(() => {
    const base = tierFilter === 'all' ? mRows
      : tierFilter === 'Taken' ? mRows.filter((r) => r.taken_side)
        : mRows.filter((r) => r.tier === tierFilter);
    const q = norm(teamQuery).trim();
    const hit = (r) => !q || [r.home, r.away, r.home_abbr, r.away_abbr].some((t) => norm(t).includes(q));
    return base.filter(hit).sort(SORTS[sort].fn);
  }, [mRows, sort, tierFilter, teamQuery]);

  const count = (m) => rows.filter((r) => r.market === m && r.taken_side).length;
  const leans = mRows.filter((r) => r.tier === 'Lean' && !r.taken_side).length;
  const graded = taken.filter((r) => r.result === 'W' || r.result === 'L');
  const pw = graded.filter((r) => r.result === 'W').length;
  const pu = taken.reduce((a, r) => a + Number(r.units_result || 0), 0);
  const openRow = open ? rows.find((r) => r.game_id === open.id && r.market === open.market) : null;
  const otherRow = open ? rows.find((r) => r.game_id === open.id && r.market !== open.market) : null;
  const close = useCallback(() => setOpen(null), []);
  const idx = weeks.indexOf(week);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 72px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>THE Bobby Model — NFL</h1>
        <span style={{ ...FM, fontSize: 12, color: C.sub }}>{SEASON} · Week {week ?? '…'}</span>
      </div>
      <div style={{ ...FM, fontSize: 11.5, color: C.sub, marginBottom: 14 }}>
        {run ? (
          <>
            Last pull {fmtET(run.started_at)} ET ({run.trigger === 'manual' ? 'manual' : 'scheduled'})
            {' · '}{run.status === 'error' ? <span style={{ color: C.warn }}>error: {run.error}</span> : run.status}
            {' · '}<a href="/nfl/log">pull log</a>
          </>
        ) : 'Checking last pull…'}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button style={btn} disabled={idx <= 0} onClick={() => setWeek(weeks[idx - 1])} aria-label="Previous week">←</button>
        <select value={week ?? ''} onChange={(e) => setWeek(Number(e.target.value))} style={{ ...btn, colorScheme: 'dark' }}>
          {weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}
        </select>
        <button style={btn} disabled={idx < 0 || idx >= weeks.length - 1} onClick={() => setWeek(weeks[idx + 1])} aria-label="Next week">→</button>
        <button style={btn} onClick={() => defaultWeek(SEASON).then(setWeek)}>This week</button>
        <RefreshButton onDone={onRefreshed} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {Object.values(MARKETS).map((m) => (
          <button key={m.key} onClick={() => setMarket(m.key)} aria-pressed={market === m.key} style={{
            ...btn, padding: '8px 16px', fontWeight: 700, fontFamily: FH.fontFamily,
            background: market === m.key ? C.surface2 : C.surface, borderColor: market === m.key ? C.green : C.border,
          }}>
            {m.label} <span style={{ ...FM, fontWeight: 400, fontSize: 12, color: C.sub }}>· {count(m.key)} play{count(m.key) === 1 ? '' : 's'}</span>
          </button>
        ))}
        <span style={{ ...FM, fontSize: 12, color: C.sub, marginLeft: 6 }}>
          {mRows.length} games · {taken.length} play{taken.length === 1 ? '' : 's'} · {leans} lean{leans === 1 ? '' : 's'}
          {graded.length ? ` · plays ${pw}-${graded.length - pw} (${units(pu)})` : ''}
        </span>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading…</div>}
      {!loading && !error && mRows.length === 0 && (
        <div className="empty">No lines for week {week} yet. PredictionTracker usually posts the week by Wednesday or Thursday.</div>
      )}

      {!loading && top.length > 0 && (
        <>
          <h2 style={{ ...FH, fontSize: 15, margin: '0 0 10px' }}>Top spots · {MARKETS[market].long}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, marginBottom: 22 }}>
            {top.map((r, i) => <TopSpot key={r.game_id} row={r} n={i + 1} onOpen={() => setOpen({ id: r.game_id, market: r.market })} />)}
          </div>
        </>
      )}

      {!loading && mRows.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <h2 style={{ ...FH, fontSize: 15, margin: 0, marginRight: 6 }}>All games</h2>
            {['all', 'Taken', 'Play', 'Lean', 'No tier'].map((t) => (
              <button key={t} onClick={() => setTierFilter(t)}
                style={{ ...btn, padding: '4px 10px', fontSize: 12, borderColor: tierFilter === t ? C.green : C.border }}>
                {t === 'all' ? 'All' : t === 'Taken' ? 'Plays taken' : t}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <input type="search" value={teamQuery} onChange={(e) => setTeamQuery(e.target.value)}
              placeholder="Search team…" aria-label="Search by team"
              style={{ ...btn, padding: '4px 10px', fontSize: 12, width: 170, cursor: 'text', colorScheme: 'dark' }} />
            <label style={{ fontSize: 12, color: C.sub }}>Sort{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ ...btn, padding: '4px 8px', fontSize: 12 }}>
                {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['#', 'Matchup', 'Tier', 'Pick', 'Tags', 'Line', 'Open', 'Model', 'Key edge', 'Agree', 'Flags', 'Final'].map((h) => (
                    <th key={h} style={head}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const lineNow = r.line_now ?? r.line;
                  return (
                    <tr key={r.game_id} onClick={() => setOpen({ id: r.game_id, market: r.market })}
                      style={{ cursor: 'pointer' }} title="Open the full breakdown">
                      <td style={{ ...cell, ...FM, color: C.sub }}>{r.rank_in_week ?? '—'}</td>
                      <td style={cell}>
                        {r.away_abbr} @ {r.home_abbr}
                        <span style={{ ...FM, fontSize: 11, color: C.sub, marginLeft: 6 }}>{fmtKick(r.kickoff)}</span>
                      </td>
                      <td style={{ ...cell, fontWeight: 700, color: r.taken_side ? C.green : TIER_COLOR[r.tier] || C.sub }}>
                        {r.taken_side && r.tier !== 'Play' ? 'Taken' : r.tier}
                      </td>
                      <td style={{ ...cell, fontWeight: 600 }}>
                        {r.taken_side ? pickLabel(r, r.taken_side, r.taken_line) : pickLabel(r, r.pick_side, lineNow)}
                      </td>
                      <td style={cell}><TagsCell summary={r._tags} labelFor={tagLabel(r)} /></td>
                      <td style={{ ...cell, ...FM }}>{lineLabel(r, lineNow)}</td>
                      <td style={{ ...cell, ...FM, color: C.sub }}>{lineLabel(r, r.open_line)}</td>
                      <td style={{ ...cell, ...FM }}>{modelLabel(r)}</td>
                      <td style={{ ...cell, ...FM, color: (r.kedge ?? 0) >= 2 ? C.green : C.text }}>{f1(r.kedge)}</td>
                      <td style={{ ...cell, ...FM, color: (r.vote_share ?? 0) >= 0.85 ? C.green : C.text }}>
                        {r.vote_share === null ? '—' : `${f1(100 * r.vote_share, 0)}%`}
                      </td>
                      <td style={cell}><Flags row={r} /></td>
                      <td style={{ ...cell, ...FM }}>
                        {r.home_score === null || r.home_score === undefined ? '' : `${r.away_score}-${r.home_score} `}<ResultTag row={r} />
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr><td colSpan={12} style={{ ...cell, color: C.sub }}>{teamQuery.trim() ? `No games match “${teamQuery.trim()}”.` : 'No games in this filter.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <details style={{ marginTop: 22, fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
        <summary style={{ cursor: 'pointer', color: C.text }}>How to read this board</summary>
        <p><b style={{ color: C.text }}>Model</b> is the weighted average of the PredictionTracker systems, weighted by how much their errors this season (blended with last season) beat the median system's. <b style={{ color: C.text }}>Key edge</b> is the gap to the line counted the NFL way: each whole number between the line and the model counts by how often games land there, so crossing 3 is worth about 3 points and crossing 5 about 1. <b style={{ color: C.text }}>Agree</b> is the share of system weight on the pick side.</p>
        <p><b style={{ color: C.green }}>Play</b>: key edge 2.0+ with 85%+ agreement. A Play is <b style={{ color: C.text }}>taken</b> the first time it qualifies, at that pull&rsquo;s line, and graded there at a flat 1 unit (win +1.0, lose −1.1), even if the line moves or a later pull drops it. <b style={{ color: C.gold }}>Lean</b>: key edge 1.5+ with 70%+, record only. Top spots are the best-ranked taken Plays.</p>
        <p>Why taken early: against the closing line the consensus has been a coin flip since 2022. The edge in the backtest came from disagreeing with the opener, and when that gap was 3+ the line moved toward the model in roughly 8 of 10 games that moved. Check the <b style={{ color: C.text }}>Line moving against pick</b> flag before playing: in the NFL that is often injury or weather news the systems have not priced.</p>
        <p><b style={{ color: C.text }}>Tags</b> counts outside sites with a pick for this market (spread and moneyline for ATS, the game total for O/U): sites on the model&rsquo;s side / sites against it. <span style={{ color: C.green }}>Green</span> = more with the model, <span style={{ color: C.warn }}>red</span> = more against, <span style={{ color: C.gold }}>gold</span> = split. Each site counts once, toward the side most of its experts picked. See <a href="/nfl/research">Research</a> for the breakdown.</p>
        <p>Pulls run at about 8:15 AM, 12:15 PM and 4:45 PM ET daily, plus before the Sunday 1:00 and 4:05 windows. A game freezes at kickoff. Tap any game for the full breakdown.</p>
      </details>

      {openRow && <GameDetail row={openRow} other={otherRow} onClose={close} />}
    </main>
  );
}

export default function NflDashboard() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <Board />
    </Suspense>
  );
}
