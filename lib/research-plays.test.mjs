// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlays, scoreboard, lineMoved } from './research-plays.js';

const games = [
  { id: 'g1', week: 10, home_team: 'H1', away_team: 'A1', current_line: -3, home_score: 20, away_score: 30, actual_margin: -10 },
  { id: 'g2', week: 11, home_team: 'H2', away_team: 'A2', current_line: 7, home_score: null, away_score: null },
  { id: 'g3', week: 11, home_team: 'H3', away_team: 'A3', current_line: 3 },
  { id: 'g4', week: 11, home_team: 'H4', away_team: 'A4', current_line: 3 },
];
const signals = [
  { game_id: 'g1', computed_at: '1', pick_side: 'away', tier: '1U', vegas_line: -3, edge: 4 },
  { game_id: 'g2', computed_at: '1', pick_side: 'home', tier: 'Lean', vegas_line: 7, edge: 1, coverage: 0.5 },
  { game_id: 'g3', computed_at: '1', pick_side: 'home', tier: '2U', vegas_line: 3, edge: 5 },
];
const tag = (o) => ({ pick_type: 'spread', source_label: 'VSIN', ...o });
const tags = [
  tag({ game_id: 'g1', pick_side: 'away', week: 10 }),
  tag({ game_id: 'g2', pick_side: 'home', week: 11, line_at_tag: 7 }),
  tag({ game_id: 'g2', pick_side: 'away', week: 11, source_label: 'KAM #1', rank: 1, conviction: 'top' }),
  tag({ game_id: 'g4', pick_side: 'home', week: 11 }),
  { game_id: 'g1', pick_type: 'total', pick_side: 'over', week: 10 },
];

test('buckets', () => {
  const plays = buildPlays({ tags, games, signals });
  const by = (id, side) => plays.find((p) => p.game_id === id && p.side === side);
  assert.equal(by('g1', 'away').bucket, 'A');
  assert.equal(by('g2', 'home').bucket, 'B');
  assert.equal(by('g2', 'away').bucket, 'X');
  assert.equal(by('g3', 'home').bucket, 'M');
  assert.equal(by('g4', 'home').bucket, 'N');
  assert.equal(plays.some((p) => p.key.includes('over')), false);
});
test('kam rank and coverage flags', () => {
  const plays = buildPlays({ tags, games, signals });
  const x = plays.find((p) => p.game_id === 'g2' && p.side === 'away');
  assert.equal(x.kamRank, 1);
  assert.equal(x.kamTop, true);
  assert.equal(plays.find((p) => p.game_id === 'g2' && p.side === 'home').lowCoverage, true);
});
test('sorted A before B before M', () => {
  const order = buildPlays({ tags, games, signals }).map((p) => p.bucket);
  assert.deepEqual(order, ['A', 'B', 'M', 'X', 'N']);
});
test('scoreboard grades with the signal line, flat 1u', () => {
  const sb = scoreboard(buildPlays({ tags, games, signals }));
  // g1: line -3 home-relative, away won by 10 => away covers
  assert.deepEqual(sb.A.backfill, { w: 1, l: 0, p: 0, units: 1 });
  assert.equal(sb.B.forward.w + sb.B.forward.l, 0);
});
test('line movement', () => {
  assert.equal(lineMoved(-3, -6), true);
  assert.equal(lineMoved(-3, -4.5), false);
  assert.equal(lineMoved(-1, 1), true);
  assert.equal(lineMoved(null, 3), false);
});
