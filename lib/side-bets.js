// "Other bets": research tags that are NOT graded. Moneylines, team totals and
// first-half / second-half / quarter bets live in research_side_bets, separate
// from research_picks, so the research report, Play Finder and grading never
// see them. The point is the consensus view: how many sources/experts are on
// the same bet this week.
//
// Pure functions, no I/O.
//
// Conventions (same as the rest of research tagging):
//   team_side  'home' | 'away'   for spread, moneyline, team_total
//   ou_side    'over' | 'under'  for total, team_total
//   line       spread in bet-slip notation from the picked team's side
//              (-9.5 = picked team gives 9.5); total / team total number
//   odds       American price (+142, -150), optional

export const PERIODS = ['full', '1h', '2h', '1q', '2q', '3q', '4q'];
export const PERIOD_LABEL = { full: '', '1h': '1H', '2h': '2H', '1q': '1Q', '2q': '2Q', '3q': '3Q', '4q': '4Q' };
export const SIDE_MARKETS = ['spread', 'total', 'moneyline', 'team_total'];

// Full-game spreads and totals are graded research_picks, never side bets.
export const isGradedMarket = (period, market) => period === 'full' && (market === 'spread' || market === 'total');

export const needsTeam = (market) => market === 'spread' || market === 'moneyline' || market === 'team_total';
export const needsOU = (market) => market === 'total' || market === 'team_total';

// Bet types offered in the Quick Tag form, after Spread / Total.
export const MANUAL_SIDE_TYPES = [
  { v: 'full:moneyline', label: 'Moneyline' },
  { v: 'full:team_total', label: 'Team total' },
  { v: '1h:spread', label: '1H spread' },
  { v: '1h:total', label: '1H total' },
  { v: '1h:moneyline', label: '1H moneyline' },
  { v: '1h:team_total', label: '1H team total' },
  { v: '2h:spread', label: '2H spread' },
  { v: '2h:total', label: '2H total' },
  { v: '1q:spread', label: '1Q spread' },
  { v: '1q:total', label: '1Q total' },
];
export function parseSideType(v) {
  const [period, market] = String(v || '').split(':');
  return PERIODS.includes(period) && SIDE_MARKETS.includes(market) && !isGradedMarket(period, market) ? { period, market } : null;
}

// Side choices for the form. Team totals combine team + over/under.
export function sideChoices(market) {
  if (market === 'total') return ['over', 'under'];
  if (market === 'team_total') return ['home:over', 'home:under', 'away:over', 'away:under'];
  return ['home', 'away'];
}
export function splitSide(market, choice) {
  const [a, b] = String(choice || '').split(':');
  if (market === 'total') return { team_side: null, ou_side: a === 'over' || a === 'under' ? a : null };
  if (market === 'team_total') return { team_side: a === 'home' || a === 'away' ? a : null, ou_side: b === 'over' || b === 'under' ? b : null };
  return { team_side: a === 'home' || a === 'away' ? a : null, ou_side: null };
}

const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
export function cleanOdds(v) {
  const n = num(v);
  if (n == null) return null;
  const r = Math.round(n);
  return Math.abs(r) >= 100 ? r : null;
}

// Returns an error string, or null when the bet is saveable.
export function validateSideBet({ period, market, team_side, ou_side, line, odds }) {
  if (!PERIODS.includes(period) || !SIDE_MARKETS.includes(market)) return 'Pick a bet type.';
  if (isGradedMarket(period, market)) return 'Full-game spreads and totals are regular tags.';
  if (needsTeam(market) && team_side !== 'home' && team_side !== 'away') return 'Pick a team.';
  if (needsOU(market) && ou_side !== 'over' && ou_side !== 'under') return 'Pick Over or Under.';
  if ((market === 'total' || market === 'team_total') && num(line) == null) return 'Enter the number.';
  if (odds !== '' && odds != null && cleanOdds(odds) == null) return 'Odds must be -100 or lower, or +100 or higher.';
  return null;
}

