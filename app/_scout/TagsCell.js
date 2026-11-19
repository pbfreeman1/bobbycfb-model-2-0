'use client';

// Board cell: outside sources with the model's side vs against it.
//   "3/1" green  = 3 sites on the model's side, 1 against
//   "0/2" red    = sources lean the other way
//   "1/1" gold   = split
// With no model side (CBB totals), shows the crowd's side and count.

import { C, FM } from '../../lib/nfl-board';

const TONE = { with: C.green, against: C.warn, split: C.gold, none: C.blue };

export default function TagsCell({ summary, labelFor }) {
  if (!summary) return <span style={{ color: C.sub }}>—</span>;
  const color = TONE[summary.tone] || C.sub;
  if (summary.withN === null) {
    const label = summary.crowdSide ? labelFor(summary.crowdSide) : 'Split';
    return (
      <span title={`${summary.total} source${summary.total === 1 ? '' : 's'} with a pick`} style={{ ...FM, fontSize: 12, color }}>
        {label} {summary.top || ''}
      </span>
    );
  }
  const title = `${summary.withN} source${summary.withN === 1 ? '' : 's'} on the model's side, ${summary.againstN} against`;
  return (
    <span title={title} style={{ ...FM, fontSize: 12.5, fontWeight: 700, color, whiteSpace: 'nowrap' }}>
      {summary.withN}<span style={{ color: C.sub, fontWeight: 400 }}>/</span>{summary.againstN}
    </span>
  );
}
