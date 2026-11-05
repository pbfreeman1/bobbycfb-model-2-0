// Research Report: pure aggregation over research_picks, games and
// cfb_game_signals. No I/O here so it can be unit tested (see
// research-report.test.mjs) and reused by the page.
//
// Conventions (same as the rest of the app):
//   * spread lines are home-relative: positive = home favored, so the home
//     team's displayed spread is -line and the away team's is +line.
//   * actual_margin = home score - away score.
//   * a "side" is one tagged outcome of one game: (game, pick_type, pick_side).
//     Counting is by side, not by game, so Georgia and Auburn each have their
//     own tag count even though they are the same game.

// ---------------------------------------------------------------------------
// Source cleanup. Labels are free text ("Kam - #3", "KAM - TOP", "SportsLIne
// Expert"), so they are folded to one name per outlet/person. First match
// wins. Edit this list when a new outlet shows up. Assumption: "BC" and
// "Big Cat" are the same source.
// ---------------------------------------------------------------------------
export const SOURCE_ALIASES = [
  [/sportsline/i, 'SportsLine'],
  [/vsin/i, 'VSIN'],
  [/action/i, 'Action Network'],
  [/covers/i, 'Covers'],
  [/espn/i, 'ESPN'],
  [/yahoo/i, 'Yahoo'],
  [/nbc/i, 'NBC'],
  [/twitter/i, 'Twitter'],
  [/6\s*pack|cbs/i, 'CBS 6 Pack'],
  [/^(kam|kap)/i, 'KAM'],
  [/^bc\b|big\s*cat/i, 'BC (Big Cat)'],
  [/^dave/i, 'Dave'],
  [/^rico/i, 'Rico'],
  [/^bear/i, 'Bear'],
  [/pickem/i, 'Pickem'],
];

// Labels that describe the tag rather than name a source.
const NOTE_ONLY = /^(lean|lean over|leaning here|under|over|numerous|random|\d+\s*hits?|over is popular|popular|medium|top|low std.*)$/i;

export const UNLABELED = 'Unlabeled';
export const UNATTRIBUTED = 'Unattributed';

// Returns the unique canonical sources credited by one label. A label such as
// "Dave,BC,RICO" or "BC & KAM on it" credits each outlet it names.
export function normalizeSources(label) {
  const raw = (label || '').trim();
  if (!raw) return [UNLABELED];
  const out = [];
  for (const token of raw.split(/\s*(?:,|&|\/|\+)\s*/)) {
    const t = token.trim();
    if (!t) continue;
    let name = null;
    for (const [re, canon] of SOURCE_ALIASES) {
      if (re.test(t)) { name = canon; break; }
    }
    if (!name && NOTE_ONLY.test(t)) name = UNATTRIBUTED;
    if (!name) name = t.replace(/\s+/g, ' ');
    if (!out.includes(name)) out.push(name);
  }
  return out.length ? out : [UNATTRIBUTED];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
export function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return 'PK';
  return n > 0 ? `+${trim(n)}` : `${trim(n)}`;
}
function trim(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10); }

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

