import test from 'node:test';
import assert from 'node:assert/strict';
import { siteSides, sideCounts, tagSummary, sideLabel, lineWorseBy, spotlights, crowdRecord, rec } from './scout-research.js';

const row = (o) => ({ sport: 'cbb', grp: 'side', home: 'Kansas', away: 'Houston', a_src: 0, b_src: 0, crowd_side: null, crowd_sources: 0, other_sources: 0, final: false, ...o });

test('tagSummary counts sources with and against the model', () => {
  const c = row({ a_src: 1, b_src: 3, crowd_side: 'away', crowd_sources: 3, other_sources: 1 });
  assert.deepEqual(sideCounts(c), { home: 1, away: 3 });
  assert.deepEqual(tagSummary(c, 'away'), { withN: 3, againstN: 1, total: 4, tone: 'with', crowdSide: 'away' });
  assert.equal(tagSummary(c, 'home').tone, 'against');
  assert.equal(tagSummary(row({ a_src: 2, b_src: 2, crowd_sources: 2, other_sources: 2 }), 'home').tone, 'split');
  const tot = row({ grp: 'total', a_src: 2, b_src: 0, crowd_side: 'over', crowd_sources: 2 });
  assert.deepEqual(tagSummary(tot, null), { withN: null, againstN: null, total: 2, tone: 'none', crowdSide: 'over', top: 2 });
  assert.equal(tagSummary(null, 'home'), null);
  assert.equal(tagSummary(row({}), 'home'), null);
});

test('sideLabel and lineWorseBy speak sportsbook', () => {
  const r = row({ market_line: -2.5 });
  assert.equal(sideLabel(r, 'away'), 'Houston -2.5');
  assert.equal(sideLabel(r, 'home'), 'Kansas +2.5');
  assert.equal(sideLabel({ market_line: 151.5 }, 'under'), 'Under 151.5');
  assert.equal(sideLabel(row({ market_line: null }), 'home'), 'Kansas');
  // took home -3 (home_line 3); now home -5 (5): 2 points worse for home
  assert.equal(lineWorseBy('home', 3, 5), 2);
  assert.equal(lineWorseBy('away', 3, 5), -2);
  assert.equal(lineWorseBy('over', 141.5, 143), 1.5);
  assert.equal(lineWorseBy('under', 141.5, 143), -1.5);
  assert.equal(lineWorseBy('home', null, 5), null);
});

test('spotlights sort open games into crowd+model, crowd vs model, splits and steam', () => {
  const rows = [
    row({ game_id: 1, crowd_side: 'away', crowd_sources: 4, other_sources: 0, model_relation: 'with' }),
    row({ game_id: 2, crowd_side: 'away', crowd_sources: 3, other_sources: 0, model_relation: 'against', open_line: 1, market_line: -1 }),
    row({ game_id: 3, crowd_side: 'home', crowd_sources: 2, other_sources: 2 - 0, model_relation: 'with' }),
    row({ game_id: 4, crowd_side: 'home', crowd_sources: 2, other_sources: 1, model_relation: 'with' }),
    row({ game_id: 5, crowd_side: 'away', crowd_sources: 5, other_sources: 0, model_relation: 'with', final: true }),
  ];
  const s = spotlights(rows);
  assert.deepEqual(s.together.map((r) => r.game_id), [1]);
  assert.deepEqual(s.against.map((r) => r.game_id), [2]);
  assert.deepEqual(s.splits.map((r) => r.game_id), [3, 4]);
  // game 2: away crowd, line went from home -1 (1) to away -1 (-1): moved 2 toward the away side
  assert.deepEqual(s.steam.map((r) => r.game_id), [2]);
});

test('crowdRecord buckets results by sources and model agreement', () => {
  const rows = [
    row({ crowd_sources: 1, other_sources: 0, crowd_result: 'W', model_relation: 'with' }),
    row({ crowd_sources: 2, other_sources: 0, crowd_result: 'W', model_relation: 'with' }),
    row({ crowd_sources: 2, other_sources: 1, crowd_result: 'L', model_relation: 'against' }),
    row({ crowd_sources: 5, other_sources: 0, crowd_result: 'P', model_relation: null }),
    row({ crowd_sources: 3, other_sources: 0, crowd_result: null }),
  ];
  const m = crowdRecord(rows);
  assert.deepEqual(rec(m.get('side|n:2|all')), { text: '1-1', pct: 50, units: -0.1, n: 2 });
  assert.equal(rec(m.get('side|n:all|with')).text, '2-0');
  assert.equal(rec(m.get('all|n:4+|all')).text, '0-0-1');
  assert.equal(rec(m.get('side|unanimous2+|all')).text, '1-0-1');
  assert.equal(rec(m.get('total|n:all|all')).text, '0-0');
});

test('siteSides counts a site on its majority side, neither when split', () => {
  const picks = [
    { source_name: 'CBS Sports', expert: 'Pete Prisco', side: 'home' },
    { source_name: 'CBS Sports', expert: 'Will Brinson', side: 'home' },
    { source_name: 'CBS Sports', expert: 'Jordan Dajani', side: 'away' },
    { source_name: 'Covers', expert: 'A B', side: 'away' },
    { source_name: 'Covers', expert: 'C D', side: 'home' },
    { source_name: 'VSIN', expert: '', side: 'away' },
    { source_name: 'VSIN', expert: '', side: 'away' },
  ];
  assert.deepEqual(siteSides(picks, ['home', 'away']), { counts: { home: 1, away: 1 }, split: ['Covers'] });
});
