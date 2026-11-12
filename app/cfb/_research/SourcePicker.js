'use client';
import { useCallback, useEffect, useState } from 'react';
import { sbFetch } from '../../../lib/supabase';
import { sortSources, findSource, cleanSourceName, resolveRankInput } from '../../../lib/research-sources';

const NEW = '__new__';

// Loads the preset source list; create() adds one (or returns the existing
// source when the name already exists, case-insensitively).
export function useResearchSources() {
  const [sources, setSources] = useState([]);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      const rows = await sbFetch('research_sources?select=*&order=sort_order.asc,name.asc');
      setSources(sortSources(rows));
      setError(null);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const create = useCallback(async (rawName) => {
    const name = cleanSourceName(rawName);
    if (!name) throw new Error('Enter a source name.');
    const existing = findSource(sources, name);
    if (existing) return existing;
    const maxOrder = sources.reduce((m, s) => Math.max(m, s.sort_order ?? 0), 0);
    try {
      const [row] = await sbFetch('research_sources', { method: 'POST', body: JSON.stringify({ name, sort_order: maxOrder + 10 }) });
      setSources((prev) => sortSources([...prev, row]));
      return row;
    } catch (e) {
      // unique index race (another tab added it): reload and use that one
      const rows = await sbFetch('research_sources?select=*&order=sort_order.asc,name.asc');
      const list = sortSources(rows);
      setSources(list);
      const again = findSource(list, name);
      if (again) return again;
      throw e;
    }
  }, [sources]);

  return { sources, create, reload, error };
}

// Source dropdown with inline "+ New source…", plus a rank field (and
// Top / Topish shortcuts) when the selected source uses ranks (KAM).
//   value        selected source id ('' = none)
//   onChange(id) called with the new source id (also after creating one)
//   rank, conviction, onRank(r), onConviction(c)
export default function SourcePicker({ sources, create, value, onChange, rank, conviction, onRank, onConviction, inputStyle, labelStyle, compact }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const selected = sources.find((s) => s.id === value) || null;
  const rk = resolveRankInput(selected, { rank, conviction });

  async function addSource() {
    setBusy(true); setErr(null);
    try {
      const s = await create(newName);
      onChange(s.id);
      setAdding(false); setNewName('');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const chip = (active) => ({
    ...inputStyle, width: 'auto', cursor: 'pointer', padding: '7px 12px',
    background: active ? '#2a3042' : inputStyle?.background, fontWeight: active ? 700 : 400,
  });

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div style={{ minWidth: compact ? 140 : 170, flex: 1 }}>
        <label style={labelStyle}>Source</label>
        <select
          style={{ ...inputStyle, width: '100%' }}
          value={adding ? NEW : value || ''}
          onChange={(e) => {
            if (e.target.value === NEW) { setAdding(true); setErr(null); }
            else { setAdding(false); onChange(e.target.value); if (onRank) onRank(''); if (onConviction) onConviction(null); }
          }}
        >
          <option value="">— No source —</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value={NEW}>+ New source…</option>
        </select>
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <div>
            <label style={labelStyle}>New source name</label>
            <input
              autoFocus style={{ ...inputStyle, width: 150 }} value={newName} placeholder="e.g. Hammer Bets"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSource(); } }}
            />
          </div>
          <button type="button" onClick={addSource} disabled={busy || !newName.trim()} style={chip(true)}>{busy ? '…' : 'Add'}</button>
          <button type="button" onClick={() => { setAdding(false); setErr(null); }} style={chip(false)}>Cancel</button>
        </div>
      )}

      {selected?.uses_rank && !adding && (
        <>
          <div>
            <label style={labelStyle}>Rank</label>
            <input
              type="number" min={1} max={50} style={{ ...inputStyle, width: 70 }} placeholder="#"
              value={rank ?? ''} onChange={(e) => { onRank(e.target.value); if (onConviction) onConviction(null); }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={chip(!rank && conviction === 'top')} onClick={() => { onRank(''); onConviction('top'); }}>Top</button>
            <button type="button" style={chip(!rank && conviction === 'topish')} onClick={() => { onRank(''); onConviction('topish'); }}>Topish</button>
          </div>
          {rk.conviction && rank ? <div style={{ fontSize: 11, color: '#8a92a3', alignSelf: 'center' }}>{rk.conviction === 'top' ? 'Top 5' : 'Top 15'}</div> : null}
        </>
      )}
      {(err || rk.error) && <div style={{ fontSize: 12, color: '#e5a64f', width: '100%' }}>{err || rk.error}</div>}
    </div>
  );
}
