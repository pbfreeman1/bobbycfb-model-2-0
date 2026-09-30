-- THE Bobby Model — NFL, Phase 1 schema.
--
-- Mirrors the CFB design (cfb_tracker_config / cfb_system_weights /
-- cfb_game_signals / cfb_signal_grades) but makes `market` a first-class
-- dimension so ATS and Totals run through one engine.
--
-- Nothing here touches the existing nfl_* PSS / Strong-Agreement tables
-- (nfl_game_metrics, nfl_pick_grades, nfl_model_grades, nfl_model_config) or
-- the functions that read them (nfl_pool_as_of, nfl_strong_agreement_plays).
-- Those stay as they are; Strong Agreement keeps its fixed top-5 pool.
--
-- MARKET VALUES: 'spread' and 'total'. The Phase 0 sign-off said 'ats', but
-- all 63,133 existing nfl_raw_predictions rows use market='spread', and
-- nfl_pool_as_of + nfl_strong_agreement_plays both hardcode 'spread'. Using
-- 'ats' here would mean a translation layer on every join for the life of the
-- project. 'ATS' stays the display label in the UI.
--
-- LINE CONVENTIONS (normalized once, at ingest, and never again):
--   spread — positive means the HOME team is favored. This is
--            thepredictiontracker.com's convention, the opposite of
--            sportsbook notation, and it is what nfl_games.spread_line,
--            nfl_raw_predictions.predicted_line and cfb_compute all already
--            use. A pick_side of 'home' wins when
--            (home_score - away_score) > line.
--   total  — raw combined points, not home-relative. A pick_side of 'over'
--            wins when (home_score + away_score) > line.

begin;

-- ---------------------------------------------------------------------------
-- Teams: the single source of truth for division, primetime and name matching
-- ---------------------------------------------------------------------------
-- `name` is the canonical form already in nfl_games.home_team (the
-- predictiontracker city style). `aliases` carries every other spelling we
-- have to resolve, ESPN's full club names above all.
create table if not exists nfl_teams (
  name         text primary key,
  abbr         text not null unique,
  conference   text not null check (conference in ('AFC','NFC')),
  division     text not null check (division in ('East','North','South','West')),
  aliases      text[] not null default '{}',
  -- Roof is here for /nfl/totals indoor/outdoor. Left null on purpose: the
  -- open question about a static roof table vs. a weather feed is unanswered,
  -- and a null column costs nothing.
  roof         text check (roof in ('dome','retractable','open'))
);

