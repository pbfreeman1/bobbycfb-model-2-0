// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToArticleText, isAllowedUrl, resolvePicks, planArticleTags, buildExtractionRequest, numberGames, teamsInText, wireSkipped } from './article-import.js';

const games = [
  { id: 'g1', home_team: 'New Mexico', away_team: 'UNLV' },
  { id: 'g2', home_team: 'Iowa State', away_team: 'Cincinnati' },
  { id: 'g3', home_team: 'Georgia State', away_team: 'Georgia Southern' },
  { id: 'g4', home_team: 'TCU', away_team: 'Kansas State' },
  { id: 'g5', home_team: 'Texas Tech', away_team: 'Oklahoma State' },
];

test('url allowlist', () => {
  assert.equal(isAllowedUrl('https://www.espn.com/espn/betting/story/_/id/1/x'), true);
  assert.equal(isAllowedUrl('https://vsin.com/college-football/x'), true);
  assert.equal(isAllowedUrl('http://www.espn.com/x'), false);
  assert.equal(isAllowedUrl('https://evil.com/?u=espn.com'), false);
  assert.equal(isAllowedUrl('https://espn.com.evil.com/x'), false);
});
test('html to text drops chrome and keeps headings', () => {
  const t = htmlToArticleText('<nav>menu</nav><h2>Mark Zinno&#39;s plays</h2><p>Kansas State +10 at TCU</p><script>x()</script>');
  assert.match(t, /## Mark Zinno's plays/);
  assert.match(t, /Kansas State \+10 at TCU/);
  assert.doesNotMatch(t, /menu|x\(\)/);
});
test('request numbers the games', () => {
  const r = buildExtractionRequest('body', games, { sourceName: 'ESPN' });
  assert.match(r.user, /1\. UNLV @ New Mexico/);
  assert.equal(r.tool.name, 'record_picks');
  assert.equal(numberGames(games).split('\n').length, 5);
});

const raw = [
  { expert: 'Maldonado', team_a: 'Cincinnati', team_b: 'Iowa State', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 59.5, text: 'Cincinnati at Iowa State OVER 59.5' },
  { expert: 'Maldonado', team_a: 'Georgia State', team_b: 'Georgia Southern', game_number: 3, market: 'spread', pick_team: 'Georgia State', side: 'team', line: 5.5, text: 'Georgia State +5.5' },
  { expert: 'Zinno', team_a: 'Kansas State', team_b: 'TCU', game_number: 4, market: 'spread', pick_team: 'Kansas St', side: 'team', line: 10, text: 'Kansas State +10 at TCU' },
  { expert: 'Zinno', team_a: 'Oklahoma State', team_b: 'Texas Tech', game_number: 5, market: 'moneyline', pick_team: 'Oklahoma State', side: 'team', line: -170, text: 'Oklahoma State ML' },
  { expert: 'Zinno', team_a: 'Alabama', team_b: 'Auburn', game_number: 0, market: 'spread', pick_team: 'Alabama', side: 'team', line: -3, text: 'Alabama -3' },
  { expert: 'Maldonado', team_a: 'UNLV', team_b: 'New Mexico', game_number: 1, market: 'team_total', pick_team: 'UNLV', side: 'under', line: 16.5, text: 'UNLV TT under 16.5' },
  { expert: 'Zinno', team_a: 'Cincinnati', team_b: 'Iowa St.', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 59.5, text: 'Cincinnati/ISU over' },
  { expert: 'Zinno', team_a: 'Georgia State', team_b: 'Georgia Southern', game_number: 3, market: 'spread', pick_team: 'Nobody', side: 'team', line: 1, text: 'bad team' },
];
test('resolve: sides, one pick per expert, other bets and skipped reasons', () => {
  const { picks, sideBets, skipped } = resolvePicks(raw, games);
  assert.deepEqual(picks.map((p) => [p.game.id, p.type, p.side]), [['g2', 'total', 'over'], ['g3', 'spread', 'home'], ['g4', 'spread', 'away'], ['g2', 'total', 'over']]);
  assert.deepEqual(picks.filter((p) => p.game.id === 'g2').map((p) => p.expert), ['Maldonado', 'Zinno']);
  // moneyline and team total are now other bets, not skipped
  assert.deepEqual(sideBets.map((b) => [b.game.id, b.period, b.market, b.team_side, b.ou_side]), [['g5', 'full', 'moneyline', 'away', null], ['g1', 'full', 'team_total', 'away', 'under']]);
  assert.equal(sideBets[0].odds, -170);
  assert.equal(sideBets[0].line, null);
  assert.equal(sideBets[1].line, 16.5);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.some((s) => /not found in this week/.test(s.reason)));
  assert.ok(skipped.some((s) => /not in/.test(s.reason) && /Nobody/.test(s.reason)));
});
test('plan: new tags use the source, existing ones are not duplicated', () => {
  const { picks } = resolvePicks(raw, games);
  const source = { id: 's1', name: 'ESPN' };
  const existing = [{ source_id: 's1', game_id: 'g3', pick_side: 'home', pick_type: 'spread' }, { source_id: 'other', game_id: 'g4', pick_side: 'away', pick_type: 'spread' }];
  const plan = planArticleTags(picks, existing, { season: 2026, week: 11, source });
  assert.deepEqual(plan.map((p) => p.action), ['insert', 'same', 'insert', 'insert']);
  assert.equal(plan[0].row.source_label, 'ESPN - Maldonado');
  assert.equal(plan[0].row.pick_type, 'total');
  assert.match(plan[0].row.note, /^Maldonado: /);
});

