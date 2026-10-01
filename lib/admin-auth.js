// Admin gate for every route that writes.
//
// Two accepted credentials, checked in constant time:
//   1. HTTP Basic, matching ADMIN_USER / ADMIN_PASSWORD. The Ingest pages are
//      ordinary browser pages behind the same gate, so once the browser has
//      prompted once it reattaches the credential to their same-origin fetch()
//      calls automatically. That is why the gate works without putting any
//      secret in client code.
//   2. Authorization: Bearer <CRON_SECRET>, which is what Vercel Cron sends.
//      Nothing is cron-invoked today (there is no vercel.json), but a cron
//      added later should not require this file to change.
//
// FAIL CLOSED. If ADMIN_USER or ADMIN_PASSWORD is missing from the
// environment, every request is denied and the response says why. A write
// route with no configured credential must not be open by default, and a
// silent 500 would be read as a bug rather than as a locked door.
//
// This runs in BOTH the Edge runtime (middleware) and the Node runtime (route
// handlers), so it uses Web Crypto rather than node:crypto — Edge has no
// crypto.timingSafeEqual.

const REALM = 'BobbyModels admin';

export const MISSING_CONFIG =
  'Admin auth is not configured on this deployment: ADMIN_USER and/or ' +
  'ADMIN_PASSWORD is missing. Denying by default rather than allowing writes.';

// Fixed-length XOR compare. Never returns early on a mismatched byte.
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

// Compares the SHA-256 digests rather than the strings. Hashing first makes the
// compared length constant, so neither the secret's length nor the position of
// the first differing character is observable from timing.
export async function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return bytesEqual(ha, hb);
}

function decodeBasic(value) {
  let decoded = '';
  try {
    decoded = typeof atob === 'function'
      ? atob(value)
      : Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // Only the FIRST colon separates user from password; a password may contain
  // colons and splitting on all of them would silently truncate it.
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

// Resolves to { ok: true, via } or { ok: false, status, error, challenge }.
// Takes the Authorization header value so it works with both a Request and a
// NextRequest without caring which.
export async function checkAdminAuth(authorization) {
  const header = authorization || '';
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASSWORD;

  // Fail closed BEFORE looking at the credential. A deployment with no admin
  // password configured denies everything, including a correct CRON_SECRET,
  // so there is exactly one way to be open: configure it deliberately.
  if (!adminUser || !adminPass) {
    return { ok: false, status: 503, error: MISSING_CONFIG, challenge: false };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && header.startsWith('Bearer ')) {
    if (await constantTimeEquals(header.slice(7).trim(), cronSecret)) {
      return { ok: true, via: 'cron' };
    }
  }

  if (header.startsWith('Basic ')) {
    const creds = decodeBasic(header.slice(6).trim());
    if (creds) {
      // Both compared every time, so a wrong username costs the same as a
      // wrong password.
      const [userOk, passOk] = await Promise.all([
        constantTimeEquals(creds.user, adminUser),
        constantTimeEquals(creds.pass, adminPass),
      ]);
      if (userOk && passOk) return { ok: true, via: 'basic' };
    }
  }

  return { ok: false, status: 401, error: 'Unauthorized', challenge: true };
}

// The JSON denial a route handler returns. Carries the Basic challenge so a
// browser hitting an API route directly still gets a prompt.
export function denyResponse(result) {
  const headers = { 'Content-Type': 'application/json' };
  if (result.challenge) headers['WWW-Authenticate'] = `Basic realm="${REALM}", charset="UTF-8"`;
  return new Response(JSON.stringify({ error: result.error }), {
    status: result.status,
    headers,
  });
}

// One call for a route handler to make. Returns null when the request may
// proceed, or the Response to return when it may not.
//
//   const denied = await guard(req);
//   if (denied) return denied;
export async function guard(req) {
  const result = await checkAdminAuth(req.headers.get('authorization'));
  return result.ok ? null : denyResponse(result);
}

export { REALM };
