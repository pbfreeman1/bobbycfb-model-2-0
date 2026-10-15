// predictiontracker COLLEGE CSV -> the p_rows payload cfb_ingest_predictions
// takes. Shared by the daily cron (app/api/cron/pt-ingest) and available to the
// manual Ingest fallback.
//
// DIVISION OF LABOUR. Nothing here matches teams, resolves model columns or
// decides what counts as a usable number. The database does all three:
// cfb_team_key matches on team names, cfb_header_alias renames legacy headers,
// source_models decides which columns are written, and non-numeric cells are
// ignored there. So this file sends the RAW predictiontracker header names
// through untranslated — renaming a column here would defeat the alias table.
//
// CONVENTION. `line` and every line* column are home-margin: positive means the
// home team is favoured, the opposite of sportsbook notation. Not transformed
// here; the database stores what the CSV states, same as the NFL path.

import { parseCsv } from './nfl-csv.js';

export { parseCsv };

// line*-prefixed columns that are NOT a system's prediction.
//
// `line` is the market line itself and `lineopen` its opening snapshot;
// `linemidweek` is a mid-week market snapshot. `lineavg`, `linemedian`,
// `linestd` and `linecons` are predictiontracker's own aggregates over the
// other columns, so feeding them in would double-count every system. `lineca`
// tracks the market line at ~0.999 correlation, which would swamp the
// consensus with the number the model is trying to beat.
//
// `line` is not in the caller-facing omit list in the spec, but it is excluded
// for the same reason the existing upload-predictions and nfl-csv paths exclude
// it: it is Vegas, not a model. Sending it would auto-register a bogus system.
export const NON_MODEL_LINE_COLUMNS = new Set([
  'line', 'lineopen', 'linemidweek',
  'lineavg', 'linemedian', 'linestd', 'linecons', 'lineca',
]);

// Columns carrying neither a prediction nor a team: kept out of `preds` without
// being reported as skipped models.
const META_COLUMNS = new Set(['road', 'home', 'neutral', 'phcover', 'phwin']);

// A cell is a prediction only if it parses as a finite number. predictiontracker
// leaves a system's cell EMPTY when it has not posted yet (verified against the
// live file: 596 empty cells, zero "." and zero "nan"). The database ignores
// non-numeric cells anyway, so dropping them here is only a payload saving —
// but the per-column blank census it yields is what tells you a system is late
// rather than broken.
function numeric(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '.' || s.toLowerCase() === 'nan') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Every line*-prefixed header that is a system prediction, in file order.
export function modelColumns(headers) {
  return headers.filter((h) => h.startsWith('line') && !NON_MODEL_LINE_COLUMNS.has(h));
}

// Builds the cfb_ingest_predictions payload.
//
//   { rows, modelCols, blankByColumn, emptyRows, valuesSent }
//
// `rows` is [{ home, road, preds: { <raw header>: <number> } }], home and road
// exactly as the CSV spells them so the SQL matcher sees what it expects.
export function buildIngestRows(parsed) {
  const { headers, rows: csvRows } = parsed;
  const modelCols = modelColumns(headers);

  const blankByColumn = Object.fromEntries(modelCols.map((c) => [c, 0]));
  const rows = [];
  let emptyRows = 0;
  let valuesSent = 0;

  for (const r of csvRows) {
    const home = (r.home ?? '').trim();
    const road = (r.road ?? '').trim();
    // A row with no matchup cannot be matched to a game; PT sometimes leaves a
    // trailing partial line.
    if (!home || !road) continue;

    const preds = {};
    for (const col of modelCols) {
      const n = numeric(r[col]);
      if (n === null) { blankByColumn[col]++; continue; }
      preds[col] = n;
      valuesSent++;
    }

    if (Object.keys(preds).length === 0) { emptyRows++; continue; }
    rows.push({ home, road, preds });
  }

  return { rows, modelCols, blankByColumn, emptyRows, valuesSent };
}

// Columns that posted nothing at all in this pull. Expected early in the week —
// Dokter, Newbury, FEI, Pig and L2 have all been blank on Thursdays — so this
// is reported, never treated as an error.
export function blankColumns(blankByColumn, rowCount) {
  return Object.keys(blankByColumn).filter((c) => blankByColumn[c] >= rowCount);
}

// Structural checks on the fetched file, BEFORE anything touches the database.
// A truncated or reshaped file that still parses is the dangerous case: it would
// quietly ingest a handful of systems and recompute the week off them. Returns
// an array of reasons; empty means the file is usable.
export function validateFile(parsed, { minModelColumns = 20 } = {}) {
  const problems = [];
  const { headers, rows } = parsed;

  if (!headers.includes('home') || !headers.includes('road')) {
    problems.push(`missing Home/Road columns (found: ${headers.slice(0, 8).join(', ')}…)`);
  }
  if (!rows.length) problems.push('zero data rows');

  const cols = modelColumns(headers);
  if (cols.length < minModelColumns) {
    problems.push(`only ${cols.length} line* model columns, expected at least ${minModelColumns}`);
  }
  return problems;
}

export const EXPECTED_META = META_COLUMNS;
