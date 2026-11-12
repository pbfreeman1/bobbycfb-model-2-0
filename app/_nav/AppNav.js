'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { SPORTS, NAV_BY_SPORT } from './nav-config';

const ICONS = {
  board: <><rect x="4" y="4" width="16" height="4" rx="1" /><rect x="4" y="10" width="16" height="4" rx="1" /><rect x="4" y="16" width="16" height="4" rx="1" /></>,
  card: <path d="M6 4h12v17l-6-4-6 4z" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></>,
  results: <path d="M5 20V10M12 20V4M19 20v-7" />,
};

function Icon({ name }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export default function AppNav() {
  const path = usePathname() || '';
  const sport = SPORTS.find((s) => path === s.prefix || path.startsWith(s.prefix + '/')) || null;
  const cfg = sport ? NAV_BY_SPORT[sport.key] : null;
  const isActive = (href) => path === href || path.startsWith(href + '/');
  const activeTab = cfg ? cfg.tabs.find((t) => t.pages.some((p) => isActive(p.href))) : null;
  const inMore = cfg ? cfg.more.some((g) => g.items.some((i) => isActive(i.href))) : false;

  // Close any open dropdown when the user taps somewhere else.
  useEffect(() => {
    const onDown = (e) => {
      document.querySelectorAll('details.bm-dd[open]').forEach((d) => {
        if (!d.contains(e.target)) d.removeAttribute('open');
      });
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  return (
    <>
      <header className="bm-top">
        <div className="bm-row1">
          <a href="/" className="bm-logo">Bobby<span>Models</span></a>

          {sport && (
            <div className="bm-sports bm-desktop" role="group" aria-label="Sport">
              {SPORTS.map((s) => (
                <a key={s.key} href={s.home} className={s.key === sport.key ? 'on' : ''} aria-current={s.key === sport.key ? 'true' : undefined}>{s.label}</a>
              ))}
            </div>
          )}

          {sport && (
            <details className="bm-dd bm-sportchip bm-mobile">
              <summary aria-label="Switch sport">{sport.label} <span aria-hidden="true">▾</span></summary>
              <div className="bm-menu">
                {SPORTS.map((s) => (
                  <a key={s.key} href={s.home} className={s.key === sport.key ? 'on' : ''}>
                    <b>{s.label}</b><span>{s.name}</span>
                  </a>
                ))}
              </div>
            </details>
          )}

          <div className="bm-spacer" />

          {cfg && (
            <details className="bm-dd bm-more">
              <summary aria-label="More pages" className={inMore ? 'on' : ''}>⋯</summary>
              <div className="bm-menu bm-menu-right">
                {cfg.more.map((g) => (
                  <div key={g.group}>
                    <div className="bm-group">{g.group}</div>
                    {g.items.map((i) => (
                      <a key={i.href} href={i.href} className={isActive(i.href) ? 'on' : ''}>{i.label}</a>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {cfg && (
          <div className="bm-tabs bm-desktop" role="navigation" aria-label="Sections">
            {cfg.tabs.map((t) => (
              <a key={t.key} href={t.pages[0].href} className={activeTab && activeTab.key === t.key ? 'on' : ''} aria-current={activeTab && activeTab.key === t.key ? 'page' : undefined}>{t.label}</a>
            ))}
          </div>
        )}

        {cfg && activeTab && activeTab.pages.length > 1 && (
          <div className="bm-sub" role="navigation" aria-label={`${activeTab.label} pages`}>
            {activeTab.pages.map((p) => (
              <a key={p.href} href={p.href} className={isActive(p.href) ? 'on' : ''} aria-current={isActive(p.href) ? 'page' : undefined}>{p.label}</a>
            ))}
          </div>
        )}
      </header>

      {cfg && (
        <div className="bm-bottom bm-mobile" role="navigation" aria-label="Primary">
          {cfg.tabs.map((t) => (
            <a key={t.key} href={t.pages[0].href} className={activeTab && activeTab.key === t.key ? 'on' : ''} aria-current={activeTab && activeTab.key === t.key ? 'page' : undefined}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

export const NAV_CSS = `
  .bm-top { background: #0f1219; border-bottom: 1px solid #1e2535; }
  .bm-row1 { display: flex; align-items: center; gap: 14px; height: 56px; padding: 0 20px; }
  .bm-spacer { flex: 1; }
  .bm-logo { font-family: 'Space Grotesk', 'Inter', sans-serif; font-size: 19px; font-weight: 700; letter-spacing: -0.02em; color: #e6e9ef; text-decoration: none; }
  .bm-logo span { color: #38bd94; }
  .bm-logo:hover { text-decoration: none; }

  .bm-sports { display: inline-flex; border: 1px solid #1e2535; border-radius: 8px; overflow: hidden; }
  .bm-sports a { padding: 7px 16px; font-size: 13px; font-weight: 700; color: #b8bfcc; background: #131722; border-left: 1px solid #1e2535; }
  .bm-sports a:first-child { border-left: 0; }
  .bm-sports a:hover { text-decoration: none; color: #e6e9ef; }
  .bm-sports a.on { background: #38bd94; color: #0b0e14; }

  .bm-tabs { display: flex; gap: 6px; padding: 0 20px; border-top: 1px solid #1e2535; }
  .bm-tabs a { padding: 12px 14px; font-size: 14px; font-weight: 600; color: #8a92a3; border-bottom: 2px solid transparent; }
  .bm-tabs a:hover { color: #e6e9ef; text-decoration: none; }
  .bm-tabs a.on { color: #e6e9ef; border-bottom-color: #38bd94; }

  .bm-sub { display: flex; gap: 8px; padding: 10px 20px; border-top: 1px solid #1e2535; background: #0b0e14; overflow-x: auto; white-space: nowrap; }
  .bm-sub a { padding: 7px 14px; border-radius: 18px; border: 1px solid #1e2535; font-size: 13px; font-weight: 600; color: #8a92a3; flex: none; }
  .bm-sub a:hover { color: #e6e9ef; text-decoration: none; }
  .bm-sub a.on { color: #38bd94; border-color: #38bd94; background: rgba(56,189,148,.1); }

  /* Dropdowns (sport chip on mobile, More menu everywhere) */
  details.bm-dd { position: relative; }
  details.bm-dd > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; min-width: 40px; padding: 0 12px; border: 1px solid #1e2535; border-radius: 8px; background: #131722; color: #e6e9ef; font-size: 14px; font-weight: 700; user-select: none; }
  details.bm-dd > summary::-webkit-details-marker { display: none; }
  details.bm-more > summary { font-size: 20px; line-height: 1; padding: 0 12px 4px; }
  details.bm-dd > summary.on { color: #38bd94; border-color: #38bd94; }
  details.bm-sportchip > summary { color: #38bd94; border-color: #38bd94; }
  .bm-menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 220px; z-index: 200; background: #131722; border: 1px solid #2a3042; border-radius: 10px; padding: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.55); }
  .bm-menu-right { left: auto; right: 0; }
  .bm-menu a { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: #d3d8e2; }
  .bm-menu a span { font-size: 12px; font-weight: 400; color: #8a92a3; }
  .bm-menu a:hover { background: #1a1e2b; text-decoration: none; }
  .bm-menu a.on { color: #38bd94; }
  .bm-group { padding: 10px 12px 4px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #5b6272; }

  .bm-mobile { display: none; }

  .bm-bottom { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; background: #0f1219; border-top: 1px solid #1e2535; padding-bottom: env(safe-area-inset-bottom); }
  .bm-bottom a { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-height: 60px; font-size: 11px; font-weight: 600; color: #8a92a3; }
  .bm-bottom a:hover { text-decoration: none; }
  .bm-bottom a.on { color: #38bd94; }

  @media (max-width: 768px) {
    .bm-desktop { display: none !important; }
    .bm-mobile { display: block; }
    .bm-bottom.bm-mobile { display: flex; }
    .bm-row1 { height: 52px; padding: 0 12px; gap: 10px; }
    .bm-logo { font-size: 16px; }
    .bm-sub { padding: 8px 12px; border-top: 0; }
    .bm-menu { position: fixed; left: 12px; right: 12px; top: 56px; min-width: 0; }
    body { padding-bottom: calc(64px + env(safe-area-inset-bottom)); }
  }

  @media print { .bm-top, .bm-bottom { display: none !important; } }
`;
