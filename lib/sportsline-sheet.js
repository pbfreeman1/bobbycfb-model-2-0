// SportsLine "Expert Picks" pick sheet (sportsline.com/college-football/picks/).
// Each row is: game, projected score, odds, expert-pick count, and the model's
// simulation pick with a grade (A+, A, B, C). This is a table, not prose, so it is
// parsed directly (no language model needed).
//
// Row shape (whitespace-collapsed):
//   Nov 14, 12:00PM ET <Away> <Home> 26 28 O/U 50.5 +2.5 0 Expert Picks A MISSST +120 Matchup Analysis
// The odds number is the HOME team's spread. The simulation pick is "OVER 44.5",
// "UNDER 74.5", "<TEAM> -10.5" (spread) or "<TEAM> +120" (moneyline, not tagged).

import { normalizeTeamName } from './team-match.js';
import { kamKey } from './kam-import.js';

export const SHEET_GRADES = ['A+', 'A'];

export function looksLikePickSheet(text) {
  const s = String(text || '');
  return /Expert Picks?/i.test(s) && /Matchup Analysis/i.test(s) && /O\/U\s+\d/.test(s);
}

const ROW = /[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} ?[AP]M ET (.+?) (\d{1,3}) (\d{1,3}) O\/U (\d+(?:\.\d+)?) ([+-]\d+(?:\.\d+)?|PK|EV) (\d+) Expert Picks? (A\+|A-|B\+|B-|C\+|C-|A|B|C|D|F) (.+?) Matchup Analysis/g;

export function parseSheetRows(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  const rows = [];
  let m;
  ROW.lastIndex = 0;
  while ((m = ROW.exec(s))) {
    rows.push({
      teams: m[1].trim(), total: +m[4],
      homeLine: m[5] === 'PK' || m[5] === 'EV' ? 0 : +m[5],
      grade: m[7], sim: m[8].trim(),
    });
  }
  return rows;
}

function teamIndex(games) {
  const idx = new Map();
  for (const g of games) {
    for (const [n, team] of [[g.home_team, 'home'], [g.away_team, 'away']]) {
      idx.set(kamKey(n), { game: g, team });
      idx.set(normalizeTeamName(n), { game: g, team });
    }
  }
  return (name) => idx.get(kamKey(name)) || idx.get(normalizeTeamName(name)) || null;
}

// "Auburn Miss. State" has no delimiter between the two teams, so try every split.
// Returns { game, swapped } where swapped means the sheet lists home first.
export function resolveSheetTeams(teamText, games) {
  const look = teamIndex(games);
  const w = teamText.split(' ');
  let best = null;
  for (let k = 1; k < w.length; k++) {
    const a = look(w.slice(0, k).join(' ')), b = look(w.slice(k).join(' '));
    let score = 0, game = null, swapped = false;
    if (a && b) { if (a.game !== b.game || a.team === b.team) continue; score = 2; game = a.game; swapped = a.team === 'home'; }
    else if (a) { score = 1; game = a.game; swapped = a.team === 'home'; }
    else if (b) { score = 1; game = b.game; swapped = b.team === 'away'; }
    else continue;
    if (!best || score > best.score) best = { score, game, swapped };
  }
  return best ? { game: best.game, swapped: best.swapped } : null;
}

// Returns { picks, skipped, rows } in the same shape the article importer uses.
export function resolveSheetPicks(text, games, { grades = SHEET_GRADES } = {}) {
  const picks = [], skipped = [];
  const rows = parseSheetRows(text);
  for (const r of rows) {
    if (!grades.includes(r.grade)) continue;
    const label = `${r.teams}: ${r.sim}`;
    const expert = `Model ${r.grade}`;
    const hit = resolveSheetTeams(r.teams, games);
    if (!hit) { skipped.push({ expert, text: label, reason: `game not found in this week (${r.teams})` }); continue; }
    const g = hit.game;
    const tot = /^(OVER|UNDER)\s+(\d+(?:\.\d+)?)$/i.exec(r.sim);
    if (tot) {
      picks.push({ game: g, type: 'total', side: tot[1].toLowerCase(), line: +tot[2], experts: [expert], expert, text: label });
      continue;
    }
    const sp = /^(.+?)\s+([+-]\d+(?:\.\d+)?)$/.exec(r.sim);
    if (!sp) { skipped.push({ expert, text: label, reason: 'unrecognized pick' }); continue; }
    const p = +sp[2];
    if (Math.abs(p) >= 100) { skipped.push({ expert, text: label, reason: 'moneyline (not tagged)' }); continue; }
    // Sheet-home spread is r.homeLine. Matching it means the pick is the sheet's second team.
    let sheetSecond;
    if (r.homeLine !== 0 && p === r.homeLine) sheetSecond = true;
    else if (r.homeLine !== 0 && p === -r.homeLine) sheetSecond = false;
    else { skipped.push({ expert, text: label, reason: 'could not tell which team the spread belongs to' }); continue; }
    const side = (sheetSecond !== hit.swapped) ? 'home' : 'away';
    picks.push({ game: g, type: 'spread', side, line: p, experts: [expert], expert, text: label });
  }
  return { picks, skipped, rows: rows.length };
}
