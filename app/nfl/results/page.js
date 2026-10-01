'use client';

// /nfl/results — the graded record, by week and by pick.
//
// Reads nfl_bobby_pick_grades, which nfl_grade writes. A pick only appears here
// once its game is final AND Grade has been run for that week; a computed but
// ungraded week shows as pending rather than silently missing, because
// "0 picks" and "16 picks nobody has graded yet" are very different states and
// the difference is the first thing you want to know when a number looks wrong.
//
// Units are paper units at the stored tier size. Tier cutoffs are still the
// CFB carry-over numbers, so treat the P/L column as a record of what the
// engine said, not as a result. Tracking and research only; nothing here is
// advice.

import { useEffect, useMemo, useState } from 'react';
import { sbFetchAll, fmtKickoff } from '../../../lib/supabase';
import { TIER_COLOR } from '../../../lib/bobby-model';
import {
  C, FH, FM, sel, SEASONS, MARKET, Badge,
} from '../../../lib/nfl-board';

const MARKETS = ['spread', 'total'];

function useResults(season, market) {
  const [state, setState] = useState({ loading: true, error: null, picks: [], games: {}, grades: {} });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const picks = await sbFetchAll(
          `nfl_bobby_picks?select=id,game_id,week,market,tier,units,pick_side,line_used,consensus,edge,` +
          `agreement,locked_at&market=eq.${market}&season=eq.${season}&order=week.asc`
        );

        const gameIds = [...new Set(picks.map((p) => p.game_id))];
        const pickIds = picks.map((p) => p.id);

        const [gameRows, gradeRows] = await Promise.all([
          gameIds.length
            ? sbFetchAll(
                `nfl_games?select=id,week,home_team,away_team,game_date,home_score,away_score,` +
                `completed,spread_line,total_line&id=in.(${gameIds.join(',')})`
              )
            : Promise.resolve([]),
          pickIds.length
            ? sbFetchAll(
                `nfl_bobby_pick_grades?select=pick_id,result,margin_vs_line,units_pl,closing_line,` +
                `clv,clv_open,clv_first,beat_close,graded_at&pick_id=in.(${pickIds.join(',')})`
              )
            : Promise.resolve([]),
        ]);

        const games = {};
        for (const g of gameRows) games[g.id] = g;
        const grades = {};
        for (const gr of gradeRows) grades[gr.pick_id] = gr;

        if (!cancelled) setState({ loading: false, error: null, picks, games, grades });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: String(e.message || e) }));
      }
    })();
    return () => { cancelled = true; };
  }, [season, market]);

  return state;
}

// One row per week, plus a season total. Pushes are excluded from the win
// percentage denominator, which is the standard ATS convention.
function summarise(picks, grades, games) {
  const byWeek = new Map();
  const blank = (week) => ({
    week, picks: 0, tiered: 0, graded: 0, pending: 0,
    w: 0, l: 0, p: 0, units: 0, clvSum: 0, clvN: 0, beatClose: 0,
  });

  for (const pick of picks) {
    if (!byWeek.has(pick.week)) byWeek.set(pick.week, blank(pick.week));
    const row = byWeek.get(pick.week);
    row.picks++;
    const tiered = pick.tier !== 'No tier';
    if (tiered) row.tiered++;

    const g = grades[pick.id];
    // Only tiered picks carry units, so only they move the P/L. Untiered picks
    // are still graded for the record.
    if (!g) {
      const game = games[pick.game_id];
      if (game?.completed) row.pending++;
      continue;
    }
    row.graded++;
    if (g.result === 'W') row.w++;
    else if (g.result === 'L') row.l++;
    else if (g.result === 'P') row.p++;
    if (g.units_pl != null) row.units += parseFloat(g.units_pl);
    if (g.clv != null) { row.clvSum += parseFloat(g.clv); row.clvN++; }
    if (g.beat_close) row.beatClose++;
  }

  const weeks = [...byWeek.values()].sort((a, b) => a.week - b.week);
  const total = weeks.reduce((t, r) => {
    for (const k of ['picks', 'tiered', 'graded', 'pending', 'w', 'l', 'p', 'clvN', 'beatClose']) t[k] += r[k];
    t.units += r.units; t.clvSum += r.clvSum;
    return t;
  }, { ...blank('Total') });

  return { weeks, total };
}

const pct = (w, l) => {
  const d = w + l;
  return d ? `${((w / d) * 100).toFixed(1)}%` : '—';
};
const signed = (n, digits = 2) => {
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
};
const unitColor = (n) => (n > 0.001 ? C.green : n < -0.001 ? C.warn : C.sub);

