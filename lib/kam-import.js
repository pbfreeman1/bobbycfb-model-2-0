// KAM import: parse the Kambour model pages, match them to this week's games
// and plan the research tags. Pure functions (no I/O) so they can be tested.
//
// Source pages (no headers, two lines per game, sorted by the unlabeled
// decimal, highest first):
//   ATS     https://www.kambour.net/NCAAPredsSprd.html
//   Totals  https://www.kambour.net/NCAAPredsOU.html
//
//   ATS:     "Georgia Tech (+13.5)   21" / "Clemson   28   0.6425"
//            The parenthesised number is that team's spread. KAM's pick is the
//            team whose predicted score covers it: (own score - other score +
//            spread) > 0. The decimal is the pick's probability.
//   Totals:  "Alabama   42" / "Vanderbilt (O 50.5)   20   0.6848"
//            O/U and the total are in the parentheses; the side shown is the pick.
//
// Rank = position in the sorted list (1 = highest probability).

import { normalizeTeamName } from './team-match.js';
import { displayLabel, convictionForRank } from './research-sources.js';

export function stripHtml(raw) {
  return String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|pre|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '');
}

const LINE_RE = /^\s*(.+?)\s*(?:\(([^)]*)\))?\s+(\d+)(?:\s+(\d?\.\d+))?\s*$/;

function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { team: m[1].trim(), paren: m[2] != null ? m[2].trim() : null, score: +m[3], prob: m[4] != null ? +m[4] : null };
}

// kind: 'ats' | 'ou'. Returns { entries, skipped } with entries in page order,
// then stably sorted by probability (desc) so rank never depends on layout.
export function parseKamText(text, kind) {
  const lines = stripHtml(text).split('\n').map(parseLine).filter(Boolean);
  const entries = [];
  const skipped = [];
  for (let i = 0; i + 1 < lines.length; ) {
    const a = lines[i], b = lines[i + 1];
    // a game is a line without the decimal followed by one with it; anything else is noise
    if (a.prob != null || b.prob == null) { skipped.push(`${a.team}: not part of a game`); i += 1; continue; }
    i += 2;
    const prob = b.prob;
    if (kind === 'ats') {
      const withP = a.paren != null ? a : b.paren != null ? b : null;
      if (!withP) { skipped.push(`${a.team} / ${b.team}: no spread`); continue; }
      const other = withP === a ? b : a;
      const sp = /^pk$/i.test(withP.paren) ? 0 : parseFloat(withP.paren);
      if (!Number.isFinite(sp)) { skipped.push(`${a.team} / ${b.team}: bad spread "${withP.paren}"`); continue; }
      const cover = withP.score - other.score + sp;
      if (cover === 0) { skipped.push(`${a.team} / ${b.team}: predicted push`); continue; }
      const pick = cover > 0 ? withP : other;
      entries.push({ kind, teams: [a.team, b.team], pickTeam: pick.team, spread: pick === withP ? sp : -sp, prob });
    } else {
      const withP = a.paren != null ? a : b.paren != null ? b : null;
      const mm = withP && /^([OU])\s*(\d+(?:\.\d+)?)$/i.exec(withP.paren);
      if (!mm) { skipped.push(`${a.team} / ${b.team}: no O/U`); continue; }
      entries.push({ kind, teams: [a.team, b.team], side: mm[1].toUpperCase() === 'O' ? 'over' : 'under', total: +mm[2], prob });
    }
  }
  entries.forEach((e, i) => { e._i = i; });
  entries.sort((x, y) => y.prob - x.prob || x._i - y._i);
  entries.forEach((e, i) => { e.rank = i + 1; delete e._i; });
  return { entries, skipped };
}

// KAM abbreviates ("C Michigan", "N Illinois", "Florida Atl", "UL Lafayette").
const KAM_WORDS = { c: 'central', n: 'northern', e: 'eastern', w: 'western', atl: 'atlantic' };
const KAM_NAMES = { 'ul lafayette': 'louisiana', 'ul monroe': 'ul monroe', 'miami oh': 'miami oh', 'miami fl': 'miami' };
export function kamKey(raw) {
  let k = normalizeTeamName(raw);
  if (KAM_NAMES[k]) return normalizeTeamName(KAM_NAMES[k]);
  return k.split(' ').map((w) => KAM_WORDS[w] || w).join(' ');
}