insert into nfl_teams (name, abbr, conference, division, aliases) values
  ('Buffalo',       'BUF', 'AFC', 'East',  array['Buffalo Bills']),
  ('Miami',         'MIA', 'AFC', 'East',  array['Miami Dolphins']),
  ('New England',   'NE',  'AFC', 'East',  array['New England Patriots']),
  ('N.Y. Jets',     'NYJ', 'AFC', 'East',  array['New York Jets','NY Jets']),
  ('Baltimore',     'BAL', 'AFC', 'North', array['Baltimore Ravens']),
  ('Cincinnati',    'CIN', 'AFC', 'North', array['Cincinnati Bengals']),
  ('Cleveland',     'CLE', 'AFC', 'North', array['Cleveland Browns']),
  ('Pittsburgh',    'PIT', 'AFC', 'North', array['Pittsburgh Steelers']),
  ('Houston',       'HOU', 'AFC', 'South', array['Houston Texans']),
  ('Indianapolis',  'IND', 'AFC', 'South', array['Indianapolis Colts']),
  ('Jacksonville',  'JAX', 'AFC', 'South', array['Jacksonville Jaguars']),
  ('Tennessee',     'TEN', 'AFC', 'South', array['Tennessee Titans']),
  ('Denver',        'DEN', 'AFC', 'West',  array['Denver Broncos']),
  ('Kansas City',   'KC',  'AFC', 'West',  array['Kansas City Chiefs']),
  ('Las Vegas',     'LV',  'AFC', 'West',  array['Las Vegas Raiders','Oakland','Oakland Raiders']),
  ('LA Chargers',   'LAC', 'AFC', 'West',  array['Los Angeles Chargers','L.A. Chargers','San Diego']),
  ('Dallas',        'DAL', 'NFC', 'East',  array['Dallas Cowboys']),
  ('N.Y. Giants',   'NYG', 'NFC', 'East',  array['New York Giants','NY Giants']),
  ('Philadelphia',  'PHI', 'NFC', 'East',  array['Philadelphia Eagles']),
  ('Washington',    'WAS', 'NFC', 'East',  array['Washington Commanders','Washington Football Team']),
  ('Chicago',       'CHI', 'NFC', 'North', array['Chicago Bears']),
  ('Detroit',       'DET', 'NFC', 'North', array['Detroit Lions']),
  ('Green Bay',     'GB',  'NFC', 'North', array['Green Bay Packers']),
  ('Minnesota',     'MIN', 'NFC', 'North', array['Minnesota Vikings']),
  ('Atlanta',       'ATL', 'NFC', 'South', array['Atlanta Falcons']),
  ('Carolina',      'CAR', 'NFC', 'South', array['Carolina Panthers']),
  ('New Orleans',   'NO',  'NFC', 'South', array['New Orleans Saints']),
  ('Tampa Bay',     'TB',  'NFC', 'South', array['Tampa Bay Buccaneers']),
  ('Arizona',       'ARI', 'NFC', 'West',  array['Arizona Cardinals']),
  ('LA Rams',       'LAR', 'NFC', 'West',  array['Los Angeles Rams','L.A. Rams','St. Louis']),
  ('San Francisco', 'SF',  'NFC', 'West',  array['San Francisco 49ers']),
  ('Seattle',       'SEA', 'NFC', 'West',  array['Seattle Seahawks'])
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Config: one row per (market, key), matching cfb_tracker_config's shape so
-- the client-side nearMiss / tierChecklist code is identical between sports.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_config (
  market      text not null check (market in ('spread','total')),
  key         text not null,
  value       numeric,
  value_text  text,
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (market, key),
  -- Exactly one of the two is set. value_text carries lists like key numbers.
  constraint nfl_bobby_config_one_value
    check ((value is null) <> (value_text is null))
);