export default function NflResults() {
  const [season, setSeason] = useState(2026);
  const [market, setMarket] = useState('spread');
  const { loading, error, picks, games, grades } = useResults(season, market);
  const { weeks, total } = useMemo(() => summarise(picks, grades, games), [picks, grades, games]);
  const [openWeek, setOpenWeek] = useState(null);

  const anyGraded = total.graded > 0;

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 64px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>THE Bobby Model — NFL results</h1>
        <span style={{ ...FM, fontSize: 12, color: C.sub }}>
          {MARKET[market].label} · {season}
        </span>
      </div>
      <p style={{ ...FM, fontSize: 11.5, color: C.sub, lineHeight: 1.6, margin: '0 0 14px', maxWidth: 760 }}>
        What the engine said, after the fact. Paper units at the stored tier size; the tier cutoffs
        are still the CFB carry-over numbers, so read this as a record of the engine's output, not
        as a result.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', margin: '0 0 16px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.4 }}>SEASON</span>
          <select value={season} onChange={(e) => setSeason(+e.target.value)} style={sel}>
            {SEASONS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...FM, fontSize: 10.5, color: C.sub, letterSpacing: 0.4 }}>MARKET</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)} style={sel}>
            {MARKETS.map((m) => <option key={m} value={m}>{MARKET[m].label}</option>)}
          </select>
        </label>
        <span style={{ ...FM, fontSize: 11.5, color: C.sub, paddingBottom: 8 }}>
          {total.picks} picks · {total.graded} graded
          {total.pending > 0 && ` · ${total.pending} awaiting Grade`}
        </span>
      </div>

      {loading && <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>Loading…</div>}
      {error && <div style={{ ...FM, fontSize: 12.5, color: C.warn }}>{error}</div>}

      {!loading && !error && total.picks === 0 && (
        <div style={{
          border: `1px dashed ${C.border}`, background: C.surface, borderRadius: 6,
          padding: '12px 14px', ...FM, fontSize: 12, lineHeight: 1.7, color: C.sub,
        }}>
          <b style={{ color: C.text }}>No {MARKET[market].label} picks computed for {season}.</b>
          {market === 'total'
            ? ' No totals predictions have been ingested yet, so the engine has nothing to grade.'
            : ' Run Recalibrate then Compute on the Ingest page first.'}
        </div>
      )}

      {!loading && !error && total.picks > 0 && !anyGraded && (
        <div style={{
          border: `1px dashed ${C.gold}`, background: `${C.gold}14`, borderRadius: 6,
          padding: '12px 14px', margin: '0 0 16px', ...FM, fontSize: 12, lineHeight: 1.7, color: C.text,
        }}>
          <b style={{ color: C.gold }}>Nothing graded yet.</b> {total.picks} picks exist for {season}
          {total.pending > 0 && `, ${total.pending} of them on games that are already final`}, but
          nfl_grade has not been run for this market. Run <b>Grade</b> for each completed week on the
          Ingest page and this page fills in.
        </div>
      )}

      {!loading && !error && total.picks > 0 && (
        <>
          <WeekTable weeks={weeks} total={total} openWeek={openWeek} setOpenWeek={setOpenWeek} />
          {openWeek != null && (
            <PickTable
              week={openWeek} market={market}
              picks={picks.filter((p) => p.week === openWeek)}
              games={games} grades={grades}
            />
          )}
        </>
      )}
    </main>
  );
}

const WCOLS = '62px 58px 58px 86px 62px 78px 72px 70px';

