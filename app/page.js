'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

const SUPABASE_URL = 'https://zpmdrazbqgzheqkvfltv.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwbWRyYXpicWd6aGVxa3ZmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDY0MjksImV4cCI6MjEwMzg4MjQyOX0.NnVqnpyXRuu5zVpYa12NZ1jl24u2dPWL2vkiQKghuag';

const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

const COLUMNS = [
  { key: 'rank', label: 'Rank', sortable: true },
  { key: 'matchup', label: 'Matchup', sortable: false, sticky: true },
  { key: 'kickoff_at', label: 'Kickoff', sortable: true },
  { key: 'vegas_line', label: 'Vegas Line', sortable: true },
  { key: 'line_move', label: 'Move', sortable: true },
  { key: 'over_under', label: 'O/U', sortable: true },
  { key: 'consensus_spread', label: 'Consensus', sortable: true },
  { key: 'edge', label: 'Edge', sortable: true },
  { key: 'agreement', label: 'Agree % (Top-K)', sortable: true },
  { key: 'agreement_all_pct', label: 'Agree % (All)', sortable: true },
  { key: 'stddev', label: 'StdDev', sortable: true },
  { key: 'range', label: 'Range', sortable: true },
  { key: 'mss', label: 'MSS', sortable: true },
  { key: 'confidence_bin', label: 'Confidence', sortable: true },
  { key: 'suggested_play', label: 'Model Play?', sortable: true },
  { key: 'valid_model_count', label: '# Models', sortable: true },
  { key: 'tv_network', label: 'TV', sortable: false },
  { key: 'lean', label: 'Lean', sortable: false },
  { key: 'play', label: 'My Play', sortable: false },
  { key: 'notes', label: 'Notes', sortable: false },
];

const TOOLTIPS = {
  rank: 'Games ranked 1\u2013N by Model Strength Score (MSS), the same backtested composite metric used for confidence \u2014 not a separate ad-hoc formula. #1 is the strongest signal this week.',
  matchup: 'Away team @ home team.',
  kickoff_at: 'Scheduled kickoff time, shown in Eastern Time.',
  vegas_line: 'The favored team and current market spread.',
  line_move: 'How many points the market has moved since the line opened. Positive = moved toward the home team; negative = moved toward the away team.',
  over_under: 'The market total (combined predicted points for both teams) from sportsbook lines.',
  consensus_spread: "BobbyCFB's weighted-average predicted spread, shown as the team and price the model itself would favor \u2014 same side as the Edge, converted to standard sportsbook notation (favorite negative, underdog positive).",
  edge: 'Consensus spread minus the Vegas line. The size of the disagreement between the model consensus and the market \u2014 the core signal this system is built around.',
  agreement: 'The fraction of the Top-K model pool (the ~7 models actually used for the consensus) whose prediction falls on the same side of the market line as the edge, with the team that direction favors and the raw count.',
  agreement_all_pct: 'The same agreement calculation, but across every model that submitted a prediction this week (not just the Top-K pool used for consensus). Useful as a sanity check \u2014 if Top-K and All disagree sharply, the Top-K pool may be an outlier relative to the wider field.',
  stddev: 'Standard deviation of predicted spreads across the selected top models. Lower means the models are tightly clustered; higher means they disagree with each other.',
  range: 'The spread between the most bullish and most bearish top-model prediction (max \u2212 min). A tight range means all the top models are in the same neighborhood; a wide range can mean one outlier is skewing StdDev without the whole group actually disagreeing.',
  mss: 'Model Strength Score \u2014 a composite confidence score combining edge size, agreement, and variance. Higher MSS means a stronger, more reliable signal.',
  confidence_bin: 'A qualitative bucket (Very Strong \u2192 Very Weak) derived from MSS, for quick scanning. The backtested qualification filter (Edge \u22651.5, StdDev \u22642.5, Agreement \u226585%) is what actually flags a Model Play \u2014 not this bucket alone.',
  suggested_play: 'Whether this game passes the backtested qualification filter (Edge \u22651.5, StdDev \u22642.5, Agreement \u226585%), which historically hit ~58% ATS across 2021\u20132025 backtesting. This is the model\u2019s pick, separate from your own.',
  valid_model_count: 'How many of the ~30+ source systems submitted a usable prediction for this game.',
  tv_network: 'Broadcast network airing the game, where available.',
  lean: 'A quick, informal flag for games you\u2019re leaning toward but haven\u2019t committed to. Not counted in your official season record.',
  play: 'Your official play for this game \u2014 the side, bet type, and unit size you\u2019re actually tracking for season results.',
  notes: 'Your private notes on this game \u2014 injuries, weather, anything worth remembering.',
};

function fmt(n, digits = 1) {
  if (n === null || n === undefined) return '\u2014';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return '\u2014';
  return num.toFixed(digits);
}

function fmtLine(n) {
  if (n === null || n === undefined) return '\u2014';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return '\u2014';
  return num > 0 ? `+${num}` : `${num}`;
}

function fmtFavoredLine(line, homeTeam, awayTeam) {
  if (line === null || line === undefined) return '\u2014';
  const num = typeof line === 'string' ? parseFloat(line) : line;
  if (Number.isNaN(num)) return '\u2014';
  if (num === 0) return "Pick'em";
  if (num > 0) return `${homeTeam} -${num}`;
  return `${awayTeam} -${Math.abs(num)}`;
}

function fmtKickoff(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  return (
    d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' ET'
  );
}

// The stored line is a single number per game: positive = home favored.
// Standard sportsbook notation always shows the favorite with a minus sign,
// so home's displayed number is -V and away's is +V (i.e. V itself).
function spreadForSide(vegasLine, side) {
  if (vegasLine === null || vegasLine === undefined) return null;
  const v = parseFloat(vegasLine);
  if (Number.isNaN(v)) return null;
  return side === 'home' ? -v : v;
}

// Which side the model consensus itself likes (same side as the edge),
// and that side's own predicted line in standard notation.
function consensusPick(r) {
  if (r.consensus_spread == null || r.edge == null) return null;
  const side = parseFloat(r.edge) >= 0 ? 'home' : 'away';
  const team = side === 'home' ? r.home_team : r.away_team;
  const num = spreadForSide(r.consensus_spread, side);
  return { side, team, num };
}

