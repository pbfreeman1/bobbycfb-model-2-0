// THE Bobby Model — shared client-safe helpers (tiers, formatting, definitions).
// Runs alongside the MSS and PSS pipelines; does not touch their code or tables.

export const TIERS = ['3U', '2U', '1U', 'Lean', 'No tier'];

export const TIER_COLOR = {
  '3U': '#D4A73C',
  '2U': '#6FBF73',
  '1U': '#B39DDB',
  'Lean': '#8B9992',
  'No tier': '#7A857F',
};

export const TIER_UNITS = { '3U': 3, '2U': 2, '1U': 1, 'Lean': 0, 'No tier': 0 };

// Order for "next tier up" lookups.
const NEXT_TIER = { '2U': '3U', '1U': '2U', 'Lean': '1U', 'No tier': '1U' };

export function fmtSpread(n) {
  if (n === null || n === undefined) return 'PK';
  const num = parseFloat(n);
  if (isNaN(num)) return 'PK';
  if (Math.abs(num) < 0.05) return 'PK';
  return num > 0 ? `+${num.toFixed(1)}` : `-${Math.abs(num).toFixed(1)}`;
}

// Spread for a given side, from a home-positive margin (positive = home favored).
export function teamLine(homeMargin, side) {
  const m = parseFloat(homeMargin);
  if (isNaN(m)) return 'PK';
  return side === 'home' ? fmtSpread(-m) : fmtSpread(m);
}

export function pickTeam(signal, game) {
  return signal.pick_side === 'home' ? game.home_team : game.away_team;
}

export function pickAbbrev(signal, abbrevFn) {
  // abbrevFn(team) -> short code; caller supplies since abbreviations are page-local.
  return signal.pick_side;
}

export function pickLabel(signal, game) {
  const team = pickTeam(signal, game);
  return `${team} ${teamLine(signal.vegas_line, signal.pick_side)}`;
}

export function modelLabel(signal, game, abbr) {
  return `Model ${abbr} ${teamLine(signal.consensus, signal.pick_side)}`;
}

const TIER_THRESH = (cfg) => ({
  '3U': { vs: cfg.t3_vs, edge: cfg.t3_edge, sd: cfg.t3_sd, conv: cfg.t3_conv },
  '2U': { vs: cfg.t2_vs, edge: cfg.t2_edge, sd: cfg.t2_sd, conv: cfg.t2_conv },
  '1U': { vs: cfg.t1_vs, edge: cfg.t1_edge, sd: cfg.t1_sd, conv: cfg.t1_conv },
});

export function nextTierUp(tier) {
  return NEXT_TIER[tier] || null;
}

// signal: { tier, vote_share, edge, std_dev, conviction, voters }
// config: flat map of cfb_tracker_config values, e.g. { t3_vs: 0.9, ... }
export function nearMiss(signal, config) {
  const next = nextTierUp(signal.tier);
  if (!next) return null;
  const t = TIER_THRESH(config)[next];
  if (!t) return null;
  const ae = Math.abs(signal.edge);
  const tol = config.near_miss_pct ?? 0.05;
  const tests = [
    { m: 'Vote', v: signal.vote_share, c: t.vs, ge: true, f: (d) => (d * 100).toFixed(1) + '%' },
    { m: 'Edge', v: ae, c: t.edge, ge: true, f: (d) => d.toFixed(2) },
    { m: 'STD', v: signal.std_dev, c: t.sd, ge: false, f: (d) => d.toFixed(2) },
    { m: 'Conv', v: signal.conviction, c: t.conv, ge: true, f: (d) => d.toFixed(2) },
  ];
  const fails = tests.filter((x) => (x.ge ? x.v < x.c : x.v > x.c));
  if (fails.length !== 1 || signal.voters < (config.min_voters ?? 5)) return null;
  const x = fails[0];
  const d = Math.abs(x.v - x.c);
  if (d / x.c > tol) return null;
  return `${x.m} ${x.f(d)} from ${next}`;
}

