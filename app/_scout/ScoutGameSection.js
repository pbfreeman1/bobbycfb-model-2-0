'use client';

// Game drawer section: every outside pick stored for this game, grouped by
// market, with how many sites are on each side, whether that side matches the
// model, and how far the line has moved since each source took it.

import { useEffect, useMemo, useState } from 'react';
import { C, FM } from '../../lib/nfl-board';
import { gamePicks, describePick } from '../../lib/scout-client';
import { lineWorseBy, sideLabel, spreadFor } from '../../lib/scout-research';

const box = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' };
const h3 = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: C.sub, fontWeight: 700, marginBottom: 8 };

const grpOf = (p) => (p.period !== 'full' || p.market === 'team_total' ? 'other' : p.market === 'total' ? 'total' : 'side');

function SideBar({ label, n, total, color, model }) {
  const w = total ? Math.max(6, (100 * n) / total) : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,170px) 1fr 70px', gap: 8, alignItems: 'center', fontSize: 12.5, marginBottom: 4 }}>
      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ background: C.surface2, borderRadius: 3, height: 10 }}>
        <span style={{ display: 'block', width: `${w}%`, height: 10, borderRadius: 3, background: color }} />
      </span>
      <span style={{ ...FM, color: C.sub }}>{n} site{n === 1 ? '' : 's'}{model ? ' · model' : ''}</span>
    </div>
  );
}

export default function ScoutGameSection({ sport, gameId, names, model = {}, now = {} }) {
  const [picks, setPicks] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    setPicks(null);
    gamePicks(sport, gameId).then((p) => { if (live) setPicks(p); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [sport, gameId]);

  const groups = useMemo(() => {
    const out = { side: [], total: [], other: [] };
    for (const p of picks || []) out[grpOf(p)].push({ ...p, home: names.home, away: names.away });
    return out;
  }, [picks, names.home, names.away]);

  if (err) return <div style={{ ...box, marginBottom: 12, fontSize: 12, color: C.warn }}>Outside picks did not load: {err}</div>;
  if (!picks) return <div style={{ ...box, marginBottom: 12, fontSize: 12, color: C.sub }}>Loading outside picks…</div>;

  const sideSites = (list, side) => new Set(list.filter((p) => p.side === side).map((p) => p.source_name.toLowerCase())).size;

  return (
    <div style={{ ...box, marginBottom: 12 }}>
      <div style={h3}>Outside picks · {picks.length ? `${picks.length} stored` : 'none yet'}</div>
      {!picks.length && (
        <p style={{ fontSize: 12.5, color: C.sub, margin: 0 }}>
          No source has picked this game yet. Picks are pulled on a schedule; see the pull log for <a href={`/${sport}/log`}>Pull picks now</a>.
        </p>
      )}
      {['side', 'total', 'other'].map((g) => {
        const list = groups[g];
        if (!list.length) return null;
        const sides = g === 'side' ? ['away', 'home'] : g === 'total' ? ['over', 'under'] : [];
        const m = g === 'side' ? model.side : g === 'total' ? model.total : null;
        const nowLine = g === 'side' ? now.side : g === 'total' ? now.total : null;
        const counts = sides.map((s) => sideSites(list, s));
        const total = counts.reduce((a, b) => a + b, 0);
        return (
          <div key={g} style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              {g === 'side' ? 'Sides (spread and moneyline)' : g === 'total' ? 'Total' : 'Other bets (halves, team totals)'}
            </div>
            {sides.map((s, i) => (
              <SideBar key={s} n={counts[i]} total={total} model={m === s}
                label={g === 'side' ? `${s === 'home' ? names.home : names.away} ${spreadFor(s, nowLine)}`.trim() : sideLabel({}, s, nowLine)}
                color={m ? (m === s ? C.green : C.warn) : C.blue} />
            ))}
            <div style={{ marginTop: 6 }}>
              {list.map((p) => {
                const worse = p.status === 'ok' || p.status === 'check'
                  ? (p.market === 'spread' ? lineWorseBy(p.side, p.home_line, nowLine) : p.market === 'total' ? lineWorseBy(p.side, p.line, nowLine) : null)
                  : null;
                const withModel = m && (p.side === m);
                return (
                  <div key={p.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5, padding: '3px 0', borderTop: `1px solid ${C.border}` }}>
                    <span style={{ ...FM, minWidth: 150, fontWeight: 600, color: m ? (withModel ? C.green : C.warn) : C.text }}>{describePick(p)}</span>
                    <span style={{ minWidth: 140 }}>
                      {p.url ? <a href={p.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>{p.source_name}</a> : p.source_name}
                      {p.expert ? <span style={{ color: C.sub }}> · {p.expert}</span> : null}
                      {p.origin === 'agent' ? <span style={{ color: C.gold }}> · agent</span> : null}
                    </span>
                    {worse !== null && Math.abs(worse) >= 0.5 && (
                      <span style={{ ...FM, fontSize: 11.5, color: worse > 0 ? C.warn : C.green }}>
                        {worse > 0 ? `line ${worse} worse now` : `line ${-worse} better now`}
                      </span>
                    )}
                    {p.status === 'check' && <span style={{ color: C.gold, fontSize: 11.5 }}>check: {p.check_reason}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <p style={{ fontSize: 11, color: C.sub, margin: '10px 0 0' }}>
        Green = the model&apos;s side, red = against it. Sites are counted once per side however many of their experts picked it.
        &ldquo;Line worse now&rdquo; means the source got a better number than is available now.
      </p>
    </div>
  );
}