insert into nfl_bobby_config (market, key, value, value_text, note) values
  -- Grading
  ('spread','juice',            1.1,  null, 'Loss cost per unit at -110'),
  ('total', 'juice',            1.1,  null, 'Loss cost per unit at -110'),

  -- System eligibility and weighting
  ('spread','min_games',       16,    null, 'Decided games a system needs before it can vote. One NFL week, vs CFB''s 15 on a ~60-game slate.'),
  ('total', 'min_games',       16,    null, 'Decided games a system needs before it can vote'),
  ('spread','prior_k',         32,    null, 'Prior strength in games, ~2 NFL weeks. Shrinks season-to-date ATS toward the system''s own archive rate.'),
  ('total', 'prior_k',         32,    null, 'Prior strength in games. No totals archive yet, so this shrinks toward prior_mean.'),
  ('spread','prior_mean',       0.5,  null, 'Prior ATS rate used when a system has no archive history'),
  ('total', 'prior_mean',       0.5,  null, 'Prior ATS rate used when a system has no archive history'),
  ('spread','use_historical_prior', 1, null, '1 = shrink toward nfl_bobby_system_priors; 0 = shrink toward prior_mean (CFB behaviour)'),
  ('total', 'use_historical_prior', 0, null, '0 until a totals archive exists to build priors from'),
  ('spread','w_ats',            0.5,  null, 'Weight on the shrunk ATS score'),
  ('total', 'w_ats',            0.5,  null, 'Weight on the shrunk ATS score'),
  ('spread','w_mae',            0.5,  null, 'Weight on the MAE score'),
  ('total', 'w_mae',            0.5,  null, 'Weight on the MAE score'),
  ('spread','mae_scale',        0.25, null, 'Scales MAE score so 10% better than median ~ 52.5% ATS'),
  ('total', 'mae_scale',        0.25, null, 'Scales MAE score so 10% better than median ~ 52.5% ATS'),
  ('spread','pool_size',        0,    null, '0 = uncapped: every system with weight > 0 votes, as in CFB'),
  ('total', 'pool_size',        0,    null, '0 = uncapped'),
  ('spread','recency_weeks',    0,    null, 'Reserved for Phase 2. 0 = no recency term, matching CFB.'),
  ('total', 'recency_weeks',    0,    null, 'Reserved for Phase 2'),
  ('spread','recency_share',    0,    null, 'Reserved for Phase 2. Share of the ATS score taken from the recent window.'),
  ('total', 'recency_share',    0,    null, 'Reserved for Phase 2'),

  -- Consensus
  ('spread','sd_floor',         1.0,  null, 'Std dev floor used in conviction'),
  ('total', 'sd_floor',         1.0,  null, 'Std dev floor used in conviction'),
  ('spread','min_voters',       5,    null, 'Voting systems a game needs to get any tier'),
  ('total', 'min_voters',       5,    null, 'Voting systems a game needs to get any tier'),
  ('spread','thin_pool',        8,    null, 'Thin pool flag below this many voters'),
  ('total', 'thin_pool',        8,    null, 'Thin pool flag below this many voters'),

  -- Tier cutoffs. CFB-derived placeholders for BOTH markets. Phase 2 replaces
  -- them; until then tiers_validated = 0 and the UI marks them unvalidated.
  ('spread','t3_vs',  0.90, null, '3U vote share'),
  ('spread','t3_edge', 3.0, null, '3U edge'),
  ('spread','t3_sd',   2.5, null, '3U max std dev'),
  ('spread','t3_conv', 1.5, null, '3U conviction'),
  ('spread','t2_vs',  0.80, null, '2U vote share'),
  ('spread','t2_edge', 2.0, null, '2U edge'),
  ('spread','t2_sd',   3.5, null, '2U max std dev'),
  ('spread','t2_conv', 1.0, null, '2U conviction'),
  ('spread','t1_vs',  0.70, null, '1U vote share'),
  ('spread','t1_edge', 1.5, null, '1U edge'),
  ('spread','t1_sd',   4.5, null, '1U max std dev'),
  ('spread','t1_conv', 0.6, null, '1U conviction'),
  ('spread','lean_vs',  0.60, null, 'Lean vote share'),
  ('spread','lean_edge', 1.0, null, 'Lean edge'),
  -- Totals seeded with the same numbers so the engine runs. Note the std dev
  -- caps are almost certainly wrong for this market: system disagreement on a
  -- 44-point total is not on the same scale as on a 3-point spread. Phase 2.
  ('total','t3_vs',  0.90, null, '3U vote share'),
  ('total','t3_edge', 3.0, null, '3U edge — CFB spread number, unvalidated for totals'),
  ('total','t3_sd',   2.5, null, '3U max std dev — CFB spread number, unvalidated for totals'),
  ('total','t3_conv', 1.5, null, '3U conviction'),
  ('total','t2_vs',  0.80, null, '2U vote share'),
  ('total','t2_edge', 2.0, null, '2U edge — unvalidated for totals'),
  ('total','t2_sd',   3.5, null, '2U max std dev — unvalidated for totals'),
  ('total','t2_conv', 1.0, null, '2U conviction'),
  ('total','t1_vs',  0.70, null, '1U vote share'),
  ('total','t1_edge', 1.5, null, '1U edge — unvalidated for totals'),
  ('total','t1_sd',   4.5, null, '1U max std dev — unvalidated for totals'),
  ('total','t1_conv', 0.6, null, '1U conviction'),
  ('total','lean_vs',  0.60, null, 'Lean vote share'),
  ('total','lean_edge', 1.0, null, 'Lean edge'),

  -- Badges and flags
  ('spread','near_miss_pct', 0.05, null, 'Near-miss badge tolerance as a share of the cutoff'),
  ('total', 'near_miss_pct', 0.05, null, 'Near-miss badge tolerance as a share of the cutoff'),
  ('spread','edge_flag',     6.0,  null, 'Big-edge flag'),
  ('total', 'edge_flag',     6.0,  null, 'Big-edge flag'),
  ('spread','fade_edge',     4.5,  null, 'Fade watch: equal-weight consensus this far off the line'),
  ('total', 'fade_edge',     4.5,  null, 'Fade watch: equal-weight consensus this far off the line'),

  -- Validation gate
  ('spread','tiers_validated',    0,  null, '0 = tiers shown with an "unvalidated" marker. Cleared once the Phase 2 backtest is reviewed.'),
  ('total', 'tiers_validated',    0,  null, '0 = tiers shown with an "unvalidated" marker'),
  ('spread','validate_min_games', 64, null, 'Graded consensus games before tiers can be treated as meaningful'),
  ('total', 'validate_min_games', 64, null, 'Graded consensus games before tiers can be treated as meaningful'),

  -- Key numbers, as text lists
  ('spread','key_numbers', null, '3,7,10',      'Spread key numbers for crossing flags'),
  ('total', 'key_numbers', null, '41,44,47,51', 'Common NFL key totals')