test('JSON-LD articleBody is used when the visible page is empty', () => {
  const body = 'Kansas State +10 at TCU is a play. '.repeat(20);
  const html = `<html><body><div id="app"></div><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></body></html>`;
  const t = htmlToArticleText(html);
  assert.match(t, /Kansas State \+10 at TCU is a play/);
});

test('team names beat a wrong game_number (the Over 72.5 mix-up)', () => {
  const r = [{ expert: 'Fornelli', team_a: 'No. 12 Texas Tech', team_b: 'No. 25 Oklahoma State', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 72.5, text: 'Over 72.5' }];
  const { picks } = resolvePicks(r, games);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].game.id, 'g5');
});
test('unknown teams are skipped even if the number points at a game', () => {
  const r = [{ expert: 'X', team_a: 'Auburn', team_b: 'Miss State', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 72.5, text: 'Over 72.5' }];
  const { picks, skipped } = resolvePicks(r, games);
  assert.equal(picks.length, 0);
  assert.match(skipped[0].reason, /Auburn/);
});

test('two experts on one side are two picks and two tags; same expert is deduped', () => {
  const mk = (expert) => ({ expert, team_a: 'Cincinnati', team_b: 'Iowa State', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 59.5, text: 'over' });
  const { picks } = resolvePicks([mk('Steve Makinen'), mk('Wes Reynolds'), mk('Makinen')], games);
  assert.equal(picks.length, 2);
  const source = { id: 's1', name: 'VSIN' };
  const existing = [{ source_id: 's1', game_id: picks[0].game.id, pick_side: 'over', pick_type: 'total', expert: null, note: 'Makinen: over' }];
  const plan = planArticleTags(picks, existing, { season: 2026, week: 11, source });
  assert.equal(plan[0].action, 'same');
  assert.equal(plan[1].action, 'insert');
  assert.equal(plan[1].row.source_label, 'VSIN - Wes Reynolds');
  assert.equal(plan[1].row.expert, 'Wes Reynolds');
});

test('Appalachian State resolves to App State', () => {
  const g = [{ id: 'gA', home_team: 'Marshall', away_team: 'App State' }];
  const r = [{ expert: 'Steve Makinen', team_a: 'Appalachian State', team_b: 'Marshall', game_number: 1, market: 'spread', pick_team: 'Appalachian State', side: 'team', line: -1.5, text: 'Appalachian State -1.5' }];
  const { picks, skipped } = resolvePicks(r, g);
  assert.equal(skipped.length, 0);
  assert.equal(picks[0].side, 'away');
});

