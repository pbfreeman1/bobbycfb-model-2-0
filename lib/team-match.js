/**
 * Normalizes college football team names so two different sources
 * (thepredictiontracker.com's abbreviated names vs. CFBD's full/current
 * names) resolve to the same key for matching.
 *
 * Examples this handles:
 *   "Colorado St."   -> "colorado state"   (matches CFBD "Colorado State")
 *   "Eastern Mich."  -> "eastern michigan" (matches CFBD "Eastern Michigan")
 *   "Troy St."       -> "troy"             (Troy dropped "State" from its
 *                                            official name; CFBD reflects that)
 *   "Kent"           -> "kent state"       (predictiontracker shortens this
 *                                            one further than CFBD does)
 *   "Miami (Ohio)"   -> "miami oh"
 *   "Hawai'i"        -> "hawaii"
 *
 * If a pair still doesn't match after this, the calling route reports it
 * in an `unmatched` array in its response so a new alias can be added here.
 */

// Explicit overrides for teams that don't follow the general "St." -> "State"
// pattern, or where CFBD's current official name differs from the common
// abbreviation. Keys are the ALREADY-CLEANED (punctuation-stripped,
// lowercased) form of the predictiontracker.com name.
const ALIASES = {
  'troy st': 'troy',
  'sam houston st': 'sam houston',
  'kent': 'kent state',
  'mississippi': 'ole miss',
  'miami ohio': 'miami oh',
  'miami fla': 'miami',
  'hawaii': 'hawaii',
};

// Word-level expansions applied token-by-token after the alias check.
const WORD_EXPANSIONS = {
  st: 'state',
  mich: 'michigan',
  ill: 'illinois',
  fla: 'florida',
  va: 'virginia',
  intl: 'international',
  no: 'northern',
  so: 'southern',
};

function cleanBase(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/[().'’]/g, '')   // drop periods, parens, apostrophes/smart quotes
    .replace(/-/g, ' ')        // hyphens -> spaces (Louisiana-Monroe -> Louisiana Monroe)
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTeamName(raw) {
  let name = cleanBase(raw);
  if (ALIASES[name]) name = cleanBase(ALIASES[name]);

  const tokens = name.split(' ').map((t) => WORD_EXPANSIONS[t] || t);
  return tokens.join(' ').trim();
}

export function matchKey(homeTeam, awayTeam) {
  return `${normalizeTeamName(homeTeam)}|${normalizeTeamName(awayTeam)}`;
}
