import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSheetRows, resolveSheetPicks, looksLikePickSheet } from './sportsline-sheet.js';

const SAMPLE = fs.readFileSync(new URL('./fixtures/sportsline-sheet.txt', import.meta.url), 'utf8');
const G = (id, away, home) => ({ id, away_team: away, home_team: home });
const games = [
  G('g1', 'Louisiana', 'UL Monroe'), G('g2', 'Auburn', 'Mississippi State'), G('g3', 'Northwestern', 'Ohio State'),
  G('g4', 'Wake Forest', 'SMU'), G('g5', 'East Carolina', 'Charlotte'), G('g6', 'UAB', 'Temple'),
  G('g7', 'Kennesaw State', 'Sam Houston'), G('g8', 'Boston College', 'Notre Dame'), G('g9', 'Michigan', 'Oregon'),
  G('g10', 'Utah', 'Arizona'), G('g11', 'South Carolina', 'Arkansas'), G('g12', 'USC', 'Indiana'),
];

test('detects a pick sheet and parses rows', () => {
  assert.ok(looksLikePickSheet(SAMPLE));
  const rows = parseSheetRows(SAMPLE);
  assert.ok(rows.length > 60);
  assert.deepEqual(rows[0], { teams: 'Louisiana UL-Monroe', total: 47.5, homeLine: 10.5, grade: 'A', sim: 'UL -10.5' });
});

test('A picks: spreads land on the right side, totals typed, moneylines skipped', () => {
  const { picks, skipped } = resolveSheetPicks(SAMPLE, games);
  const by = (id) => picks.find((p) => p.game.id === id);
  assert.deepEqual([by('g1').type, by('g1').side, by('g1').line], ['spread', 'away', -10.5]);   // UL -10.5: Louisiana (away)
  assert.deepEqual([by('g3').type, by('g3').side], ['total', 'over']);
  assert.deepEqual([by('g4').type, by('g4').side, by('g4').line], ['spread', 'away', 1.5]);     // WAKE +1.5: Wake Forest (away)
  assert.deepEqual([by('g5').side, by('g5').line], ['away', -11.5]);                            // ECU -11.5 (abbreviation not needed)
  assert.deepEqual([by('g8').side, by('g8').line], ['home', -29.5]);                            // ND -29.5
  assert.deepEqual([by('g9').type, by('g9').side], ['total', 'over']);
  assert.equal(by('g2'), undefined);                                                            // MISSST +120 is a moneyline
  assert.ok(skipped.some((s) => /moneyline/.test(s.reason) && /MISSST/.test(s.text)));
  assert.equal(by('g1').expert, 'Model A');
});

test('B and C grades are ignored by default, but can be asked for', () => {
  const dflt = resolveSheetPicks(SAMPLE, games).picks;
  assert.equal(dflt.find((p) => p.game.id === 'g12'), undefined);                               // USC/Indiana is a B
  const withB = resolveSheetPicks(SAMPLE, games, { grades: ['A+', 'A', 'B'] }).picks;
  const ind = withB.find((p) => p.game.id === 'g12');
  assert.deepEqual([ind.side, ind.line], ['home', -8.5]);                                       // IND -8.5
});

test('swapped home/away (neutral site) flips the side', () => {
  const flipped = [G('g1', 'UL Monroe', 'Louisiana')];
  const { picks } = resolveSheetPicks(SAMPLE, flipped);
  assert.equal(picks[0].side, 'home');                                                          // still Louisiana
});
