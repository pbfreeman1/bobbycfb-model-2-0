// Weekend Guide: one place for the week's model plays, research tags, combos and
// your own logged plays. Pure functions over rows already loaded by the page.
//
// The sections follow docs/ weekly-play-selection-process (v1.2):
//   core      Model 1U play AND an outside tag on the same side
//   lean      Tagged underdog the model does not strongly oppose
//   three     Model 3U with a tag (optional, track)
//   two       Model 2U with a tag (process says skip; shown so nothing is hidden)
//   model     Model 1U/2U/3U play with no spread tag (track only)
//   against   Research tags a side a tiered model play is against (information)
//   other     Remaining tagged sides (favourites, no signal) in one compact list
// Totals tags are listed separately (track only). "My card" is the plays logged
// with + Bobby Pick, cross-referenced to the sections.
//
// Every section carries its own record from weeks 1+ in the data, split into
// forward (week >= forwardFrom) and backfill. The rules were found by slicing
// weeks 1-10, so the backfill record is a hypothesis, not proof.

import { buildPlays, TIERED, unitsFor } from './research-plays.js';
import { fmtSigned, normalizeSources } from './research-report.js';
import { shortTeam } from './team-short.js';
import { pickDescription, unitsPL } from './bet-types.js';

export const SECTIONS = [
  { id: 'core', title: 'Core card', rule: 'Model 1U play + an outside tag on the same side. Flat 1u.' },
  { id: 'lean', title: 'Leans', rule: 'Tagged underdog the model does not strongly oppose. Prefer 2+ sources. Flat 1u or pass.' },
  { id: 'three', title: 'Model 3U + tag', rule: 'Optional. Track only until it has 30+ forward games.' },
  { id: 'two', title: 'Model 2U + tag', rule: 'Process says skip 2U plays. Shown so nothing is hidden.' },
  { id: 'model', title: 'Model only (no tag)', rule: 'Untagged model plays. Track only.' },
  { id: 'against', title: 'Research vs model', rule: 'A tag on the side a 1U/2U/3U model play is against. Information, not a bet.' },
  { id: 'other', title: 'Other research tags', rule: 'Tagged sides that fit none of the above.' },
];

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

// Which section a play (from buildPlays) belongs to.
export function classify(p) {
  const tiered = TIERED.has(p.tier);
  if (p.bucket === 'A') return p.tier === '1U' ? 'core' : p.tier === '3U' ? 'three' : 'two';
  if (p.bucket === 'M') return 'model';
  if (p.bucket === 'X' && tiered) return 'against';
  const dog = p.spread != null && p.spread > 0;
  if (dog && (p.bucket === 'B' || p.bucket === 'N' || p.bucket === 'X')) return 'lean';
  return 'other';
}

const blank = () => ({ w: 0, l: 0, p: 0, units: 0 });
function record(plays) {
  const fwd = blank(), back = blank();
  for (const p of plays) {
    if (!p.result) continue;
    const r = p.forward ? fwd : back;
    if (p.result === 'win') r.w++; else if (p.result === 'loss') r.l++; else r.p++;
    r.units += unitsFor(p.result);
  }
  fwd.units = Math.round(fwd.units * 10) / 10; back.units = Math.round(back.units * 10) / 10;
  return { forward: fwd, backfill: back };
}

function describePlay(p, mine) {
  const g = p.game;
  const team = g ? shortTeam(p.side === 'home' ? g.home_team : g.away_team) : p.side;
  const opp = g ? shortTeam(p.side === 'home' ? g.away_team : g.home_team) : '';
  const labels = [...new Set((p.tags || []).map((t) => t.source_label).filter(Boolean))];
  return {
    key: p.key, game_id: p.game_id, bucket: p.bucket, section: classify(p),
    team, opp, atHome: p.side === 'home', spread: p.spread,
    pick: `${team} ${fmtSigned(p.spread)}`,
    matchup: g ? `${shortTeam(g.away_team)} @ ${shortTeam(g.home_team)}` : '',
    kickoff: g?.kickoff_at || null,
    tier: p.tier || null,
    edge: num(p.signal?.edge),
    sources: p.sources, sourceCount: p.sourceCount, labels,
    kam: p.kamRank != null ? `KAM #${p.kamRank}` : p.kamTop ? 'KAM Top' : p.kamTopish ? 'KAM Topish' : null,
    flags: [p.moved ? 'Line moved' : null, p.lowCoverage ? 'Low coverage' : null].filter(Boolean),
    mine,
  };
}

// user picks (My Card rows) -> display rows with a relation to the plays.
function myCardRows(userPicks, gameById, weekPlays) {
  return (userPicks || []).map((u) => {
    const g = u.games || gameById.get(u.game_id) || null;
    const teamFor = (side) => shortTeam(side === 'home' ? g?.home_team : g?.away_team);
    const desc = pickDescription(u, teamFor);
    const sameGame = weekPlays.filter((p) => p.game_id === u.game_id);
    let relation = null;
    if (u.pick_type === 'spread' || u.pick_type == null) {
      const hit = sameGame.find((p) => p.side === u.side);
      const opp = sameGame.find((p) => p.side !== u.side);
      if (hit) relation = { kind: 'with', section: classify(hit) };
      else if (opp) relation = { kind: 'against', section: classify(opp) };
    }
    return {
      id: u.id, game_id: u.game_id, desc, units: num(u.units), lock: !!u.is_lock, result: u.result || null,
      matchup: g ? `${shortTeam(g.away_team)} @ ${shortTeam(g.home_team)}` : '',
      kickoff: g?.kickoff_at || null, type: u.is_custom ? 'custom' : u.pick_type, side: u.side, relation,
      model: u._model || null, net: u.result ? Math.round(unitsPL(u) * 100) / 100 : null,
    };
  });
}

