// Single source of truth for site navigation.
//
// Every sport gets the same shape: a handful of primary tabs, each owning one or
// more existing pages (shown as a sub-tab strip), plus a "More" menu for pages
// that are rarely used. Adding a sport later (CBB, NBA) is one entry in SPORTS
// and one entry in NAV_BY_SPORT. The header and the mobile bottom bar render
// from this and need no changes.
//
// Routes are unchanged on purpose: this only regroups what already exists.

export const SPORTS = [
  { key: 'cfb', label: 'CFB', name: 'College Football', prefix: '/cfb', home: '/cfb/dashboard' },
  { key: 'nfl', label: 'NFL', name: 'Pro Football', prefix: '/nfl', home: '/nfl/dashboard' },
  { key: 'cbb', label: 'CBB', name: 'College Basketball', prefix: '/cbb', home: '/cbb/dashboard' },
  // { key: 'nba', label: 'NBA', name: 'Pro Basketball', prefix: '/nba', home: '/nba/dashboard' },
];

export const NAV_BY_SPORT = {
  cfb: {
    tabs: [
      { key: 'board', label: 'Board', icon: 'board', pages: [
        { href: '/cfb/dashboard', label: 'THE Bobby Model' },
      ] },
      { key: 'card', label: 'My Card', icon: 'card', pages: [
        { href: '/cfb/my-card', label: 'My Card' },
      ] },
      { key: 'research', label: 'Research', icon: 'search', pages: [
        { href: '/cfb/research-report', label: 'Research Report' },
        { href: '/cfb/play-finder', label: 'Play Finder' },
        { href: '/cfb/weekend-guide', label: 'Weekend Guide' },
        { href: '/cfb/research', label: 'Quick Tag' },
      ] },
      { key: 'results', label: 'Results', icon: 'results', pages: [
        { href: '/cfb/bobby-results', label: 'Bobby Results' },
        { href: '/cfb/bobcat-log', label: 'Bobcat Log' },
        { href: '/cfb/models', label: 'Models' },
        { href: '/cfb/results', label: 'Weekly' },
      ] },
    ],
    more: [
      { group: 'Archive', items: [
        { href: '/cfb/pss-dashboard', label: 'PSS Dashboard' },
        { href: '/cfb/mss-dashboard', label: 'MSS Dashboard' },
        { href: '/cfb/weekly-board', label: 'Weekly Board' },
      ] },
      { group: 'Admin', items: [
        { href: '/cfb/log', label: 'Pull Log' },
        { href: '/cfb/calibration', label: 'Calibration' },
        { href: '/cfb/ingest', label: 'Manual CSV Ingest' },
      ] },
    ],
  },
  nfl: {
    tabs: [
      { key: 'board', label: 'Board', icon: 'board', pages: [
        { href: '/nfl/dashboard', label: 'Weekly Board' },
      ] },
      { key: 'research', label: 'Research', icon: 'search', pages: [
        { href: '/nfl/research', label: 'Outside Picks' },
      ] },
      { key: 'results', label: 'Results', icon: 'results', pages: [
        { href: '/nfl/results', label: 'Results' },
      ] },
    ],
    more: [
      { group: 'Admin', items: [
        { href: '/nfl/log', label: 'Pull Log' },
      ] },
      { group: 'Archive', items: [
        { href: '/nfl/legacy/dashboard', label: 'Old Dashboard' },
        { href: '/nfl/legacy/ats', label: 'Old ATS' },
        { href: '/nfl/legacy/totals', label: 'Old O/U' },
        { href: '/nfl/legacy/results', label: 'Old Results' },
        { href: '/nfl/ingest', label: 'Manual CSV Ingest' },
      ] },
    ],
  },
  cbb: {
    tabs: [
      { key: 'board', label: 'Board', icon: 'board', pages: [
        { href: '/cbb/dashboard', label: 'Daily Board' },
      ] },
      { key: 'research', label: 'Research', icon: 'search', pages: [
        { href: '/cbb/research', label: 'Outside Picks' },
      ] },
      { key: 'results', label: 'Results', icon: 'results', pages: [
        { href: '/cbb/results', label: 'Results' },
      ] },
    ],
    more: [
      { group: 'Admin', items: [
        { href: '/cbb/log', label: 'Pull Log' },
      ] },
    ],
  },
};
