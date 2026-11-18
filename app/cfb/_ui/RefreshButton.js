'use client';

import { useState } from 'react';
import { C } from '../../../lib/nfl-board';
import { requestRefresh } from '../../../lib/cfb-auto';

// Queues an ESPN + PredictionTracker pull and waits for it to finish.
export default function RefreshButton({ onDone, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function go() {
    setBusy(true);
    setMsg('Requesting…');
    try {
      const run = await requestRefresh(setMsg);
      setMsg(run.status === 'ok' ? 'Updated.' : `Finished with an error: ${run.error || 'see pull log'}`);
      if (onDone) onDone(run);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button onClick={go} disabled={busy} style={{
        background: busy ? C.surface : C.green, color: busy ? C.sub : '#0F1412', border: `1px solid ${busy ? C.border : C.green}`,
        borderRadius: 6, padding: compact ? '4px 10px' : '7px 12px', fontSize: compact ? 12 : 13, fontWeight: 700,
        cursor: busy ? 'default' : 'pointer',
      }}>{busy ? 'Refreshing…' : 'Refresh now'}</button>
      {msg && <span style={{ fontSize: 12, color: C.sub }}>{msg}</span>}
    </span>
  );
}