function totalsRows(tags, gameById, week) {
  const by = new Map();
  for (const t of tags) {
    if (t.week !== week || (t.pick_type || 'spread') !== 'total' || (t.pick_side !== 'over' && t.pick_side !== 'under')) continue;
    const k = `${t.game_id}|${t.pick_side}`;
    if (!by.has(k)) by.set(k, { game_id: t.game_id, side: t.pick_side, labels: [], sources: new Set() });
    const r = by.get(k);
    if (t.source_label) r.labels.push(t.source_label);
    for (const s of normalizeSources(t.source_label)) r.sources.add(s);
  }
  return [...by.values()].map((r) => {
    const g = gameById.get(r.game_id);
    return {
      game_id: r.game_id, side: r.side, total: num(g?.over_under), sourceCount: r.sources.size, labels: [...new Set(r.labels)],
      matchup: g ? `${shortTeam(g.away_team)} @ ${shortTeam(g.home_team)}` : '', kickoff: g?.kickoff_at || null,
    };
  }).sort((a, b) => b.sourceCount - a.sourceCount || (a.kickoff || '').localeCompare(b.kickoff || ''));
}

// tags / games / signals: every row for the season (evidence uses all weeks).
// userPicks: My Card rows for this week only.
export function buildGuide({ week, tags, games, signals, userPicks = [], forwardFrom = 11 }) {
  const all = buildPlays({ tags, games, signals, forwardFrom });
  const gameById = new Map((games || []).map((g) => [g.id, g]));
  const weekPlays = all.filter((p) => p.week === week);

  const evidence = {};
  for (const s of SECTIONS) evidence[s.id] = record(all.filter((p) => classify(p) === s.id));

  const mineByKey = new Map();
  const myRows = myCardRows(userPicks, gameById, weekPlays);
  for (const m of myRows) {
    if (m.type !== 'spread' || !m.side) continue;
    const k = `${m.game_id}|${m.side}`;
    if (!mineByKey.has(k)) mineByKey.set(k, []);
    mineByKey.get(k).push(m);
  }

  // When most signals are low-coverage (late PredictionTracker systems not loaded yet),
  // a chip on every play is noise: say it once at the top instead.
  const wkPlays = weekPlays.filter((p) => p.signal);
  const lowShare = wkPlays.length ? wkPlays.filter((p) => p.lowCoverage).length / wkPlays.length : 0;
  const coverageGlobal = lowShare >= 0.5;

  const sections = SECTIONS.map((s) => ({
    ...s,
    evidence: evidence[s.id],
    plays: weekPlays.filter((p) => classify(p) === s.id).map((p) => {
      const d = describePlay(p, (mineByKey.get(p.key) || []).map((m) => m.desc));
      if (coverageGlobal) d.flags = d.flags.filter((f) => f !== 'Low coverage');
      return d;
    }),
  }));

  const weekGames = (games || []).filter((g) => g.week === week);
  const weekSignals = new Map();
  for (const s of signals || []) {
    if (!weekGames.some((g) => g.id === s.game_id)) continue;
    const p = weekSignals.get(s.game_id);
    if (!p || String(s.computed_at) > String(p.computed_at)) weekSignals.set(s.game_id, s);
  }
  const computedAt = [...weekSignals.values()].map((s) => s.computed_at).filter(Boolean).sort().pop() || null;
  const flagged = sections.flatMap((s) => (s.id === 'core' || s.id === 'lean' ? s.plays : [])).filter((p) => p.flags.length).length;

  const warnings = [];
  if (!weekSignals.size) warnings.push('No model signals for this week yet. Load the latest predictions and run Compute.');
  if (!(tags || []).some((t) => t.week === week)) warnings.push('No research tags for this week yet.');
  if (coverageGlobal) warnings.push(`Model coverage is below 0.90 on ${Math.round(lowShare * 100)}% of this week's plays (late PredictionTracker systems are probably not loaded yet). Re-pull the CSV, run Compute, and regenerate before trusting any tier.`);
  if (flagged) warnings.push(`${flagged} core/lean play${flagged > 1 ? 's have' : ' has'} a flag (line moved or low coverage). Recheck the line before betting.`);

  return {
    week, forwardFrom, computedAt,
    counts: {
      games: weekGames.length, signals: weekSignals.size,
      coverageGlobal,
      tiered: [...weekSignals.values()].filter((s) => TIERED.has(s.tier)).length,
      tagsThisWeek: (tags || []).filter((t) => t.week === week).length,
      myPlays: myRows.length,
    },
    sections, totals: totalsRows(tags || [], gameById, week), myCard: myRows, warnings,
  };
}
