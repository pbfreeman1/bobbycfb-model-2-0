import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide, classify } from './weekend-guide.js';

// Week 10 (graded, backfill) + week 11 (open, forward).
const games = [
  { id: 'o1', week: 10, home_team: 'Utah', away_team: 'Kansas', current_line: -3, over_under: 50, home_score: 30, away_score: 20, status: 'final' },
  { id: 'a', week: 11, home_team: 'Arizona', away_team: 'Utah', current_line: -2.5, over_under: 54.5, kickoff_at: '2026-11-14T19:30:00-05:00' },
  { id: 'b', week: 11, home_team: 'SMU', away_team: 'Wake Forest', current_line: 1.5, over_under: 60.5 },
  { id: 'c', week: 11, home_team: 'Indiana', away_team: 'USC', current_line: 8.5, over_under: 50.5 },
  { id: 'd', week: 11, home_team: 'Oklahoma', away_team: 'Ole Miss', current_line: -1.5, over_under: 49.5 },
];
const sig = (game_id, pick_side, tier, extra = {}) => ({ game_id, computed_at: '2026-11-12T12:00:00Z', pick_side, vegas_line: games.find((g) => g.id === game_id).current_line, edge: 2, tier, coverage: 0.95, ...extra });
const signals = [
  sig('o1', 'home', '1U'),
  sig('a', 'away', '1U'),            // model: Utah... tagged Arizona -> against? no, tag below is Utah
  sig('b', 'home', '2U'),
  sig('c', 'home', null),
  sig('d', 'away', '1U'),
];
const tag = (game_id, week, pick_side, source_label, extra = {}) => ({ id: `${game_id}${pick_side}${source_label}`, game_id, week, season: 2026, pick_type: 'spread', pick_side, source_label, ...extra });
const tags = [
  tag('o1', 10, 'home', 'VSIN'),
  tag('a', 11, 'away', 'KAM #2', { rank: 2 }), tag('a', 11, 'away', 'VSIN - Makinen'),   // core: Utah -2.5 1U
  tag('b', 11, 'home', 'ESPN'),                                                            // 2U
  tag('c', 11, 'away', 'SportsLine - Model A'),                                            // USC +8.5 dog, no tier -> X? model home -> bucket X weak -> lean
  tag('d', 11, 'home', 'VSIN'),                                                            // Oklahoma vs 1U Ole Miss -> against
  { id: 't1', game_id: 'c', week: 11, season: 2026, pick_type: 'total', pick_side: 'under', source_label: 'SportsLine - Eric Cohen' },
];
const userPicks = [
  { id: 'u1', game_id: 'a', week: 11, pick_type: 'spread', side: 'away', line_played: -2.5, units: 1, games: games[1] },
  { id: 'u2', game_id: 'd', week: 11, pick_type: 'spread', side: 'home', line_played: 1.5, units: 1, games: games[4] },
];

test('classify: tier decides the section', () => {
  assert.equal(classify({ bucket: 'A', tier: '1U' }), 'core');
  assert.equal(classify({ bucket: 'A', tier: '3U' }), 'three');
  assert.equal(classify({ bucket: 'A', tier: '2U' }), 'two');
  assert.equal(classify({ bucket: 'M' }), 'model');
  assert.equal(classify({ bucket: 'X', tier: '1U', spread: 3 }), 'against');
  assert.equal(classify({ bucket: 'X', tier: null, spread: 3 }), 'lean');
  assert.equal(classify({ bucket: 'B', tier: null, spread: -3 }), 'other');
});

test('guide sections, my card cross-reference, evidence and totals', () => {
  const g = buildGuide({ week: 11, tags, games, signals, userPicks });
  const sec = (id) => g.sections.find((s) => s.id === id);
  assert.equal(sec('core').plays.length, 1);
  assert.equal(sec('core').plays[0].pick, 'Utah -2.5');
  assert.deepEqual(sec('core').plays[0].mine, ['Utah -2.5']);               // your play is on the core card
  assert.equal(sec('core').plays[0].sourceCount, 2);
  assert.equal(sec('two').plays[0].matchup.includes('SMU'), true);
  assert.equal(sec('lean').plays[0].pick.endsWith('+8.5'), true);
  assert.equal(sec('against').plays.length, 1);
  assert.deepEqual(g.myCard.find((m) => m.id === 'u2').relation, { kind: 'with', section: 'against' });
  assert.equal(g.myCard.find((m) => m.id === 'u1').relation.section, 'core');
  // evidence: week-10 core play (Utah home, margin +10 on -3 line) is a backfill win
  assert.deepEqual(sec('core').evidence.backfill, { w: 1, l: 0, p: 0, units: 1 });
  assert.equal(g.totals.length, 1);
  assert.equal(g.totals[0].side, 'under');
  assert.equal(g.counts.myPlays, 2);
});

test('warnings when nothing is loaded', () => {
  const g = buildGuide({ week: 12, tags, games, signals });
  assert.ok(g.warnings.some((w) => /No model signals/.test(w)));
  assert.ok(g.warnings.some((w) => /No research tags/.test(w)));
});

test('low coverage on most plays becomes one banner, not a chip per play', () => {
  const low = signals.map((x) => ({ ...x, coverage: 0.7 }));
  const g = buildGuide({ week: 11, tags, games, signals: low, userPicks });
  assert.equal(g.counts.coverageGlobal, true);
  assert.ok(g.warnings.some((w) => /coverage is below 0.90/i.test(w)));
  assert.ok(g.sections.every((s) => s.plays.every((p) => !p.flags.includes('Low coverage'))));
});
