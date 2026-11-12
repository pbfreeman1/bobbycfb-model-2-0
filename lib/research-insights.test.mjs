// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from './research-report.js';
import { buildInsights, kamBand, pct } from './research-insights.js';

const games = [
  { id: 'g1', week: 10, home_team: 'H1', away_team: 'A1', current_line: -3, home_score: 20, away_score: 30, actual_margin: -10 }, // away covers
  { id: 'g2', week: 11, home_team: 'H2', away_team: 'A2', current_line: 7, home_score: 30, away_score: 10, actual_margin: 20 },   // home covers
  { id: 'g3', week: 11, home_team: 'H3', away_team: 'A3', current_line: 3, home_score: 10, away_score: 20, actual_margin: -10 },  // away covers
];
const signals = [
  { game_id: 'g1', computed_at: '1', pick_side: 'away', tier: '1U', vegas_line: -3 },
  { game_id: 'g2', computed_at: '1', pick_side: 'away', tier: 'Lean', vegas_line: 7 },
  { game_id: 'g3', computed_at: '1', pick_side: 'home', tier: '2U', vegas_line: 3 },
];
const t = (o) => ({ pick_type: 'spread', source_label: 'VSIN', ...o });
const tags = [
  t({ game_id: 'g1', pick_side: 'away', week: 10 }),
  t({ game_id: 'g1', pick_side: 'away', week: 10, source_label: 'KAM #2', rank: 2, conviction: 'top' }),
  t({ game_id: 'g2', pick_side: 'home', week: 11 }),
  t({ game_id: 'g3', pick_side: 'away', week: 11, source_label: 'KAM Top', conviction: 'top' }),
];
const ins = buildInsights(buildReport({ tags, games, signals }));
const row = (title, label) => ins.groups.find((g) => g.title === title)?.rows.find((r) => r.label === label);

test('model tier slice counts each side once', () => {
  const r = row('Model tier vs the tagged side', 'With model: 1U');
  assert.deepEqual([r.all.w, r.all.l], [1, 0]);   // two tags on g1 away, one side
  assert.equal(row('Model tier vs the tagged side', 'Against the model').all.w, 2); // g2 home and g3 away both cover, both oppose
});
test('forward and backfill are split', () => {
  const r = row('With vs against the model', 'Against model');
  assert.equal(r.all.w, 2);
  assert.equal(r.fwd.w, 2);
  assert.equal(row('With vs against the model', 'With model').fwd.w, 0);
  assert.equal(ins.spreadAll.units, 3);
});
test('KAM bands and sources', () => {
  assert.equal(row('KAM rank', 'KAM #1-3').all.w, 1);
  assert.equal(row('KAM rank', 'KAM Top (no rank)').all.w, 1);
  assert.equal(row('Distinct sources on the side', '2 sources').all.w, 1);
  assert.equal(row('Source', 'VSIN').all.w, 2);
});
test('kamBand uses the best rank', () => {
  assert.equal(kamBand({ tags: [{ source_label: 'KAM #9', rank: 9 }, { source_label: 'KAM #4', rank: 4 }] }), 'KAM #4-5');
  assert.equal(kamBand({ tags: [{ source_label: 'VSIN' }] }), null);
  assert.equal(pct({ w: 1, l: 1, p: 0 }), 0.5);
});
