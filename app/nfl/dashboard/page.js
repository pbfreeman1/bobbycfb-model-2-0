'use client';

// THE Bobby Model — NFL dashboard.
//
// The loader, cards and pool table this page introduced now live in
// lib/nfl-board, so /nfl/ats and /nfl/totals read through exactly the same code
// instead of three copies drifting apart. The shape is unchanged:
//
//   - useNflBoard() owns all reading. Phase 3 adds picks/research/logos to it.
//   - the rows it returns are {game, pick, snapshot}. Phase 3 wraps that array
//     with filtering and attachBobbyRank before it reaches the cards.
//   - GameCard takes one row plus display helpers. Phase 3 adds badges and
//     actions inside it without changing how it is fed.
//
// What this page adds over the single-market boards is the two market summary
// cards and the switch between them, so the week reads at a glance before you
// drop into either market. Deliberately still has no sort, filter, tags or My
// Card: those are Phase 3.
//
// This is a tracking and research surface. Nothing here is advice.

import { useMemo, useState } from 'react';
import {
  C, FH, FM, MARKET, GameCard, NoMarketData, SeasonWeekPicker,
  UnvalidatedNotice, boardCounts, useDefaultWeek, useNflBoard,
} from '../../../lib/nfl-board';

export default function NflDashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null);
  const [market, setMarket] = useState('spread');

  // The default week is resolved off the spread market, which is the one with
  // history; totals would otherwise drag the whole page back to week 1.
  useDefaultWeek(season, week, setWeek, 'spread');

  const ats = useNflBoard(season, week, 'spread');
  const tot = useNflBoard(season, week, 'total');
  const board = market === 'spread' ? ats : tot;

  const atsCounts = useMemo(() => boardCounts(ats.rows), [ats.rows]);
  const totCounts = useMemo(() => boardCounts(tot.rows), [tot.rows]);
  const counts = market === 'spread' ? atsCounts : totCounts;

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 16px 64px', color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ ...FH, fontSize: 21, margin: 0 }}>THE Bobby Model — NFL</h1>
        <span style={{ ...FM, fontSize: 12, color: C.sub }}>
          {season} week {week ?? '…'}
        </span>
      </div>

      <UnvalidatedNotice cfg={board.cfg} market={market} />

      <SeasonWeekPicker
        season={season} setSeason={setSeason} week={week} setWeek={setWeek}
        weeks={ats.weeks.length ? ats.weeks : tot.weeks} counts={null}
      />

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12, margin: '0 0 18px',
      }}>
        <MarketSummary
          market="spread" counts={atsCounts} active={market === 'spread'}
          loading={ats.loading} onClick={() => setMarket('spread')}
        />
        <MarketSummary
          market="total" counts={totCounts} active={market === 'total'}
          loading={tot.loading} onClick={() => setMarket('total')}
        />
      </div>

      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
        borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 14,
      }}>
        <h2 style={{ ...FH, fontSize: 15, margin: 0 }}>
          {MARKET[market].label} · week {week ?? '…'}
        </h2>
        <span style={{ ...FM, fontSize: 11.5, color: C.sub }}>
          {counts.games} games · {counts.computed} computed · {counts.tiered} tiered
        </span>
      </div>

      {board.loading && <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>Loading…</div>}
      {board.error && <div style={{ ...FM, fontSize: 12.5, color: C.warn }}>{board.error}</div>}
      {!board.loading && !board.error && board.rows.length === 0 && (
        <div style={{ ...FM, fontSize: 12.5, color: C.sub }}>
          No games for {season} week {week}. Run the ESPN sync on the Ingest page.
        </div>
      )}
      {!board.loading && !board.error && board.rows.length > 0 && counts.computed === 0 && (
        <NoMarketData market={market} season={season} week={week} />
      )}

      {board.rows.map((r) => (
        <GameCard key={`${market}-${r.game.id}`} row={r} abbr={board.abbr} market={market} />
      ))}
    </main>
  );
}

// One market's week at a glance, and the switch for the board below.
function MarketSummary({ market, counts, active, loading, onClick }) {
  const M = MARKET[market];
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        textAlign: 'left', cursor: 'pointer',
        background: active ? C.surface2 : C.surface,
        border: `1px solid ${active ? C.blue : C.border}`,
        borderLeft: `4px solid ${active ? C.blue : C.border}`,
        borderRadius: 6, padding: '12px 14px', color: C.text,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ ...FH, fontSize: 14, fontWeight: 600 }}>{M.label}</span>
        <span style={{ ...FM, fontSize: 10, color: active ? C.blue : C.sub, letterSpacing: 0.4 }}>
          {active ? 'SHOWING' : 'VIEW'}
        </span>
      </div>
      <div style={{ ...FM, fontSize: 12, color: C.sub, marginTop: 7, lineHeight: 1.7 }}>
        {loading ? (
          'Loading…'
        ) : counts.games === 0 ? (
          'No games this week'
        ) : counts.computed === 0 ? (
          <span style={{ color: C.gold }}>{counts.games} games · not computed</span>
        ) : (
          <>
            <span style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>{counts.tiered}</span>
            {' tiered'}
            <span style={{ color: C.border }}>{'  ·  '}</span>
            {counts.computed}/{counts.games} computed
          </>
        )}
      </div>
    </button>
  );
}
