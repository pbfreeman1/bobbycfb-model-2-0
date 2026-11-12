// Source list helpers for research tags. Pure functions (no I/O) so they can be
// unit tested; the page/components do the fetching.
//
// A tag's source is a row in research_sources (picked from a dropdown), plus
// an optional KAM rank / conviction. The DB trigger research_picks_before_insert
// derives conviction from rank and rebuilds source_label, so the label is
// always consistent ("KAM #2", "KAM Top", "VSIN").

export const KAM_TOP_MAX = 5;      // rank 1-5  => 'top'
export const KAM_TOPISH_MAX = 15;  // rank 6-15 => 'topish'

export function sortSources(list) {
  return [...(list || [])]
    .filter((s) => s.active !== false)
    .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || String(a.name).localeCompare(String(b.name)));
}

export function cleanSourceName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

// Case/whitespace-insensitive match, mirroring the unique index on
// lower(btrim(name)).
export function findSource(list, name) {
  const k = cleanSourceName(name).toLowerCase();
  if (!k) return null;
  return (list || []).find((s) => cleanSourceName(s.name).toLowerCase() === k) || null;
}

export function convictionForRank(rank) {
  if (!Number.isInteger(rank) || rank < 1) return null;
  if (rank <= KAM_TOP_MAX) return 'top';
  if (rank <= KAM_TOPISH_MAX) return 'topish';
  return null;
}

// Same text the DB function research_display_label produces.
export function displayLabel(name, rank, conviction) {
  if (!name) return null;
  if (Number.isInteger(rank)) return `${name} #${rank}`;
  if (conviction === 'top') return `${name} Top`;
  if (conviction === 'topish') return `${name} Topish`;
  return name;
}

// Validates and normalises the rank-related inputs for one source.
// Returns { rank, conviction, error }.
export function resolveRankInput(source, { rank, conviction } = {}) {
  if (!source?.uses_rank) return { rank: null, conviction: null, error: null };
  const r = rank === '' || rank == null ? null : parseInt(rank, 10);
  if (r != null && (!Number.isInteger(r) || r < 1 || r > 50)) return { rank: null, conviction: null, error: 'Rank must be 1-50.' };
  if (r != null) return { rank: r, conviction: convictionForRank(r), error: null };
  if (conviction === 'top' || conviction === 'topish') return { rank: null, conviction, error: null };
  return { rank: null, conviction: null, error: null };
}

// Row to POST to research_picks. source_label / conviction are recomputed by
// the DB trigger, but we send them too so the optimistic UI row matches.
export function buildTagPayload({ game, season, week, pickType, pickSide, source, rank, conviction, note }) {
  const rk = resolveRankInput(source, { rank, conviction });
  if (rk.error) throw new Error(rk.error);
  const customText = pickType === 'custom' ? (note || '').trim() : null;
  return {
    season, week,
    game_id: game.id,
    home_team: game.home_team,
    away_team: game.away_team,
    pick_type: pickType,
    pick_side: pickType === 'custom' ? null : pickSide,
    source_id: source?.id || null,
    rank: rk.rank,
    conviction: rk.conviction,
    source_label: source ? displayLabel(source.name, rk.rank, rk.conviction) : null,
    note: (note || '').trim() || customText || null,
  };
}
