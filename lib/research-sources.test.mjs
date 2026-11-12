// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortSources, findSource, convictionForRank, displayLabel, resolveRankInput, buildTagPayload } from './research-sources.js';

const kam = { id: 'k', name: 'KAM', uses_rank: true, sort_order: 10 };
const vsin = { id: 'v', name: 'VSIN', uses_rank: false, sort_order: 20 };
const old = { id: 'o', name: 'Old', active: false };

test('sources sort by sort_order and hide inactive', () => {
  assert.deepEqual(sortSources([vsin, old, kam]).map((s) => s.name), ['KAM', 'VSIN']);
});
test('findSource ignores case and spacing', () => {
  assert.equal(findSource([kam, vsin], '  vsin ').id, 'v');
  assert.equal(findSource([kam, vsin], 'Pickem'), null);
});
test('rank maps to conviction', () => {
  assert.equal(convictionForRank(1), 'top');
  assert.equal(convictionForRank(5), 'top');
  assert.equal(convictionForRank(6), 'topish');
  assert.equal(convictionForRank(15), 'topish');
  assert.equal(convictionForRank(16), null);
});
test('labels match the DB function', () => {
  assert.equal(displayLabel('KAM', 2, 'top'), 'KAM #2');
  assert.equal(displayLabel('KAM', null, 'top'), 'KAM Top');
  assert.equal(displayLabel('KAM', null, 'topish'), 'KAM Topish');
  assert.equal(displayLabel('VSIN', null, null), 'VSIN');
});
test('rank input only applies to rank sources and is validated', () => {
  assert.deepEqual(resolveRankInput(vsin, { rank: 3 }), { rank: null, conviction: null, error: null });
  assert.deepEqual(resolveRankInput(kam, { rank: '7' }), { rank: 7, conviction: 'topish', error: null });
  assert.equal(resolveRankInput(kam, { rank: 99 }).error, 'Rank must be 1-50.');
  assert.equal(resolveRankInput(kam, { conviction: 'top' }).conviction, 'top');
});
test('payload for a KAM spread tag', () => {
  const p = buildTagPayload({ game: { id: 'g', home_team: 'H', away_team: 'A' }, season: 2026, week: 11, pickType: 'spread', pickSide: 'away', source: kam, rank: 2, note: '' });
  assert.equal(p.source_label, 'KAM #2');
  assert.equal(p.conviction, 'top');
  assert.equal(p.pick_side, 'away');
  assert.equal(p.note, null);
});