const TEAM_ABBR = {
  'Alabama': 'ALA', 'Auburn': 'AUB', 'California': 'CAL', 'Cincinnati': 'CIN',
  'Colorado St.': 'CSU', 'Duke': 'DUKE', 'Eastern Mich.': 'EMU', 'Florida': 'FLA',
  'Florida St.': 'FSU', 'Georgia Tech': 'GT', 'Hawaii': 'HAW', 'Houston': 'HOU',
  'Illinois': 'ILL', 'Indiana': 'IND', 'Iowa': 'IOWA', 'James Madison': 'JMU',
  'LSU': 'LSU', 'Memphis': 'MEM', 'Michigan': 'MICH', 'Michigan St.': 'MSU',
  'Mississippi': 'MISS', 'Mississippi St.': 'MSST', 'Nebraska': 'NEB', 'Nevada': 'NEV',
  'New Mexico': 'UNM', 'Notre Dame': 'ND', 'Ohio St.': 'OSU', 'Oklahoma': 'OU',
  'Oregon': 'ORE', 'Penn St.': 'PSU', 'Pittsburgh': 'PITT', 'Rutgers': 'RUTG',
  'South Carolina': 'SCAR', 'South Florida': 'USF', 'Stanford': 'STAN', 'Texas': 'TEX',
  'Texas A&M': 'TAMU', 'Troy St.': 'TROY', 'Tulsa': 'TLSA', 'USC': 'USC',
  'Wake Forest': 'WAKE', 'Washington': 'WASH', 'West Va.': 'WVU',
  'East Carolina': 'ECU', 'Baylor': 'BAY', 'UCLA': 'UCLA', 'Boston College': 'BC',
  'Wyoming': 'WYO', 'Tulane': 'TULN', 'San Jose St.': 'SJSU', 'Florida Atlantic': 'FAU',
  'SMU': 'SMU', 'Colorado': 'COLO', 'UNLV': 'UNLV', 'Oregon St.': 'ORST', 'UAB': 'UAB',
  'North Texas': 'UNT', 'Northern Ill.': 'NIU', 'Liberty': 'LIB', 'Clemson': 'CLEM',
  'Arkansas St.': 'ARST', 'Western Mich.': 'WMU', 'Toledo': 'TOL', 'Louisville': 'LOU',
  'Louisiana-Monroe': 'ULM', 'Ohio': 'OHIO', 'Western Kentucky': 'WKU', 'Central Mich.': 'CMU',
  'Wisconsin': 'WISC', 'Ball St.': 'BALL', 'UTEP': 'UTEP', 'Boise St.': 'BSU',
  'Marshall': 'MRSH', 'Miami (Ohio)': 'M-OH', 'Massachusetts': 'UMASS', 'Kent': 'KENT',
  'Florida Intl.': 'FIU', 'Miami (Fla.)': 'MIA', 'Texas St.': 'TXST', 'Missouri St.': 'MOST',
  'Sam Houston St.': 'SHSU', 'Oklahoma St.': 'OKST', 'Fresno St.': 'FRES', 'Akron': 'AKR',
  'Washington St.': 'WSU', 'Coastal Carolina': 'CCU',
};
function abbr(team) {
  return TEAM_ABBR[team] || team;
}

function fmtKickoffPrint(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const time = `${get('hour')}:${get('minute')}${get('dayPeriod')?.[0]?.toLowerCase() || ''}`;
  return `${get('weekday')} ${get('month')}/${get('day')} ${time}`;
}

const CONFIDENCE_ORDER = ['Very Strong', 'Strong', 'Moderate', 'Weak', 'Very Weak'];

// Grade a pick against a finished game. Straight units, no vig modeled.
function gradePick(pick, game) {
  if (!game || game.home_score == null || game.away_score == null) return null;
  const margin = game.home_score - game.away_score;
  if (pick.pick_type === 'total') {
    if (pick.line_played == null) return null;
    const total = game.home_score + game.away_score;
    if (total === pick.line_played) return 'push';
    if (pick.side === 'over') return total > pick.line_played ? 'win' : 'loss';
    if (pick.side === 'under') return total < pick.line_played ? 'win' : 'loss';
    return null;
  }
  if (pick.line_played == null) return null;
  if (margin === pick.line_played) return 'push';
  if (pick.side === 'home') return margin > pick.line_played ? 'win' : 'loss';
  if (pick.side === 'away') return margin < pick.line_played ? 'win' : 'loss';
  return null;
}

// CLV: positive = you beat the closing line. Spread only (no closing total tracked yet).
function computeCLV(pick, game) {
  if (pick.pick_type !== 'spread') return null;
  if (game?.closing_line == null || pick.line_played == null) return null;
  const closing = parseFloat(game.closing_line);
  const played = parseFloat(pick.line_played);
  const sign = pick.side === 'home' ? 1 : -1;
  return sign * (closing - played);
}

function useOutsideClose(ref, onClose) {
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClose]);
}

function InfoIcon({ text }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  function show() {
    const rect = ref.current.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    x = Math.max(120, Math.min(x, window.innerWidth - 120));
    setPos({ x, y: rect.bottom + 8 });
  }
  function hide() {
    setPos(null);
  }

  return (
    <span
      ref={ref}
      className="info-icon"
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={(e) => {
        e.stopPropagation();
        pos ? hide() : show();
      }}
    >
      i
      {pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="tooltip-fixed" style={{ left: pos.x, top: pos.y }}>
            {text}
          </div>,
          document.body
        )}
      <style jsx>{`
        .info-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #2a3042;
          color: #8a92a3;
          font-size: 10px;
          font-style: italic;
          font-weight: 700;
          cursor: help;
          text-transform: none;
          margin-left: 5px;
        }
        .info-icon:hover {
          background: #38bd94;
          color: #0b0e14;
        }
      `}</style>
    </span>
  );
}

function TeamLogo({ src, alt }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className="team-logo"
      onError={(e) => {
        e.currentTarget.style.display = 'none';
      }}
    />
  );
}

