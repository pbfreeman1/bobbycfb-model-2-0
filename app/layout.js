'use client';
import { GLOBAL_STYLE } from '../lib/supabase';
import AppNav, { NAV_CSS } from './_nav/AppNav';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
        <title>BobbyModels</title>
      </head>
      <body>
        <AppNav />
        {children}
        <style global jsx>{`${GLOBAL_STYLE}\n${NAV_CSS}`}</style>
      </body>
    </html>
  );
}
