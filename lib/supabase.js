export const SUPABASE_URL = 'https://zpmdrazbqgzheqkvfltv.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag';

export function sbHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

export async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: sbHeaders(),
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return res.json();
}

// Formatting helpers shared across pages
export function fmt(n, digits = 1) {
  if (n === null || n === undefined) return '—';
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  return num.toFixed(digits);
}

export function fmtLine(n) {
  if (n === null || n === undefined) return '—';
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  return num > 0 ? `+${num.toFixed(1)}` : num.toFixed(1);
}

export function fmtKickoff(iso, tbd) {
  if (!iso || tbd) return 'TBD';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }) + ' ET';
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const CONFIDENCE_ORDER = ['Very Strong', 'Strong', 'Moderate', 'Weak', 'Very Weak'];

export const CONF_BADGE_CLASS = {
  'Very Strong': 'badge-vs',
  'Strong': 'badge-s',
  'Moderate': 'badge-m',
  'Weak': 'badge-w',
  'Very Weak': 'badge-vw',
};

export const GLOBAL_STYLE = `
  *, *::before, *::after { box-sizing: border-box; }
  html { font-size: 15px; }
  body {
    margin: 0;
    background: #0b0e14;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #38bd94; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Badges */
  .badge { padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; background: #232838; color: #b8bfcc; white-space: nowrap; }
  .badge-vs { background: rgba(56,189,148,.2); color: #38bd94; }
  .badge-s  { background: rgba(56,189,148,.12); color: #38bd94; }
  .badge-m  { background: rgba(250,204,21,.15); color: #facc15; }
  .badge-w  { background: rgba(148,163,184,.14); color: #94a3b8; }
  .badge-vw { background: rgba(148,163,184,.07); color: #6b7280; }

  .play-badge { background: rgba(56,189,148,.15); color: #38bd94; padding: 3px 9px; border-radius: 6px; font-weight: 700; font-size: 12px; white-space: nowrap; }
  .lock-badge { background: rgba(251,191,36,.2); color: #fbbf24; padding: 3px 9px; border-radius: 6px; font-weight: 700; font-size: 12px; }

  /* Nav */
  nav { background: #0f1219; border-bottom: 1px solid #1e2535; padding: 0 20px; display: flex; align-items: center; gap: 4px; }
  nav a, nav .nav-logo { display: flex; align-items: center; padding: 14px 12px; font-size: 13px; font-weight: 600; color: #8a92a3; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; }
  nav .nav-logo { color: #e6e9ef; font-size: 16px; font-weight: 800; padding-right: 20px; border-right: 1px solid #1e2535; margin-right: 8px; border-bottom: none; letter-spacing: -0.3px; }
  nav .nav-logo span { color: #38bd94; }
  nav a:hover { color: #e6e9ef; text-decoration: none; }
  nav a.active { color: #e6e9ef; border-bottom-color: #38bd94; }

  /* Page container */
  .page { max-width: 1440px; margin: 0 auto; padding: 28px 20px 60px; }
  .page-header { margin-bottom: 24px; }
  .page-header h1 { font-size: 24px; font-weight: 800; margin: 0 0 4px; letter-spacing: -0.3px; }
  .page-header p { color: #8a92a3; font-size: 13px; margin: 0; }

  /* Cards */
  .card { background: #131722; border: 1px solid #1e2535; border-radius: 12px; padding: 20px; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: opacity .15s; }
  .btn:hover { opacity: .85; }
  .btn-primary { background: #38bd94; color: #0b0e14; }
  .btn-outline { background: transparent; color: #8a92a3; border: 1px solid #2a3042; }
  .btn-outline:hover { color: #e6e9ef; border-color: #8a92a3; opacity: 1; }
  .btn-danger { background: rgba(239,68,68,.15); color: #f87171; border: 1px solid rgba(239,68,68,.3); }
  .btn-lock { background: rgba(251,191,36,.15); color: #fbbf24; border: 1px solid rgba(251,191,36,.3); }

  /* Status */
  .loading, .empty { padding: 48px; text-align: center; color: #5b6272; }
  .error-msg { padding: 16px; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3); border-radius: 8px; color: #f87171; margin-bottom: 16px; }

  /* Table base */
  .tbl-wrap { overflow-x: auto; border: 1px solid #1e2535; border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; white-space: nowrap; }
  thead th { text-align: left; padding: 10px 14px; background: #0f1219; border-bottom: 1px solid #1e2535; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5b6272; }
  thead th.sortable { cursor: pointer; user-select: none; }
  thead th.sortable:hover { color: #b8bfcc; }
  tbody td { padding: 10px 14px; border-bottom: 1px solid #131722; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: #131722; }
  tr.is-play > td { background: rgba(56,189,148,.05); }
  tr.is-play:hover > td { background: rgba(56,189,148,.1); }
  tr.is-lock > td { background: rgba(251,191,36,.05); }
  tr.is-lock:hover > td { background: rgba(251,191,36,.1); }

  /* Sticky columns */
  .sticky-col { position: sticky; left: 0; z-index: 2; background: inherit; }
  .sticky-col-2 { position: sticky; left: 44px; z-index: 2; background: inherit; }

  /* Info icon */
  .info-wrap { position: relative; display: inline-flex; align-items: center; }
  .info-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background: #232838; color: #8a92a3; font-size: 9px; font-style: italic; font-weight: 700; cursor: help; margin-left: 4px; flex-shrink: 0; }
  .info-icon:hover { background: #38bd94; color: #0b0e14; }
  .tooltip-box { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); width: 230px; background: #1a1e2b; border: 1px solid #2a3042; color: #d3d8e2; font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: normal; line-height: 1.55; padding: 9px 11px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,.5); z-index: 30; white-space: normal; }

  /* Mobile */
  @media (max-width: 768px) {
    .page { padding: 16px 12px 60px; }
    nav { padding: 0 12px; gap: 0; overflow-x: auto; }
    nav a, nav .nav-logo { padding: 12px 10px; font-size: 12px; }
    nav .nav-logo { font-size: 14px; padding-right: 14px; margin-right: 4px; }
  }
`;
