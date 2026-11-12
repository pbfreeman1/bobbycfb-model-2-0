'use client';
import { useEffect, useMemo, useState } from 'react';
import { sbFetch } from '../../../lib/supabase';
import { planArticleTags } from '../../../lib/article-import';
import { shortTeam } from '../../../lib/team-short';
import { fmtSigned } from '../../../lib/research-report';

// "Import from article": pick the source, paste the article URL (or its text),
// preview the picks Claude found, then save them as tags for that source.
//   games / tallies  this week's games and research_picks rows
//   sources          preset research sources
export default function ArticleImport({ season, week, games, tallies, sources, onDone, inputStyle, labelStyle }) {
  const [sourceId, setSourceId] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [needPass, setNeedPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [result, setResult] = useState(null);
  const [off, setOff] = useState({}); // unchecked rows

  const source = sources.find((s) => s.id === sourceId) || null;
  const gameById = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);

  useEffect(() => { try { setPasscode(localStorage.getItem('import.passcode') || ''); } catch {} }, []);
  useEffect(() => {
    try { setUrl(source ? localStorage.getItem(`import.url.${source.id}`) || '' : ''); } catch {}
  }, [sourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function read() {
    if (!source) { setError('Pick a source first.'); return; }
    setBusy(true); setError(null); setDone(null); setResult(null); setOff({});
    try {
      try { if (url) localStorage.setItem(`import.url.${source.id}`, url); localStorage.setItem('import.passcode', passcode); } catch {}
      const res = await fetch('/api/article-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-import-passcode': passcode },
        body: JSON.stringify({ season, week, sourceName: source.name, ...(pasteOpen && text.trim() ? { text } : { url }) }),
      });
      const j = await res.json();
      if (res.status === 401) setNeedPass(true);
      if (!j.ok) throw new Error(j.error || 'Import failed');
      setResult(j);
    } catch (e) { setError(e.message); if (!pasteOpen) setPasteOpen(true); }
    finally { setBusy(false); }
  }

  const plan = useMemo(() => {
    if (!result || !source) return [];
    const picks = result.picks.map((p) => ({ ...p, game: gameById.get(p.game_id) })).filter((p) => p.game).map((p) => ({ game: p.game, type: p.type, side: p.side, line: p.line, experts: p.experts, expert: (p.experts || [])[0] || '', text: p.text }));
    return planArticleTags(picks, tallies, { season, week, source });
  }, [result, source, tallies, gameById, season, week]);

  const toSave = plan.filter((p, i) => p.action === 'insert' && !off[i]);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (toSave.length) await sbFetch('research_picks', { method: 'POST', body: JSON.stringify(toSave.map((p) => p.row)) });
      setDone(`Saved ${toSave.length} ${source.name} tags.`);
      setResult(null);
      onDone && onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const btn = (primary) => ({
    ...inputStyle, width: 'auto', cursor: 'pointer', padding: '8px 14px',
    background: primary ? '#38bd94' : inputStyle.background, color: primary ? '#06210f' : inputStyle.color, fontWeight: 700,
    border: primary ? 'none' : inputStyle.border,
  });
  const desc = (p) => {
    const g = p.game;
    const matchup = `${shortTeam(g.away_team)} @ ${shortTeam(g.home_team)}`;
    if (p.type === 'total') return `${p.side === 'over' ? 'Over' : 'Under'} ${p.line ?? ''} · ${matchup}`;
    const sp = p.line != null ? ` ${fmtSigned(p.line)}` : '';
    return `${shortTeam(p.side === 'home' ? g.home_team : g.away_team)}${sp} · ${matchup}`;
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Import from an article</div>
      <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 12 }}>
        Pick the source, paste the article link, and Claude reads out the spread and total picks for week {week}. Moneylines, team totals, halves and props are listed but not tagged. Review, then save.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 170 }}>
          <label style={labelStyle}>Source</label>
          <select style={{ ...inputStyle, width: '100%' }} value={sourceId} onChange={(e) => { setSourceId(e.target.value); setResult(null); }}>
            <option value="">— Pick source —</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label style={labelStyle}>Article URL</label>
          <input style={{ ...inputStyle, width: '100%' }} placeholder="https://www.espn.com/…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        {needPass && (
          <div><label style={labelStyle}>Passcode</label><input type="password" style={{ ...inputStyle, width: 120 }} value={passcode} onChange={(e) => setPasscode(e.target.value)} /></div>
        )}
        <button style={btn(true)} disabled={busy || !source || (!url.trim() && !text.trim())} onClick={read}>{busy && !result ? 'Reading…' : 'Read article'}</button>
        <button style={{ ...btn(false), fontWeight: 400 }} onClick={() => setPasteOpen((v) => !v)}>{pasteOpen ? 'Hide paste' : 'Paste article text'}</button>
      </div>
      {pasteOpen && (
        <textarea style={{ ...inputStyle, width: '100%', height: 110, marginTop: 8 }} placeholder="Select all on the article page, copy, paste here (used instead of the URL when filled)" value={text} onChange={(e) => setText(e.target.value)} />
      )}

      {error && <div className="error-msg" style={{ marginTop: 10 }}>{error}</div>}
      {done && <div style={{ marginTop: 10, color: '#38bd94', fontSize: 13 }}>{done}</div>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13 }}>
            Found <b>{plan.length}</b> spread/total picks: <b>{plan.filter((p) => p.action === 'insert').length}</b> new, {plan.filter((p) => p.action === 'same').length} already tagged by {source.name}. {result.truncated ? 'Long article: only the first part was read. ' : ''}
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 8, fontSize: 12 }}>
            {plan.map((p, i) => (
              <label key={i} style={{ display: 'flex', gap: 8, padding: '2px 0', alignItems: 'center', color: p.action === 'same' ? '#5b6272' : '#e6e9ef' }}>
                <input type="checkbox" disabled={p.action === 'same'} checked={p.action === 'insert' && !off[i]} onChange={() => setOff((o) => ({ ...o, [i]: !o[i] }))} />
                <span style={{ flex: 1 }}>{desc(p.pick)}</span>
                <span style={{ color: '#8a92a3' }}>{p.action === 'same' ? 'already tagged' : p.pick.experts.join(', ')}</span>
              </label>
            ))}
          </div>
          {plan.length === 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#e5a64f' }}>
              No usable picks. Claude was given {result.chars?.toLocaleString()} characters of the page, starting: <span style={{ color: '#8a92a3' }}>“{(result.preview || '').replace(/\s+/g, ' ').slice(0, 300)}…”</span>. If that is not the article, the site likely builds it with JavaScript: use Paste article text.
            </div>
          )}
          {result.skipped.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 12, color: '#e5a64f' }}>
              <summary>{result.skipped.length} not tagged</summary>
              {result.skipped.map((s, i) => <div key={i}>{s.expert ? `${s.expert}: ` : ''}{s.text} <span style={{ color: '#8a92a3' }}>({s.reason})</span></div>)}
            </details>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={btn(true)} disabled={busy || !toSave.length} onClick={save}>{busy ? 'Saving…' : `Save ${toSave.length} tags`}</button>
            <button style={{ ...btn(false), fontWeight: 400 }} onClick={() => setResult(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