on conflict (market, key) do nothing;

-- ---------------------------------------------------------------------------
-- Priors: each system's archive accuracy, stamped with the last season that
-- fed it. Recalibrating season S reads through_season = S - 1, so a
-- walk-forward backtest can never leak the season it is evaluating.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_system_priors (
  id             bigserial primary key,
  model_id       bigint not null references nfl_source_models(id) on delete cascade,
  market         text not null check (market in ('spread','total')),
  through_season integer not null,
  from_season    integer not null,
  wins           integer not null default 0,
  losses         integer not null default 0,
  pushes         integer not null default 0,
  hist_ats       numeric,
  hist_mae       numeric,
  computed_at    timestamptz not null default now(),
  unique (model_id, market, through_season)
);

-- ---------------------------------------------------------------------------
-- Seeds: season-to-date system records loaded from predictiontracker's results
-- page for weeks whose per-game predictions we could not recover. The engine
-- adds these to the per-game grades it computes itself; they are records, not
-- per-game rows, so they can only ever contribute W-L-P and MAE.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_system_seeds (
  id            bigserial primary key,
  model_id      bigint not null references nfl_source_models(id) on delete cascade,
  market        text not null check (market in ('spread','total')),
  season        integer not null,
  through_week  integer not null,
  wins          integer not null default 0,
  losses        integer not null default 0,
  pushes        integer not null default 0,
  mae           numeric,
  source        text not null default 'predictiontracker results page',
  note          text,
  created_at    timestamptz not null default now(),
  unique (model_id, market, season, through_week)
);

-- NO SEED ROWS ARE LOADED. The table and the engine's seed handling stay,
-- because they are the right mechanism if a week's per-game predictions ever
-- turn out to be unrecoverable — but as of now no week needs one.
--
-- The 50 rows in nfl_model_grades stamped 2026 week 1 were loaded on the
-- premise that Week 1 per-game predictions were gone. data/archive/nfl_spread/
-- nfl26_ats.csv turns out to carry per-game predictions AND final scores for
-- 2026 weeks 1-3, so the real per-game data supersedes that summary. Seeding
-- week 1 here would actively lose information: nfl_recalibrate counts
-- per-game grades only for weeks AFTER the latest seed, so a week-1 seed
-- would suppress the 16 real games we now have.
--
-- The 50 rows stay in nfl_model_grades untouched; nfl_pool_as_of and
-- nfl_strong_agreement_plays still read them.
--
-- Totals have per-game data for 2026 weeks 1, 2 and 4, with week 3 missing
-- entirely. That gap needs no seed either — nfl_recalibrate simply grades the
-- weeks that exist.

-- ---------------------------------------------------------------------------
-- System grades: what nfl_recalibrate writes. `week` is the as-of week, i.e.
-- the week these weights APPLY to — recalibrating week N writes week N+1,
-- exactly as cfb_recalibrate does.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_system_grades (
  id             bigserial primary key,
  model_id       bigint not null references nfl_source_models(id) on delete cascade,
  market         text not null check (market in ('spread','total')),
  season         integer not null,
  week           integer not null,
  source_season  integer not null,
  games_graded   integer not null default 0,
  wins           integer not null default 0,
  losses         integer not null default 0,
  pushes         integer not null default 0,
  seed_games     integer not null default 0,
  raw_ats        numeric,
  hist_ats       numeric,
  shrunk_ats     numeric,
  mae            numeric,
  bias           numeric,
  ats_score      numeric,
  mae_score      numeric,
  weight         numeric,
  rank           integer,
  computed_at    timestamptz not null default now(),
  unique (model_id, market, season, week)
);
create index if not exists nfl_bobby_system_grades_lookup
  on nfl_bobby_system_grades (market, season, week) where weight > 0;

