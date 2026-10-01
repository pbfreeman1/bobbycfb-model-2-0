'use client';

// /nfl/ats — the spread board on its own, so ATS can be read at full width
// without the dashboard's O/U half. All logic lives in lib/nfl-board.
//
// Tracking and research only. Nothing here is advice.

import { MarketBoard } from '../../../lib/nfl-board';

export default function NflAts() {
  return (
    <MarketBoard
      market="spread"
      title="THE Bobby Model — NFL ATS"
      blurb="Every game this week against the spread, with the weighted system pool behind each
             number. Expand a card for the pool snapshot taken at compute time."
    />
  );
}
