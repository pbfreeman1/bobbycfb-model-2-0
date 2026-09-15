'use client';
import { usePathname } from 'next/navigation';
import { GLOBAL_STYLE } from '../lib/supabase';

const CFB_NAV = [
  { href: '/cfb/dashboard', label: '📊 Dashboard' },
  { href: '/cfb/my-card', label: '🎯 My Card' },
  { href: '/cfb/weekly-board', label: '📋 Weekly Board' },
  { href: '/cfb/pss-dashboard', label: '🧠 PSS Dashboard' },
  { href: '/cfb/mss-dashboard', label: '🧮 MSS Dashboard' },
  { href: '/cfb/bobby-results', label: '🏈 Bobby Results' },
  { href: '/cfb/research', label: '🔍 Research' },
  { href: '/cfb/models', label: '🤖 Models' },
  { href: '/cfb/results', label: '📅 Results' },
  { href: '/cfb/calibration', label: '📈 Calibration' },
  { href: '/cfb/ingest', label: '⚙️ Ingest' },
];

const NFL_NAV = [
  { href: '/nfl/dashboard', label: '📊 Dashboard' },
  { href: '/nfl/pss', label: '🧠 PSS' },
  { href: '/nfl/strong-agreement', label: '🔥 Strong Agreement' },
  { href: '/nfl/results', label: '📅 Results' },
  { href: '/nfl/bobby-results', label: '🏈 Bobby Results' },
  { href: '/nfl/research', label: '🔍 Research' },
  { href: '/nfl/ingest', label: '⚙️ Ingest' },
];

export default function RootLayout({ children }) {
  const path = usePathname();
  const sport = path.startsWith('/nfl') ? 'nfl' : path.startsWith('/cfb') ? 'cfb' : null;
  const subNav = sport === 'nfl' ? NFL_NAV : sport === 'cfb' ? CFB_NAV : [];

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>BobbyModels</title>
      </head>
      <body>
        <nav>
          <a href="/" className="nav-logo" style={{ textDecoration: 'none' }}>Bobby<span>Models</span></a>
          {sport && (
            <span style={{ display: 'inline-flex', gap: 4, marginLeft: 10, marginRight: 10 }}>
              <a href="/cfb/dashboard" className={sport === 'cfb' ? 'active' : ''}>CFB</a>
              <a href="/nfl/dashboard" className={sport === 'nfl' ? 'active' : ''}>NFL</a>
            </span>
          )}
          {subNav.map((n) => (
            <a key={n.href} href={n.href} className={path === n.href ? 'active' : ''}>
              {n.label}
            </a>
          ))}
        </nav>
        {children}
        <style global jsx>{GLOBAL_STYLE}</style>
      </body>
    </html>
  );
}
