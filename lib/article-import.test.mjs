// node --test lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToArticleText, isAllowedUrl, resolvePicks, planArticleTags, buildExtractionRequest, numberGames } from './article-import.js';

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
  { expert: 'Maldonado', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 59.5, text: 'Cincinnati at Iowa State OVER 59.5' },
  { expert: 'Maldonado', game_number: 3, market: 'spread', pick_team: 'Georgia State', side: 'team', line: 5.5, text: 'Georgia State +5.5' },
  { expert: 'Zinno', game_number: 4, market: 'spread', pick_team: 'Kansas St', side: 'team', line: 10, text: 'Kansas State +10 at TCU' },
  { expert: 'Zinno', game_number: 5, market: 'moneyline', pick_team: 'Oklahoma State', side: 'team', line: -170, text: 'Oklahoma State ML' },
  { expert: 'Zinno', game_number: 0, market: 'spread', pick_team: 'Alabama', side: 'team', line: -3, text: 'Alabama -3' },
  { expert: 'Maldonado', game_number: 1, market: 'team_total', pick_team: 'UNLV', side: 'under', line: 16.5, text: 'UNLV TT under 16.5' },
  { expert: 'Zinno', game_number: 2, market: 'total', pick_team: '', side: 'over', line: 59.5, text: 'Cincinnati/ISU over' },
  { expert: 'Zinno', game_number: 3, market: 'spread', pick_team: 'Nobody', side: 'team', line: 1, text: 'bad team' },
];
test('resolve: sides, merging experts, and skipped reasons', () => {
  const { picks, skipped } = resolvePicks(raw, games);
  assert.deepEqual(picks.map((p) => [p.game.id, p.type, p.side]), [['g2', 'total', 'over'], ['g3', 'spread', 'home'], ['g4', 'spread', 'away']]);
  assert.deepEqual(picks[0].experts, ['Maldonado', 'Zinno']);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.some((s) => /moneyline/.test(s.reason)));
  assert.ok(skipped.some((s) => /not in this week/.test(s.reason)));
  assert.ok(skipped.some((s) => /team total/.test(s.reason)));
  assert.ok(skipped.some((s) => /not in/.test(s.reason) && /Nobody/.test(s.reason)));
});
test('plan: new tags use the source, existing ones are not duplicated', () => {
  const { picks } = resolvePicks(raw, games);
  const source = { id: 's1', name: 'ESPN' };
  const existing = [{ source_id: 's1', game_id: 'g3', pick_side: 'home', pick_type: 'spread' }, { source_id: 'other', game_id: 'g4', pick_side: 'away', pick_type: 'spread' }];
  const plan = planArticleTags(picks, existing, { season: 2026, week: 11, source });
  assert.deepEqual(plan.map((p) => p.action), ['insert', 'same', 'insert']);
  assert.equal(plan[0].row.source_label, 'ESPN');
  assert.equal(plan[0].row.pick_type, 'total');
  assert.match(plan[0].row.note, /Maldonado, Zinno/);
});
