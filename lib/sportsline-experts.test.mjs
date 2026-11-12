import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseExpertCards, resolveExpertPicks, looksLikeExpertPicks } from './sportsline-experts.js';

const TXT = fs.readFileSync(new URL('./fixtures/sportsline-experts.txt', import.meta.url), 'utf8');
const G = (id, away, home) => ({ id, away_team: away, home_team: home });
const games = [
  G('a', 'Oregon State', 'Boise State'), G('b', 'Wake Forest', 'SMU'), G('c', 'USC', 'Indiana'), G('d', 'Kansas', 'West Virginia'),
  G('e', 'Utah', 'Arizona'), G('f', 'Ole Miss', 'Oklahoma'), G('g', 'Texas Tech', 'Oklahoma State'), G('h', 'Florida State', 'Pittsburgh'),
  G('x', 'Troy', 'South Alabama'),
];

test('detects the expert picks page, not the pick sheet', () => {
  assert.ok(looksLikeExpertPicks(TXT));
  assert.ok(!looksLikeExpertPicks('Matchup Analysis Expert Picks O/U 4'));
});
test('parses all eight cards', () => {
  const cards = parseExpertCards(TXT);
  assert.equal(cards.length, 8);
  assert.deepEqual(cards[0], { away: 'Beavers', home: 'Broncos', market: 'Over / Under', pick: 'Under 65.5 -115', expert: 'Mike Tierney' });
  assert.equal(cards[1].expert, 'Eric Cohen');
  assert.equal(cards[7].market, 'Money Line');
});
test('totals and spreads resolve; moneyline is skipped; nicknames disambiguate', () => {
  const { picks, skipped } = resolveExpertPicks(TXT, games);
  const by = (id) => picks.find((p) => p.game.id === id);
  assert.deepEqual([by('a').type, by('a').side, by('a').line, by('a').expert], ['total', 'under', 65.5, 'Mike Tierney']);
  assert.deepEqual([by('b').side, by('b').line], ['home', -1]);          // SMU -1
  assert.deepEqual([by('c').type, by('c').side], ['total', 'under']);   // Trojans = USC (not Troy)
  assert.deepEqual([by('d').side], ['over']);
  assert.deepEqual([by('e').side, by('e').line], ['home', 3]);          // Arizona +3
  assert.deepEqual([by('f').side, by('f').line], ['away', -1.5]);       // Ole Miss -1.5
  assert.deepEqual([by('g').side, by('g').line], ['home', -3.5]);       // Oklahoma State -3.5
  assert.equal(by('h'), undefined);
  assert.ok(skipped.some((s) => /money line/.test(s.reason)));
  assert.equal(picks.length, 7);
});
