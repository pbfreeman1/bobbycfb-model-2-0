'use client';
import { useMemo, useState } from 'react';
import { sbFetch } from '../../../lib/supabase';
import { parseKamText, matchEntries, planTags } from '../../../lib/kam-import';
import { shortTeam } from '../../../lib/team-short';

// "Import KAM ranks": fetch a Kambour page (or paste its text), preview the
// tags that would be created, then save. Rank 1-N becomes KAM #n, the next
// ranks become KAM Topish. Existing KAM tags with the same game+side+type are
// left alone (same rank) or re-ranked.
//
//   games     this week's games
//   tallies   this week's research_picks
//   source    the KAM research_sources row
export default function KamImport({ season, week, games, tallies, source, onDone, inputStyle, labelStyle }) {
  const [kind, setKind] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [numberedThrough, setNumberedThrough] = useState(10);
  const [topishThrough, setTopishThrough] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function load(k) {
    setBusy(true); setError(null); setDone(null); setKind(k); setParsed(null);
    try {
      const res = await fetch(`/api/kam-import?kind=${k}`, { cache: 'no-store' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'Import failed');
      setParsed(j);
    } catch (e) { setError(e.message); setPasteOpen(true); }
    finally { setBusy(false); }
  }
  function usePasted(k) {
    setError(null); setDone(null); setKind(k);
    const p = parseKamText(pasted, k);
    if (!p.entries.length) { setError('Nothing parsed from the pasted text.'); return; }
    setParsed({ ok: true, kind: k, ...p });
  }

  const match = useMemo(() => (parsed ? matchEntries(parsed.entries, games) : null), [parsed, games]);
  const plan = useMemo(() => {
    if (!match || !source) return [];
    const existing = tallies.filter((t) => t.source_id === source.id);
    return planTags(match.matched, existing, { kind, season, week, source, numberedThrough, topishThrough });
  }, [match, tallies, source, kind, season, week, numberedThrough, topishThrough]);

  const counts = useMemo(() => {
    const c = { insert: 0, rerank: 0, same: 0 };
    for (const p of plan) c[p.action]++;
    return c;
  }, [plan]);
  const lowMatch = match && parsed && match.matched.length < Math.min(parsed.entries.length, games.length) * 0.5;

  async function save() {
    setBusy(true); setError(null);
    try {
      const rerank = plan.filter((p) => p.action === 'rerank');
      for (const p of rerank) await sbFetch(`research_picks?id=eq.${p.oldId}`, { method: 'DELETE' });
      // separate POSTs: PostgREST fills keys missing from some rows with NULL, and re-ranked rows carry extra stamp columns
      const fresh = plan.filter((p) => p.action === 'insert').map((p) => p.row);
      const kept = plan.filter((p) => p.action === 'rerank').map((p) => p.row);
      if (fresh.length) await sbFetch('research_picks', { method: 'POST', body: JSON.stringify(fresh) });
      if (kept.length) await sbFetch('research_picks', { method: 'POST', body: JSON.stringify(kept) });
      setDone(`Created ${counts.insert} new, re-ranked ${counts.rerank}, ${counts.same} already correct.`);
      setParsed(null);
      onDone && onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const btn = (primary) => ({
    ...inputStyle, width: 'auto', cursor: 'pointer', padding: '8px 14px',
    background: primary ? '#38bd94' : inputStyle.background, color: primary ? '#06210f' : inputStyle.color, fontWeight: 700,
    border: primary ? 'none' : inputStyle.border,
  });
  const label = (g, side) => (g ? `${shortTeam(side === 'home' ? g.home_team : g.away_team)}` : side);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Import KAM ranks</div>
      <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 12 }}>
        Reads the KAM page (highest probability first) and tags week {week}: rank 1-{numberedThrough} as KAM #n, then through {topishThrough} as KAM Topish. You review the list before anything is saved.
      </div>
      {!source && <div style={{ color: '#e5a64f', fontSize: 13 }}>Add a source named KAM first.</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <button style={btn(false)} disabled={busy || !source} onClick={() => load('ats')}>Import KAM ATS</button>
        <button style={btn(false)} disabled={busy || !source} onClick={() => load('ou')}>Import KAM Totals</button>
        <div><label style={labelStyle}>Numbered through</label><input type="number" min={1} max={50} style={{ ...inputStyle, width: 70 }} value={numberedThrough} onChange={(e) => setNumberedThrough(Math.max(1, +e.target.value || 1))} /></div>
        <div><label style={labelStyle}>Topish through</label><input type="number" min={1} max={50} style={{ ...inputStyle, width: 70 }} value={topishThrough} onChange={(e) => setTopishThrough(Math.max(numberedThrough, +e.target.value || numberedThrough))} /></div>
        <button style={{ ...btn(false), fontWeight: 400 }} onClick={() => setPasteOpen((v) => !v)}>{pasteOpen ? 'Hide paste' : 'Paste page text'}</button>
      </div>

      {pasteOpen && (
        <div style={{ marginTop: 10 }}>
          <textarea style={{ ...inputStyle, width: '100%', height: 110, fontFamily: 'monospace' }} placeholder="Select all on the KAM page, copy, paste here" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button style={btn(false)} onClick={() => usePasted('ats')} disabled={!pasted.trim()}>Parse as ATS</button>
            <button style={btn(false)} onClick={() => usePasted('ou')} disabled={!pasted.trim()}>Parse as Totals</button>
          </div>
        </div>
      )}

      {error && <div className="error-msg" style={{ marginTop: 10 }}>{error}</div>}
      {done && <div style={{ marginTop: 10, color: '#38bd94', fontSize: 13 }}>{done}</div>}

      {parsed && match && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13 }}>
            {kind === 'ou' ? 'Totals' : 'ATS'}: {parsed.entries.length} games on the page, <b>{match.matched.length}</b> matched to week {week}
            {match.unmatched.length ? `, ${match.unmatched.length} not matched` : ''}. To save: <b>{counts.insert}</b> new, <b>{counts.rerank}</b> re-ranked, {counts.same} unchanged.
          </div>
          {lowMatch && <div style={{ color: '#e5a64f', fontSize: 13, marginTop: 4 }}>Few games matched. The KAM page is not dated, so check it is for week {week} (change the week above if not).</div>}
          <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8, fontSize: 12 }}>
            {plan.map((p) => (
              <div key={`${p.game.id}${p.side}`} style={{ display: 'flex', gap: 8, padding: '2px 0', color: p.action === 'same' ? '#5b6272' : '#e6e9ef' }}>
                <span style={{ width: 70, fontWeight: 700 }}>{p.label}</span>
                <span style={{ flex: 1 }}>
                  {kind === 'ou' ? `${p.side === 'over' ? 'Over' : 'Under'} · ${shortTeam(p.game.away_team)} @ ${shortTeam(p.game.home_team)}` : `${label(p.game, p.side)} · ${shortTeam(p.game.away_team)} @ ${shortTeam(p.game.home_team)}`}
                </span>
                <span style={{ color: '#8a92a3' }}>{p.action === 'insert' ? 'new' : p.action === 'rerank' ? `was ${p.from}` : 'same'}</span>
              </div>
            ))}
          </div>
          {match.unmatched.length > 0 && (
            <div style={{ fontSize: 12, color: '#e5a64f', marginTop: 8 }}>
              Not matched (tag these by hand): {match.unmatched.map((u) => `#${u.rank} ${u.teams.join(' / ')} (${u.reason})`).join('; ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={btn(true)} disabled={busy || counts.insert + counts.rerank === 0} onClick={save}>{busy ? 'Saving…' : `Save ${counts.insert + counts.rerank} tags`}</button>
            <button style={{ ...btn(false), fontWeight: 400 }} onClick={() => setParsed(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