function WeekTable({ weeks, total, openWeek, setOpenWeek }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ overflowX: 'auto' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: WCOLS, gap: 9, padding: '8px 13px',
          background: C.surface2, ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, minWidth: 560,
        }}>
          <span>WEEK</span><span>PICKS</span><span>TIERED</span><span>W-L-P</span>
          <span>WIN%</span><span>UNITS</span><span>AVG CLV</span><span>BEAT CLOSE</span>
        </div>

        {weeks.map((r) => {
          const on = openWeek === r.week;
          return (
            <button
              key={r.week}
              onClick={() => setOpenWeek(on ? null : r.week)}
              aria-expanded={on}
              style={{
                display: 'grid', gridTemplateColumns: WCOLS, gap: 9, alignItems: 'center',
                width: '100%', textAlign: 'left', padding: '8px 13px', minWidth: 560,
                borderTop: `1px solid ${C.border}`, border: 'none',
                borderLeft: `3px solid ${on ? C.blue : 'transparent'}`,
                background: on ? C.surface2 : 'transparent', color: C.text,
                ...FM, fontSize: 12, cursor: 'pointer',
              }}
            >
              <span style={{ fontWeight: 700 }}>{r.week >= 19 ? `${r.week} post` : r.week}</span>
              <span style={{ color: C.sub }}>{r.picks}</span>
              <span style={{ color: C.sub }}>{r.tiered}</span>
              <span>{r.graded ? `${r.w}-${r.l}-${r.p}` : <span style={{ color: C.sub }}>pending</span>}</span>
              <span>{r.graded ? pct(r.w, r.l) : '—'}</span>
              <span style={{ color: unitColor(r.units), fontWeight: 700 }}>
                {r.graded ? signed(r.units) : '—'}
              </span>
              <span style={{ color: C.sub }}>{r.clvN ? signed(r.clvSum / r.clvN) : '—'}</span>
              <span style={{ color: C.sub }}>{r.graded ? `${r.beatClose}/${r.graded}` : '—'}</span>
            </button>
          );
        })}

        <div style={{
          display: 'grid', gridTemplateColumns: WCOLS, gap: 9, alignItems: 'center',
          padding: '9px 13px', borderTop: `2px solid ${C.border}`, background: C.surface2,
          ...FM, fontSize: 12, fontWeight: 700, minWidth: 560,
        }}>
          <span>TOTAL</span>
          <span style={{ color: C.sub }}>{total.picks}</span>
          <span style={{ color: C.sub }}>{total.tiered}</span>
          <span>{total.graded ? `${total.w}-${total.l}-${total.p}` : '—'}</span>
          <span>{total.graded ? pct(total.w, total.l) : '—'}</span>
          <span style={{ color: unitColor(total.units) }}>{total.graded ? signed(total.units) : '—'}</span>
          <span style={{ color: C.sub }}>{total.clvN ? signed(total.clvSum / total.clvN) : '—'}</span>
          <span style={{ color: C.sub }}>{total.graded ? `${total.beatClose}/${total.graded}` : '—'}</span>
        </div>
      </div>
    </div>
  );
}

const RESULT_COLOR = { W: C.green, L: C.warn, P: C.sub };
const PCOLS = 'minmax(0,1fr) 150px 54px 62px 64px 66px';

function PickTable({ week, market, picks, games, grades }) {
  const M = MARKET[market];
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ padding: '10px 13px', ...FM, fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: 0.5 }}>
        WEEK {week} · {picks.length} PICKS
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: PCOLS, gap: 9, padding: '6px 13px',
          background: C.surface2, ...FM, fontSize: 9.5, color: C.sub, letterSpacing: 0.4, minWidth: 620,
        }}>
          <span>GAME</span><span>PICK</span><span>TIER</span><span>RESULT</span><span>UNITS</span><span>CLV</span>
        </div>

        {picks.map((pick) => {
          const game = games[pick.game_id];
          const g = grades[pick.id];
          const tierColor = TIER_COLOR[pick.tier] || C.sub;
          const sideName = M.sideLabel(pick, game || {});
          return (
            <div key={pick.id} style={{
              display: 'grid', gridTemplateColumns: PCOLS, gap: 9, alignItems: 'center',
              padding: '7px 13px', borderTop: `1px solid ${C.border}`, ...FM, fontSize: 11.5, minWidth: 620,
            }}>
              <span style={{ ...FH, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {game ? `${game.away_team} @ ${game.home_team}` : `game ${pick.game_id}`}
                {game?.completed && (
                  <span style={{ ...FM, fontSize: 10.5, color: C.sub }}>
                    {' '}{game.away_score}–{game.home_score}
                  </span>
                )}
              </span>
              <span>
                {sideName ? `${sideName} ${M.atLine(pick.line_used, pick)}` : '—'}
              </span>
              <span style={{ color: tierColor, fontWeight: 700 }}>
                {pick.tier === 'No tier' ? '—' : pick.tier}
              </span>
              <span style={{ color: g ? RESULT_COLOR[g.result] || C.sub : C.sub, fontWeight: 700 }}>
                {g ? g.result : game?.completed ? 'ungraded' : 'pending'}
              </span>
              <span style={{ color: g && g.units_pl != null ? unitColor(parseFloat(g.units_pl)) : C.sub }}>
                {g && g.units_pl != null ? signed(g.units_pl) : '—'}
              </span>
              <span style={{ color: C.sub }}>
                {g && g.clv != null ? signed(g.clv) : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