-- ---------------------------------------------------------------------------
-- Line snapshots. 'open' and 'close' are one per game/market; 'ingest' rows
-- accumulate, one per CSV upload, which is what drives line movement.
-- The last ingest before kickoff is what the UI labels "closing".
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_lines (
  id          bigserial primary key,
  game_id     bigint not null references nfl_games(id) on delete cascade,
  market      text not null check (market in ('spread','total')),
  phase       text not null check (phase in ('open','ingest','close')),
  line        numeric not null,
  captured_at timestamptz not null default now(),
  source      text not null default 'predictiontracker csv'
);
-- One open and one close per game per market; ingest snapshots are unbounded.
create unique index if not exists nfl_bobby_lines_one_per_phase
  on nfl_bobby_lines (game_id, market, phase) where phase in ('open','close');
-- Idempotent re-ingest: an archive re-pull derives captured_at from the file
-- rather than clock time, so replaying it collides here and does nothing
-- instead of stacking duplicate snapshots.
create unique index if not exists nfl_bobby_lines_dedupe
  on nfl_bobby_lines (game_id, market, phase, captured_at);
create index if not exists nfl_bobby_lines_game
  on nfl_bobby_lines (game_id, market, captured_at desc);

-- ---------------------------------------------------------------------------
-- Picks: one row per game per market, with the pool snapshotted so any
-- historical pick explains itself even after the weights have moved on.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_picks (
  id             bigserial primary key,
  game_id        bigint not null references nfl_games(id) on delete cascade,
  market         text not null check (market in ('spread','total')),
  season         integer not null,
  week           integer not null,
  snapshot_week  integer not null,
  -- The line this pick was actually scored against: the latest ingest snapshot
  -- captured strictly before kickoff, falling back to nfl_games when no
  -- snapshot exists (the 2021-2025 archive, and any first-ever compute).
  line_used      numeric not null,
  -- Which snapshot that was. Null means the nfl_games fallback was used.
  line_snapshot_id bigint references nfl_bobby_lines(id) on delete set null,
  -- Set once the game has kicked off. A locked pick is never rewritten, so a
  -- Sunday re-pull can refine games that have not started and cannot touch
  -- one that has.
  locked_at      timestamptz,
  open_line      numeric,
  consensus      numeric not null,
  eq_consensus   numeric,
  edge           numeric not null,
  eq_edge        numeric,
  std_dev        numeric,
  agreement      numeric,
  conviction     numeric,
  voters         integer not null,
  pool_weight    numeric,
  pick_side      text,
  tier           text not null default 'No tier'
                 check (tier in ('3U','2U','1U','Lean','No tier')),
  units          numeric not null default 0,
  near_miss      text,
  flags          text[] not null default '{}',
  keys_crossed   text[] not null default '{}',
  -- [{model_id, name, rank, record, weight, share, prediction, edge, side}]
  pool           jsonb not null default '[]'::jsonb,
  config_version text,
  run_id         bigint,
  computed_at    timestamptz not null default now(),
  unique (game_id, market),
  -- Sides are market-specific: home/away for a spread, over/under for a total.
  constraint nfl_bobby_picks_side_matches_market check (
    pick_side is null
    or (market = 'spread' and pick_side in ('home','away'))
    or (market = 'total'  and pick_side in ('over','under'))
  )
);
create index if not exists nfl_bobby_picks_week
  on nfl_bobby_picks (market, season, week);

-- ---------------------------------------------------------------------------
-- Pick grades. Every computed game is graded, not just tiered ones.
-- margin_vs_line and clv are both sign-normalized against the pick, so the
-- same formula serves both markets:
--   margin_vs_line = sign(edge) * (actual - line_used)
--   clv            = sign(edge) * (closing_line - line_used)
-- where actual is the home margin for a spread and combined points for a
-- total. Positive clv means the pick beat the closing number.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_pick_grades (
  id              bigserial primary key,
  pick_id         bigint not null references nfl_bobby_picks(id) on delete cascade,
  result          text not null check (result in ('win','loss','push')),
  margin_vs_line  numeric,
  units_pl        numeric not null default 0,
  closing_line    numeric,
  -- CLV as specified: the scored line vs the close. Under the kickoff-lock
  -- rule these are usually the SAME snapshot, so this collapses to ~0 by
  -- construction. Kept for completeness; clv_open is the one that measures
  -- whether the model's side actually beat the market.
  clv             numeric,
  -- Opening number to close, on the pick's side. Positive means the side was
  -- available at a better price when the market opened than when it closed.
  clv_open        numeric,
  beat_close      boolean,
  graded_at       timestamptz not null default now(),
  unique (pick_id)
);