function PickModal({ game, existing, defaultStatus, onClose, onSaved, onDeleted }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);

  const [pickType, setPickType] = useState(existing?.pick_type || 'spread');
  const [side, setSide] = useState(existing?.side || null);
  const [units, setUnits] = useState(existing?.units || 1);
  const [status, setStatus] = useState(existing?.status || defaultStatus || 'official');
  const [saving, setSaving] = useState(false);

  const homeLine = game.vegas_line;
  const homeDisplay = spreadForSide(homeLine, 'home');
  const awayDisplay = spreadForSide(homeLine, 'away');

  async function handleSave() {
    if (!side) return;
    setSaving(true);
    // line_played is always the game's single stored line (home-positive
    // convention), regardless of which side is picked — grading logic
    // depends on both sides sharing the same threshold.
    const linePlayed = pickType === 'total' ? game.over_under : (homeLine != null ? parseFloat(homeLine) : null);
    const body = {
      game_id: game.id,
      game_metrics_id: game.game_metrics_id || null,
      played: true,
      pick_type: pickType,
      side,
      line_played: linePlayed,
      units,
      status,
    };
    await fetch(`${SUPABASE_URL}/rest/v1/user_picks?on_conflict=game_id`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    });
    setSaving(false);
    onSaved();
  }

  async function handleDelete() {
    setSaving(true);
    await fetch(`${SUPABASE_URL}/rest/v1/user_picks?game_id=eq.${game.id}`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    setSaving(false);
    onDeleted();
  }

  return createPortal(
    <div className="overlay">
      <div className="modal" ref={ref}>
        <h3>{game.away_team} @ {game.home_team}</h3>

        <div className="seg">
          <button className={pickType === 'spread' ? 'on' : ''} onClick={() => { setPickType('spread'); setSide(null); }}>Spread</button>
          <button className={pickType === 'total' ? 'on' : ''} onClick={() => { setPickType('total'); setSide(null); }}>Total</button>
        </div>

        {pickType === 'spread' ? (
          <div className="sidepick">
            <button className={side === 'away' ? 'on' : ''} onClick={() => setSide('away')}>
              {game.away_team}<span>{fmtLine(awayDisplay)}</span>
            </button>
            <button className={side === 'home' ? 'on' : ''} onClick={() => setSide('home')}>
              {game.home_team}<span>{fmtLine(homeDisplay)}</span>
            </button>
          </div>
        ) : (
          <div className="sidepick">
            <button className={side === 'over' ? 'on' : ''} onClick={() => setSide('over')}>
              Over<span>{game.over_under ?? '\u2014'}</span>
            </button>
            <button className={side === 'under' ? 'on' : ''} onClick={() => setSide('under')}>
              Under<span>{game.over_under ?? '\u2014'}</span>
            </button>
          </div>
        )}

        <div className="row">
          <label>Units</label>
          <div className="units">
            {[1, 2, 3, 4, 5].map((u) => (
              <button key={u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>{u}</button>
            ))}
          </div>
        </div>

        <div className="row">
          <label>Status</label>
          <div className="seg small">
            <button className={status === 'lean' ? 'on' : ''} onClick={() => setStatus('lean')}>Lean</button>
            <button className={status === 'official' ? 'on' : ''} onClick={() => setStatus('official')}>Official</button>
          </div>
        </div>

        <div className="actions">
          {existing && <button className="danger" onClick={handleDelete} disabled={saving}>Remove</button>}
          <button className="ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={handleSave} disabled={saving || !side}>{saving ? 'Saving\u2026' : 'Save'}</button>
        </div>
      </div>

      <style jsx>{`
        .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
        .modal { background: #131722; border: 1px solid #2a3042; border-radius: 12px; padding: 20px; width: 340px; max-width: 90vw; }
        h3 { margin: 0 0 14px; font-size: 15px; color: #e6e9ef; }
        .seg { display: flex; gap: 6px; margin-bottom: 12px; }
        .seg button { flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #2a3042; background: #0b0e14; color: #8a92a3; cursor: pointer; font-size: 13px; }
        .seg.small button { padding: 5px; font-size: 12px; }
        .seg button.on { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 600; }
        .sidepick { display: flex; gap: 8px; margin-bottom: 14px; }
        .sidepick button { flex: 1; padding: 10px 6px; border-radius: 8px; border: 1px solid #2a3042; background: #0b0e14; color: #e6e9ef; cursor: pointer; text-align: center; display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
        .sidepick button span { font-weight: 400; color: #8a92a3; font-size: 12px; }
        .sidepick button.on { border-color: #38bd94; background: rgba(56,189,148,0.1); }
        .sidepick button.on span { color: #38bd94; }
        .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .row label { font-size: 12px; color: #8a92a3; text-transform: uppercase; letter-spacing: 0.04em; }
        .units { display: flex; gap: 4px; }
        .units button { width: 28px; height: 28px; border-radius: 6px; border: 1px solid #2a3042; background: #0b0e14; color: #8a92a3; cursor: pointer; font-size: 13px; }
        .units button.on { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 700; }
        .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
        .actions button { padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid #2a3042; }
        .primary { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 600; }
        .primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .ghost { background: transparent; color: #8a92a3; }
        .danger { background: transparent; color: #f87171; border-color: #f87171; margin-right: auto; }
      `}</style>
    </div>,
    document.body
  );
}

function NoteModal({ game, existing, onClose, onSaved }) {
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const [text, setText] = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await fetch(`${SUPABASE_URL}/rest/v1/user_picks?on_conflict=game_id`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ game_id: game.id, note: text }),
    });
    setSaving(false);
    onSaved(text);
  }

  return createPortal(
    <div className="overlay">
      <div className="modal" ref={ref}>
        <h3>Notes \u2014 {game.away_team} @ {game.home_team}</h3>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Injuries, weather, matchup notes\u2026" />
        <div className="actions">
          <button className="ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving\u2026' : 'Save'}</button>
        </div>
      </div>
      <style jsx>{`
        .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
        .modal { background: #131722; border: 1px solid #2a3042; border-radius: 12px; padding: 20px; width: 380px; max-width: 90vw; }
        h3 { margin: 0 0 14px; font-size: 15px; color: #e6e9ef; }
        textarea { width: 100%; background: #0b0e14; border: 1px solid #2a3042; border-radius: 8px; color: #e6e9ef; padding: 10px; font-size: 13px; resize: vertical; font-family: inherit; }
        .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
        .actions button { padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid #2a3042; }
        .primary { background: #38bd94; color: #0b0e14; border-color: #38bd94; font-weight: 600; }
        .ghost { background: transparent; color: #8a92a3; }
      `}</style>
    </div>,
    document.body
  );
}

