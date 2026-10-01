import { NextResponse } from 'next/server';
import { checkAdminAuth, REALM } from './lib/admin-auth';

// Gates the admin surface: both Ingest pages and every /api route.
//
// WHY BASIC. The Ingest pages call the write routes with a plain same-origin
// fetch() from the browser. Any header-based secret would have to be in the
// client bundle to do that, which would publish it. Basic Auth moves the
// credential into the browser's own credential store: it prompts once on the
// page, then reattaches the header to the page's fetch() calls by itself. No
// secret reaches the bundle and neither Ingest page needed changing.
//
// This is the outer door. Every write route ALSO calls guard() from
// lib/admin-auth, so a route stays closed even if this matcher is later edited
// or a route is reached by a path this does not cover.
//
// READS ARE UNAFFECTED. The dashboards read Supabase REST directly from the
// browser with the anon key; that traffic never passes through /api, so none of
// it is gated. Public pages are not in the matcher.
export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Defensive: the matcher below never sends these here, but if it is ever
  // broadened, framework assets must not end up behind a password prompt.
  if (
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml'
  ) {
    return NextResponse.next();
  }

  const result = await checkAdminAuth(req.headers.get('authorization'));
  if (result.ok) return NextResponse.next();

  const headers = { 'Content-Type': 'application/json' };
  if (result.challenge) {
    // Without this the browser shows the error instead of prompting.
    headers['WWW-Authenticate'] = `Basic realm="${REALM}", charset="UTF-8"`;
  }
  return new NextResponse(JSON.stringify({ error: result.error }), {
    status: result.status,
    headers,
  });
}

// An allowlist, so anything not named here is untouched. That already excludes
// /_next, static assets and every public page, rather than relying on a
// negative pattern that has to be kept correct as routes are added.
export const config = {
  matcher: ['/api/:path*', '/cfb/ingest', '/nfl/ingest'],
};
