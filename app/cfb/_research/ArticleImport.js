'use client';
import { useEffect, useMemo, useState } from 'react';
import { sbFetch } from '../../../lib/supabase';
import { planArticleTags } from '../../../lib/article-import';
import { planSideBets, describeSideBet } from '../../../lib/side-bets';
import { shortTeam } from '../../../lib/team-short';
import { fmtSigned } from '../../../lib/research-report';

// "Import from article": pick the source, paste the article URL (or its text),
// preview the picks Claude found, then save them as tags for that source.
//   games / tallies  this week's games and research_picks rows
//   sideTallies      this week's research_side_bets rows (ML, team totals, 1H...)
//   sources          preset research sources
export default function ArticleImport({ season, week, games, tallies, sideTallies = [], sources, onDone, inputStyle, labelStyle }) {
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
  const [offBet, setOffBet] = useState({}); // unchecked other bets
  const [assigned, setAssigned] = useState({}); // skipped index -> chosen option (ambiguous game)

  const source = sources.find((s) => s.id === sourceId) || null;
  const gameById = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);

  useEffect(() => { try { setPasscode(localStorage.getItem('import.passcode') || ''); } catch {} }, []);
  useEffect(() => {
    try { setUrl(source ? localStorage.getItem(`import.url.${source.id}`) || '' : ''); } catch {}
  }, [sourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function read() {
    if (!source) { setError('Pick a source first.'); return; }
    setBusy(true); setError(null); setDone(null); setResult(null); setOff({}); setOffBet({}); setAssigned({});
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

  // Picks the server matched, plus any ambiguous ones you assigned to a game.
  const chosen = useMemo(() => Object.values(assigned), [assigned]);
  const plan = useMemo(() => {
    if (!result || !source) return [];
    const raw = [...result.picks, ...chosen.filter((o) => o.kind === 'pick')];
    const picks = raw.map((p) => ({ ...p, game: gameById.get(p.game_id) })).filter((p) => p.game).map((p) => ({ game: p.game, type: p.type, side: p.side, line: p.line, experts: p.experts, expert: (p.experts || [])[0] || '', text: p.text }));
    return planArticleTags(picks, tallies, { season, week, source });
  }, [result, source, tallies, gameById, season, week, chosen]);
  const betPlan = useMemo(() => {
    if (!result || !source) return [];
    const raw = [...(result.sideBets || []), ...chosen.filter((o) => o.kind === 'bet')];
    const bets = raw.map((b) => ({ ...b, game: gameById.get(b.game_id) })).filter((b) => b.game);
    return planSideBets(bets, sideTallies, { season, week, source });
  }, [result, source, sideTallies, gameById, season, week, chosen]);

  const toSave = plan.filter((p, i) => p.action === 'insert' && !off[i]);
  const betsToSave = betPlan.filter((p, i) => p.action === 'insert' && !offBet[i]);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (toSave.length) await sbFetch('research_picks', { method: 'POST', body: JSON.stringify(toSave.map((p) => p.row)) });
      if (betsToSave.length) await sbFetch('research_side_bets', { method: 'POST', body: JSON.stringify(betsToSave.map((p) => p.row)) });
      setDone(`Saved ${toSave.length} ${source.name} tags${betsToSave.length ? ` and ${betsToSave.length} other bets` : ''}.`);
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
  const descBet = (b) => `${describeSideBet(b, (sd) => shortTeam(sd === 'home' ? b.game.home_team : b.game.away_team))} · ${shortTeam(b.game.away_team)} @ ${shortTeam(b.game.home_team)}`;
  const descOption = (o) => {
    const g = gameById.get(o.game_id);
    if (!g) return '?';
    return o.kind === 'bet' ? descBet({ ...o, game: g }) : desc({ ...o, game: g });
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Import from an article</div>
      <div style={{ fontSize: 12, color: '#8a92a3', marginBottom: 12 }}>
        Pick the source, paste the article link, and Claude reads out the picks for week {week}. Full-game spreads and totals become graded tags; moneylines, team totals and 1H/2H/quarter bets are saved as other bets (tracked, not graded). Props and parlays are listed but not saved. Review, then save.
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
          {plan.length === 0 && betPlan.length === 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#e5a64f' }}>
              No usable picks. Claude was given {result.chars?.toLocaleString()} characters of the page, starting: <span style={{ color: '#8a92a3' }}>“{(result.preview || '').replace(/\s+/g, ' ').slice(0, 300)}…”</span>. If that is not the article, the site likely builds it with JavaScript: use Paste article text. (Model returned {result.rawCount ?? '?'} picks, stop reason: {result.stopReason || 'n/a'}.)
            </div>
          )}
          {betPlan.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13 }}>
                <b>{betPlan.length}</b> other bets (not graded): <b>{betPlan.filter((p) => p.action === 'insert').length}</b> new, {betPlan.filter((p) => p.action === 'same').length} already tagged.
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6, fontSize: 12 }}>
                {betPlan.map((p, i) => (
                  <label key={i} style={{ display: 'flex', gap: 8, padding: '2px 0', alignItems: 'center', color: p.action === 'same' ? '#5b6272' : '#c8b6ff' }}>
                    <input type="checkbox" disabled={p.action === 'same'} checked={p.action === 'insert' && !offBet[i]} onChange={() => setOffBet((o) => ({ ...o, [i]: !o[i] }))} />
                    <span style={{ flex: 1 }}>{descBet(p.bet)}</span>
                    <span style={{ color: '#8a92a3' }}>{p.action === 'same' ? 'already tagged' : p.bet.expert}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {result.skipped.length > 0 && (
            <details open={result.skipped.some((s) => s.options?.length)} style={{ marginTop: 8, fontSize: 12, color: '#e5a64f' }}>
              <summary>{result.skipped.length} not tagged</summary>
              {result.skipped.map((s, i) => (
                <div key={i} style={{ padding: '2px 0' }}>
                  {s.expert ? `${s.expert}: ` : ''}{s.text} <span style={{ color: '#8a92a3' }}>({s.reason})</span>
                  {s.options?.length > 0 && (
                    <span style={{ marginLeft: 6 }}>
                      {s.options.map((o, j) => {
                        const on = assigned[i] === o;
                        return (
                          <button key={j} onClick={() => setAssigned((a) => { const n = { ...a }; if (on) delete n[i]; else n[i] = o; return n; })}
                            style={{ marginLeft: 4, fontSize: 11, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', border: '1px solid #2a3042', background: on ? '#38bd94' : 'transparent', color: on ? '#06210f' : '#e6e9ef' }}>
                            {on ? '✓ ' : 'Use '}{descOption(o)}
                          </button>
                        );
                      })}
                    </span>
                  )}
                </div>
              ))}
            </details>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={btn(true)} disabled={busy || !(toSave.length + betsToSave.length)} onClick={save}>{busy ? 'Saving…' : `Save ${toSave.length} tags${betsToSave.length ? ` + ${betsToSave.length} other` : ''}`}</button>
            <button style={{ ...btn(false), fontWeight: 400 }} onClick={() => setResult(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
