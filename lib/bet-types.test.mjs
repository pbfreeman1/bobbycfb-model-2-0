// node --test lib/
//
// Covers the spread sign convention end to end for all four shapes — home
// favorite, home underdog, away favorite, away underdog — following one pick
// from what the form prefills, through what gets stored, to what the chip
// shows and how it grades. The raw games.current_line is home-positive; every
// stored line is bet-slip notation from the picked team's point of view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamLine } from './bobby-model.js';
import { pickDescription, gradeAgainstScore, unitsPL, spreadCover } from './bet-types.js';

const HOME = 'Oregon', AWAY = 'Washington';
const teamFor = (side) => (side === 'home' ? HOME : AWAY);

// What the form does: prefill from the raw line, save exactly what is shown.
function logSpread({ rawLine, side }) {
  const shown = parseFloat(teamLine(rawLine, side)); // bet-slip, as displayed
  return { pick_type: 'spread', side, line_played: shown, units: 1, is_custom: false, played: true };
}

const CASES = [
  {
    name: 'home favorite: raw +7 -> Oregon -7',
    rawLine: 7, side: 'home', expectLine: -7, expectChip: 'Oregon -7.0',
    outcomes: [
      { home: 31, away: 21, cover: 3, result: 'win' },   // wins by 10
      { home: 24, away: 21, cover: -4, result: 'loss' }, // wins by 3, does not cover
      { home: 28, away: 21, cover: 0, result: 'push' },  // wins by exactly 7
    ],
  },
  {
    name: 'home underdog: raw -7 -> Oregon +7',
    rawLine: -7, side: 'home', expectLine: 7, expectChip: 'Oregon +7.0',
    outcomes: [
      { home: 21, away: 24, cover: 4, result: 'win' },   // loses by 3, covers
      { home: 21, away: 35, cover: -7, result: 'loss' }, // loses by 14
      { home: 21, away: 28, cover: 0, result: 'push' },  // loses by exactly 7
    ],
  },
  {
    name: 'away favorite: raw -7 -> Washington -7',
    rawLine: -7, side: 'away', expectLine: -7, expectChip: 'Washington -7.0',
    outcomes: [
      { home: 21, away: 31, cover: 3, result: 'win' },   // wins by 10
      { home: 21, away: 24, cover: -4, result: 'loss' }, // wins by 3
      { home: 21, away: 28, cover: 0, result: 'push' },  // wins by exactly 7
    ],
  },
  {
    name: 'away underdog: raw +7 -> Washington +7',
    rawLine: 7, side: 'away', expectLine: 7, expectChip: 'Washington +7.0',
    outcomes: [
      { home: 24, away: 21, cover: 4, result: 'win' },   // loses by 3, covers
      { home: 35, away: 21, cover: -7, result: 'loss' }, // loses by 14
      { home: 28, away: 21, cover: 0, result: 'push' },  // loses by exactly 7
    ],
  },
];

for (const c of CASES) {
  test(c.name, () => {
    const pick = logSpread({ rawLine: c.rawLine, side: c.side });

    // 1. the form stores bet-slip notation
    assert.equal(pick.line_played, c.expectLine);

    // 2. the chip prints the stored number as-is, never re-flipped
    assert.equal(pick.line_played, c.expectLine);
    assert.equal(pickDescription(pick, teamFor), c.expectChip);

    // 3. it grades off the picked team's own margin plus that line
    for (const o of c.outcomes) {
      assert.equal(
        spreadCover({ side: c.side, linePlayed: pick.line_played, homeScore: o.home, awayScore: o.away }),
        o.cover,
        `${c.name}: cover for ${o.away}-${o.home}`,
      );
      assert.equal(
        gradeAgainstScore(pick, o.home, o.away),
        o.result,
        `${c.name}: result for ${o.away}-${o.home}`,
      );
    }
  });
}

test('a favorite and an underdog on the same game cannot both win', () => {
  const home = logSpread({ rawLine: 7, side: 'home' });   // Oregon -7
  const away = logSpread({ rawLine: 7, side: 'away' });   // Washington +7
  for (const [h, a] of [[31, 21], [24, 21], [10, 40]]) {
    const results = [gradeAgainstScore(home, h, a), gradeAgainstScore(away, h, a)];
    assert.notDeepEqual(results, ['win', 'win']);
    assert.notDeepEqual(results, ['loss', 'loss']);
  }
});

test('the regression that started this: Louisiana -7.5 winning by 7 is a loss', () => {
  // UAB @ Louisiana, raw line +7, played at -7.5, final 21-14.
  const pick = logSpread({ rawLine: 7.5, side: 'home' });
  assert.equal(pick.line_played, -7.5);
  assert.equal(gradeAgainstScore(pick, 21, 14), 'loss');
});

test('units are the amount to win, with the risk on a loss', () => {
  assert.equal(unitsPL({ units: 1, pick_type: 'spread', result: 'win' }), 1);
  assert.equal(unitsPL({ units: 1, pick_type: 'spread', result: 'loss' }), -1.1);
  assert.equal(unitsPL({ units: 1, pick_type: 'moneyline', line_played: -150, result: 'win' }), 1);
  assert.equal(unitsPL({ units: 1, pick_type: 'moneyline', line_played: -150, result: 'loss' }), -1.5);
  assert.equal(unitsPL({ units: 1, pick_type: 'moneyline', line_played: 130, result: 'win' }), 1);
  assert.equal(
    Number(unitsPL({ units: 1, pick_type: 'moneyline', line_played: 130, result: 'loss' }).toFixed(4)),
    -0.7692,
  );
  for (const result of ['push', 'void', 'pending', null]) {
    assert.equal(unitsPL({ units: 3, pick_type: 'spread', result }), 0);
  }
  // custom is treated as -110
  assert.equal(unitsPL({ units: 2, is_custom: true, pick_type: 'custom', result: 'loss' }), -2.2);
});

test('totals and moneylines grade off the score, customs never auto-grade', () => {
  const over = { pick_type: 'total', side: 'over', line_played: 51.5, played: true };
  const under = { pick_type: 'total', side: 'under', line_played: 51.5, played: true };
  assert.equal(gradeAgainstScore(over, 30, 28), 'win');    // 58
  assert.equal(gradeAgainstScore(under, 30, 28), 'loss');
  assert.equal(gradeAgainstScore(over, 17, 24), 'loss');   // 41
  assert.equal(gradeAgainstScore(under, 17, 24), 'win');

  const mlHome = { pick_type: 'moneyline', side: 'home', line_played: -150, played: true };
  const mlAway = { pick_type: 'moneyline', side: 'away', line_played: 130, played: true };
  assert.equal(gradeAgainstScore(mlHome, 17, 24), 'loss');
  assert.equal(gradeAgainstScore(mlAway, 17, 24), 'win');
  assert.equal(gradeAgainstScore(mlHome, 24, 17), 'win');
  assert.equal(gradeAgainstScore(mlHome, 21, 21), 'push');

  assert.equal(gradeAgainstScore({ pick_type: 'custom', is_custom: true }, 30, 10), null);
});