// Week 12 ESPN article: headings carry the bet. Kansas State plays Arizona this
// week, so the model naming "Kansas State" for a Utah at TCU pick used to tie
// two games and drop the pick.
const wk12 = [
  { id: 'a', home_team: 'Baylor', away_team: 'Texas Tech' },
  { id: 'b', home_team: 'TCU', away_team: 'Utah' },
  { id: 'c', home_team: 'Kansas State', away_team: 'Arizona' },
  { id: 'd', home_team: 'Arizona State', away_team: 'Oklahoma State' },
  { id: 'e', home_team: 'South Carolina', away_team: 'Georgia' },
  { id: 'f', home_team: 'Cincinnati', away_team: 'Colorado' },
  { id: 'g', home_team: 'Georgia State', away_team: 'Marshall' },
];
test('heading text outvotes a stray team from the analysis', () => {
  const r = [{ expert: 'Zinno', team_a: 'Kansas State', team_b: 'TCU', game_number: 0, market: 'total', period: '1h', pick_team: '', side: 'under', line: 23.5, text: 'Utah at TCU first half UNDER 23.5' }];
  const { sideBets, skipped } = resolvePicks(r, wk12);
  assert.equal(skipped.length, 0);
  assert.deepEqual([sideBets[0].game.id, sideBets[0].period, sideBets[0].market, sideBets[0].ou_side, sideBets[0].line], ['b', '1h', 'total', 'under', 23.5]);
});
test('a true tie offers both games to choose from', () => {
  const r = [{ expert: 'X', team_a: 'Kansas State', team_b: 'TCU', game_number: 0, market: 'total', period: '1h', pick_team: '', side: 'under', line: 23.5, text: 'first half UNDER 23.5' }];
  const { sideBets, skipped } = resolvePicks(r, wk12);
  assert.equal(sideBets.length, 0);
  assert.match(skipped[0].reason, /more than one game/);
  assert.deepEqual(skipped[0].options.map((o) => o.game.id).sort(), ['b', 'c']);
  const w = wireSkipped(skipped[0]);
  assert.equal(w.options[0].kind, 'bet');
  assert.ok(w.options[0].game_id);
});
test('heading-style picks: spread, ML, team total, 1H spread', () => {
  const r = [
    { expert: 'Maldonado', team_a: 'Texas Tech', team_b: 'Baylor', game_number: 1, market: 'spread', period: 'full', pick_team: 'Baylor', side: 'team', line: 3.5, text: 'Texas Tech at Baylor (+3.5)' },
    { expert: 'Maldonado', team_a: 'Texas Tech', team_b: 'Baylor', game_number: 1, market: 'moneyline', period: 'full', pick_team: 'Baylor', side: 'team', odds: 142, text: 'Baylor +142' },
    { expert: 'Zinno', team_a: 'Oklahoma State', team_b: 'Arizona State', game_number: 4, market: 'team_total', period: 'full', pick_team: 'Oklahoma State', side: 'over', line: 31.5, text: 'Oklahoma State (team total OVER 31.5) at Arizona State' },
    { expert: 'Zinno', team_a: 'Georgia', team_b: 'South Carolina', game_number: 5, market: 'spread', period: '1h', pick_team: 'Georgia', side: 'team', line: -9.5, text: 'Georgia (first half -9.5) at South Carolina' },
    { expert: 'Zinno', team_a: 'Cincinnati', team_b: '', game_number: 6, market: 'spread', period: 'full', pick_team: 'Cincinnati', side: 'team', line: -3, text: 'Cincinnati -3' },
  ];
  const { picks, sideBets, skipped } = resolvePicks(r, wk12);
  assert.equal(skipped.length, 0);
  assert.deepEqual(picks.map((p) => [p.game.id, p.type, p.side, p.line]), [['a', 'spread', 'home', 3.5], ['f', 'spread', 'home', -3]]);
  assert.deepEqual(sideBets.map((b) => [b.game.id, b.period, b.market, b.team_side, b.ou_side]), [
    ['a', 'full', 'moneyline', 'home', null], ['d', 'full', 'team_total', 'away', 'over'], ['e', '1h', 'spread', 'away', null]]);
  assert.equal(sideBets[0].odds, 142);
});
test('"Georgia State" in the text is not also read as Georgia', () => {
  assert.deepEqual([...teamsInText('Georgia State +5.5 vs Marshall', wk12)].sort(), ['Georgia State', 'Marshall']);
});
test('legacy half_or_quarter market maps to a period', () => {
  const r = [{ expert: 'Z', team_a: 'Utah', team_b: 'TCU', game_number: 2, market: 'half_or_quarter', pick_team: '', side: 'under', line: 23.5, text: 'Utah at TCU 1H under 23.5' }];
  const { sideBets } = resolvePicks(r, wk12);
  assert.equal(sideBets[0].period, '1h');
  assert.equal(sideBets[0].market, 'total');
});
test('props and parlays stay skipped', () => {
  const r = [{ expert: 'Z', team_a: 'Utah', team_b: 'TCU', game_number: 2, market: 'prop', period: 'full', pick_team: '', side: 'other', text: 'QB over 220.5 passing yards' }];
  const { skipped } = resolvePicks(r, wk12);
  assert.match(skipped[0].reason, /prop/);
});
