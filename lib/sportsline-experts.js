// SportsLine "Expert Picks" tab (sportsline.com/college-football/picks/, Expert Picks).
// Each card is one expert's pick:
//   Nov 14 2026, 12:00 pm ET League Logo Demon Deacons Logo @ Mustangs Logo Point Spread
//   SMU -1 -108 Unit 1.0 Avatar Eric Cohen EC Profile -> ...
// Cards name teams by NICKNAME (Beavers @ Broncos), so games are found through a
// nickname table plus the pick text. Parsed directly, no language model.
// Tags are one per expert (label "SportsLine - Eric Cohen").

import { normalizeTeamName } from './team-match.js';
import { kamKey } from './kam-import.js';

// nickname -> team names it can mean. The matchup (both nicknames) picks the right one.
const TEAMS = {
  'Boston College': 'Eagles', California: 'Golden Bears', Clemson: 'Tigers', Duke: 'Blue Devils', 'Florida State': 'Seminoles',
  'Georgia Tech': 'Yellow Jackets', Louisville: 'Cardinals', Miami: 'Hurricanes', 'NC State': 'Wolfpack', 'North Carolina': 'Tar Heels',
  Pittsburgh: 'Panthers', SMU: 'Mustangs', Stanford: 'Cardinal', Syracuse: 'Orange', Virginia: 'Cavaliers', 'Virginia Tech': 'Hokies',
  'Wake Forest': 'Demon Deacons', Illinois: 'Fighting Illini|Illini', Indiana: 'Hoosiers', Iowa: 'Hawkeyes', Maryland: 'Terrapins',
  Michigan: 'Wolverines', 'Michigan State': 'Spartans', Minnesota: 'Golden Gophers|Gophers', Nebraska: 'Cornhuskers|Huskers',
  Northwestern: 'Wildcats', 'Ohio State': 'Buckeyes', Oregon: 'Ducks', 'Penn State': 'Nittany Lions', Purdue: 'Boilermakers',
  Rutgers: 'Scarlet Knights', UCLA: 'Bruins', USC: 'Trojans', Washington: 'Huskies', Wisconsin: 'Badgers', Arizona: 'Wildcats',
  'Arizona State': 'Sun Devils', Baylor: 'Bears', BYU: 'Cougars', Cincinnati: 'Bearcats', Colorado: 'Buffaloes', Houston: 'Cougars',
  'Iowa State': 'Cyclones', Kansas: 'Jayhawks', 'Kansas State': 'Wildcats', 'Oklahoma State': 'Cowboys', TCU: 'Horned Frogs',
  'Texas Tech': 'Red Raiders', UCF: 'Knights', Utah: 'Utes', 'West Virginia': 'Mountaineers', Alabama: 'Crimson Tide', Arkansas: 'Razorbacks',
  Auburn: 'Tigers', Florida: 'Gators', Georgia: 'Bulldogs', Kentucky: 'Wildcats', LSU: 'Tigers', 'Ole Miss': 'Rebels',
  'Mississippi State': 'Bulldogs', Missouri: 'Tigers', Oklahoma: 'Sooners', 'South Carolina': 'Gamecocks', Tennessee: 'Volunteers|Vols',
  Texas: 'Longhorns', 'Texas A&M': 'Aggies', Vanderbilt: 'Commodores', Army: 'Black Knights', Charlotte: '49ers', 'East Carolina': 'Pirates',
  FAU: 'Owls', Memphis: 'Tigers', Navy: 'Midshipmen', 'North Texas': 'Mean Green', Rice: 'Owls', 'South Florida': 'Bulls', Temple: 'Owls',
  Tulane: 'Green Wave', Tulsa: 'Golden Hurricane', UAB: 'Blazers', UTSA: 'Roadrunners', 'Air Force': 'Falcons', 'Boise State': 'Broncos',
  'Colorado State': 'Rams', 'Fresno State': 'Bulldogs', Hawaii: 'Rainbow Warriors|Warriors', Nevada: 'Wolf Pack', 'New Mexico': 'Lobos',
  'San Diego State': 'Aztecs', 'San Jose State': 'Spartans', UNLV: 'Rebels', 'Utah State': 'Aggies', Wyoming: 'Cowboys',
  'Washington State': 'Cougars', 'Oregon State': 'Beavers', 'Northern Illinois': 'Huskies', 'North Dakota State': 'Bison',
  'Texas State': 'Bobcats', 'App State': 'Mountaineers', 'Arkansas State': 'Red Wolves', 'Coastal Carolina': 'Chanticleers',
  'Georgia Southern': 'Eagles', 'Georgia State': 'Panthers', 'James Madison': 'Dukes', Louisiana: 'Ragin Cajuns|Ragin\' Cajuns|Cajuns',
  'UL Monroe': 'Warhawks', Marshall: 'Thundering Herd', 'Old Dominion': 'Monarchs', 'South Alabama': 'Jaguars', 'Southern Miss': 'Golden Eagles',
  Troy: 'Trojans', Delaware: 'Blue Hens', FIU: 'Panthers', 'Jacksonville State': 'Gamecocks', 'Kennesaw State': 'Owls', Liberty: 'Flames',
  'Louisiana Tech': 'Bulldogs', 'Middle Tennessee': 'Blue Raiders', 'New Mexico State': 'Aggies', 'Sam Houston': 'Bearkats', UTEP: 'Miners',
  'Western Kentucky': 'Hilltoppers', 'Missouri State': 'Bears', Akron: 'Zips', 'Ball State': 'Cardinals', 'Bowling Green': 'Falcons',
  Buffalo: 'Bulls', 'Central Michigan': 'Chippewas', 'Eastern Michigan': 'Eagles', 'Kent State': 'Golden Flashes', 'Miami (OH)': 'RedHawks',
  Ohio: 'Bobcats', Toledo: 'Rockets', UMass: 'Minutemen', 'Western Michigan': 'Broncos', 'Notre Dame': 'Fighting Irish', UConn: 'Huskies',
};
const NICK = new Map();
for (const [team, nicks] of Object.entries(TEAMS)) {
  for (const n of nicks.split('|')) {
    const k = n.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (!NICK.has(k)) NICK.set(k, []);
    NICK.get(k).push(team);
  }
}
const nickKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const same = (a, b) => !!a && !!b && (kamKey(a) === kamKey(b) || normalizeTeamName(a) === normalizeTeamName(b));
const isTeam = (dbName, nick) => (NICK.get(nickKey(nick)) || []).some((t) => same(dbName, t));

