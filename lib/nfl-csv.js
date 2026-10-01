// predictiontracker NFL CSV parsing, shared by the ingest route and the
// archive loader.
//
// FORMATS. Two shapes, detected from the header rather than declared:
//   spread — system columns named line*, market line in `line`, open in
//            `lineopen`. The current-week file has NO week or date column, so
//            season and week must be supplied by the caller. The archive file
//            has `week`, `rscore`, `hscore` and a capitalised `Home,Road`
//            header with home FIRST.
//   total  — system columns named tot*, market total in `line`, open in
//            `lineopen`, and it always carries `week` and `date`.
//
// CONVENTIONS. `line` and every line* column are home-margin: positive means
// the home team is favoured, the opposite of sportsbook notation. Totals are
// raw combined points and are not home-relative. Neither is transformed here;
// both go into the database exactly as the CSV states them, which is what
// nfl_games.spread_line and nfl_raw_predictions already use.
//
// `date` is a SAS serial: days since 1960-01-01.

export const SAS_EPOCH_MS = Date.UTC(1960, 0, 1);

export function sasDateToISO(serial) {
  const n = parseInt(serial, 10);
  if (!Number.isFinite(n)) return null;
  return new Date(SAS_EPOCH_MS + n * 86400000).toISOString();
}

// Never model inputs. The market line and its open/midweek snapshots, the
// pre-computed aggregates, lineca (~0.999 correlated with the market line), and
// the result/meta columns.
export const NON_MODEL_COLUMNS = new Set([
  'line', 'lineopen', 'linemidweek',
  'lineavg', 'linemedian', 'linemed', 'linestd', 'lineca',
  'totavg', 'totmed', 'totstd', 'min', 'max',
  'road', 'home', 'date', 'week', 'rscore', 'hscore',
  'neutral', 'phcover', 'phwin',
]);

// Minimal RFC4180-ish split: predictiontracker does not quote fields, but a
// stray quote should not shift every column after it.
function splitRow(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('CSV has no data rows.');
  // Headers are lowercased so the archive's `Home,Road` and the current-week
  // file's `home,road` resolve identically.
  const headers = splitRow(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const r = {};
    headers.forEach((h, j) => { r[h] = (cells[j] ?? '').trim(); });
    rows.push(r);
  }
  return { headers, rows };
}

export function detectMarket(headers) {
  const tot = headers.filter((h) => h.startsWith('tot') && !NON_MODEL_COLUMNS.has(h)).length;
  const spr = headers.filter((h) => h.startsWith('line') && !NON_MODEL_COLUMNS.has(h)).length;
  if (tot > spr) return 'total';
  if (spr > 0) return 'spread';
  throw new Error('Could not detect market: no line* or tot* system columns found.');
}

// Column -> model_id, using nfl_source_models.model_key plus csv_aliases. The
// database is the only place the mapping lives; nothing here hardcodes it.
export function buildColumnResolver(modelRows) {
  const byName = new Map();
  for (const m of modelRows) {
    byName.set(m.model_key.toLowerCase(), m);
    for (const a of m.csv_aliases || []) byName.set(String(a).toLowerCase(), m);
  }
  return function resolveColumn(col) {
    const m = byName.get(col.toLowerCase());
    if (!m) return { status: 'unknown' };
    if (m.is_aggregate) return { status: 'aggregate', model: m };
    return { status: 'ok', model: m };
  };
}

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s.toLowerCase() === 'nan' || s === '.') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// One CSV -> matchups plus per-system predictions, with every column accounted
// for. `resolveTeam` maps a CSV team name to the canonical nfl_games spelling.
export function extractGames(parsed, { market, resolveTeam, resolveColumn, defaultWeek }) {
  const { headers, rows } = parsed;
  const modelCols = [];
  const skipped = { aggregate: [], unknown: [], nonModel: [] };

  for (const h of headers) {
    if (NON_MODEL_COLUMNS.has(h)) { skipped.nonModel.push(h); continue; }
    const wantsPrefix = market === 'total' ? 'tot' : 'line';
    if (!h.startsWith(wantsPrefix)) { skipped.nonModel.push(h); continue; }
    const r = resolveColumn(h);
    if (r.status === 'ok') modelCols.push({ col: h, modelId: r.model.id, key: r.model.model_key });
    else if (r.status === 'aggregate') skipped.aggregate.push(h);
    else skipped.unknown.push(h);
  }

  const games = [];
  const unresolvedTeams = [];
  const noWeek = [];

  for (const r of rows) {
    const home = resolveTeam(r.home);
    const away = resolveTeam(r.road);
    if (!home || !away) {
      unresolvedTeams.push(`${r.road} @ ${r.home}`);
      continue;
    }
    let week = r.week !== undefined && r.week !== '' ? parseInt(r.week, 10) : defaultWeek;
    if (!Number.isFinite(week)) {
      // The archive's blank-week rows: kept aside with their predictions so the
      // caller can decide whether the matchup identifies a game unambiguously.
      noWeek.push({ home, away, row: r });
      week = null;
    }

    const preds = [];
    for (const mc of modelCols) {
      const v = num(r[mc.col]);
      if (v === null) continue;
      preds.push({ model_id: mc.modelId, key: mc.key, value: v });
    }

    games.push({
      home, away, week,
      line: num(r.line),
      open: num(r.lineopen),
      midweek: num(r.linemidweek),
      csvDate: r.date ? sasDateToISO(r.date) : null,
      roadScore: num(r.rscore),
      homeScore: num(r.hscore),
      preds,
    });
  }

  return { market, modelCols, skipped, games, unresolvedTeams, noWeek };
}

// Week validation. The current-week spread file carries no week column, so the
// only defence against loading a file against the wrong week is to check its
// matchups against the schedule we already have from ESPN. A silent mismatch
// would attach this week's predictions to last week's games.
export function validateAgainstSchedule(games, scheduleRows, week) {
  const inWeek = new Set();
  const elsewhere = new Map();
  for (const g of scheduleRows) {
    const k = `${g.home_team}|${g.away_team}`;
    if (g.week === week) inWeek.add(k);
    else elsewhere.set(k, g.week);
  }
  const matched = [];
  const wrongWeek = [];
  const notScheduled = [];
  for (const g of games) {
    const k = `${g.home}|${g.away}`;
    if (inWeek.has(k)) matched.push(g);
    else if (elsewhere.has(k)) wrongWeek.push({ matchup: `${g.away} @ ${g.home}`, scheduled_week: elsewhere.get(k) });
    else notScheduled.push(`${g.away} @ ${g.home}`);
  }
  const missingFromCsv = [...inWeek]
    .filter((k) => !games.some((g) => `${g.home}|${g.away}` === k))
    .map((k) => { const [h, a] = k.split('|'); return `${a} @ ${h}`; });

  return {
    matched, wrongWeek, notScheduled, missingFromCsv,
    ok: wrongWeek.length === 0 && notScheduled.length === 0,
  };
}
