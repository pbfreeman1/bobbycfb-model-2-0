// Fetching and validating predictiontracker's live NCAA CSV, shared by
// app/api/cron/pt-ingest (manual + ?dry=1) and app/api/cron/cfb-daily.
//
// Parsing and the column policy live in lib/pt-cfb-csv.js; this is the network
// and sanity-check half.

import { createClient } from '@supabase/supabase-js';
import { parseCsv, buildIngestRows, blankColumns, validateFile } from './pt-cfb-csv.js';
import { SUPABASE_URL } from './supabase.js';

export const PT_URL = 'https://www.thepredictiontracker.com/ncaapredictions.csv';
export const FETCH_TIMEOUT_MS = 20_000;

// An HONEST, non-browser User-Agent, and that is deliberate — the opposite of
// the usual advice.
//
// thepredictiontracker.com sits behind Cloudflare bot management. Claiming to
// be Chrome from a server makes things WORSE: Cloudflare compares the claimed
// browser against the connection's TLS fingerprint and header order, Node's do
// not look like Chrome's, and the mismatch is served a "Just a moment..." JS
// challenge as HTTP 403. Verified against the live site: a full Chrome/Safari
// UA returned 403 with a challenge page, while curl's UA, python-requests' UA,
// no UA at all and the string below all returned the real 20KB CSV (6/6
// consecutive 200s).
//
// So identify the client truthfully, which is also what lets the site's owner
// see who is pulling the file once a day and ask us to stop.
export const USER_AGENT = 'bobbycfb-model/2.0 (+https://github.com/pbfreeman1/bobbycfb-model-2-0)';

// Carries the HTTP status the caller should answer with, so a cron step can
// report a failure without inventing its own mapping.
export class PtError extends Error {
  constructor(message, status = 502, context = {}) {
    super(message);
    this.name = 'PtError';
    this.status = status;
    this.context = context;
  }
}

// Fetches the CSV. Throws PtError on timeout, transport failure or non-200.
export async function fetchPtCsv() {
  let res;
  try {
    res = await fetch(PT_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    // A timeout or DNS failure is upstream, not a bug here.
    const why = e?.name === 'TimeoutError' ? `no response in ${FETCH_TIMEOUT_MS}ms` : String(e?.message || e);
    throw new PtError(`Could not fetch ${PT_URL}: ${why}`, 502);
  }

  if (!res.ok) {
    // Name the Cloudflare challenge when that is what came back, so a future
    // 403 is not mistaken for the file having moved. If this starts firing from
    // Vercel's IPs while a local run still works, it is bot management on the
    // egress address, not a bug in this code.
    const body = await res.text().catch(() => '');
    const challenged =
      res.status === 403 && /Just a moment|cf-browser-verification|challenge-platform/i.test(body);
    throw new PtError(
      challenged
        ? 'predictiontracker returned 403 with a Cloudflare bot challenge. Do NOT answer this by sending a browser User-Agent — a browser UA from a server is what triggers it. See the USER_AGENT note in lib/pt-fetch.js.'
        : `predictiontracker returned ${res.status} ${res.statusText}`,
      502
    );
  }

  return res.text();
}

// Parses and sanity-checks the CSV, then builds the cfb_ingest_predictions
// payload. Throws PtError when the file is unusable, so nothing reaches the
// database on a bad file.
//
// A truncated or reshaped file that still parses is the case these checks exist
// for: ingesting a handful of systems and recomputing the week off them would
// otherwise look like a normal run.
export function buildPtPayload(text) {
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (e) {
    throw new PtError(`Could not parse the predictiontracker CSV: ${String(e?.message || e)}`, 502, {
      bytes: text.length,
    });
  }

  const problems = validateFile(parsed);
  if (problems.length) {
    throw new PtError(
      `predictiontracker CSV failed its sanity checks: ${problems.join('; ')}. Nothing was written.`,
      502,
      { bytes: text.length, headers: parsed.headers }
    );
  }

  const built = buildIngestRows(parsed);
  if (!built.rows.length) {
    throw new PtError(
      'No usable rows after parsing: every row was missing Home/Road or had no numeric prediction. Nothing was written.',
      502,
      { bytes: text.length }
    );
  }

  const report = {
    source: PT_URL,
    bytes: text.length,
    csv_rows: parsed.rows.length,
    rows_built: built.rows.length,
    model_columns: built.modelCols.length,
    values_sent: built.valuesSent,
    rows_without_predictions: built.emptyRows,
    // Systems that posted nothing in this pull. Normal early in the week
    // (Dokter, Newbury, FEI, Pig and L2 are routinely blank on Thursdays), so
    // it is reported rather than treated as a failure.
    columns_blank_this_pull: blankColumns(built.blankByColumn, built.rows.length),
  };

  return { parsed, built, report };
}

// The season a date belongs to: a season is named for the calendar year it
// starts in, so January–June belongs to the previous year's season.
export function resolveSeason(override) {
  const explicit = override ?? process.env.PT_SEASON;
  if (explicit) {
    const n = parseInt(explicit, 10);
    return Number.isInteger(n) ? n : NaN;
  }
  const now = new Date();
  return now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export function serviceClient() {
  // NEXT_PUBLIC_SUPABASE_URL is set in Vercel but may be absent from
  // .env.local, where only the service-role key lives. Falling back to the
  // project URL the rest of the app already imports keeps a local run working.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. The CFB RPCs are service_role only.');
  return createClient(url, key, { auth: { persistSession: false } });
}

// Anything needing a human: a matchup the SQL matcher could not place, or a
// column predictiontracker added that is now sitting in source_models at status
// 'verify' and contributing nothing until reviewed. Logged as one console.error
// line so it stands out in Vercel's runtime log.
export function alertOnAttention({ season, unmatched = [], newColumns = [], blank = [] }) {
  const notes = [];
  if (unmatched.length) {
    notes.push(
      `${unmatched.length} unmatched game(s): ${JSON.stringify(unmatched)}. ` +
      'Fix with: insert into cfb_team_alias(norm_key, team) ' +
      "values (cfb_norm_team('PT Name'), 'exact games.home_team value') " +
      'on conflict (norm_key) do update set team = excluded.team;'
    );
  }
  if (newColumns.length) {
    notes.push(
      `${newColumns.length} new column(s) auto-registered at status 'verify' ` +
      `(no weight until reviewed): ${newColumns.join(', ')}.`
    );
  }
  if (notes.length) console.error(`[cfb-cron ${season}] NEEDS ATTENTION — ${notes.join(' | ')}`);
  if (blank.length) {
    console.warn(`[cfb-cron ${season}] ${blank.length} system(s) posted nothing this pull: ${blank.join(', ')}`);
  }
}