export function looksLikeExpertPicks(text) {
  const s = String(text || '');
  return /Pick Made/i.test(s) && /\bUnit\b\s*\d/.test(s) && /Profile/.test(s) && !/Matchup Analysis/i.test(s);
}

const LABELS = 'Over / Under|Point Spread|Money Line|Moneyline|Total|Spread';
const CARD = new RegExp(`[A-Z][a-z]{2} \\d{1,2} \\d{4}, \\d{1,2}:\\d{2} [ap]m ET League (?:Logo )?(.+?) (?:Logo )?@ (.+?) (?:Logo )?(${LABELS}|[A-Z][A-Za-z /]{2,24}?) (.+?) Unit \\d+(?:\\.\\d+)? Avatar (\\S+(?: \\S+)?)`, 'g');

export function parseExpertCards(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  const cards = [];
  let m;
  CARD.lastIndex = 0;
  while ((m = CARD.exec(s))) cards.push({ away: m[1].trim(), home: m[2].trim(), market: m[3].trim(), pick: m[4].trim(), expert: m[5].trim() });
  return cards;
}

export function resolveExpertPicks(text, games) {
  const picks = [], skipped = [];
  const cards = parseExpertCards(text);
  for (const c of cards) {
    const label = `${c.away} @ ${c.home}: ${c.pick}`;
    const note = { expert: c.expert, text: label };
    const hits = games.filter((g) => (isTeam(g.away_team, c.away) && isTeam(g.home_team, c.home)) || (isTeam(g.home_team, c.away) && isTeam(g.away_team, c.home)));
    if (hits.length !== 1) { skipped.push({ ...note, reason: hits.length ? `ambiguous game (${c.away} @ ${c.home})` : `game not found in this week (${c.away} @ ${c.home})` }); continue; }
    const g = hits[0];
    if (/^(Over \/ Under|Total)$/i.test(c.market)) {
      const t = /^(Over|Under)\s+(\d+(?:\.\d+)?)/i.exec(c.pick);
      if (!t) { skipped.push({ ...note, reason: 'unrecognized total' }); continue; }
      picks.push({ game: g, type: 'total', side: t[1].toLowerCase(), line: +t[2], experts: [c.expert], expert: c.expert, text: label });
    } else if (/^(Point Spread|Spread)$/i.test(c.market)) {
      const t = /^(.+?)\s+([+-]\d+(?:\.\d+)?)(?:\s+[+-]\d+)?$/.exec(c.pick);
      if (!t) { skipped.push({ ...note, reason: 'unrecognized spread' }); continue; }
      let side = null;
      if (same(g.home_team, t[1])) side = 'home';
      else if (same(g.away_team, t[1])) side = 'away';
      if (!side) { skipped.push({ ...note, reason: `team "${t[1]}" not in ${g.away_team} @ ${g.home_team}` }); continue; }
      picks.push({ game: g, type: 'spread', side, line: +t[2], experts: [c.expert], expert: c.expert, text: label });
    } else {
      skipped.push({ ...note, reason: `${c.market.toLowerCase()} (not tagged)` });
    }
  }
  return { picks, skipped, cards: cards.length };
}
