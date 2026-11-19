// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSideBet, groupSideBets, planSideBets, validateSideBet, buildSideBetRow, parseSideType, splitSide, cleanOdds } from './side-bets.js';

const teamFor = (sd) => (sd === 'home' ? 'Baylor' : 'Texas Tech');
const game = { id: 'g1', home_team: 'Baylor', away_team: 'Texas Tech' };

test('descriptions', () => {
  assert.equal(describeSideBet({ period: 'full', market: 'moneyline', team_side: 'home', odds: 142 }, teamFor), 'Baylor ML +142');
  assert.equal(describeSideBet({ period: '1h', market: 'total', ou_side: 'under', line: 23.5 }, teamFor), '1H Under 23.5');
  assert.equal(describeSideBet({ period: 'full', market: 'team_total', team_side: 'away', ou_side: 'over', line: 31.5 }, teamFor), 'Texas Tech TT Over 31.5');
  assert.equal(describeSideBet({ period: '1h', market: 'spread', team_side: 'away', line: -9.5 }, teamFor), '1H Texas Tech -9.5');
  assert.equal(describeSideBet({ period: '1h', market: 'spread', team_side: 'away', line: -9.5 }, teamFor, { withLine: false }), '1H Texas Tech');
});

test('form helpers', () => {
  assert.deepEqual(parseSideType('1h:total'), { period: '1h', market: 'total' });
  assert.equal(parseSideType('full:spread'), null); // graded, not a side bet
  assert.deepEqual(splitSide('team_total', 'away:over'), { team_side: 'away', ou_side: 'over' });
  assert.equal(cleanOdds('+142'), 142);
  assert.equal(cleanOdds('50'), null);
  assert.equal(validateSideBet({ period: 'full', market: 'spread', team_side: 'home' }), 'Full-game spreads and totals are regular tags.');
  assert.equal(validateSideBet({ period: '1h', market: 'total', ou_side: 'under', line: '' }), 'Enter the number.');
  assert.equal(validateSideBet({ period: 'full', market: 'moneyline', team_side: 'home', odds: '+142' }), null);
  const row = buildSideBetRow({ game, season: 2026, week: 12, period: 'full', market: 'moneyline', team_side: 'home', ou_side: 'over', line: '3', odds: '+142', source: { id: 's', name: 'ESPN' }, expert: 'Maldonado' });
  assert.equal(row.ou_side, null);
  assert.equal(row.line, null);
  assert.equal(row.odds, 142);
  assert.equal(row.source_label, 'ESPN - Maldonado');
});

test('grouping counts distinct source+expert and flags splits', () => {
  const rows = [
    { id: 1, game_id: 'g1', period: '1h', market: 'total', ou_side: 'under', line: 23.5, source_id: 'espn', expert: 'Mark Zinno' },
    { id: 2, game_id: 'g1', period: '1h', market: 'total', ou_side: 'under', line: 24, source_id: 'vsin', expert: 'Makinen' },
    { id: 3, game_id: 'g1', period: '1h', market: 'total', ou_side: 'under', line: 23.5, source_id: 'espn', expert: 'Zinno' },
    { id: 4, game_id: 'g1', period: '1h', market: 'total', ou_side: 'over', line: 23.5, source_id: 'kam', expert: null },
    { id: 5, game_id: 'g1', period: 'full', market: 'moneyline', team_side: 'home', odds: 142, source_id: 'espn', expert: 'Maldonado' },
  ];
  const g = groupSideBets(rows);
  assert.equal(g[0].ou_side, 'under');
  assert.equal(g[0].count, 2);
  assert.equal(g[0].rows.length, 3);
  assert.deepEqual([g[0].min, g[0].max], [23.5, 24]);
  assert.equal(g[0].opposed, true);
  const ml = g.find((x) => x.market === 'moneyline');
  assert.equal(ml.opposed, false);
  assert.equal(ml.min, 142);
});

test('import plan dedupes on source + expert + bet', () => {
  const source = { id: 'espn', name: 'ESPN' };
  const bets = [
    { game, period: 'full', market: 'moneyline', team_side: 'home', ou_side: null, line: null, odds: 142, expert: 'Pamela Maldonado', text: 'Baylor +142' },
    { game, period: '1h', market: 'total', team_side: null, ou_side: 'under', line: 23.5, odds: null, expert: 'Zinno', text: '1H under' },
  ];
  const existing = [{ source_id: 'espn', game_id: 'g1', period: 'full', market: 'moneyline', team_side: 'home', ou_side: null, expert: 'Maldonado' }];
  const plan = planSideBets(bets, existing, { season: 2026, week: 12, source });
  assert.deepEqual(plan.map((p) => p.action), ['same', 'insert']);
  assert.equal(plan[1].row.source_label, 'ESPN - Zinno');
  assert.match(plan[1].row.note, /^Zinno: /);
});