// The tagged team's spread from a home-relative line.
export function teamSpread(line, side) {
  const l = num(line);
  if (l == null) return null;
  return side === 'home' ? -l : l;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------
export function finalMargin(game) {
  if (!game) return null;
  const m = num(game.actual_margin);
  if (m != null) return m;
  const h = num(game.home_score), a = num(game.away_score);
  return h != null && a != null ? h - a : null;
}

// 'win' | 'loss' | 'push' | null (not gradable yet / custom tag).
export function gradeTag(tag, game, signal) {
  if (!game) return null;
  const type = tag.pick_type || 'spread';
  const side = tag.pick_side;
  const margin = finalMargin(game);
  if (type === 'spread') {
    const line = num(signal?.vegas_line) ?? num(game.current_line);
    if (margin == null || line == null || (side !== 'home' && side !== 'away')) return null;
    const d = margin - line;
    if (d === 0) return 'push';
    return (side === 'home' ? d > 0 : d < 0) ? 'win' : 'loss';
  }
  if (type === 'total') {
    const ou = num(game.over_under);
    const h = num(game.home_score), a = num(game.away_score);
    if (ou == null || h == null || a == null || (side !== 'over' && side !== 'under')) return null;
    const d = h + a - ou;
    if (d === 0) return 'push';
    return (side === 'over' ? d > 0 : d < 0) ? 'win' : 'loss';
  }
  if (type === 'moneyline') {
    if (margin == null || margin === 0 || (side !== 'home' && side !== 'away')) return null;
    return (side === 'home' ? margin > 0 : margin < 0) ? 'win' : 'loss';
  }
  return null;
}

const emptyRec = () => ({ w: 0, l: 0, p: 0 });
function addRec(rec, r) { if (r === 'win') rec.w++; else if (r === 'loss') rec.l++; else if (r === 'push') rec.p++; }
export function recPct(rec) { const d = rec.w + rec.l; return d ? rec.w / d : null; }
export function recStr(rec) { return `${rec.w}-${rec.l}${rec.p ? `-${rec.p}` : ''}`; }

// ---------------------------------------------------------------------------
// Label for a side, e.g. "Georgia -7", "Over 52.5", "Auburn ML", or the free
// text of a custom tag.
// ---------------------------------------------------------------------------
export function sideLabel(tag, game, signal, short = (s) => s) {
  const type = tag.pick_type || 'spread';
  if (type === 'custom') return tag.note || 'Custom';
  const team = (s) => short(s === 'home' ? (game?.home_team || tag.home_team) : (game?.away_team || tag.away_team));
  if (type === 'total') {
    const ou = num(game?.over_under);
    return `${tag.pick_side === 'over' ? 'Over' : 'Under'}${ou != null ? ` ${trim(ou)}` : ''}`;
  }
  if (type === 'moneyline') return `${team(tag.pick_side)} ML`;
  const sp = teamSpread(num(signal?.vegas_line) ?? num(game?.current_line), tag.pick_side);
  return `${team(tag.pick_side)} ${fmtSigned(sp)}`.trim();
}

// ---------------------------------------------------------------------------
// buildReport
//   tags    research_picks rows
//   games   games rows (id, home_team, away_team, kickoff_at, current_line,
//           over_under, home_score, away_score, actual_margin, status, week)
//   signals cfb_game_signals rows (any number per game; newest computed_at wins)
// ---------------------------------------------------------------------------
export function buildReport({ tags, games, signals }) {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const sigByGame = new Map();
  for (const s of signals) {
    const prev = sigByGame.get(s.game_id);
    if (!prev || String(s.computed_at) > String(prev.computed_at)) sigByGame.set(s.game_id, s);
  }

  const sides = new Map();
  const gameAgg = new Map();
  const sources = new Map();
  const weeks = new Map();
  const tagRec = emptyRec();

  for (const t of tags) {
    const game = gameById.get(t.game_id) || null;
    const signal = sigByGame.get(t.game_id) || null;
    const type = t.pick_type || 'spread';
    const result = gradeTag(t, game, signal);
    const credited = normalizeSources(t.source_label);

    // Bobby agreement exists only for spread tags with a computed signal.
    let bobby = null;
    if (type === 'spread' && signal && (t.pick_side === 'home' || t.pick_side === 'away')) {
      bobby = signal.pick_side === t.pick_side ? 'agree' : 'oppose';
    }

    // side
    const key = `${t.game_id}|${type}|${t.pick_side ?? `custom:${t.id}`}`;
    let s = sides.get(key);
    if (!s) {
      s = {
        key, game_id: t.game_id, game, signal, type, side: t.pick_side, week: t.week,
        label: sideLabel(t, game, signal), count: 0, tags: [], sources: new Map(),
        result, bobby, firstAt: t.created_at, lastAt: t.created_at,
      };
      sides.set(key, s);
    }
    s.count++;
    s.tags.push({ ...t, sources: credited, result });
    for (const src of credited) s.sources.set(src, (s.sources.get(src) || 0) + 1);
    if (String(t.created_at) < String(s.firstAt)) s.firstAt = t.created_at;
    if (String(t.created_at) > String(s.lastAt)) s.lastAt = t.created_at;

    // game
    let ga = gameAgg.get(t.game_id);
    if (!ga) {
      ga = { game_id: t.game_id, game, signal, week: t.week, home_team: t.home_team, away_team: t.away_team, counts: { home: 0, away: 0, over: 0, under: 0, other: 0 }, total: 0, sourceSet: new Set() };
      gameAgg.set(t.game_id, ga);
    }
    if (type === 'spread' || type === 'moneyline' || type === 'total') {
      if (ga.counts[t.pick_side] != null) ga.counts[t.pick_side]++;
      else ga.counts.other++;
    } else ga.counts.other++;
    ga.total++;
    for (const src of credited) ga.sourceSet.add(src);

    // source
    for (const src of credited) {
      let r = sources.get(src);
      if (!r) { r = { name: src, tags: 0, gameSet: new Set(), sideSet: new Set(), rec: emptyRec(), agree: 0, oppose: 0 }; sources.set(src, r); }
      r.tags++;
      r.gameSet.add(t.game_id);
      r.sideSet.add(key);
      addRec(r.rec, result);
      if (bobby === 'agree') r.agree++;
      else if (bobby === 'oppose') r.oppose++;
    }

    // week
    let w = weeks.get(t.week);
    if (!w) { w = { week: t.week, tags: 0, gameSet: new Set(), rec: emptyRec(), sideRec: emptyRec() }; weeks.set(t.week, w); }
    w.tags++;
    w.gameSet.add(t.game_id);
    addRec(w.rec, result);
    addRec(tagRec, result);
  }

  // side-level record (each side graded once, however many tags it has)
  const sideRec = emptyRec();
  for (const s of sides.values()) {
    addRec(sideRec, s.result);
    const w = weeks.get(s.week);
    if (w) addRec(w.sideRec, s.result);
  }

  const sourceList = [...sources.values()].map((r) => ({
    name: r.name, tags: r.tags, games: r.gameSet.size, sides: r.sideSet.size,
    rec: r.rec, pct: recPct(r.rec), agree: r.agree, oppose: r.oppose,
    agreePct: r.agree + r.oppose ? r.agree / (r.agree + r.oppose) : null,
  }));

  return {
    sides: [...sides.values()],
    games: [...gameAgg.values()].map((g) => ({ ...g, sources: g.sourceSet.size })),
    sources: sourceList,
    weeks: [...weeks.values()].map((w) => ({ week: w.week, tags: w.tags, games: w.gameSet.size, rec: w.rec, sideRec: w.sideRec, pct: recPct(w.sideRec) })).sort((a, b) => b.week - a.week),
    summary: {
      tags: tags.length,
      sides: sides.size,
      games: gameAgg.size,
      sources: sources.size,
      tagRec, sideRec,
    },
  };
}
