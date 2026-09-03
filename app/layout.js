'use client';
import { usePathname } from 'next/navigation';
import { GLOBAL_STYLE } from '../lib/supabase';

const NAV = [
  { href: '/', label: '📊 Dashboard' },
  { href: '/my-card', label: '🎯 My Card' },
  { href: '/weekly-board', label: '📋 Weekly Board' },
  { href: '/research', label: '🔍 Research' },
  { href: '/models', label: '🤖 Models' },
  { href: '/calibration', label: '📈 Calibration' },
  { href: '/ingest', label: '⚙️ Ingest' },
];

export default function RootLayout({ children }) {
  const path = usePathname();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>BobbyModels</title>
      </head>
      <body>
        <nav>
          <span className="nav-logo">Bobby<span>Models</span></span>
          {NAV.map((n) => (
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
