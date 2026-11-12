// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKamText, matchEntries, planTags, tagForRank, stripHtml } from './kam-import.js';

const ATS = `
     Miami Oh                          20
     Ohio (+1.5)                       30          0.7554

     East Carolina (-11.5)             34
     Charlotte                         13          0.7138

     Tulane (+2.5)                     26
     Rice                              20          0.7095

     Georgia Tech (+13.5)              21
     Clemson                           28          0.6425

     Cincinnati                        24
     Iowa St (-3.5)                    34          0.6515
`;
const OU = `
     Colorado St                       24
     Washington St (U 67.5)            34          0.6970

     Alabama                           42
     Vanderbilt (O 50.5)               20          0.6848
`;

test('ATS: pick is the team whose predicted score covers, ranked by probability', () => {
  const { entries } = parseKamText(ATS, 'ats');
  assert.deepEqual(entries.map((e) => [e.rank, e.pickTeam]), [
    [1, 'Ohio'], [2, 'East Carolina'], [3, 'Tulane'], [4, 'Iowa St'], [5, 'Georgia Tech'],
  ]);
});
test('Totals: side and total come from the parentheses', () => {
  const { entries } = parseKamText(OU, 'ou');
  assert.deepEqual(entries.map((e) => [e.rank, e.side, e.total]), [[1, 'under', 67.5], [2, 'over', 50.5]]);
});
test('html wrapper and entities are stripped', () => {
  assert.match(stripHtml('<pre>A&nbsp;B&amp;C</pre>'), /A B&C/);
  assert.equal(parseKamText('<html><body><pre>' + ATS + '</pre></body></html>', 'ats').entries.length, 5);
});

const games = [
  { id: 'g1', home_team: 'Ohio', away_team: 'Miami (OH)' },
  { id: 'g2', home_team: 'East Carolina', away_team: 'Charlotte' },
  { id: 'g3', home_team: 'Rice', away_team: 'Tulane' },
  { id: 'g4', home_team: 'Clemson', away_team: 'Georgia Tech' },
  { id: 'g5', home_team: 'Iowa State', away_team: 'Cincinnati' },
];
test('matching resolves abbreviations and the side', () => {
  const { matched, unmatched } = matchEntries(parseKamText(ATS, 'ats').entries, games);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(matched.map((m) => [m.game.id, m.side]), [['g1', 'home'], ['g2', 'home'], ['g3', 'away'], ['g5', 'home'], ['g4', 'away']]);
});
test('one resolvable team is enough; no game is reported', () => {
  const e = parseKamText('Zzz Tech 10\nOhio (+1.5) 30 0.7\n\nNobody U 3\nAlso Nobody (-3) 4 0.6\n', 'ats').entries;
  const { matched, unmatched } = matchEntries(e, games);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].game.id, 'g1');
  assert.equal(unmatched.length, 1);
});
test('KAM abbreviations (C Michigan, N Illinois, Florida Atl, UL Lafayette)', () => {
  const g = [
    { id: 'a', home_team: 'Central Michigan', away_team: 'Sacramento State' },
    { id: 'b', home_team: 'Northern Illinois', away_team: 'Nevada' },
    { id: 'c', home_team: 'Tulsa', away_team: 'Florida Atlantic' },
    { id: 'd', home_team: 'Louisiana', away_team: 'UL Monroe' },
  ];
  const t = 'Sacramento St 10\nC Michigan (-17.5) 34 0.64\nNevada (-7.5) 30\nN Illinois 16 0.65\nFlorida Atl 31\nTulsa (U 74.5) 35 0.63\nUL Lafayette (-10.5) 34\nUL Monroe 17 0.62\n';
  const { matched } = matchEntries([...parseKamText(t, 'ats').entries.filter((e) => e.kind === 'ats')], g);
  assert.deepEqual(matched.map((m) => m.game.id).sort(), ['a', 'b', 'd']);
});

test('rank cutoffs', () => {
  assert.deepEqual(tagForRank(1), { rank: 1, conviction: 'top' });
  assert.deepEqual(tagForRank(7), { rank: 7, conviction: 'topish' });
  assert.deepEqual(tagForRank(10), { rank: 10, conviction: 'topish' });
  assert.deepEqual(tagForRank(12), { rank: null, conviction: 'topish' });
  assert.equal(tagForRank(16), null);
});
test('plan: insert, same, and re-rank (keeps the tag-time stamp)', () => {
  const { matched } = matchEntries(parseKamText(ATS, 'ats').entries, games);
  const source = { id: 'k', name: 'KAM' };
  const existing = [
    { id: 'o1', game_id: 'g1', pick_side: 'home', pick_type: 'spread', rank: 1, conviction: 'top', source_label: 'KAM #1' },
    { id: 'o2', game_id: 'g2', pick_side: 'home', pick_type: 'spread', rank: null, conviction: 'top', source_label: 'KAM Top', created_at: 'T', line_at_tag: -11, total_at_tag: 50, line_basis: 'backfill' },
  ];
  const plan = planTags(matched, existing, { kind: 'ats', season: 2026, week: 11, source });
  assert.equal(plan.find((p) => p.game.id === 'g1').action, 'same');
  const rr = plan.find((p) => p.game.id === 'g2');
  assert.equal(rr.action, 'rerank');
  assert.equal(rr.row.source_label, 'KAM #2');
  assert.equal(rr.row.line_at_tag, -11);
  assert.equal(plan.find((p) => p.game.id === 'g3').action, 'insert');
  assert.equal(plan.find((p) => p.game.id === 'g4').row.source_label, 'KAM #5');
});