// Returns checklist rows for the next tier up (or 3U's own thresholds if already 3U).
export function tierChecklist(signal, config) {
  const next = nextTierUp(signal.tier) || '3U';
  const t = TIER_THRESH(config)[next];
  const ae = Math.abs(signal.edge);
  const minVoters = config.min_voters ?? 5;
  const rows = [
    { label: `Vote share ≥ ${Math.round(t.vs * 100)}%`, value: `${Math.round(signal.vote_share * 100)}%`, pass: signal.vote_share >= t.vs },
    { label: `Edge ≥ ${t.edge.toFixed(1)}`, value: ae.toFixed(1), pass: ae >= t.edge },
    { label: `Std dev ≤ ${t.sd.toFixed(1)}`, value: signal.std_dev.toFixed(1), pass: signal.std_dev <= t.sd },
    { label: `Conviction ≥ ${t.conv.toFixed(1)}`, value: signal.conviction.toFixed(2), pass: signal.conviction >= t.conv },
    { label: 'Voters ≥ 5', value: String(signal.voters), pass: signal.voters >= minVoters },
  ];
  return { title: next === '3U' && signal.tier === '3U' ? 'Clears every 3U threshold' : `What it takes to reach ${next}`, rows };
}

export const DEFINITIONS = {
  rank: ['Bobby Rank', 'Best to worst play for the week, fixed per game: unit tier first (3U, 2U, 1U, Lean, near miss, no play), then a strength score from weighted vote share, edge and tightness — with edge tapered past 3 points and ignored past 5, since bigger edges have not held up ATS. Searching, filtering and re-sorting never change it.'],
  pick: ['Bobby Model pick', 'The side the weighted consensus favors against the current Vegas line, shown at the Vegas number you would bet.'],
  modelLine: ['Model line', 'The weighted consensus of the voting systems, shown for the pick side. The gap between this and the Vegas line is the edge.'],
  vegas: ['Vegas line', 'The current market spread from the latest predictiontracker CSV upload.'],
  edge: ['Edge', 'Points between the model line and the Vegas line. Bigger means more disagreement with the market. Not capped; 6+ is flagged.'],
  vs: ['Vote share', 'Share of total system weight on the pick side. 96% means systems holding 96% of the weight agree on the side.'],
  sd: ['Std dev', 'How spread out the voting systems’ predictions are, weighted. Lower means tighter agreement.'],
  conv: ['Conviction', 'Edge divided by std dev (std dev floored at 1.0). High conviction means a big edge with tight agreement.'],
  move: ['Line move', 'Opening line to current line. Shown for context; it does not change the tier.'],
  ou: ['Total (O/U)', 'The game total. Shown for context only.'],
  tier: ['Unit tier', '3U, 2U, 1U or Lean, assigned when a game clears every threshold for that tier. Paper units, graded weekly at −110.'],
  weight: ['System weight', 'Half shrunk 2026 ATS, half accuracy (MAE) versus the median system. Systems at or below average get no vote. Recalibrated after every graded week.'],
  flags: ['Flags', '6+ edge, Fade watch, Thin pool (fewer than 8 voters) and Split top (top two systems disagree). Graded separately; never change the tier.'],
  near: ['Near miss', 'The game missed the next tier up on exactly one threshold, by 5% of that cutoff or less. The tier stays as scored; the badge shows how close it came.'],
  checks: ['Tier checklist', 'Each threshold for the next tier up, with this game’s value and whether it passes.'],
};

export const TIER_THRESHOLDS_DISPLAY = [
  { t: '3U', vs: '≥90%', edge: '≥3.0', sd: '≤2.5', conv: '≥1.5' },
  { t: '2U', vs: '≥80%', edge: '≥2.0', sd: '≤3.5', conv: '≥1.0' },
  { t: '1U', vs: '≥70%', edge: '≥1.5', sd: '≤4.5', conv: '≥0.6' },
  { t: 'Lean', vs: '≥60%', edge: '≥1.0', sd: 'any', conv: '—' },
];