export default function Dashboard() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const [rows, setRows] = useState([]);
  const [picksByGame, setPicksByGame] = useState({});
  const [logos, setLogos] = useState({});
  const [ranges, setRanges] = useState({});
  const [agreementAll, setAgreementAll] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [sortKey, setSortKey] = useState('mss');
  const [sortDir, setSortDir] = useState('desc');

  const [search, setSearch] = useState('');
  const [confFilter, setConfFilter] = useState('All');
  const [playOnly, setPlayOnly] = useState(false);
  const [minEdge, setMinEdge] = useState('');
  const [minMove, setMinMove] = useState('');

  const [pickModalGame, setPickModalGame] = useState(null);
  const [pickModalDefaultStatus, setPickModalDefaultStatus] = useState('official');
  const [noteModalGame, setNoteModalGame] = useState(null);

  const [showMyCard, setShowMyCard] = useState(false);
  const [showSeasonStats, setShowSeasonStats] = useState(false);
  const [seasonPicks, setSeasonPicks] = useState(null);
  const [seasonLoading, setSeasonLoading] = useState(false);

  const [cardConfFilter, setCardConfFilter] = useState('All');
  const [cardTypeFilter, setCardTypeFilter] = useState('All');

  async function loadWeek() {
    setLoading(true);
    setError(null);
    try {
      const gamesUrl = `${SUPABASE_URL}/rest/v1/games?select=id,home_team,away_team,kickoff_at,current_line,opening_line,closing_line,over_under,tv_network,status,home_score,away_score,game_metrics(id,vegas_line,consensus_spread,edge,agreement,stddev,mss,confidence_bin,suggested_play,suggested_side,suggested_line,valid_model_count,actual_k,topk_model_ids)&season=eq.${season}&week=eq.${week}`;
      const picksUrl = `${SUPABASE_URL}/rest/v1/user_picks?select=*,games!inner(season,week)&games.season=eq.${season}&games.week=eq.${week}`;
      const logosUrl = `${SUPABASE_URL}/rest/v1/team_logos?select=team_name,logo_url`;

      const [gamesRes, picksRes, logosRes] = await Promise.all([
        fetch(gamesUrl, { headers: SB_HEADERS }),
        fetch(picksUrl, { headers: SB_HEADERS }),
        fetch(logosUrl, { headers: SB_HEADERS }),
      ]);
      if (!gamesRes.ok) throw new Error(`Supabase error ${gamesRes.status}`);
      const gamesData = await gamesRes.json();
      const picksData = picksRes.ok ? await picksRes.json() : [];
      const logosData = logosRes.ok ? await logosRes.json() : [];

      const byGame = {};
      for (const p of picksData) byGame[p.game_id] = p;

      const logoMap = {};
      for (const l of logosData) logoMap[l.team_name] = l.logo_url;

      // Fetch raw predictions for all games this week, then compute per-game
      // range (max - min) restricted to each game's top-K model pool.
      let rangeByGame = {};
      let agreementAllByGame = {};
      if (gamesData.length > 0) {
        const gameIds = gamesData.map((g) => g.id).join(',');
        const predsUrl = `${SUPABASE_URL}/rest/v1/raw_predictions?select=game_id,model_id,predicted_margin&game_id=in.(${gameIds})`;
        const predsRes = await fetch(predsUrl, { headers: SB_HEADERS });
        if (predsRes.ok) {
          const preds = await predsRes.json();
          const byGamePreds = {};
          for (const p of preds) {
            if (!byGamePreds[p.game_id]) byGamePreds[p.game_id] = [];
            byGamePreds[p.game_id].push(p);
          }
          for (const g of gamesData) {
            const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
            const topk = m?.topk_model_ids || [];
            const gamePreds = byGamePreds[g.id] || [];
            const topkPreds = gamePreds
              .filter((p) => topk.includes(p.model_id))
              .map((p) => parseFloat(p.predicted_margin));
            if (topkPreds.length >= 2) {
              rangeByGame[g.id] = Math.max(...topkPreds) - Math.min(...topkPreds);
            }
            // Agreement across the FULL valid model pool (not just Top-K),
            // using the same "which side of the market line" logic as the
            // official agreement metric.
            const vegasLine = m?.vegas_line != null ? parseFloat(m.vegas_line) : (g.current_line != null ? parseFloat(g.current_line) : null);
            const edgeVal = m?.edge != null ? parseFloat(m.edge) : null;
            if (vegasLine != null && edgeVal != null && gamePreds.length > 0) {
              const edgePositive = edgeVal > 0;
              let agreeCount = 0;
              for (const p of gamePreds) {
                const margin = parseFloat(p.predicted_margin);
                if (Number.isNaN(margin)) continue;
                if ((margin > vegasLine) === edgePositive) agreeCount++;
              }
              agreementAllByGame[g.id] = { count: agreeCount, total: gamePreds.length, pct: (agreeCount / gamePreds.length) * 100 };
            }
          }
        }
      }

      setRows(gamesData);
      setPicksByGame(byGame);
      setLogos(logoMap);
      setRanges(rangeByGame);
      setAgreementAll(agreementAllByGame);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWeek();
  }, [season, week]);

  async function loadSeasonStats() {
    setSeasonLoading(true);
    try {
      const url = `${SUPABASE_URL}/rest/v1/user_picks?select=*,games!inner(season,home_team,away_team,home_score,away_score,status,closing_line)&status=eq.official&games.status=eq.final&games.season=eq.${season}`;
      const res = await fetch(url, { headers: SB_HEADERS });
      const data = res.ok ? await res.json() : [];
      setSeasonPicks(data);
    } finally {
      setSeasonLoading(false);
    }
  }

  function refreshAfterPickChange() {
    setPickModalGame(null);
    loadWeek();
    if (showSeasonStats) loadSeasonStats();
  }

  const flat = useMemo(() => {
    return rows.map((g) => {
      const m = Array.isArray(g.game_metrics) ? g.game_metrics[0] : g.game_metrics;
      const pick = picksByGame[g.id] || null;
      const agreementPct = m?.agreement != null ? parseFloat(m.agreement) * 100 : null;
      // Agreement is defined over the Top-K pool used for consensus (actual_k),
      // not the full valid_model_count — those are two different denominators.
      const modelsAgreeing =
        agreementPct != null && m?.actual_k != null
          ? Math.round((agreementPct / 100) * m.actual_k)
          : null;
      const lineMove =
        g.opening_line != null && g.current_line != null
          ? parseFloat(g.current_line) - parseFloat(g.opening_line)
          : null;
      // Agreement is measured relative to the EDGE direction (which side of the
      // market line the top models are on), not the raw sign of the consensus
      // average — those can point different ways, as they did for CSU/Wyoming.
      const agreeSide =
        m?.edge != null
          ? parseFloat(m.edge) > 0
            ? g.home_team
            : g.away_team
          : null;
      return {
        id: g.id,
        matchup: `${g.away_team} @ ${g.home_team}`,
        away_team: g.away_team,
        home_team: g.home_team,
        kickoff_at: g.kickoff_at,
        status: g.status,
        home_score: g.home_score,
        away_score: g.away_score,
        closing_line: g.closing_line,
        vegas_line: m?.vegas_line ?? g.current_line,
        line_move: lineMove,
        over_under: g.over_under ?? null,
        tv_network: g.tv_network ?? null,
        consensus_spread: m?.consensus_spread ?? null,
        edge: m?.edge ?? null,
        agreement: agreementPct,
        agree_side: agreeSide,
        models_agreeing: modelsAgreeing,
        actual_k: m?.actual_k ?? null,
        agreement_all_pct: agreementAll[g.id]?.pct ?? null,
        agreement_all_count: agreementAll[g.id]?.count ?? null,
        agreement_all_total: agreementAll[g.id]?.total ?? null,
        stddev: m?.stddev ?? null,
        range: ranges[g.id] ?? null,
        mss: m?.mss ?? null,
        confidence_bin: m?.confidence_bin ?? null,
        suggested_play: !!m?.suggested_play,
        suggested_side: m?.suggested_side ?? null,
        suggested_line: m?.suggested_line ?? null,
        valid_model_count: m?.valid_model_count ?? null,
        game_metrics_id: m?.id ?? null,
        pick,
      };
    });
  }, [rows, picksByGame, ranges, agreementAll]);

  const filtered = useMemo(() => {
    let out = flat;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => r.home_team.toLowerCase().includes(q) || r.away_team.toLowerCase().includes(q));
    }
    if (confFilter !== 'All') out = out.filter((r) => r.confidence_bin === confFilter);
    if (playOnly) out = out.filter((r) => r.suggested_play);
    if (minEdge !== '') {
      const threshold = parseFloat(minEdge);
      if (!Number.isNaN(threshold)) out = out.filter((r) => r.edge !== null && Math.abs(parseFloat(r.edge)) >= threshold);
    }
    if (minMove !== '') {
      const threshold = parseFloat(minMove);
      if (!Number.isNaN(threshold)) out = out.filter((r) => r.line_move !== null && Math.abs(r.line_move) >= threshold);
    }
    return out;
  }, [flat, search, confFilter, playOnly, minEdge, minMove]);

  // Rank 1..N by MSS descending (ties broken by |edge|) — the same
  // backtested composite metric used for Confidence, not a separate formula.
  const rankByGameId = useMemo(() => {
    const ranked = [...flat].sort((a, b) => {
      const am = a.mss ?? -Infinity;
      const bm = b.mss ?? -Infinity;
      if (bm !== am) return bm - am;
      const ae = a.edge != null ? Math.abs(parseFloat(a.edge)) : -Infinity;
      const be = b.edge != null ? Math.abs(parseFloat(b.edge)) : -Infinity;
      return be - ae;
    });
    const map = {};
    ranked.forEach((r, i) => { map[r.id] = i + 1; });
    return map;
  }, [flat]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av = sortKey === 'rank' ? rankByGameId[a.id] : a[sortKey];
      let bv = sortKey === 'rank' ? rankByGameId[b.id] : b[sortKey];
      if (sortKey === 'confidence_bin') {
        av = CONFIDENCE_ORDER.indexOf(av); bv = CONFIDENCE_ORDER.indexOf(bv);
        if (av === -1) av = 99; if (bv === -1) bv = 99;
      } else if (sortKey === 'kickoff_at') {
        av = av ? new Date(av).getTime() : Infinity; bv = bv ? new Date(bv).getTime() : Infinity;
      } else if (sortKey === 'suggested_play') {
        av = av ? 1 : 0; bv = bv ? 1 : 0;
      } else if (typeof av === 'string' && av !== null && !Number.isNaN(parseFloat(av))) {
        av = parseFloat(av); bv = parseFloat(bv);
      }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir, rankByGameId]);

  // Print always sorts by kickoff time regardless of the on-screen sort,
  // and respects the current filters.
  const printSorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      const at = a.kickoff_at ? new Date(a.kickoff_at).getTime() : Infinity;
      const bt = b.kickoff_at ? new Date(b.kickoff_at).getTime() : Infinity;
      return at - bt;
    });
    return out;
  }, [filtered]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  }

  async function toggleLean(row) {
    if (row.pick?.status === 'official') return;
    if (row.pick?.status === 'lean') {
      await fetch(`${SUPABASE_URL}/rest/v1/user_picks?game_id=eq.${row.id}`, { method: 'DELETE', headers: SB_HEADERS });
    } else {
      const side = row.suggested_side || 'home';
      // line_played is always the game's single stored line, same as PickModal.
      const line = row.vegas_line != null ? parseFloat(row.vegas_line) : null;
      await fetch(`${SUPABASE_URL}/rest/v1/user_picks?on_conflict=game_id`, {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          game_id: row.id, game_metrics_id: row.game_metrics_id, played: true,
          pick_type: 'spread', side, line_played: line, units: 1, status: 'lean',
        }),
      });
    }
    loadWeek();
  }

  const myCardPicksAll = useMemo(() => flat.filter((r) => r.pick?.status === 'official'), [flat]);
  const myCardPicks = useMemo(() => {
    let out = myCardPicksAll;
    if (cardConfFilter !== 'All') out = out.filter((r) => r.confidence_bin === cardConfFilter);
    if (cardTypeFilter !== 'All') out = out.filter((r) => r.pick.pick_type === cardTypeFilter);
    return out;
  }, [myCardPicksAll, cardConfFilter, cardTypeFilter]);

  const seasonRecord = useMemo(() => {
    if (!seasonPicks) return null;
    let w = 0, l = 0, p = 0, unitsNet = 0;
    let clvSum = 0, clvCount = 0;
    for (const sp of seasonPicks) {
      const g = sp.games;
      const result = gradePick(sp, g);
      if (result === 'win') { w++; unitsNet += sp.units || 1; }
      else if (result === 'loss') { l++; unitsNet -= sp.units || 1; }
      else if (result === 'push') { p++; }
      const clv = computeCLV(sp, g);
      if (clv !== null) { clvSum += clv; clvCount++; }
    }
    return { w, l, p, unitsNet, total: w + l + p, avgClv: clvCount ? clvSum / clvCount : null, clvCount };
  }, [seasonPicks]);

  return (
    <div className="wrap">
      <header>
        <div className="header-top">
          <div>
            <h1>BobbyCFB \u2014 Weekly Dashboard</h1>
            <p className="sub">Consensus spreads, edge &amp; qualification signals across all games</p>
          </div>
          <div className="header-actions no-print">
            <button className="toggle-btn" onClick={() => setShowMyCard((v) => !v)}>
              My Card {myCardPicksAll.length > 0 && <span className="count-badge">{myCardPicksAll.length}</span>}
            </button>
            <button
              className="toggle-btn"
              onClick={() => {
                setShowSeasonStats((v) => !v);
                if (!showSeasonStats && !seasonPicks) loadSeasonStats();
              }}
            >
              Season Stats
            </button>
            <button className="toggle-btn print-btn" onClick={() => window.print()}>
              \ud83d\udda8\ufe0f Print
            </button>
          </div>
        </div>
        <div className="print-header">
          <div className="print-title">BobbyCFB \u2014 Week {week}, {season}</div>
          <div className="print-sub">Generated {new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</div>
        </div>
      </header>

      {showMyCard && (
        <div className="panel no-print">
          <div className="panel-head">
            <h2>My Card \u2014 Week {week}</h2>
            <div className="card-filters">
              <select value={cardConfFilter} onChange={(e) => setCardConfFilter(e.target.value)}>
                <option value="All">All confidence</option>
                {CONFIDENCE_ORDER.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={cardTypeFilter} onChange={(e) => setCardTypeFilter(e.target.value)}>
                <option value="All">All bet types</option>
                <option value="spread">Spread</option>
                <option value="total">Total</option>
              </select>
            </div>
          </div>
          {myCardPicksAll.length === 0 ? (
            <p className="empty-note">No official plays saved for this week yet. Click the + in the My Play column to add one.</p>
          ) : myCardPicks.length === 0 ? (
            <p className="empty-note">No plays match these filters.</p>
          ) : (
            <div className="card-list">
              {myCardPicks.map((r) => {
                const result = r.status === 'final' ? gradePick(r.pick, r) : null;
                const clv = computeCLV(r.pick, r);
                const label =
                  r.pick.pick_type === 'total'
                    ? `${r.pick.side === 'over' ? 'Over' : 'Under'} ${r.pick.line_played}`
                    : `${r.pick.side === 'home' ? r.home_team : r.away_team} ${fmtLine(spreadForSide(r.pick.line_played, r.pick.side))}`;
                return (
                  <div key={r.id} className="card-item">
                    <div>
                      <div className="card-matchup">{r.matchup}</div>
                      <div className="card-pick">{label} \u00b7 {r.pick.units}u{clv !== null ? ` \u00b7 CLV ${clv >= 0 ? '+' : ''}${clv.toFixed(1)}` : ''}</div>
                    </div>
                    {result && <span className={`result-badge ${result}`}>{result}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showSeasonStats && (
        <div className="panel no-print">
          <h2>Season Stats \u2014 {season}</h2>
          {seasonLoading && <p className="empty-note">Loading\u2026</p>}
          {!seasonLoading && seasonRecord && (
            <div className="stats-row">
              <div className="stat"><span className="stat-num">{seasonRecord.w}-{seasonRecord.l}{seasonRecord.p ? `-${seasonRecord.p}` : ''}</span><span className="stat-label">Record</span></div>
              <div className="stat"><span className="stat-num">{seasonRecord.total ? `${((seasonRecord.w / (seasonRecord.w + seasonRecord.l || 1)) * 100).toFixed(1)}%` : '\u2014'}</span><span className="stat-label">Win %</span></div>
              <div className="stat"><span className={`stat-num ${seasonRecord.unitsNet >= 0 ? 'pos' : 'neg'}`}>{seasonRecord.unitsNet >= 0 ? '+' : ''}{seasonRecord.unitsNet.toFixed(1)}u</span><span className="stat-label">Units (straight, no vig)</span></div>
              <div className="stat"><span className="stat-num">{seasonRecord.total}</span><span className="stat-label">Graded Plays</span></div>
              <div className="stat">
                <span className={`stat-num ${seasonRecord.avgClv == null ? '' : seasonRecord.avgClv >= 0 ? 'pos' : 'neg'}`}>
                  {seasonRecord.avgClv == null ? '\u2014' : `${seasonRecord.avgClv >= 0 ? '+' : ''}${seasonRecord.avgClv.toFixed(2)}`}
                </span>
                <span className="stat-label">Avg CLV ({seasonRecord.clvCount} graded)</span>
              </div>
            </div>
          )}
          {!seasonLoading && seasonRecord && seasonRecord.total === 0 && (
            <p className="empty-note">No graded official plays yet this season \u2014 results populate once games go final.</p>
          )}
        </div>
      )}

      <div className="controls no-print">
        <div className="control">
          <label>Season</label>
          <input type="number" value={season} onChange={(e) => setSeason(parseInt(e.target.value || '0', 10))} />
        </div>
        <div className="control">
          <label>Week</label>
          <input type="number" value={week} onChange={(e) => setWeek(parseInt(e.target.value || '0', 10))} />
        </div>
        <div className="control">
          <label>Search team</label>
          <input type="text" placeholder="e.g. Auburn" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="control">
          <label>Confidence</label>
          <select value={confFilter} onChange={(e) => setConfFilter(e.target.value)}>
            <option>All</option>
            {CONFIDENCE_ORDER.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="control">
          <label>Min |Edge|</label>
          <input type="number" step="0.5" placeholder="e.g. 1.5" value={minEdge} onChange={(e) => setMinEdge(e.target.value)} />
        </div>
        <div className="control">
          <label>Min |Line Move|</label>
          <input type="number" step="0.5" placeholder="e.g. 1.0" value={minMove} onChange={(e) => setMinMove(e.target.value)} />
        </div>
        <div className="control checkbox">
          <label><input type="checkbox" checked={playOnly} onChange={(e) => setPlayOnly(e.target.checked)} />Model plays only</label>
        </div>
      </div>

      {loading && <div className="status">Loading\u2026</div>}
      {error && <div className="status error">Error: {error}</div>}

      {!loading && !error && (
        <>
          <div className="count no-print">{sorted.length} game{sorted.length === 1 ? '' : 's'}</div>
          <div className="table-wrap screen-only-table">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} onClick={() => c.sortable && toggleSort(c.key)} className={`${c.sortable ? 'sortable' : ''} ${c.sticky ? 'sticky-col' : ''} ${['lean', 'play', 'notes'].includes(c.key) ? 'no-print' : ''}`}>
                      {c.label}
                      {TOOLTIPS[c.key] && <InfoIcon text={TOOLTIPS[c.key]} />}
                      {sortKey === c.key ? (sortDir === 'asc' ? ' \u25b2' : ' \u25bc') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} className={r.suggested_play ? 'play-row' : ''}>
                    <td className="rank-cell">{rankByGameId[r.id]}</td>
                    <td className={`matchup sticky-col ${r.suggested_play ? 'play-row' : ''}`}>
                      <TeamLogo src={logos[r.away_team]} alt={r.away_team} />
                      {r.away_team} @ <TeamLogo src={logos[r.home_team]} alt={r.home_team} />
                      {r.home_team}
                    </td>
                    <td>{fmtKickoff(r.kickoff_at)}</td>
                    <td>{fmtFavoredLine(r.vegas_line, r.home_team, r.away_team)}</td>
                    <td className={r.line_move !== null && Math.abs(r.line_move) >= 0.5 ? (r.line_move > 0 ? 'move-up' : 'move-down') : 'dim'}>
                      {r.line_move !== null ? `${r.line_move > 0 ? '\u25b2 ' : r.line_move < 0 ? '\u25bc ' : ''}${Math.abs(r.line_move).toFixed(1)}` : '\u2014'}
                    </td>
                    <td className={r.over_under == null ? 'dim' : ''}>{r.over_under ?? '\u2014'}</td>
                    <td>
                      {(() => {
                        const c = consensusPick(r);
                        return c ? (
                          <span className="consensus-cell">
                            <TeamLogo src={logos[c.team]} alt={c.team} />
                            {c.team} {fmtLine(fmt(c.num, 2))}
                          </span>
                        ) : '\u2014';
                      })()}
                    </td>
                    <td className={r.edge !== null && Math.abs(parseFloat(r.edge)) >= 1.5 ? 'strong' : ''}>{fmtLine(fmt(r.edge, 2))}</td>
                    <td>{r.agreement !== null ? `${r.agree_side} ${fmt(r.agreement, 0)}% (${r.models_agreeing}/${r.actual_k})` : '\u2014'}</td>
                    <td>{r.agreement_all_pct !== null ? `${r.agree_side} ${fmt(r.agreement_all_pct, 0)}% (${r.agreement_all_count}/${r.agreement_all_total})` : '\u2014'}</td>
                    <td>{fmt(r.stddev, 2)}</td>
                    <td>{fmt(r.range, 1)}</td>
                    <td>{fmt(r.mss, 1)}</td>
                    <td><span className={`badge ${(r.confidence_bin || '').replace(/\s+/g, '-').toLowerCase()}`}>{r.confidence_bin || '\u2014'}</span></td>
                    <td>
                      {r.suggested_play ? (
                        <span className="play-badge">{r.suggested_side === 'home' ? r.home_team : r.away_team} {fmtLine(fmt(spreadForSide(r.suggested_line, r.suggested_side), 1))}</span>
                      ) : '\u2014'}
                    </td>
                    <td>{r.valid_model_count ?? '\u2014'}</td>
                    <td className={r.tv_network == null ? 'dim' : ''}>{r.tv_network ?? '\u2014'}</td>
                    <td className="center no-print">
                      <input
                        type="checkbox"
                        checked={r.pick?.status === 'lean'}
                        disabled={r.pick?.status === 'official'}
                        onChange={() => toggleLean(r)}
                        title={r.pick?.status === 'official' ? 'Already an official play' : 'Mark as a lean'}
                      />
                    </td>
                    <td className="center no-print">
                      {r.pick?.status === 'official' ? (
                        <button className="chip" onClick={() => { setPickModalDefaultStatus('official'); setPickModalGame(r); }}>
                          {r.pick.pick_type === 'total'
                            ? `${r.pick.side === 'over' ? 'O' : 'U'} ${r.pick.line_played}`
                            : `${r.pick.side === 'home' ? r.home_team : r.away_team} ${fmtLine(spreadForSide(r.pick.line_played, r.pick.side))}`} \u00b7 {r.pick.units}u
                        </button>
                      ) : (
                        <button className="add-btn" onClick={() => { setPickModalDefaultStatus('official'); setPickModalGame(r); }}>+</button>
                      )}
                    </td>
                    <td className="center no-print">
                      <button className={`note-btn ${r.pick?.note ? 'has-note' : ''}`} onClick={() => setNoteModalGame(r)} title={r.pick?.note ? 'Edit note' : 'Add note'}>
                        {r.pick?.note ? '\ud83d\udcdd' : '\uff0b'}
                      </button>
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr><td colSpan={COLUMNS.length} className="empty">No games match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="print-only-cards">
            {printSorted.map((r) => {
              const marketFav = fmtFavoredLine(r.vegas_line, r.home_team, r.away_team);
              const c = consensusPick(r);
              const edgeAbs = r.edge != null ? Math.abs(parseFloat(r.edge)) : null;
              return (
                <div key={r.id} className={`gcard gcard-${(r.confidence_bin || 'very-weak').toLowerCase().replace(/\s+/g, '-')} ${r.suggested_play ? 'gcard-play' : ''} ${r.pick?.status === 'official' ? 'gcard-mine' : ''}`}>
                  <div className="gc-top">
                    <span className="gc-rank">#{rankByGameId[r.id]}</span>
                    <span className="gc-time">{fmtKickoffPrint(r.kickoff_at)}</span>
                    <span className="gc-tv">{r.tv_network ?? ''}</span>
                  </div>
                  <div className="gc-matchup">
                    <TeamLogo src={logos[r.away_team]} alt={r.away_team} />
                    {r.away_team} @ {r.home_team}
                    <TeamLogo src={logos[r.home_team]} alt={r.home_team} />
                  </div>
                  <div className="gc-line">
                    Market: <b>{marketFav}</b> &nbsp;\u00b7&nbsp; O/U {r.over_under ?? '\u2014'}
                    {r.line_move !== null && Math.abs(r.line_move) >= 0.5 && (
                      <span className={r.line_move > 0 ? 'gc-up' : 'gc-down'}>
                        {' '}({r.line_move > 0 ? '\u25b2' : '\u25bc'}{Math.abs(r.line_move).toFixed(1)} since open)
                      </span>
                    )}
                  </div>
                  {c && (
                    <div className="gc-story">
                      Model likes <TeamLogo src={logos[c.team]} alt={c.team} /><b>{c.team} {fmtLine(fmt(c.num, 1))}</b>
                      <span className={edgeAbs !== null && edgeAbs >= 1.5 ? 'gc-edge-strong' : 'gc-edge'}> (edge {fmtLine(fmt(r.edge, 1))})</span>.
                      {r.agreement !== null && ` ${fmt(r.agreement, 0)}% of top-7 agree`}
                      {r.agreement_all_pct !== null && ` (${fmt(r.agreement_all_pct, 0)}% of all ${r.valid_model_count}).`}
                    </div>
                  )}
                  <div className="gc-stats">
                    StdDev {fmt(r.stddev, 1)} \u00b7 Range {fmt(r.range, 1)} \u00b7 MSS {fmt(r.mss, 1)} \u00b7 <span className="gc-conf">{r.confidence_bin || '\u2014'}</span>
                  </div>
                  {r.suggested_play && (
                    <div className="gc-badge">\u2605 MODEL PLAY: {r.suggested_side === 'home' ? r.home_team : r.away_team} {fmtLine(fmt(spreadForSide(r.suggested_line, r.suggested_side), 1))}</div>
                  )}
                  {r.pick?.status === 'official' && (
                    <div className="gc-badge gc-badge-mine">
                      \u2691 MY PLAY: {r.pick.pick_type === 'total'
                        ? `${r.pick.side === 'over' ? 'Over' : 'Under'} ${r.pick.line_played}`
                        : `${r.pick.side === 'home' ? r.home_team : r.away_team} ${fmtLine(spreadForSide(r.pick.line_played, r.pick.side))}`} ({r.pick.units}u)
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {pickModalGame && (
        <PickModal
          game={pickModalGame}
          existing={pickModalGame.pick}
          defaultStatus={pickModalDefaultStatus}
          onClose={() => setPickModalGame(null)}
          onSaved={refreshAfterPickChange}
          onDeleted={refreshAfterPickChange}
        />
      )}

      {noteModalGame && (
        <NoteModal
          game={noteModalGame}
          existing={noteModalGame.pick}
          onClose={() => setNoteModalGame(null)}
          onSaved={() => { setNoteModalGame(null); loadWeek(); }}
        />
      )}

      <style jsx global>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #0b0e14; color: #e6e9ef; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .tooltip-fixed {
          position: fixed; transform: translateX(-50%); width: 220px; background: #1a1e2b;
          border: 1px solid #2a3042; color: #d3d8e2; font-size: 11px; font-weight: 400;
          line-height: 1.5; padding: 8px 10px; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          z-index: 1000; white-space: normal; pointer-events: none;
        }
        .team-logo { width: 16px; height: 16px; object-fit: contain; vertical-align: middle; margin: 0 4px; }
        .consensus-cell { display: inline-flex; align-items: center; gap: 2px; }
        .print-header { display: none; }
        .print-only-cards { display: none; }
        @media print {
          @page { size: landscape; margin: 8mm; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .no-print, .info-icon { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          .wrap { max-width: 100% !important; padding: 0 !important; }
          .print-header { display: block !important; margin-bottom: 8px; }
          .print-title { font-size: 16px; font-weight: 700; color: #000; }
          .print-sub { font-size: 9px; color: #555; margin-top: 1px; }
          .screen-only-table { display: none !important; }
          .print-only-cards {
            display: grid !important;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
          }
          .gcard {
            border: 1px solid #ccc; border-left: 3px solid #bbb; border-radius: 3px; padding: 5px 7px;
            break-inside: avoid; color: #000; background: #fff;
          }
          .gcard-very-strong { border-left-color: #059669; }
          .gcard-strong { border-left-color: #10b981; }
          .gcard-moderate { border-left-color: #d97706; }
          .gcard-weak { border-left-color: #94a3b8; }
          .gcard-very-weak { border-left-color: #d1d5db; }
          .gcard-play { border: 1px solid #059669; border-left: 3px solid #059669; background: #ecfdf5; }
          .gcard-mine { box-shadow: inset 0 0 0 1px #2563eb; }
          .gc-top {
            display: flex; justify-content: space-between; align-items: baseline;
            font-size: 7.5px; color: #666; margin-bottom: 2px;
          }
          .gc-rank { font-weight: 700; color: #000; }
          .gc-matchup {
            font-size: 11px; font-weight: 700; margin-bottom: 2px;
            display: flex; align-items: center; gap: 3px;
          }
          .gc-line { font-size: 8.5px; margin-bottom: 3px; color: #333; }
          .gc-up { color: #059669; }
          .gc-down { color: #dc2626; }
          .gc-story { font-size: 8px; line-height: 1.35; margin-bottom: 3px; color: #222; }
          .gc-edge { color: #444; }
          .gc-edge-strong { color: #059669; font-weight: 700; }
          .gc-stats { font-size: 7.5px; color: #555; margin-bottom: 2px; }
          .gc-conf { font-weight: 700; }
          .gcard-very-strong .gc-conf, .gcard-strong .gc-conf { color: #059669; }
          .gcard-moderate .gc-conf { color: #b45309; }
          .gcard-weak .gc-conf, .gcard-very-weak .gc-conf { color: #6b7280; }
          .gc-badge {
            font-size: 8.5px; font-weight: 700; border-radius: 3px;
            padding: 2px 5px; margin-top: 3px; display: inline-block;
            border: 1px solid #059669; background: #d1fae5; color: #065f46;
          }
          .gc-badge-mine { border: 1px solid #2563eb; background: #dbeafe; color: #1e3a8a; margin-left: 4px; }
        }
      `}</style>
      <style jsx>{`
        .wrap { max-width: 1600px; margin: 0 auto; padding: 32px 20px 60px; }
        .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
        header h1 { font-size: 26px; margin: 0 0 4px; font-weight: 700; }
        .sub { color: #8a92a3; margin: 0 0 24px; font-size: 14px; }
        .header-actions { display: flex; gap: 8px; }
        .toggle-btn { background: #131722; border: 1px solid #2a3042; color: #e6e9ef; padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
        .toggle-btn:hover { border-color: #38bd94; }
        .print-btn { }
        .count-badge { background: #38bd94; color: #0b0e14; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 10px; }
        .panel { background: #131722; border: 1px solid #232838; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
        .panel-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
        .panel h2 { font-size: 15px; margin: 0; }
        .card-filters { display: flex; gap: 8px; }
        .card-filters select { background: #0b0e14; border: 1px solid #2a3042; color: #e6e9ef; padding: 5px 8px; border-radius: 6px; font-size: 12px; }
        .empty-note { color: #5b6272; font-size: 13px; margin: 0; }
        .card-list { display: flex; flex-direction: column; gap: 8px; }
        .card-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #0b0e14; border-radius: 8px; border: 1px solid #1a1e2b; }
        .card-matchup { font-size: 13px; font-weight: 600; }
        .card-pick { font-size: 12px; color: #8a92a3; margin-top: 2px; }
        .result-badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; text-transform: uppercase; }
        .result-badge.win { background: rgba(56,189,148,0.15); color: #38bd94; }
        .result-badge.loss { background: rgba(248,113,113,0.15); color: #f87171; }
        .result-badge.push { background: rgba(148,163,184,0.15); color: #94a3b8; }
        .stats-row { display: flex; gap: 28px; flex-wrap: wrap; }
        .stat { display: flex; flex-direction: column; gap: 2px; }
        .stat-num { font-size: 22px; font-weight: 700; }
        .stat-num.pos { color: #38bd94; }
        .stat-num.neg { color: #f87171; }
        .stat-label { font-size: 11px; color: #8a92a3; text-transform: uppercase; letter-spacing: 0.04em; }
        .controls { display: flex; flex-wrap: wrap; gap: 16px; background: #131722; border: 1px solid #232838; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
        .control { display: flex; flex-direction: column; gap: 4px; }
        .control.checkbox { justify-content: flex-end; }
        .control label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #8a92a3; }
        .control input[type='text'], .control input[type='number'], .control select { background: #0b0e14; border: 1px solid #2a3042; color: #e6e9ef; padding: 7px 10px; border-radius: 6px; font-size: 14px; width: 110px; }
        .control input[type='text'] { width: 160px; }
        .control.checkbox label { text-transform: none; font-size: 14px; color: #e6e9ef; display: flex; align-items: center; gap: 6px; padding-bottom: 7px; }
        .status { padding: 40px 0; text-align: center; color: #8a92a3; }
        .status.error { color: #f87171; }
        .count { color: #8a92a3; font-size: 13px; margin-bottom: 8px; }
        .table-wrap { overflow-x: auto; border: 1px solid #232838; border-radius: 10px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; white-space: nowrap; }
        thead th { text-align: left; padding: 10px 12px; background: #131722; border-bottom: 1px solid #232838; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #8a92a3; }
        th.sortable { cursor: pointer; user-select: none; }
        th.sortable:hover { color: #e6e9ef; }
        th.sticky-col { position: sticky; left: 0; z-index: 3; background: #131722; box-shadow: 2px 0 4px rgba(0,0,0,0.3); }
        td.sticky-col { position: sticky; left: 0; z-index: 1; background: #0b0e14; box-shadow: 2px 0 4px rgba(0,0,0,0.3); }
        td.sticky-col.play-row { background: #121a17; }
        tbody td { padding: 9px 12px; border-bottom: 1px solid #1a1e2b; }
        td.center { text-align: center; }
        tbody tr:hover { background: #131722; }
        tbody tr:hover td.sticky-col { background: #131722; }
        tr.play-row { background: rgba(56, 189, 148, 0.06); }
        tr.play-row:hover { background: rgba(56, 189, 148, 0.12); }
        td.matchup { font-weight: 600; }
        td.dim { color: #5b6272; }
        td.strong { color: #38bd94; font-weight: 700; }
        .move { font-size: 11px; margin-left: 4px; }
        .move.up { color: #38bd94; }
        .move.down { color: #f87171; }
        .rank-cell { font-weight: 700; color: #8a92a3; text-align: center; }
        .move-up { color: #38bd94; }
        .move-down { color: #f87171; }
        .badge { padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #232838; color: #b8bfcc; }
        .badge.very-strong { background: rgba(56, 189, 148, 0.18); color: #38bd94; }
        .badge.strong { background: rgba(56, 189, 148, 0.12); color: #38bd94; }
        .badge.moderate { background: rgba(250, 204, 21, 0.14); color: #facc15; }
        .badge.weak { background: rgba(148, 163, 184, 0.14); color: #94a3b8; }
        .badge.very-weak { background: rgba(148, 163, 184, 0.08); color: #6b7280; }
        .play-badge { background: rgba(56, 189, 148, 0.14); color: #38bd94; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 12px; }
        .empty { text-align: center; color: #5b6272; padding: 30px !important; }
        .add-btn { width: 26px; height: 26px; border-radius: 6px; border: 1px dashed #2a3042; background: transparent; color: #8a92a3; cursor: pointer; font-size: 14px; }
        .add-btn:hover { border-color: #38bd94; color: #38bd94; }
        .chip { background: rgba(56,189,148,0.12); color: #38bd94; border: 1px solid rgba(56,189,148,0.3); border-radius: 6px; padding: 4px 8px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .note-btn { width: 26px; height: 26px; border-radius: 6px; border: 1px solid transparent; background: transparent; cursor: pointer; font-size: 13px; color: #5b6272; }
        .note-btn.has-note { color: #facc15; }
        .note-btn:hover { border-color: #2a3042; }
      `}</style>
    </div>
  );
}
