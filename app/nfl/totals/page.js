'use client';

// /nfl/totals — the over/under board. Same loader and cards as ATS, with the
// market swapped; see MARKET.total in lib/nfl-board for the notation.
//
// Tracking and research only. Nothing here is advice.

import { MarketBoard } from '../../../lib/nfl-board';

export default function NflTotals() {
  return (
    <MarketBoard
      market="total"
      title="THE Bobby Model — NFL O/U"
      blurb="Every game this week against the total, with the weighted system pool behind each
             number. Expand a card for the pool snapshot taken at compute time."
    />
  );
}
