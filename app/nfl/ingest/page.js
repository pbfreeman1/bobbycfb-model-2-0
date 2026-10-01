'use client';
import { useState } from 'react';

// THE Bobby Model — NFL ingest.
//
// The weekly order is fixed by what depends on what:
//   ESPN sync -> CSV upload -> Recalibrate (last completed week) -> Compute
// Recalibrate must run on the last COMPLETED week, because it writes the weight
// snapshot that Compute for the following week reads. Grading is for the Results
// page and is not a prerequisite for Compute.
export default function NflIngest() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(4);
  const [market, setMarket] = useState('spread');
  const [csvFile, setCsvFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState([]);

  const add = (msg, type = 'info') =>
    setLog((p) => [...p, { msg, type, t: new Date().toLocaleTimeString() }]);

  async function call(url, opts, describe) {
    setLoading(true);
    try {
      const res = await fetch(url, { method: 'POST', ...opts });
      const d = await res.json();
      if (!res.ok || d.error) {
        add(`${describe} — ${d.error || res.status}`, 'error');
        if (d.validation) add(JSON.stringify(d.validation), 'error');
      } else {
        add(`${describe} — ${describe.startsWith('Upload') ? summarize(d) : JSON.stringify(d)}`, 'ok');
      }
      return d;
    } catch (e) {
      add(`${describe} — network error: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  function summarize(d) {
    const v = d.validation || {};
    const bits = [
      `${d.market} · ${d.matched_games} games`,
      `${d.predictions_written ?? d.predictions_in_file} predictions`,
      `${d.model_columns} systems`,
    ];
    if (d.line_snapshots_written != null) bits.push(`${d.line_snapshots_written} line snapshots`);
    if (d.games_locked_after_kickoff) bits.push(`${d.games_locked_after_kickoff} locked (already kicked off)`);
    if (v.missing_from_csv?.length) bits.push(`NOT IN CSV: ${v.missing_from_csv.join(', ')}`);
    if (d.note) bits.push(d.note);
    return bits.join(' · ');
  }

  const q = `season=${season}&week=${week}`;
  const upload = (dry) => {
    if (!csvFile) return add('No file selected.', 'error');
    const form = new FormData();
    form.append('file', csvFile);
    return call(`/api/nfl/ingest-predictions?${q}${dry ? '&dry_run=1' : ''}`, { body: form },
      dry ? 'Upload (dry run)' : 'Upload CSV');
  };

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px 64px' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>THE Bobby Model — NFL ingest</h1>
      <p style={{ color: '#8a92a3', fontSize: 13, margin: '0 0 20px' }}>
        Run the steps in order. Every step is idempotent, so re-running one is safe.
      </p>

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 20 }}>
        <Field label="Season"><input type="number" value={season} onChange={(e) => setSeason(+e.target.value)} style={inp} /></Field>
        <Field label="Week"><input type="number" value={week} onChange={(e) => setWeek(+e.target.value)} style={inp} /></Field>
        <Field label="Market (engine steps)">
          <select value={market} onChange={(e) => setMarket(e.target.value)} style={inp}>
            <option value="spread">spread (ATS)</option>
            <option value="total">total (O/U)</option>
          </select>
        </Field>
      </div>

      <Section title="1 · Schedule, kickoffs and scores" />
      <Grid>
        <Step n="1" title="ESPN sync"
          desc="Upserts schedule, kickoff (UTC), broadcast network and finals into nfl_games for the whole season. Run before uploading a CSV, so week validation has a schedule to check against, and again after games finish to pull scores."
          action="Run ESPN sync" loading={loading}
          onClick={() => call(`/api/nfl/espn-sync?season=${season}`, {}, 'ESPN sync')} />
        <Step n="1b" title="Classify games"
          desc="Sets is_divisional from the division map and is_primetime from kickoff hour (7pm ET or later). Re-run after an ESPN sync fills new kickoffs."
          action="Classify" loading={loading}
          onClick={() => call(`/api/nfl/engine?op=classify&season=${season}`, {}, 'Classify')} />
      </Grid>

      <Section title="2 · Upload the predictiontracker CSV" />
      <div className="card" style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 12, color: '#8a92a3', lineHeight: 1.6 }}>
          Spread or totals — the market is detected from the header, so there is one upload for both.
          The load is <b>blocked</b> if any matchup in the file is not on the selected week&rsquo;s schedule,
          because the spread file carries no week column and nothing else would catch a wrong-week upload.
          Each upload also writes a line snapshot, which is what makes CLV computable.
          Re-uploading later in the week picks up late-posting systems; the current-week file
          typically carries far fewer systems than the post-week archive.
        </p>
        <input type="file" accept=".csv" onChange={(e) => setCsvFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: '#8a92a3' }} />
        {csvFile && <div style={{ fontSize: 11, color: '#38bd94' }}>Selected: {csvFile.name}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => upload(true)} disabled={loading || !csvFile} style={{ fontSize: 13 }}>
            Dry run (validate only)
          </button>
          <button className="btn btn-primary" onClick={() => upload(false)} disabled={loading || !csvFile} style={{ fontSize: 13 }}>
            {loading ? 'Working…' : 'Upload and load'}
          </button>
        </div>
      </div>

      <Section title="3 · Run the engine" />
      <Grid>
        <Step n="3a" title="Build priors (once per season)"
          desc="Each system's 2021-2025 accuracy, which the early-season weights shrink toward. Stamped through_season so a backtest cannot see the season it is scoring. Only needs re-running when the archive changes."
          action="Build priors" loading={loading}
          onClick={() => call(`/api/nfl/engine?op=priors&market=${market}&from=2021&through=2025`, {}, `Priors (${market})`)} />
        <Step n="3b" title="Recalibrate"
          desc="Set Week to the LAST COMPLETED week. Grades every system season-to-date and writes the weight snapshot that Compute for the NEXT week uses. Always runs in live mode."
          action="Recalibrate" loading={loading}
          onClick={() => call(`/api/nfl/engine?op=recalibrate&${q}&market=${market}`, {}, `Recalibrate ${market} wk${week}`)} />
        <Step n="3c" title="Compute"
          desc="Set Week to the week you are playing. Scores every game against the weight snapshot: consensus, edge, vote share, std dev, conviction, tier, flags and key numbers. A game that has kicked off is locked and never rewritten."
          action="Compute" loading={loading}
          onClick={() => call(`/api/nfl/engine?op=compute&${q}&market=${market}`, {}, `Compute ${market} wk${week}`)} />
        <Step n="3d" title="Grade"
          desc="After a week is final. Grades every computed game at −110 with pushes at 0, and records CLV. For the Results page — not a prerequisite for Compute."
          action="Grade" loading={loading}
          onClick={() => call(`/api/nfl/engine?op=grade&${q}&market=${market}`, {}, `Grade ${market} wk${week}`)} />
      </Grid>

      <div className="card" style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#5b6272', marginBottom: 8, letterSpacing: '.05em' }}>LOG</div>
        {log.length === 0 && <div style={{ fontSize: 12, color: '#5b6272' }}>Nothing run yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
          {log.map((l, i) => (
            <div key={i} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, lineHeight: 1.5,
                                  color: l.type === 'error' ? '#e6795f' : l.type === 'ok' ? '#6fbf73' : '#8a92a3',
                                  wordBreak: 'break-word' }}>
              <span style={{ color: '#5b6272' }}>{l.t}</span> {l.msg}
            </div>
          ))}
        </div>
        {log.length > 0 && (
          <button className="btn" onClick={() => setLog([])} style={{ fontSize: 12, marginTop: 10 }}>Clear log</button>
        )}
      </div>
    </main>
  );
}

const inp = { background: '#0b0e14', border: '1px solid #232838', borderRadius: 4, color: '#e6e9ef', padding: '7px 9px', fontSize: 13, width: 130 };

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: '#8a92a3', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      {children}
    </label>
  );
}
function Section({ title }) {
  return <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#5b6272', margin: '0 0 10px' }}>{title}</div>;
}
function Grid({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginBottom: 24 }}>{children}</div>;
}
function Step({ n, title, desc, action, onClick, loading }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 28, height: 28, borderRadius: '50%', background: '#38bd94', color: '#0b0e14',
                       display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, flexShrink: 0 }}>{n}</span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: '#8a92a3', lineHeight: 1.5 }}>{desc}</p>
      <button className="btn btn-primary" onClick={onClick} disabled={loading} style={{ fontSize: 13, marginTop: 'auto' }}>
        {loading ? 'Working…' : action}
      </button>
    </div>
  );
}
