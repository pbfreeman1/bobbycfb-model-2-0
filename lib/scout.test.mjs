import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLinks, extractJsonLinks, dropOffSlateLinks, urlDate, buildLinkChoice, chosenArticles, formatSlate, sideSpread, buildScoutExtraction, resolveScoutPicks, slateWindow, callCost,
} from './scout.js';

const slate = [
  { game_id: 101, game_date: '2026-11-19', away: 'Notre Dame', home: 'Auburn', home_line: 3.5, total: null, neutral: false },
  { game_id: 102, game_date: '2026-11-19', away: 'Northeastern', home: 'Butler', home_line: 16, total: null, neutral: false },
  { game_id: 103, game_date: '2026-11-19', away: 'East Texas A&M', home: 'California', home_line: -2, total: null, neutral: true },
];

test('extractLinks keeps same-site article links, resolves relative urls, drops nav', () => {
  const html = `
    <a href="/college-basketball/picks-for-thursday-november-19/">College Basketball Picks for Thursday, November 19</a>
    <a href="https://vsin.com/college-basketball/picks-for-thursday-november-19/#comments">Picks</a>
    <a href="https://pro.vsin.com/x/">A subscriber article about Houston and Kansas</a>
    <a href="https://twitter.com/vsin">Follow VSIN on Twitter for more</a>
    <a href="/nba/">NBA</a>
    <script><a href="/hidden/">Hidden link in script text</a></script>
    <a href="/college-basketball/houston-vs-kansas/"><span>Houston vs. Kansas</span> <em>Prediction</em></a>`;
  const links = extractLinks(html, 'https://vsin.com/college-basketball/');
  assert.deepEqual(links.map((l) => l.url), [
    'https://vsin.com/college-basketball/picks-for-thursday-november-19/',
    'https://pro.vsin.com/x/',
    'https://vsin.com/college-basketball/houston-vs-kansas/',
  ]);
  assert.equal(links[2].text, 'Houston vs. Kansas Prediction');
});

test('chosenArticles maps numbers to links, dedupes and caps', () => {
  const links = [{ url: 'a', text: 'A' }, { url: 'b', text: 'B' }, { url: 'c', text: 'C' }];
  assert.deepEqual(chosenArticles([{ n: 2 }, { n: 2 }, { n: 9 }, { n: 1 }, { n: 3 }], links, 2), [
    { url: 'b', title: 'B' }, { url: 'a', title: 'A' },
  ]);
  const req = buildLinkChoice({ sport: 'cbb', sourceName: 'VSIN', window: 'Thursday', links, max: 2 });
  assert.match(req.user, /1\. A — a/);
  assert.match(req.system, /at most 2/);
});

test('formatSlate shows the home team\'s sportsbook spread', () => {
  assert.equal(sideSpread('home', 3.5), '-3.5');
  assert.equal(sideSpread('away', 3.5), '+3.5');
  assert.equal(sideSpread('home', 0), 'PK');
  assert.equal(sideSpread('home', null), null);
  const s = formatSlate(slate);
  assert.match(s, /^1\. Notre Dame at Auburn \| 2026-11-19 \| line: Auburn -3\.5$/m);
  assert.match(s, /3\. East Texas A&M at California \(neutral site\) \| 2026-11-19 \| line: California \+2/);
  const req = buildScoutExtraction('text', slate, { sport: 'cbb', sourceName: 'VSIN', window: 'Thursday, November 19, 2026' });
  assert.match(req.user, /Games \(Thursday, November 19, 2026\):/);
});

