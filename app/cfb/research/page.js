'use client';
import { useEffect, useState, useMemo } from 'react';
import { SUPABASE_URL, SUPABASE_ANON_KEY, sbFetch, getBoardWeek } from '../../../lib/supabase';
import { buildTagPayload } from '../../../lib/research-sources';
import { teamSpread, fmtSigned } from '../../../lib/research-report';
import SourcePicker, { useResearchSources } from '../_research/SourcePicker';
import KamImport from '../_research/KamImport';
import ArticleImport from '../_research/ArticleImport';
import { shortTeam } from '../../../lib/team-short';
import {
  MANUAL_SIDE_TYPES, parseSideType, sideChoices, splitSide, validateSideBet, buildSideBetRow, groupSideBets, describeSideBet,
} from '../../../lib/side-bets';

const SB_HDR = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };

export default function Research() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(null); // resolved to the latest week with games below
  const [games, setGames] = useState([]);
  const [tallies, setTallies] = useState([]);   // research_picks rows
  const [sideTallies, setSideTallies] = useState([]); // research_side_bets rows (not graded)
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Quick-add form
  const [selGame, setSelGame] = useState('');
  const [pickSide, setPickSide] = useState('home');
  const [pickType, setPickType] = useState('spread');
  const [sourceId, setSourceId] = useState('');
  const [rank, setRank] = useState('');
  const [conviction, setConviction] = useState(null);
  const [note, setNote] = useState('');
  const [betLine, setBetLine] = useState('');
  const [betOdds, setBetOdds] = useState('');
  const sideType = parseSideType(pickType); // null for graded spread / total
  const { sources, create } = useResearchSources();
  const source = sources.find((x) => x.id === sourceId) || null;

  // Remember the last source so a batch of tags from one source is one click each.
  useEffect(() => { try { const v = localStorage.getItem('research.lastSource'); if (v) setSourceId(v); } catch {} }, []);
  useEffect(() => { try { if (sourceId) localStorage.setItem('research.lastSource', sourceId); } catch {} }, [sourceId]);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [gData, tData, sData] = await Promise.all([
        sbFetch(`games?select=id,home_team,away_team,over_under,current_line,game_metrics(suggested_side,suggested_line)&season=eq.${season}&week=eq.${week}&order=home_team.asc`),
        sbFetch(`research_picks?select=*&season=eq.${season}&week=eq.${week}&order=created_at.asc`),
        sbFetch(`research_side_bets?select=*&season=eq.${season}&week=eq.${week}&order=created_at.asc`).catch(() => []),
      ]);
      setGames(gData);
      setTallies(tData);
      setSideTallies(sData);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    let cancelled = false;
    getBoardWeek(season).then((w) => { if (!cancelled) setWeek(w); });
    return () => { cancelled = true; };
  }, [season]);

  useEffect(() => { if (week != null) load(); }, [season, week]);

  async function addTally() {
    const game = games.find(g => g.id === selGame);
    if (!selGame || !game) return;
    setSaving(true); setError(null);
    try {
      if (sideType) {
        const { team_side, ou_side } = splitSide(sideType.market, pickSide);
        const bet = { ...sideType, team_side, ou_side, line: betLine, odds: betOdds };
        const err = validateSideBet(bet);
        if (err) throw new Error(err);
        const row = buildSideBetRow({ game, season, week, ...bet, source, note });
        await sbFetch('research_side_bets', { method: 'POST', body: JSON.stringify(row) });
        setNote(''); setBetLine(''); setBetOdds(''); setSelGame('');
        load();
        return;
      }
      const body = buildTagPayload({ game, season, week, pickType, pickSide, source, rank, conviction, note });
      const res = await fetch(`${SUPABASE_URL}/rest/v1/research_picks`, { method: 'POST', headers: SB_HDR, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Save failed (${res.status}): ${await res.text().catch(() => '')}`);
      // Next KAM rank is usually rank + 1, so pre-fill it. Keep source for the next tag.
      if (source?.uses_rank && body.rank) setRank(String(body.rank + 1));
      setNote(''); setSelGame('');
      load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function removeSideBet(id) {
    setSaving(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/research_side_bets?id=eq.${id}`, { method: 'DELETE', headers: SB_HDR });
      load();
    } finally { setSaving(false); }
  }

  const sideGroups = useMemo(() => groupSideBets(sideTallies), [sideTallies]);
  const gameById = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);

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
        <h1>🔍 Quick Tag</h1>
        <p>Pick a game, tap a side, choose a source. The line and total at tag time are saved automatically. Finished tagging? Open Play Finder.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
        <label style={{ fontSize: 12, color: '#8a92a3' }}>Season</label>
        <input type="number" value={season} onChange={e => setSeason(+e.target.value)} style={inp} />
        <label style={{ fontSize: 12, color: '#8a92a3' }}>Week</label>
        <input type="number" value={week ?? ''} onChange={e => setWeek(+e.target.value)} style={{ ...inp, width: 60 }} />
      </div>

      {week != null && !loading && (
        <KamImport
          season={season} week={week} games={games} tallies={tallies}
          source={sources.find((x) => x.name === 'KAM') || null}
          onDone={load} inputStyle={inp} labelStyle={lbl}
        />
      )}

      {week != null && !loading && (
        <ArticleImport
          season={season} week={week} games={games} tallies={tallies} sideTallies={sideTallies}
          sources={sources.filter((x) => x.name !== 'KAM')}
          onDone={load} inputStyle={inp} labelStyle={lbl}
        />
      )}

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
              {sideType ? sideChoices(sideType.market).map((c) => {
                const [a, b] = c.split(':');
                const nm = (sd) => (selectedGame ? (sd === 'home' ? selectedGame.home_team : selectedGame.away_team) : sd === 'home' ? 'Home' : 'Away');
                const lbl = a === 'over' ? 'Over' : a === 'under' ? 'Under' : `${nm(a)}${b ? ` ${b === 'over' ? 'Over' : 'Under'}` : ''}`;
                return <option key={c} value={c}>{lbl}</option>;
              }) : selectedGame ? (
                <>
                  <option value="home">{selectedGame.home_team} {fmtSigned(teamSpread(selectedGame.current_line, 'home'))}</option>
                  <option value="away">{selectedGame.away_team} {fmtSigned(teamSpread(selectedGame.current_line, 'away'))}</option>
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
            <select style={inp} value={pickType} onChange={e => {
              const t = e.target.value; setPickType(t);
              const st = parseSideType(t);
              setPickSide(st ? sideChoices(st.market)[0] : t === 'total' ? 'over' : 'home');
            }}>
              <option value="spread">Spread (ATS)</option>
              <option value="total">Total (O/U)</option>
              <optgroup label="Other bets (not graded)">
                {MANUAL_SIDE_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </optgroup>
            </select>
          </div>
          {sideType && sideType.market !== 'moneyline' && (
            <div>
              <label style={lbl}>{sideType.market === 'spread' ? 'Spread' : 'Number'}</label>
              <input style={{ ...inp, width: 70 }} inputMode="decimal" placeholder={sideType.market === 'spread' ? '-3.5' : '23.5'} value={betLine} onChange={e => setBetLine(e.target.value)} />
            </div>
          )}
          {sideType && (
            <div>
              <label style={lbl}>Odds</label>
              <input style={{ ...inp, width: 70 }} inputMode="numeric" placeholder={sideType.market === 'moneyline' ? '+142' : 'opt.'} value={betOdds} onChange={e => setBetOdds(e.target.value)} />
            </div>
          )}
          <div style={{ flex: 3, minWidth: 260 }}>
            <SourcePicker
              sources={sources} create={create} value={sourceId} onChange={setSourceId}
              rank={rank} conviction={conviction} onRank={setRank} onConviction={setConviction}
              inputStyle={inp} labelStyle={lbl}
            />
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

          {sideGroups.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Other bets</div>
                <div style={{ fontSize: 11, color: '#5b6272' }}>ML, team totals, halves, quarters · not graded · most sources first</div>
              </div>
              {sideGroups.map((grp) => {
                const g = gameById.get(grp.game_id);
                if (!g) return null;
                const teamFor = (sd) => shortTeam(sd === 'home' ? g.home_team : g.away_team);
                const nums = grp.min == null ? '' : grp.min === grp.max ? '' : grp.market === 'moneyline' ? ` (${grp.min > 0 ? '+' : ''}${grp.min} to ${grp.max > 0 ? '+' : ''}${grp.max})` : ` (${grp.min} to ${grp.max})`;
                const head = grp.min != null && grp.min === grp.max
                  ? describeSideBet({ ...grp, line: grp.market === 'moneyline' ? null : grp.min, odds: grp.market === 'moneyline' ? grp.min : null }, teamFor)
                  : describeSideBet(grp, teamFor, { withLine: false });
                return (
                  <div key={grp.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid #1e2535', flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 26, textAlign: 'center', fontWeight: 800, fontSize: 15, color: grp.count >= 2 ? '#38bd94' : '#5b6272' }}>{grp.count}</span>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{head}{nums}</span>
                    <span style={{ fontSize: 12, color: '#8a92a3' }}>{shortTeam(g.away_team)} @ {shortTeam(g.home_team)}</span>
                    {grp.opposed && <span style={{ fontSize: 10.5, color: '#e5a64f', border: '1px solid #e5a64f55', borderRadius: 4, padding: '0 5px' }}>split</span>}
                    <span style={{ flex: 1 }} />
                    {grp.rows.map((r) => (
                      <span key={r.id} title={r.note || ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#0b0e14', border: '1px solid #2a3042', borderRadius: 6, padding: '2px 8px', fontSize: 11.5, color: '#8a92a3' }}>
                        {r.source_label || 'Unlabeled'}
                        <button onClick={() => removeSideBet(r.id)} disabled={saving} aria-label="Remove other bet" style={{ background: 'none', border: 'none', color: '#3a404e', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

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