-- ---------------------------------------------------------------------------
-- Run audit log
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_runs (
  id             bigserial primary key,
  kind           text not null check (kind in ('recalibrate','compute','grade','backtest','ingest','line_snapshot')),
  market         text check (market in ('spread','total')),
  season         integer,
  week           integer,
  rows_written   integer,
  config_version text,
  actor          text not null default 'ingest page',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  ok             boolean,
  detail         jsonb
);

-- ---------------------------------------------------------------------------
-- Backtest: physically separate tables so 2021-2025 can never be blended
-- with live 2026 by a careless query.
-- ---------------------------------------------------------------------------
create table if not exists nfl_bobby_backtest_runs (
  id             bigserial primary key,
  market         text not null check (market in ('spread','total')),
  from_season    integer not null,
  to_season      integer not null,
  include_post   boolean not null default true,
  config_version text,
  config         jsonb,
  games          integer,
  notes          text,
  run_at         timestamptz not null default now()
);

create table if not exists nfl_bobby_backtest_picks (
  id             bigserial primary key,
  run_id         bigint not null references nfl_bobby_backtest_runs(id) on delete cascade,
  game_id        bigint not null references nfl_games(id) on delete cascade,
  market         text not null check (market in ('spread','total')),
  season         integer not null,
  week           integer not null,
  line_used      numeric not null,
  open_line      numeric,
  consensus      numeric not null,
  eq_consensus   numeric,
  edge           numeric not null,
  eq_edge        numeric,
  std_dev        numeric,
  agreement      numeric,
  conviction     numeric,
  voters         integer not null,
  pick_side      text,
  tier           text not null default 'No tier',
  units          numeric not null default 0,
  near_miss      text,
  flags          text[] not null default '{}',
  keys_crossed   text[] not null default '{}',
  pool           jsonb not null default '[]'::jsonb,
  result         text check (result in ('win','loss','push')),
  margin_vs_line numeric,
  units_pl       numeric,
  -- Null when the archive has no separate open and final line for this game,
  -- which is the case for all 1,424 rows today. Surfaced as "CLV unavailable".
  clv            numeric,
  unique (run_id, game_id, market)
);
create index if not exists nfl_bobby_backtest_picks_slice
  on nfl_bobby_backtest_picks (run_id, market, season, week);