test('resolveScoutPicks maps game numbers and copied team names to sides', () => {
  const raw = [
    { expert: 'Adam Burke', game_number: 1, pick_team: 'Notre Dame', team_as_written: 'Fighting Irish', market: 'spread', period: 'full', side: 'team', line: 3.5, text: 'Notre Dame +3.5' },
    { expert: 'Adam Burke', game_number: 2, pick_team: '', market: 'total', period: 'full', side: 'under', line: 151.5, text: 'Under 151.5' },
    { expert: '', game_number: 3, pick_team: 'california', market: 'moneyline', period: 'full', side: 'team', odds: 120, text: 'Cal ML' },
    { expert: '', game_number: 1, pick_team: 'Auburn', market: 'team_total', period: '1h', side: 'over', line: 38.5, text: 'Auburn 1H TT over' },
    { expert: '', game_number: 0, pick_team: 'Duke', market: 'spread', period: 'full', side: 'team', line: -9, text: 'Duke -9' },
    { expert: '', game_number: 2, pick_team: 'Butler U', market: 'spread', period: 'full', side: 'team', line: -16, text: 'Butler -16' },
    { expert: '', game_number: 2, pick_team: 'Butler', market: 'prop', period: 'full', side: 'team', text: 'Player X over 20.5' },
  ];
  const { picks, skipped } = resolveScoutPicks(raw, slate);
  assert.deepEqual(picks.map((p) => [p.game_id, p.market, p.period, p.side, p.ou, p.line]), [
    [101, 'spread', 'full', 'away', null, 3.5],
    [102, 'total', 'full', 'under', null, 151.5],
    [103, 'moneyline', 'full', 'home', null, null],
    [101, 'team_total', '1h', 'home', 'over', 38.5],
    [null, 'spread', 'full', null, null, -9],
  ]);
  assert.equal(picks[2].odds, 120);
  assert.equal(picks[0].team_text, 'Fighting Irish');
  assert.equal(picks[0].expert, 'Adam Burke');
  assert.equal(picks[4].reason, 'game not on the slate');
  assert.deepEqual(skipped.map((s) => s.text), ['Butler -16', 'Player X over 20.5']);
  assert.match(skipped[0].reason, /not in Northeastern at Butler/);
});

test('slateWindow describes one day or a range', () => {
  assert.equal(slateWindow('cbb', slate, '2026-11-19'), 'Thursday, November 19, 2026');
  const nfl = [{ game_date: '2026-11-19' }, { game_date: '2026-11-23' }];
  assert.equal(slateWindow('nfl', nfl, '2026-11-19'), 'Thursday, November 19, 2026 through Monday, November 23, 2026');
  assert.equal(slateWindow('nfl', [], '2026-11-19'), 'this NFL week');
});

test('callCost prices tokens per model', () => {
  assert.equal(callCost('claude-sonnet-5-5', { input_tokens: 10000, output_tokens: 1000 }), 0.03);
  assert.equal(callCost('unknown', { input_tokens: 1 }), null);
});

test('extractJsonLinks reads headline + web link objects', () => {
  const json = { articles: [
    { headline: 'NFL Week 11 best bets: Picks for every game', links: { web: { href: 'https://www.espn.com/nfl/story/_/id/1/best-bets' } } },
    { headline: 'Short', links: { web: { href: 'https://www.espn.com/x' } } },
    { title: 'Another betting story with a long title', link: 'https://www.espn.com/nfl/story/_/id/2' },
  ] };
  assert.deepEqual(extractJsonLinks(json).map((l) => l.url), ['https://www.espn.com/nfl/story/_/id/1/best-bets', 'https://www.espn.com/nfl/story/_/id/2']);
});

test('urlDate reads common URL date forms', () => {
  assert.equal(urlDate('https://www.covers.com/ncaab/top-picks-nov-18-2026', '2026'), '2026-11-18');
  assert.equal(urlDate('https://vsin.com/college-basketball/college-basketball-picks-for-thursday-november-19-from-adam-burke/', '2026'), '2026-11-19');
  assert.equal(urlDate('https://x.com/2026/11/20/story', '2026'), '2026-11-20');
  assert.equal(urlDate('https://a.com/picks-11-19-2026', '2026'), '2026-11-19');
  assert.equal(urlDate('https://www.si.com/betting/nfl-week-11-ats-picks-for-every-game', '2026'), null);
  assert.equal(urlDate('https://www.espn.com/espn/betting/story/_/id/50436635/nfl-week-11-odds', '2026'), null);
});

test('dropOffSlateLinks keeps slate-dated and undated links', () => {
  const links = [
    { url: 'https://www.covers.com/ncaab/top-picks-nov-18-2026' },
    { url: 'https://www.covers.com/ncaab/top-picks-nov-19-2026' },
    { url: 'https://www.covers.com/ncaab/houston-vs-kansas-prediction' },
  ];
  assert.deepEqual(dropOffSlateLinks(links, ['2026-11-19', '2026-11-20']).map((l) => l.url), [
    'https://www.covers.com/ncaab/top-picks-nov-19-2026', 'https://www.covers.com/ncaab/houston-vs-kansas-prediction',
  ]);
});
