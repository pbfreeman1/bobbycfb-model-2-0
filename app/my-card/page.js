'use client';
import { useEffect, useRef, useState } from 'react';
import { SUPABASE_URL, SUPABASE_ANON_KEY, sbFetch, sbHeaders, fmt, fmtLine, fmtKickoff, getCurrentWeek } from '../../lib/supabase';

const SB_HDR = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

export default function MyCard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null); // resolved to the latest week with games below
  const [picks, setPicks] = useState([]);
  const [games, setGames] = useState([]);
  const [pssGames, setPssGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('card'); // 'card' | 'history'
  const [lockHistory, setLockHistory] = useState([]);

  // Custom play form
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [customType, setCustomType] = useState('parlay');
  const [customNote, setCustomNote] = useState('');

  // Share
  const cardRef = useRef(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [pData, gData, lockData, pssPData, pssGData, pssLockData] = await Promise.all([
        sbFetch(`user_picks?select=*,games(home_team,away_team,kickoff_at,current_line,over_under,game_metrics(consensus_spread,edge,mss,confidence_bin,suggested_side,suggested_line))&season=eq.${season}&week=eq.${week}&order=created_at.asc`),
        sbFetch(`games?select=id,home_team,away_team,kickoff_at,current_line,game_metrics(suggested_side,suggested_line,consensus_spread,edge,mss)&season=eq.${season}&week=eq.${week}&order=home_team.asc`),
        sbFetch(`user_picks?select=*,games(home_team,away_team)&is_lock=eq.true&order=created_at.desc&limit=20`),
        // BobbyPSSModel — separate table, merged into the same consolidated card below.
        sbFetch(`pss_user_picks?select=*,games(home_team,away_team,kickoff_at,current_line,over_under)&season=eq.${season}&week=eq.${week}&order=created_at.asc`),
        sbFetch(`games?select=id,home_team,away_team,kickoff_at,current_line,pss_game_metrics(suggested_side,consensus_spread,edge,pss,pss_bin,qualifies)&season=eq.${season}&week=eq.${week}&order=home_team.asc`),
        sbFetch(`pss_user_picks?select=*,games(home_team,away_team)&is_lock=eq.true&order=created_at.desc&limit=20`),
      ]);
      const tagged = pData.map((p) => ({ ...p, _table: 'user_picks', _model: 'BobbyCFB' }));
      const pssTagged = pssPData.map((p) => ({ ...p, _table: 'pss_user_picks', _model: 'BobbyPSSModel' }));
      setPicks([...tagged, ...pssTagged].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
      setGames(gData);
      setPssGames(pssGData);
      const taggedLock = lockData.map((p) => ({ ...p, _table: 'user_picks', _model: 'BobbyCFB' }));
      const pssTaggedLock = pssLockData.map((p) => ({ ...p, _table: 'pss_user_picks', _model: 'BobbyPSSModel' }));
      setLockHistory(
        [...taggedLock, ...pssTaggedLock]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 20)
      );
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    let cancelled = false;
    // Default to latest scheduled week (not just final) so current week shows on load
    fetch(`${SUPABASE_URL}/rest/v1/games?select=week&season=eq.${season}&order=week.desc&limit=1`, { headers: SB_HDR })
      .then(r => r.json())
      .then(rows => { if (!cancelled) setWeek(rows.length ? rows[0].week : 1); })
      .catch(() => { if (!cancelled) setWeek(1); });
    return () => { cancelled = true; };
  }, [season]);

  useEffect(() => { if (week != null) load(); }, [season, week]);

  async function toggleLock(pick) {
    // The lock is a single shared "Barney Rubble Lock of the Week" across
    // BOTH models — unset any existing lock in either table first.
    const existingLock = picks.find(p => p.is_lock && p.id !== pick.id);
    setSaving(true);
    try {
      if (existingLock) {
        await fetch(`${SUPABASE_URL}/rest/v1/${existingLock._table}?id=eq.${existingLock.id}`, {
          method: 'PATCH', headers: SB_HDR,
          body: JSON.stringify({ is_lock: false }),
        });
      }
      const newLock = !pick.is_lock;
      await fetch(`${SUPABASE_URL}/rest/v1/${pick._table}?id=eq.${pick.id}`, {
        method: 'PATCH', headers: SB_HDR,
        body: JSON.stringify({ is_lock: newLock }),
      });
      load();
    } finally { setSaving(false); }
  }

  async function removePick(id, table = 'user_picks') {
    setSaving(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method: 'DELETE', headers: SB_HDR });
      load();
    } finally { setSaving(false); }
  }

  async function addCustomPlay() {
    if (!customLabel.trim()) return;
    setSaving(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/user_picks`, {
        method: 'POST', headers: SB_HDR,
        body: JSON.stringify({
          season, week,
          is_custom: true,
          custom_label: customLabel.trim(),
          custom_type: customType,
          note: customNote.trim() || null,
          played: true,
          status: 'official',
          pick_type: 'spread',
        }),
      });
      setCustomLabel(''); setCustomNote(''); setShowCustomForm(false);
      load();
    } finally { setSaving(false); }
  }

  async function updateResult(pickId, result, table = 'user_picks') {
    setSaving(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${pickId}`, {
        method: 'PATCH', headers: SB_HDR,
        body: JSON.stringify({ result }),
      });
      load();
    } finally { setSaving(false); }
  }

  async function shareCard() {
    // Build a text-based share for iMessage
    const lockPick = picks.find(p => p.is_lock);
    const officialPicks = picks.filter(p => p.played || p.status === 'official');
    let text = `🏈 BobbyModels Week ${week} Card\n`;
    if (lockPick) {
      const g = lockPick.games;
      const teamName = lockPick.side === 'home' ? g?.home_team : g?.away_team;
      text += `🔒 BRLW Lock: ${lockPick.is_custom ? lockPick.custom_label : (teamName + ' ' + fmtLine(lockPick.line_played))}\n`;
    }
    text += `\nPicks (${officialPicks.length}):\n`;
    for (const p of officialPicks) {
      if (p.is_lock) continue;
      const g = p.games;
      if (p.is_custom) {
        text += `• ${p.custom_label} (${p.custom_type})\n`;
      } else {
        const teamName = p.side === 'home' ? g?.home_team : g?.away_team;
        text += `• ${teamName} ${fmtLine(p.line_played)} — ${g?.away_team} @ ${g?.home_team}\n`;
      }
    }
    text += `\nbobbymodels.app`;

    // Try Web Share API (native share sheet on mobile), fallback to clipboard
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { /* fallback */ }
    }
    await navigator.clipboard.writeText(text);
    alert('Card copied to clipboard! Paste into iMessage.');
  }

  async function shareCardImage() {
    // Canvas-based PNG for visual sharing
    const canvas = document.createElement('canvas');
    const dpr = 2;
    canvas.width = 640 * dpr;
    canvas.height = Math.max(400, (picks.length + 3) * 52 + 160) * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = 640, rowH = 52;

    // Background
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, W, canvas.height / dpr);

    // Header bar
    ctx.fillStyle = '#131722';
    ctx.fillRect(0, 0, W, 80);
    ctx.fillStyle = '#38bd94';
    ctx.font = 'bold 22px -apple-system, sans-serif';
    ctx.fillText('BobbyModels', 24, 36);
    ctx.fillStyle = '#e6e9ef';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.fillText(`Week ${week} Card`, 24, 60);

    // Lock pick
    const lockPick = picks.find(p => p.is_lock);
    if (lockPick) {
      ctx.fillStyle = 'rgba(251,191,36,0.15)';
      ctx.roundRect(16, 92, W - 32, 48, 8);
      ctx.fill();
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 13px -apple-system, sans-serif';
      const g = lockPick.games;
      const lockTeam = lockPick.side === 'home' ? g?.home_team : g?.away_team;
      ctx.fillText(`🔒 BRLW Lock: ${lockPick.is_custom ? lockPick.custom_label : (lockTeam + ' ' + fmtLine(lockPick.line_played))}`, 28, 122);
    }

    let y = lockPick ? 158 : 100;
    const officialPicks = picks.filter(p => p.played || p.status === 'official');
    for (const p of officialPicks) {
      if (p.is_lock) continue;
      ctx.fillStyle = '#131722';
      ctx.roundRect(16, y, W - 32, rowH - 4, 6);
      ctx.fill();

      const g = p.games;
      const teamName = p.is_custom ? null : (p.side === 'home' ? g?.home_team : g?.away_team);

      ctx.fillStyle = '#e6e9ef';
      ctx.font = 'bold 14px -apple-system, sans-serif';
      ctx.fillText(p.is_custom ? p.custom_label : `${teamName} ${fmtLine(p.line_played)}`, 28, y + 24);

      if (!p.is_custom) {
        ctx.fillStyle = '#8a92a3';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText(`${g?.away_team} @ ${g?.home_team}`, 28, y + 40);
      }

      if (p.result) {
        const resultColor = p.result === 'win' ? '#38bd94' : p.result === 'loss' ? '#f87171' : '#facc15';
        ctx.fillStyle = resultColor;
        ctx.font = 'bold 13px -apple-system, sans-serif';
        ctx.fillText(p.result.toUpperCase(), W - 70, y + 28);
      }

      y += rowH;
    }

    // Footer
    ctx.fillStyle = '#2a3042';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('bobbymodels.app', 24, canvas.height / dpr - 16);

    canvas.toBlob(async (blob) => {
      const file = new File([blob], `bobby-week${week}.png`, { type: 'image/png' });
      if (navigator.share && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `Week ${week} Card` }); return; } catch (e) { /* fallback */ }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `bobby-week${week}.png`;
      a.click(); URL.revokeObjectURL(url);
    }, 'image/png');
  }

  const officialPicks = picks.filter(p => p.played || p.status === 'official');
  const lockPick = picks.find(p => p.is_lock);
  const wins = officialPicks.filter(p => p.result === 'win').length;
  const losses = officialPicks.filter(p => p.result === 'loss').length;
  const pushes = officialPicks.filter(p => p.result === 'push').length;

  const lockWins = lockHistory.filter(p => p.result === 'win').length;
  const lockLosses = lockHistory.filter(p => p.result === 'loss').length;

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>🎯 My Card</h1>
          <p>Manage your weekly picks, designate your Barney Rubble Lock, add custom plays</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
          <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inp} />
          <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
          <input type="number" value={week ?? ''} onChange={e => setWeek(+e.target.value)} style={{ ...inp, width: 60 }} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #1e2535' }}>
        {[['card', `Week ${week} Card`], ['history', '🔒 BRLW History']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ background: 'none', border: 'none', color: tab === t ? '#e6e9ef' : '#5b6272', borderBottom: `2px solid ${tab === t ? '#38bd94' : 'transparent'}`, padding: '10px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="loading">Loading card…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && tab === 'card' && (
        <>
          {/* Card header */}
          <div className="card" style={{ marginBottom: 16 }} ref={cardRef}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Week {week} Card</div>
                <div style={{ fontSize: 13, color: '#8a92a3', marginTop: 2 }}>
                  {officialPicks.length} pick{officialPicks.length !== 1 ? 's' : ''}
                  {(wins + losses + pushes) > 0 && ` · ${wins}–${losses}${pushes > 0 ? `–${pushes}` : ''}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-outline" onClick={shareCard} style={{ fontSize: 12 }}>📱 Share Text</button>
                <button className="btn btn-outline" onClick={shareCardImage} style={{ fontSize: 12 }}>🖼 Share Image</button>
                <button className="btn btn-primary" onClick={() => setShowCustomForm(f => !f)} style={{ fontSize: 12 }}>+ Custom Play</button>
              </div>
            </div>

            {showCustomForm && (
              <div style={{ marginTop: 16, padding: 16, background: '#0b0e14', borderRadius: 8, border: '1px solid #2a3042' }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: '#e6e9ef' }}>Add Custom Play</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <label style={{ fontSize: 11, color: '#8a92a3', display: 'block', marginBottom: 4 }}>Label *</label>
                    <input style={inp} placeholder="e.g. Alabama ML + Georgia ML parlay" value={customLabel} onChange={e => setCustomLabel(e.target.value)} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#8a92a3', display: 'block', marginBottom: 4 }}>Type</label>
                    <select style={inp} value={customType} onChange={e => setCustomType(e.target.value)}>
                      <option value="parlay">Parlay</option>
                      <option value="moneyline">Moneyline</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <label style={{ fontSize: 11, color: '#8a92a3', display: 'block', marginBottom: 4 }}>Note</label>
                    <input style={inp} placeholder="Optional note" value={customNote} onChange={e => setCustomNote(e.target.value)} />
                  </div>
                  <button className="btn btn-primary" onClick={addCustomPlay} disabled={saving || !customLabel.trim()} style={{ fontSize: 12 }}>Add</button>
                  <button className="btn btn-outline" onClick={() => setShowCustomForm(false)} style={{ fontSize: 12 }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* BRLW section */}
          {lockPick && (
            <div className="card" style={{ marginBottom: 16, background: 'rgba(251,191,36,.06)', border: '1px solid rgba(251,191,36,.25)' }}>
              <div style={{ fontSize: 11, color: '#fbbf24', fontWeight: 800, marginBottom: 6, letterSpacing: '.05em' }}>🔒 BARNEY RUBBLE LOCK OF THE WEEK</div>
              <PickCard pick={lockPick} onRemove={removePick} onToggleLock={toggleLock} onResultChange={updateResult} saving={saving} />
              <div style={{ marginTop: 10, fontSize: 12, color: '#8a92a3' }}>
                BRLW All-Time: {lockWins}–{lockLosses} ({lockWins + lockLosses > 0 ? ((lockWins / (lockWins + lockLosses)) * 100).toFixed(0) : '—'}%)
              </div>
            </div>
          )}

          {/* Picks list */}
          {officialPicks.filter(p => !p.is_lock).length === 0 && !lockPick && (
            <div className="empty">No picks yet. Go to the Dashboard and click "+ Add" on any game, or use the custom play button above.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {officialPicks.filter(p => !p.is_lock).map(pick => (
              <div key={pick.id} className="card" style={{ padding: '12px 16px' }}>
                <PickCard pick={pick} onRemove={removePick} onToggleLock={toggleLock} onResultChange={updateResult} saving={saving} />
              </div>
            ))}
          </div>

          {/* Add from available model plays — BobbyCFB */}
          {games.filter(g => {
            const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
            return m?.suggested_play && !picks.find(p => p._table === 'user_picks' && p.game_id === g.id);
          }).length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 12, color: '#5b6272', marginBottom: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Available BobbyCFB Plays Not Yet Added
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {games.filter(g => {
                  const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
                  return m?.suggested_play && !picks.find(p => p._table === 'user_picks' && p.game_id === g.id);
                }).map(g => {
                  const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
                  const teamName = m?.suggested_side === 'home' ? g.home_team : g.away_team;
                  return (
                    <button key={g.id} className="btn btn-outline" style={{ fontSize: 12 }} onClick={async () => {
                      setSaving(true);
                      await fetch(`${SUPABASE_URL}/rest/v1/user_picks`, {
                        method: 'POST', headers: SB_HDR,
                        body: JSON.stringify({ game_id: g.id, season, week, played: true, status: 'official', side: m?.suggested_side, line_played: m?.suggested_line, pick_type: 'spread' }),
                      });
                      load(); setSaving(false);
                    }} disabled={saving}>
                      + {teamName} {fmtLine(m?.suggested_line)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Add from available model plays — BobbyPSSModel */}
          {pssGames.filter(g => {
            const m = Array.isArray(g.pss_game_metrics) ? g.pss_game_metrics[0] : g.pss_game_metrics;
            return m?.qualifies && !picks.find(p => p._table === 'pss_user_picks' && p.game_id === g.id);
          }).length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 12, color: '#5b6272', marginBottom: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Available BobbyPSSModel Plays Not Yet Added
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {pssGames.filter(g => {
                  const m = Array.isArray(g.pss_game_metrics) ? g.pss_game_metrics[0] : g.pss_game_metrics;
                  return m?.qualifies && !picks.find(p => p._table === 'pss_user_picks' && p.game_id === g.id);
                }).map(g => {
                  const m = Array.isArray(g.pss_game_metrics) ? g.pss_game_metrics[0] : g.pss_game_metrics;
                  const teamName = m?.suggested_side === 'home' ? g.home_team : g.away_team;
                  // Displayed line: consensus, properly signed for the suggested side (same fix as the dashboard).
                  const num = m?.consensus_spread != null
                    ? (m.suggested_side === 'home' ? -parseFloat(m.consensus_spread) : parseFloat(m.consensus_spread))
                    : null;
                  return (
                    <button key={g.id} className="btn btn-outline" style={{ fontSize: 12, borderColor: 'rgba(167,139,250,.4)' }} onClick={async () => {
                      setSaving(true);
                      // line_played is the game's single stored line (home-positive
                      // convention) — the actual market price, not the model's fair line.
                      const linePlayed = g.current_line != null ? parseFloat(g.current_line) : null;
                      await fetch(`${SUPABASE_URL}/rest/v1/pss_user_picks`, {
                        method: 'POST', headers: SB_HDR,
                        body: JSON.stringify({ game_id: g.id, pss_game_metrics_id: null, season, week, played: true, status: 'official', side: m?.suggested_side, line_played: linePlayed, pick_type: 'spread' }),
                      });
                      load(); setSaving(false);
                    }} disabled={saving}>
                      + {teamName} {fmtLine(num != null ? num.toFixed(1) : null)} <ModelBadge model="BobbyPSSModel" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {!loading && !error && tab === 'history' && (
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>🔒 BRLW All-Time Record</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#fbbf24' }}>{lockWins}–{lockLosses}</div>
            <div style={{ fontSize: 13, color: '#8a92a3' }}>
              {lockWins + lockLosses > 0 ? ((lockWins / (lockWins + lockLosses)) * 100).toFixed(1) : '—'}% — from your last {lockHistory.length} designated locks
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Season / Week</th>
                  <th>Model</th>
                  <th>Pick</th>
                  <th>Matchup</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {lockHistory.map(p => {
                  const g = p.games;
                  const teamName = p.side === 'home' ? g?.home_team : g?.away_team;
                  const resultColor = p.result === 'win' ? '#38bd94' : p.result === 'loss' ? '#f87171' : '#facc15';
                  return (
                    <tr key={`${p._table}-${p.id}`}>
                      <td style={{ color: '#8a92a3' }}>{p.season} / Wk {p.week}</td>
                      <td><ModelBadge model={p._model} /></td>
                      <td style={{ fontWeight: 700 }}>
                        {p.is_custom ? p.custom_label : `${teamName} ${fmtLine(p.line_played)}`}
                      </td>
                      <td style={{ color: '#8a92a3', fontSize: 12 }}>
                        {g ? `${g.away_team} @ ${g.home_team}` : '—'}
                      </td>
                      <td style={{ color: p.result ? resultColor : '#5b6272', fontWeight: 700 }}>
                        {p.result ? p.result.toUpperCase() : 'Pending'}
                      </td>
                    </tr>
                  );
                })}
                {lockHistory.length === 0 && (
                  <tr><td colSpan={5} className="empty">No lock history yet. Designate picks as the BRLW Lock on your card.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const MODEL_BADGE = {
  BobbyCFB: { label: 'BobbyCFB', fg: '#38bd94', bg: 'rgba(56,189,148,.15)' },
  BobbyPSSModel: { label: 'PSS', fg: '#c4b5fd', bg: 'rgba(167,139,250,.18)' },
};

function ModelBadge({ model }) {
  const c = MODEL_BADGE[model] || MODEL_BADGE.BobbyCFB;
  return (
    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 800, color: c.fg, background: c.bg, padding: '2px 7px', borderRadius: 10, letterSpacing: '.03em', textTransform: 'uppercase' }}>
      {c.label}
    </span>
  );
}

function PickCard({ pick, onRemove, onToggleLock, onResultChange, saving }) {
  const g = pick.games;
  const teamName = pick.is_custom ? null : (pick.side === 'home' ? g?.home_team : g?.away_team);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 160 }}>
        {pick.is_custom
          ? <>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{pick.custom_label}</span>
            <span style={{ marginLeft: 8, fontSize: 11, color: '#8a92a3', background: '#232838', padding: '2px 6px', borderRadius: 4 }}>{pick.custom_type}</span>
          </>
          : <>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{teamName} {fmtLine(pick.line_played)}</span>
            {g && <span style={{ marginLeft: 8, fontSize: 12, color: '#8a92a3' }}>{g.away_team} @ {g.home_team}</span>}
            <ModelBadge model={pick._model} />
          </>
        }
        {pick.note && <div style={{ fontSize: 11, color: '#8a92a3', marginTop: 2 }}>{pick.note}</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Result selector */}
        {['win', 'loss', 'push'].map(r => (
          <button key={r} onClick={() => onResultChange(pick.id, pick.result === r ? null : r, pick._table)} disabled={saving}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid', cursor: 'pointer', background: pick.result === r ? (r === 'win' ? '#38bd94' : r === 'loss' ? '#f87171' : '#facc15') : 'transparent', color: pick.result === r ? '#0b0e14' : '#8a92a3', borderColor: pick.result === r ? 'transparent' : '#2a3042', fontWeight: 700 }}>
            {r.toUpperCase()}
          </button>
        ))}
        {/* Lock button */}
        {!pick.is_custom && (
          <button className={pick.is_lock ? 'btn btn-lock' : 'btn btn-outline'} style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => onToggleLock(pick)} disabled={saving}>
            {pick.is_lock ? '🔒 Lock' : '🔓 Lock?'}
          </button>
        )}
        <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => onRemove(pick.id, pick._table)} disabled={saving}>✕</button>
      </div>
    </div>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110 };