-- ---------------------------------------------------------------------------
-- My Card: parallel to the CFB tables, keyed on bigint nfl_games.id. The CFB
-- user_picks / research_picks / team_logos key on games.id (uuid) and cannot
-- be shared.
-- ---------------------------------------------------------------------------
create table if not exists nfl_user_picks (
  id           bigserial primary key,
  game_id      bigint not null references nfl_games(id) on delete cascade,
  season       integer not null,
  week         integer not null,
  pick_type    text not null default 'spread'
               check (pick_type in ('spread','total','moneyline','custom')),
  side         text,
  line_played  numeric,
  units        numeric not null default 1,
  status       text not null default 'official' check (status in ('official','draft')),
  played       boolean not null default true,
  is_lock      boolean not null default false,
  is_custom    boolean not null default false,
  custom_label text,
  custom_type  text,
  note         text,
  source_model text,
  result       text check (result in ('win','loss','push')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Spread and moneyline take a team side; totals take over/under; a custom
  -- bet may have no side at all.
  constraint nfl_user_picks_side_matches_type check (
    (pick_type = 'custom')
    or (pick_type = 'total' and side in ('over','under'))
    or (pick_type in ('spread','moneyline') and side in ('home','away'))
  )
);
create index if not exists nfl_user_picks_game on nfl_user_picks (game_id);
create index if not exists nfl_user_picks_week on nfl_user_picks (season, week);

create table if not exists nfl_research_picks (
  id           bigserial primary key,
  game_id      bigint not null references nfl_games(id) on delete cascade,
  season       integer not null,
  week         integer not null,
  home_team    text,
  away_team    text,
  pick_side    text,
  pick_type    text not null default 'spread',
  source_label text,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists nfl_research_picks_game on nfl_research_picks (game_id);

create table if not exists nfl_team_logos (
  team_name  text primary key,
  logo_url   text not null,
  created_at timestamptz not null default now()
);

drop trigger if exists nfl_user_picks_touch on nfl_user_picks;
create trigger nfl_user_picks_touch before update on nfl_user_picks
  for each row execute function nfl_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Classification backfill: is_divisional and is_primetime are existing
-- nfl_games columns that were never populated (false on all 1,424 rows).
-- ---------------------------------------------------------------------------
create or replace function nfl_classify_games(p_season integer default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  update nfl_games g set
    -- `awt` not `at`: AT is a keyword (AT TIME ZONE) and fails as an alias.
    -- is_divisional needs no kickoff time, so it is set unconditionally.
    is_divisional = (ht.conference = awt.conference and ht.division = awt.division),
    -- Thursday and Monday games, anything kicking at or after 8pm ET, and
    -- Saturday night games. Week 1 Thursday and the late-season Saturday
    -- slate both land correctly. The ESPN sync overwrites this with the real
    -- broadcast window where it has one.
    -- game_date is NULL on all 1,424 archive rows, so primetime is left
    -- untouched rather than silently set to false where kickoff is unknown.
    is_primetime = case
      when g.game_date is null then g.is_primetime
      else (extract(dow from g.game_date at time zone 'America/New_York') in (1, 4)
            or extract(hour from g.game_date at time zone 'America/New_York') >= 20)
    end,
    updated_at = now()
  from nfl_teams ht, nfl_teams awt
  where ht.name = g.home_team and awt.name = g.away_team
    and (p_season is null or g.season = p_season);
  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- RLS: every new table gets an explicit FOR SELECT USING (true) policy, in
-- this migration, per the project rule. Writes go through the service role,
-- except the My Card tables which the dashboard writes with the anon key
-- exactly as the CFB pages do.
-- ---------------------------------------------------------------------------
alter table nfl_teams                     enable row level security;
alter table nfl_bobby_config              enable row level security;
alter table nfl_bobby_system_priors       enable row level security;
alter table nfl_bobby_system_seeds        enable row level security;
alter table nfl_bobby_system_grades       enable row level security;
alter table nfl_bobby_lines               enable row level security;
alter table nfl_bobby_picks               enable row level security;
alter table nfl_bobby_pick_grades         enable row level security;
alter table nfl_bobby_runs                enable row level security;
alter table nfl_bobby_backtest_runs       enable row level security;
alter table nfl_bobby_backtest_picks      enable row level security;
alter table nfl_user_picks                enable row level security;
alter table nfl_research_picks            enable row level security;
alter table nfl_team_logos                enable row level security;

create policy nfl_teams_select_all                on nfl_teams                for select using (true);
create policy nfl_bobby_config_select_all         on nfl_bobby_config         for select using (true);
create policy nfl_bobby_system_priors_select_all  on nfl_bobby_system_priors  for select using (true);
create policy nfl_bobby_system_seeds_select_all   on nfl_bobby_system_seeds   for select using (true);
create policy nfl_bobby_system_grades_select_all  on nfl_bobby_system_grades  for select using (true);
create policy nfl_bobby_lines_select_all          on nfl_bobby_lines          for select using (true);
create policy nfl_bobby_picks_select_all          on nfl_bobby_picks          for select using (true);
create policy nfl_bobby_pick_grades_select_all    on nfl_bobby_pick_grades    for select using (true);
create policy nfl_bobby_runs_select_all           on nfl_bobby_runs           for select using (true);
create policy nfl_bobby_backtest_runs_select_all  on nfl_bobby_backtest_runs  for select using (true);
create policy nfl_bobby_backtest_picks_select_all on nfl_bobby_backtest_picks for select using (true);
create policy nfl_team_logos_select_all           on nfl_team_logos           for select using (true);

-- My Card tables are written from the browser with the anon key, matching the
-- CFB user_picks / research_picks flow the dashboard already uses.
create policy nfl_user_picks_select_all     on nfl_user_picks     for select using (true);
create policy nfl_user_picks_insert_all     on nfl_user_picks     for insert with check (true);
create policy nfl_user_picks_update_all     on nfl_user_picks     for update using (true) with check (true);
create policy nfl_user_picks_delete_all     on nfl_user_picks     for delete using (true);
create policy nfl_research_picks_select_all on nfl_research_picks for select using (true);
create policy nfl_research_picks_insert_all on nfl_research_picks for insert with check (true);
create policy nfl_research_picks_delete_all on nfl_research_picks for delete using (true);

commit;
