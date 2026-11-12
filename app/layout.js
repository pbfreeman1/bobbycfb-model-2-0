'use client';
import { GLOBAL_STYLE } from '../lib/supabase';
import AppNav from './_nav/AppNav';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>BobbyModels</title>
      </head>
      <body>
        <AppNav />
        {children}
        <style global jsx>{GLOBAL_STYLE}</style>
      </body>
    </html>
  );
}
