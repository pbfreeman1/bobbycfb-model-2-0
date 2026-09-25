// Bet types for logged picks (user_picks) and research tags (research_picks).
//
// UNITS ARE RISK. One unit staked returns the price: a 1u spread/total at -110
// wins 0.909u and loses 1.000u; a 1u moneyline at -150 wins 0.667u, at +130
// wins 1.300u, and loses 1.000u either way. This matches the PSS page's
// convention; the Bobby dashboard used to treat units as the to-win amount
// (win +1u, loss -1.1u), which made moneyline prices impossible to express.
//
// Custom picks are logged but never auto-graded — result is set by hand, and
// 'void' means it never settled and should not count.

export const BET_TYPES = [
  { v: 'spread', label: 'Spread', short: 'Spread' },
  { v: 'total', label: 'Total (O/U)', short: 'Total' },
  { v: 'moneyline', label: 'Moneyline', short: 'ML' },
  { v: 'custom', label: 'Custom', short: 'Custom' },
];

export const STANDARD_VIG = -110;

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

// Net units for one graded pick, risk-based. Spreads and totals assume -110
// because user_picks stores no price for them; moneyline uses its own odds.
export function unitsPL(pick) {
  const u = parseFloat(pick.units) || 0;
  if (!u) return 0;
  const res = pick.result;
  if (res === 'push' || res === 'void' || !res) return 0;
  if (res === 'loss') return -u;
  if (res !== 'win') return 0;
  const price = pick.pick_type === 'moneyline' ? pick.line_played : STANDARD_VIG;
  const profit = americanProfit(price);
  return profit == null ? 0 : u * profit;
}

// True when this pick is graded by /api/grade rather than by hand.
export function isAutoGraded(pick) {
  return !pick.is_custom && pick.pick_type !== 'custom';
}

// "Oregon -6.5" / "Over 54.5" / "Oregon ML (-150)" / "1H Oregon -3.5"
// teamFor(side) supplies the display name, so callers can pass short names.
export function pickDescription(pick, teamFor, fmtLine) {
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
  return `${team} ${fmtLine(pick.line_played, pick.side)}`.trim();
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