// Teams play once a week, so either team identifies the game. Both resolving
// to different games is ambiguous and left unmatched.
export function matchEntries(entries, games) {
  const byTeam = new Map();
  for (const g of games) {
    for (const n of [g.home_team, g.away_team]) {
      const keys = new Set([normalizeTeamName(n), kamKey(n)]);
      for (const k of keys) byTeam.set(k, g);
    }
  }
  const matched = [], unmatched = [];
  for (const e of entries) {
    const hits = e.teams.map((t) => byTeam.get(kamKey(t)) || byTeam.get(normalizeTeamName(t)) || null);
    const found = [...new Set(hits.filter(Boolean))];
    if (found.length !== 1) { unmatched.push({ ...e, reason: found.length ? 'ambiguous' : 'no game found' }); continue; }
    const game = found[0];
    const is = (name, team) => !!team && (kamKey(name) === kamKey(team) || normalizeTeamName(name) === normalizeTeamName(team));
    let side;
    if (e.kind === 'ou') side = e.side;
    else if (is(e.pickTeam, game.home_team)) side = 'home';
    else if (is(e.pickTeam, game.away_team)) side = 'away';
    else {
      // pick team did not resolve; it is the opposite of the team that did
      const otherName = e.teams.find((t) => t !== e.pickTeam);
      side = is(otherName, game.home_team) ? 'away' : is(otherName, game.away_team) ? 'home' : null;
    }
    if (!side) { unmatched.push({ ...e, reason: 'could not tell the side' }); continue; }
    matched.push({ ...e, game, side });
  }
  return { matched, unmatched };
}

// What a rank becomes: numbered through `numberedThrough`, then unnumbered
// Topish through `topishThrough`, otherwise not tagged.
export function tagForRank(rank, { numberedThrough = 10, topishThrough = 15 } = {}) {
  if (rank <= numberedThrough) return { rank, conviction: convictionForRank(rank) };
  if (rank <= topishThrough) return { rank: null, conviction: 'topish' };
  return null;
}

// existing: research_picks rows for the week already carrying the KAM source.
// Returns [{ action: 'insert' | 'rerank' | 'same', ... }].
export function planTags(matched, existing, { kind, season, week, source, numberedThrough = 10, topishThrough = 15 }) {
  const pickType = kind === 'ou' ? 'total' : 'spread';
  const plan = [];
  for (const m of matched) {
    const tg = tagForRank(m.rank, { numberedThrough, topishThrough });
    if (!tg) continue;
    const old = existing.find((r) => r.game_id === m.game.id && r.pick_side === m.side && (r.pick_type || 'spread') === pickType);
    const label = displayLabel(source.name, tg.rank, tg.conviction);
    const row = {
      season, week, game_id: m.game.id, home_team: m.game.home_team, away_team: m.game.away_team,
      pick_type: pickType, pick_side: m.side, source_id: source.id, rank: tg.rank, conviction: tg.conviction, source_label: label,
      note: old?.note ?? null,
    };
    if (old) {
      if (old.rank === tg.rank && old.conviction === tg.conviction) { plan.push({ action: 'same', rank: m.rank, label, game: m.game, side: m.side, oldId: old.id }); continue; }
      // research_picks has no UPDATE policy, so a re-rank is delete + insert that keeps the original tag-time stamp
      plan.push({ action: 'rerank', rank: m.rank, label, from: old.source_label, game: m.game, side: m.side, oldId: old.id,
        row: { ...row, created_at: old.created_at, line_at_tag: old.line_at_tag, total_at_tag: old.total_at_tag, line_basis: old.line_basis } });
    } else {
      plan.push({ action: 'insert', rank: m.rank, label, game: m.game, side: m.side, row });
    }
  }
  return plan;
}
