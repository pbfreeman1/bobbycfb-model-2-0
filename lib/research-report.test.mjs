// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSources, gradeTag, sideLabel, buildReport, recStr, UNLABELED, UNATTRIBUTED } from './research-report.js';

test('source labels fold to one name per outlet', () => {
  assert.deepEqual(normalizeSources('Kam - #3'), ['KAM']);
  assert.deepEqual(normalizeSources('KAM - TOP'), ['KAM']);
  assert.deepEqual(normalizeSources('KAMBOUR BB'), ['KAM']);
  assert.deepEqual(normalizeSources('KAP - #1'), ['KAM']);
  assert.deepEqual(normalizeSources('SportsLIne Expert'), ['SportsLine']);
  assert.deepEqual(normalizeSources('A Rated SportsLine'), ['SportsLine']);
  assert.deepEqual(normalizeSources('Big Cat'), ['BC (Big Cat)']);
  assert.deepEqual(normalizeSources('BC Cam Over'), ['BC (Big Cat)']);
  assert.deepEqual(normalizeSources('6Pack - Lock'), ['CBS 6 Pack']);
  assert.deepEqual(normalizeSources('COVERS'), ['Covers']);
  assert.deepEqual(normalizeSources('Action'), ['Action Network']);
});

test('multi-source labels credit each outlet', () => {
  assert.deepEqual(normalizeSources('Dave,BC,RICO'), ['Dave', 'BC (Big Cat)', 'Rico']);
  assert.deepEqual(normalizeSources('BC & KAM on it'), ['BC (Big Cat)', 'KAM']);
  assert.deepEqual(normalizeSources('SportsLine A sim + Dave lock'), ['SportsLine', 'Dave']);
  assert.deepEqual(normalizeSources('POPULAR - VSIN, PICKEM'), ['VSIN', 'Pickem']);
});

test('blank and note-only labels are not treated as sources', () => {
  assert.deepEqual(normalizeSources(null), [UNLABELED]);
  assert.deepEqual(normalizeSources('  '), [UNLABELED]);
  assert.deepEqual(normalizeSources('Lean Over'), [UNATTRIBUTED]);
  assert.deepEqual(normalizeSources('2 hits'), [UNATTRIBUTED]);
  assert.deepEqual(normalizeSources('LOW STD - Low EDGE'), [UNATTRIBUTED]);
});

// Oregon (home) 31, Washington (away) 24 -> home margin +7. Raw line +3 means
// Oregon is a 3-point favorite, so Oregon -3 covers and Washington +3 does not.
const game = { id: 'g1', home_team: 'Oregon', away_team: 'Washington', current_line: 3, over_under: 50.5, home_score: 31, away_score: 24, actual_margin: 7, week: 5 };

test('spread grading follows the home-positive convention', () => {
  assert.equal(gradeTag({ pick_type: 'spread', pick_side: 'home' }, game, null), 'win');
  assert.equal(gradeTag({ pick_type: 'spread', pick_side: 'away' }, game, null), 'loss');
  assert.equal(gradeTag({ pick_type: 'spread', pick_side: 'home' }, game, { vegas_line: 7 }), 'push');
  assert.equal(gradeTag({ pick_type: 'spread', pick_side: 'away' }, game, { vegas_line: 10 }), 'win');
});

test('totals, moneyline, ungraded and custom', () => {
  assert.equal(gradeTag({ pick_type: 'total', pick_side: 'over' }, game, null), 'win'); // 55 > 50.5
  assert.equal(gradeTag({ pick_type: 'total', pick_side: 'under' }, game, null), 'loss');
  assert.equal(gradeTag({ pick_type: 'moneyline', pick_side: 'home' }, game, null), 'win');
  assert.equal(gradeTag({ pick_type: 'custom', pick_side: null }, game, null), null);
  const open = { ...game, home_score: null, away_score: null, actual_margin: null };
  assert.equal(gradeTag({ pick_type: 'spread', pick_side: 'home' }, open, null), null);
  assert.equal(gradeTag({ pick_type: 'total', pick_side: 'over' }, open, null), null);
});

test('side labels show the tagged team spread', () => {
  assert.equal(sideLabel({ pick_type: 'spread', pick_side: 'home' }, game, null), 'Oregon -3');
  assert.equal(sideLabel({ pick_type: 'spread', pick_side: 'away' }, game, null), 'Washington +3');
  assert.equal(sideLabel({ pick_type: 'total', pick_side: 'over' }, game, null), 'Over 50.5');
  assert.equal(sideLabel({ pick_type: 'custom', note: 'Team total over 31.5' }, game, null), 'Team total over 31.5');
});

test('report counts by side, not by game, and credits sources', () => {
  const tags = [
    { id: 1, game_id: 'g1', week: 5, pick_type: 'spread', pick_side: 'home', source_label: 'Kam - #1', home_team: 'Oregon', away_team: 'Washington', created_at: '2026-10-01T00:00:00Z' },
    { id: 2, game_id: 'g1', week: 5, pick_type: 'spread', pick_side: 'home', source_label: 'SportsLine', home_team: 'Oregon', away_team: 'Washington', created_at: '2026-10-02T00:00:00Z' },
    { id: 3, game_id: 'g1', week: 5, pick_type: 'spread', pick_side: 'away', source_label: 'KAM - 2', home_team: 'Oregon', away_team: 'Washington', created_at: '2026-10-03T00:00:00Z' },
    { id: 4, game_id: 'g1', week: 5, pick_type: 'total', pick_side: 'under', source_label: null, home_team: 'Oregon', away_team: 'Washington', created_at: '2026-10-03T00:00:00Z' },
  ];
  const signals = [
    { game_id: 'g1', pick_side: 'home', computed_at: '2026-09-30T00:00:00Z', vegas_line: 3 },
    { game_id: 'g1', pick_side: 'home', computed_at: '2026-10-01T00:00:00Z', vegas_line: 3 },
  ];
  const r = buildReport({ tags, games: [game], signals });
  assert.equal(r.summary.tags, 4);
  assert.equal(r.summary.sides, 3);
  assert.equal(r.summary.games, 1);
  const home = r.sides.find((s) => s.side === 'home');
  assert.equal(home.count, 2);
  assert.equal(home.bobby, 'agree');
  assert.equal(r.sides.find((s) => s.side === 'away').bobby, 'oppose');
  assert.equal(r.sides.find((s) => s.type === 'total').bobby, null);
  const kam = r.sources.find((s) => s.name === 'KAM');
  assert.equal(kam.tags, 2);
  assert.equal(recStr(kam.rec), '1-1');
  assert.equal(kam.agreePct, 0.5);
  // tag record: home x2 win, away loss, under loss
  assert.equal(recStr(r.summary.tagRec), '2-2');
  // side record: home win, away loss, under loss
  assert.equal(recStr(r.summary.sideRec), '1-2');
});
