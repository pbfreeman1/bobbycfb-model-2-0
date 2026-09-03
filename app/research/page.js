'use client';
import { useEffect, useState, useMemo } from 'react';
import { SUPABASE_URL, SUPABASE_ANON_KEY, sbFetch } from '../../lib/supabase';

const SB_HDR = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };

export default function Research() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const [games, setGames] = useState([]);
  const [tallies, setTallies] = useState([]);   // research_picks rows
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Quick-add form
  const [selGame, setSelGame] = useState('');
  const [pickSide, setPickSide] = useState('home');
  const [pickType, setPickType] = useState('spread');
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [gData, tData] = await Promise.all([
        sbFetch(`games?select=id,home_team,away_team,over_under,current_line,game_metrics(suggested_side,suggested_line)&season=eq.${season}&week=eq.${week}&order=home_team.asc`),
        sbFetch(`research_picks?select=*&season=eq.${season}&week=eq.${week}&order=created_at.asc`),
      ]);
      setGames(gData);
      setTallies(tData);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [season, week]);

  async function addTally() {
    const game = games.find(g => g.id === selGame);
    if (!selGame || !game) return;
    setSaving(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/research_picks`, {
        method: 'POST', headers: SB_HDR,
        body: JSON.stringify({
          season, week,
          game_id: game.id,
          home_team: game.home_team,
          away_team: game.away_team,
          pick_side: pickSide,
          pick_type: pickType,
          source_label: source.trim() || null,
          note: note.trim() || null,
        }),
      });
      setSource(''); setNote('');
      load();
    } finally { setSaving(false); }
  }

  async function removeTally(id) {
    setSaving(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/research_picks?id=eq.${id}`, { method: 'DELETE', headers: SB_HDR });
      load();
    } finally { setSaving(false); }
  }

  // Aggregate tallies by game
  const agg = useMemo(() => {
    const byGame = {};
    for (const g of games) {
      byGame[g.id] = { game: g, home: 0, away: 0, over: 0, under: 0, entries: [] };
    }
    for (const t of tallies) {
      if (!byGame[t.game_id]) continue;
      const side = t.pick_side;
      if (['home','away','over','under'].includes(side)) byGame[t.game_id][side]++;
      byGame[t.game_id].entries.push(t);
    }
    return Object.values(byGame).filter(a => a.entries.length > 0 || games.length < 20);
  }, [games, tallies]);

  // Sorted by total pick count descending
  const sorted = useMemo(() => [...agg].sort((a, b) => (b.home + b.away + b.over + b.under) - (a.home + a.away + a.over + a.under)), [agg]);

  const selectedGame = games.find(g => g.id === selGame);

  return (
    <div className="page">
      <div className="page-header">
        <h1>🔍 Research Tally</h1>
        <p>Track picks from your sources — websites, blogs, podcasts. See which plays are most popular.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
        <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
        <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inp} />
        <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
        <input type="number" value={week} onChange={e => setWeek(+e.target.value)} style={{ ...inp, width: 60 }} />
      </div>

      {/* Quick-add form */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Record a Pick from Research</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <label style={lbl}>Game</label>
            <select style={{ ...inp, width: '100%' }} value={selGame} onChange={e => { setSelGame(e.target.value); setPickSide('home'); setPickType('spread'); }}>
              <option value="">— Select game —</option>
              {games.map(g => <option key={g.id} value={g.id}>{g.away_team} @ {g.home_team}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Side</label>
            <select style={inp} value={pickSide} onChange={e => setPickSide(e.target.value)}>
              {selectedGame ? (
                <>
                  <option value="home">{selectedGame.home_team} (Home)</option>
                  <option value="away">{selectedGame.away_team} (Away)</option>
                  <option value="over">Over {selectedGame.over_under ?? ''}</option>
                  <option value="under">Under {selectedGame.over_under ?? ''}</option>
                </>
              ) : (
                <>
                  <option value="home">Home</option>
                  <option value="away">Away</option>
                  <option value="over">Over</option>
                  <option value="under">Under</option>
                </>
              )}
            </select>
          </div>
          <div>
            <label style={lbl}>Type</label>
            <select style={inp} value={pickType} onChange={e => setPickType(e.target.value)}>
              <option value="spread">Spread (ATS)</option>
              <option value="total">Total (O/U)</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 130 }}>
            <label style={lbl}>Source</label>
            <input style={inp} placeholder="e.g. Action Network" value={source} onChange={e => setSource(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label style={lbl}>Note</label>
            <input style={inp} placeholder="Optional" value={note} onChange={e => setNote(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={addTally} disabled={saving || !selGame} style={{ fontSize: 13 }}>+ Add</button>
        </div>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error && <div className="error-msg">{error}</div>}

      {!loading && !error && (
        <>
          <div style={{ fontSize: 12, color: '#5b6272', marginBottom: 10 }}>
            {tallies.length} total tally entries across {games.filter(g => sorted.find(a => a.game.id === g.id && a.entries.length > 0)).length} games this week
          </div>

          {/* Per-game tally cards */}
          {sorted.filter(a => a.entries.length > 0).length === 0 && (
            <div className="empty">No research tallies yet. Use the form above to start tracking picks from your sources.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sorted.filter(a => a.entries.length > 0).map(({ game: g, home, away, over, under, entries }) => {
              const totalSpread = home + away;
              const totalOU = over + under;
              const topSpread = home >= away ? 'home' : 'away';
              const topSpreadTeam = home >= away ? g.home_team : g.away_team;
              const topOU = over >= under ? 'over' : 'under';

              return (
                <div key={g.id} className="card">
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{g.away_team} @ {g.home_team}</div>
                      <div style={{ fontSize: 12, color: '#8a92a3', marginTop: 2 }}>
                        {totalSpread + totalOU} total picks
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      {/* ATS tally */}
                      {totalSpread > 0 && (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 10, color: '#5b6272', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>ATS</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <TallyBar label={g.home_team} count={home} total={totalSpread} top={home >= away} />
                            <TallyBar label={g.away_team} count={away} total={totalSpread} top={away > home} />
                          </div>
                        </div>
                      )}
                      {/* O/U tally */}
                      {totalOU > 0 && (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 10, color: '#5b6272', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>O/U {g.over_under ?? ''}</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <TallyBar label="Over" count={over} total={totalOU} top={over >= under} />
                            <TallyBar label="Under" count={under} total={totalOU} top={under > over} />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Entry list with source tags */}
                  <div style={{ marginTop: 12, borderTop: '1px solid #1e2535', paddingTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {entries.map(e => (
                      <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#0b0e14', border: '1px solid #2a3042', borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
                        <span style={{ fontWeight: 700, color: e.pick_side === 'home' || e.pick_side === 'over' ? '#38bd94' : '#94a3b8' }}>
                          {e.pick_side === 'home' ? g.home_team : e.pick_side === 'away' ? g.away_team : e.pick_side === 'over' ? 'Over' : 'Under'}
                        </span>
                        {e.source_label && <span style={{ color: '#8a92a3' }}>· {e.source_label}</span>}
                        {e.note && <span style={{ color: '#5b6272' }}>{e.note}</span>}
                        <button onClick={() => removeTally(e.id)} disabled={saving} style={{ background: 'none', border: 'none', color: '#3a404e', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TallyBar({ label, count, total, top }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: top ? '#38bd94' : '#5b6272', lineHeight: 1 }}>{count}</div>
      <div style={{ height: 4, background: '#1e2535', borderRadius: 2, marginTop: 4, marginBottom: 4, width: 56 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: top ? '#38bd94' : '#3a404e', borderRadius: 2, transition: 'width .3s' }} />
      </div>
      <div style={{ fontSize: 10, color: '#8a92a3', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 10, color: '#5b6272' }}>{pct}%</div>
    </div>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #2a3042', color: '#e6e9ef', padding: '7px 10px', borderRadius: 6, fontSize: 13, width: 110 };
const lbl = { fontSize: 11, color: '#8a92a3', display: 'block', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.04em' };