// Row to POST to research_side_bets.
export function buildSideBetRow({ game, season, week, period, market, team_side, ou_side, line, odds, source, expert, note }) {
  const ex = String(expert || '').replace(/\s+/g, ' ').trim() || null;
  return {
    season, week, game_id: game.id, home_team: game.home_team, away_team: game.away_team,
    period, market,
    team_side: needsTeam(market) ? team_side : null,
    ou_side: needsOU(market) ? ou_side : null,
    line: market === 'moneyline' ? null : num(line),
    odds: cleanOdds(odds),
    source_id: source?.id || null,
    source_label: source ? (ex ? `${source.name} - ${ex}` : source.name) : null,
    expert: ex,
    note: String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
  };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const fmtOdds = (o) => (o == null ? '' : signed(o));

// "1H Under 23.5", "Baylor ML +142", "Oklahoma State TT Over 31.5", "1H Georgia -9.5".
// teamFor(side) returns the display name. withLine=false gives the bet without its number,
// which is what groups compare on.
export function describeSideBet(b, teamFor, { withLine = true } = {}) {
  const per = PERIOD_LABEL[b.period] || '';
  const team = b.team_side ? (teamFor ? teamFor(b.team_side) : b.team_side) : '';
  const ou = b.ou_side === 'over' ? 'Over' : b.ou_side === 'under' ? 'Under' : '';
  const ln = withLine && b.line != null ? b.line : null;
  let s;
  if (b.market === 'moneyline') s = `${team} ML${withLine && b.odds != null ? ` ${fmtOdds(b.odds)}` : ''}`;
  else if (b.market === 'team_total') s = `${team} TT ${ou}${ln != null ? ` ${ln}` : ''}`;
  else if (b.market === 'total') s = `${ou}${ln != null ? ` ${ln}` : ''}`;
  else s = `${team}${ln != null ? ` ${signed(ln)}` : ''}`;
  return `${per ? `${per} ` : ''}${s}`.trim();
}

export const sideBetKey = (b) => [b.game_id, b.period, b.market, b.team_side || '', b.ou_side || ''].join('|');
const marketKey = (b) => [b.game_id, b.period, b.market].join('|');
const who = (b) => `${b.source_id || b.source_label || ''}|${String(b.expert || '').toLowerCase().split(' ').pop()}`;

// Groups the week's side bets by game + period + market + side. count is the
// number of distinct source/expert pairs on that bet. opposed = someone else is
// on the other side of the same market. Sorted by count, most popular first.
export function groupSideBets(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = sideBetKey(r);
    if (!groups.has(k)) groups.set(k, { key: k, game_id: r.game_id, period: r.period, market: r.market, team_side: r.team_side || null, ou_side: r.ou_side || null, rows: [] });
    groups.get(k).rows.push(r);
  }
  const list = [...groups.values()];
  const byMarket = new Map();
  for (const g of list) {
    g.count = new Set(g.rows.map(who)).size;
    const lines = g.rows.map((r) => (g.market === 'moneyline' ? r.odds : r.line)).filter((v) => v != null).map(Number);
    g.min = lines.length ? Math.min(...lines) : null;
    g.max = lines.length ? Math.max(...lines) : null;
    const mk = marketKey(g);
    byMarket.set(mk, (byMarket.get(mk) || 0) + 1);
  }
  for (const g of list) g.opposed = byMarket.get(marketKey(g)) > 1;
  return list.sort((a, b) => b.count - a.count || b.rows.length - a.rows.length);
}

// Article import: one side bet per source + expert + bet. existing = research_side_bets rows.
export function planSideBets(bets, existing, { season, week, source }) {
  const ek = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().split(' ').pop();
  return (bets || []).map((b) => {
    const k = sideBetKey({ ...b, game_id: b.game.id });
    const same = (existing || []).find((r) => r.source_id === source.id && sideBetKey(r) === k && ek(r.expert) === ek(b.expert));
    if (same) return { action: 'same', bet: b };
    return {
      action: 'insert', bet: b,
      row: buildSideBetRow({ game: b.game, season, week, period: b.period, market: b.market, team_side: b.team_side, ou_side: b.ou_side, line: b.line, odds: b.odds, source, expert: b.expert, note: [b.expert, b.text].filter(Boolean).join(': ') }),
    };
  });
}
