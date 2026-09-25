// Readable short team names, for when a full name will not fit.
//
// Keys are the NORMALIZED name (normalizeTeamName from team-match.js), so one
// entry covers every spelling of a team that shows up in the games table —
// "Jacksonville St." and "Jacksonville State" both key to 'jacksonville state',
// "Miami (Ohio)" and "Miami (OH)" both key to 'miami oh'.
//
// Hand-curated on purpose: CFBD's own /teams abbreviations include things like
// "OKST" and "CMU" that are hard to read on a card. We are not storing CFBD
// abbreviations today (cfbd-sync only pulls games, media and lines), so this
// map is the whole answer for now; shortTeam() will prefer a CFBD abbreviation
// over the full name if one is ever passed in.
//
// Coverage: every team whose name runs 12+ characters in the 2026 games table.

import { normalizeTeamName } from './team-match.js';

export const SHORT_NAMES = {
  // --- the ones called out by name ---
  'middle tennessee': 'MTSU',
  'jacksonville state': 'Jax State',
  'florida atlantic': 'FAU',
  'massachusetts': 'UMass',
  'northern illinois': 'NIU',
  'sacramento state': 'Sac State',
  'southern miss': 'So Miss',
  'south alabama': 'S. Alabama',
  'oklahoma state': 'Okla State',
  'washington state': 'Wash State',
  'georgia tech': 'GA Tech',
  'coastal carolina': 'Coastal',
  'virginia tech': 'VA Tech',
  'boston college': 'BC',

  // --- "X State", following the Okla State / Wash State pattern ---
  'arizona state': 'Ariz State',
  'arkansas state': 'Ark State',
  'colorado state': 'Colo State',
  'michigan state': 'Mich State',
  'mississippi state': 'Miss State',
  'missouri state': 'Mo State',
  'new mexico state': 'NM State',
  'north dakota state': 'NDSU',
  'oregon state': 'Ore State',
  'san diego state': 'SDSU',
  'san jose state': 'San Jose St',
  'kansas state': 'K-State',
  'kennesaw state': 'Kennesaw',
  'fresno state': 'Fresno',
  'florida state': 'FSU',
  'georgia state': 'GA State',

  // --- directional schools ---
  'central michigan': 'C. Michigan',
  'eastern michigan': 'E. Michigan',
  'western michigan': 'W. Michigan',
  'western kentucky': 'WKU',
  'georgia southern': 'GA Southern',
  'north carolina': 'UNC',
  'south carolina': 'S. Carolina',
  'east carolina': 'ECU',
  'south florida': 'USF',
  'west virginia': 'WVU',

  // --- initialisms that read cleanly ---
  'florida international': 'FIU',
  'james madison': 'JMU',
  'old dominion': 'ODU',
  'louisiana tech': 'LA Tech',
  'bowling green': 'BGSU',
  'ul monroe': 'ULM',
  'utsa': 'UTSA',
  'ucf': 'UCF',

  // --- long spelling, short common name ---
  'louisiana': 'Louisiana',       // "Louisiana-Lafayette" in some rows
  'sam houston': 'Sam Houston',   // "Sam Houston St." in some rows
  'app state': 'App State',       // "Appalachian St." in some rows
  'miami oh': 'Miami OH',
  'miami': 'Miami',               // "Miami (Fla.)" in some rows
};

// shortTeam(name, abbrMap?) — the display name to use when space is tight.
// Order: curated map, then a CFBD abbreviation if the caller has one, then the
// full name unchanged.
export function shortTeam(name, abbrMap) {
  if (!name) return name;
  const key = normalizeTeamName(name);
  const curated = SHORT_NAMES[key];
  if (curated) return curated;
  if (abbrMap) {
    const abbr = abbrMap[name] || abbrMap[key];
    if (abbr) return abbr;
  }
  return name;
}

// True when a shorter form actually exists, so callers only add title/aria-label
// when the text on screen is not the full name.
export function hasShortName(name, abbrMap) {
  return shortTeam(name, abbrMap) !== name;
}

// Search has to keep working on the full name even while the card shows the
// short one: "Jacksonville" must still find a card reading "Jax State".
export function teamSearchText(name, abbrMap) {
  const short = shortTeam(name, abbrMap);
  return short === name ? name.toLowerCase() : `${name} ${short}`.toLowerCase();
}
