// Bet types for logged picks (user_picks) and research tags (research_picks).
//
// UNITS ARE THE AMOUNT TO WIN, matching cfb_signal_grades and THE Bobby
// Model's own grading (win +1u, loss -1.1u at -110). A win always pays the
// units; a loss costs whatever had to be risked to win them:
//   spread / total / custom (-110): win +u,  loss -1.1u
//   moneyline at negative odds:     win +u,  loss -u * |odds| / 100
//   moneyline at positive odds:     win +u,  loss -u * 100 / odds
// So 1u at -150 wins 1.00 and loses 1.50; 1u at +130 wins 1.00 and loses 0.77.
// Push and void are always 0.
//
// SPREAD LINES ARE BET-SLIP NOTATION, from the picked team's perspective:
// negative means that team is favored, exactly as it reads on a ticket. This is
// what the form shows, what it saves, and what the grader expects. (The raw
// games.current_line stays home-positive; teamLine() converts between them.)
//
// Custom picks are logged but never auto-graded — result is set by hand, and
// 'void' means it never settled and should not count.

import { fmtSpread } from './bobby-model.js';

export const BET_TYPES = [
  { v: 'spread', label: 'Spread', short: 'Spread' },
  { v: 'total', label: 'Total (O/U)', short: 'Total' },
  { v: 'moneyline', label: 'Moneyline', short: 'ML' },
  { v: 'custom', label: 'Custom', short: 'Custom' },
];

export const STANDARD_VIG = -110;
// A -110 loss costs 1.1 units to win 1.
export const VIG_LOSS = 1.1;

// Sides offered per type. Custom has no side.
export function sidesFor(pickType) {
  if (pickType === 'total') return ['over', 'under'];
  if (pickType === 'custom') return [];
  return ['home', 'away'];
}

// Profit on a 1-unit-risk win at American odds. -150 -> 0.667, +130 -> 1.30.
export function americanProfit(odds) {
  const n = parseFloat(odds);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return n > 0 ? n / 100 : 100 / Math.abs(n);
}

export function fmtOdds(odds) {
  const n = parseFloat(odds);
  if (!Number.isFinite(n)) return '';
  return n > 0 ? `+${n}` : String(n);
}

// Net units for one graded pick. See the header: units are the amount to win.
export function unitsPL(pick) {
  const u = parseFloat(pick.units) || 0;
  if (!u) return 0;
  const res = pick.result;
  if (res !== 'win' && res !== 'loss') return 0; // push, void, pending, ungraded
  if (res === 'win') return u;

  const type = pick.is_custom ? 'custom' : pick.pick_type;
  if (type === 'moneyline') {
    const odds = parseFloat(pick.line_played);
    // No usable price recorded: fall back to the -110 assumption.
    if (!Number.isFinite(odds) || Math.abs(odds) < 100) return -u * VIG_LOSS;
    return odds < 0 ? -u * (Math.abs(odds) / 100) : -u * (100 / odds);
  }
  // Spread, total and custom are all assumed -110.
  return -u * VIG_LOSS;
}

// True when this pick is graded by /api/grade rather than by hand.
export function isAutoGraded(pick) {
  return !pick.is_custom && pick.pick_type !== 'custom';
}

// "Oregon -6.5" / "Over 54.5" / "Oregon ML (-150)" / "1H Oregon -3.5"
// teamFor(side) supplies the display name, so callers can pass short names.
// line_played is already bet-slip notation, so it prints as stored.
export function pickDescription(pick, teamFor) {
  const type = pick.pick_type;
  if (type === 'custom' || pick.is_custom) return pick.custom_label || 'Custom';
  if (type === 'total') {
    const side = pick.side === 'over' ? 'Over' : 'Under';
    return `${side} ${pick.line_played ?? ''}`.trim();
  }
  if (type === 'moneyline') {
    const team = teamFor(pick.side) || '';
    const odds = fmtOdds(pick.line_played);
    return `${team} ML${odds ? ` (${odds})` : ''}`.trim();
  }
  const team = teamFor(pick.side) || '';
  return `${team} ${fmtSpread(pick.line_played)}`.trim();
}

// Cover margin for a graded spread: the picked team's own margin plus the line
// it was taken at. Positive covers, negative does not, zero pushes. Identical
// for home and away because the stored line is already from the picked team's
// point of view.
export function spreadCover({ side, linePlayed, homeScore, awayScore }) {
  const margin = (Number(homeScore) || 0) - (Number(awayScore) || 0);
  const own = side === 'home' ? margin : -margin;
  return own + (parseFloat(linePlayed) || 0);
}

// The single grading rule, shared by /api/grade and the tests. Returns null for
// anything that is not auto-graded.
export function gradeAgainstScore(pick, homeScore, awayScore) {
  if (pick.is_custom || pick.pick_type === 'custom') return null;
  if (homeScore == null || awayScore == null) return null;
  const hs = Number(homeScore), as = Number(awayScore);
  const margin = hs - as;
  if (pick.pick_type === 'moneyline') {
    if (margin === 0) return 'push';
    return (pick.side === 'home') === (margin > 0) ? 'win' : 'loss';
  }
  let cover;
  if (pick.pick_type === 'total') {
    const total = hs + as;
    const line = parseFloat(pick.line_played) || 0;
    cover = pick.side === 'over' ? total - line : line - total;
  } else {
    cover = spreadCover({ side: pick.side, linePlayed: pick.line_played, homeScore: hs, awayScore: as });
  }
  return cover > 0 ? 'win' : cover < 0 ? 'loss' : 'push';
}

// Same, for a research tag: no units, and a custom tag keeps its free text in
// the note column because research_picks has no custom_label.
export function researchDescription(row, teamFor) {
  const type = row.pick_type || 'spread';
  if (type === 'custom') return row.note || 'Custom';
  if (type === 'total') return row.pick_side === 'over' ? 'Over' : 'Under';
  const team = teamFor(row.pick_side) || '';
  return type === 'moneyline' ? `${team} ML`.trim() : team;
}

// Returns an error string, or null when the pick is saveable.
export function validatePick({ pickType, side, line, units, customLabel }) {
  if (pickType === 'custom') {
    if (!customLabel || !customLabel.trim()) return 'Describe the bet.';
    return null;
  }
  if (pickType === 'total') {
    if (side !== 'over' && side !== 'under') return 'Pick Over or Under.';
    if (line === '' || line == null || !Number.isFinite(parseFloat(line))) return 'Enter the total.';
    return null;
  }
  if (side !== 'home' && side !== 'away') return 'Pick a team.';
  if (pickType === 'moneyline') {
    const odds = parseFloat(line);
    if (!Number.isFinite(odds)) return 'Enter the odds you got.';
    if (odds > -100 && odds < 100) return 'Odds must be -100 or lower, or +100 or higher.';
    return null;
  }
  if (line !== '' && line != null && !Number.isFinite(parseFloat(line))) return 'Enter a valid line.';
  return null;
}

// Aggregate helper for season stats: record + net units over graded picks.
export function aggregate(picks) {
  let wins = 0, losses = 0, pushes = 0, voids = 0, u = 0;
  for (const p of picks) {
    if (p.result === 'win') wins++;
    else if (p.result === 'loss') losses++;
    else if (p.result === 'push') pushes++;
    else if (p.result === 'void') { voids++; continue; }
    else continue;
    u += unitsPL(p);
  }
  return { wins, losses, pushes, voids, units: u, decided: wins + losses };
}
