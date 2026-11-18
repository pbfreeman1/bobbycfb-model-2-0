-- THE Bobby Model — NFL v2 (CBB-style): schema, ESPN sync, PredictionTracker pulls.
--
-- Mirrors the college basketball build: everything runs in Postgres on a
-- pg_cron schedule; the app only reads views. Reuses nfl_games,
-- nfl_raw_predictions and nfl_source_models (and their 2021-2025 history);
-- every new object is prefixed nfl2_ so it never collides with the older
-- nfl_bobby_* engine, which is left untouched.
--
-- Sources
--   ESPN scoreboard     schedule, kickoff (the per-game lock), TV, finals
--   nflpredictions.csv  this week's spread predictions (no week column)
--   nfltotals.csv       this week's total predictions
--   nflYY.csv           season spread archive with scores (backfill)
--   nfltotalsYY.csv     season totals archive (backfill)
-- PT spreads are home-relative: +3 means the home team is favored by 3.

alter table nfl_raw_predictions add column if not exists updated_at timestamptz;

create table if not exists nfl2_config (
  market text not null check (market in ('spread', 'total', 'all')),
  key text not null,
  value text not null,
  note text,
  primary key (market, key)
);

create table if not exists nfl2_runs (
  id bigserial primary key,
  kind text not null default 'cycle',
  trigger text not null default 'schedule',
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  detail jsonb
);

create table if not exists nfl2_refresh_requests (
  id bigserial primary key,
  requested_at timestamptz not null default now(),
  picked_up_at timestamptz,
  run_id bigint
);

create table if not exists nfl2_line_history (
  id bigserial primary key,
  game_id bigint not null references nfl_games(id) on delete cascade,
  market text not null,
  line numeric,
  prev_line numeric,
  captured_at timestamptz not null default now()
);
create index if not exists nfl2_line_history_game on nfl2_line_history (game_id, market, captured_at);

create table if not exists nfl2_prediction_history (
  id bigserial primary key,
  game_id bigint not null references nfl_games(id) on delete cascade,
  model_id bigint not null,
  market text not null,
  value numeric,
  prev_value numeric,
  captured_at timestamptz not null default now()
);
create index if not exists nfl2_prediction_history_game on nfl2_prediction_history (game_id, market);

-- How often NFL games land on each number: |home margin| for spreads, total
-- points for totals. rel = frequency / average frequency over the usual range,
-- so rel 3.0 means "three times as likely as a typical number".
create table if not exists nfl2_key_freq (
  market text not null,
  value int not null,
  games int not null,
  freq numeric not null,
  rel numeric not null,
  primary key (market, value)
);

alter table nfl2_config enable row level security;
alter table nfl2_runs enable row level security;
alter table nfl2_refresh_requests enable row level security;
alter table nfl2_line_history enable row level security;
alter table nfl2_prediction_history enable row level security;
alter table nfl2_key_freq enable row level security;
create policy nfl2_config_read on nfl2_config for select using (true);
create policy nfl2_runs_read on nfl2_runs for select using (true);
create policy nfl2_refresh_requests_read on nfl2_refresh_requests for select using (true);
create policy nfl2_line_history_read on nfl2_line_history for select using (true);
create policy nfl2_prediction_history_read on nfl2_prediction_history for select using (true);
create policy nfl2_key_freq_read on nfl2_key_freq for select using (true);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function nfl2_cfg(p_market text, p_key text) returns numeric
language sql stable set search_path = public as $$
  select coalesce(
    (select value::numeric from nfl2_config where market = p_market and key = p_key),
    (select value::numeric from nfl2_config where market = 'all' and key = p_key))
$$;

create or replace function nfl2_norm(t text) returns text
language sql immutable as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[.''’]', '', 'g'), '\s+', ' ', 'g'))
$$;

-- PT or ESPN team name -> nfl_teams.name
create or replace function nfl2_team(t text) returns text
language sql stable set search_path = public as $$
  select name from (
    select name, 1 o from nfl_teams where nfl2_norm(name) = nfl2_norm(t) or nfl2_norm(abbr) = nfl2_norm(t)
    union all
    select name, 2 from nfl_teams, unnest(aliases) a where nfl2_norm(a) = nfl2_norm(t)
    union all
    select 'Washington', 3 where nfl2_norm(t) = 'wsh'
  ) x order by o limit 1
$$;

-- Columns in a PT file that are not a system's prediction.
create or replace function nfl2_skip_col(c text) returns boolean
language sql immutable as $$
  select c in ('line', 'lineopen', 'linemidweek', 'lineavg', 'linemedian', 'linemed', 'linestd', 'lineca',
               'line_avgdiff', 'totavg', 'totmed', 'totstd')
      or not (c like 'line%' or c like 'tot%')
$$;

-- Resolves a PT column to a system, registering systems PT adds mid-season.
-- A new totFOO joins the existing lineFOO system when there is one.
create or replace function nfl2_model_for(p_col text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  v_id := nfl_resolve_model(p_col);
  if v_id is not null then return v_id; end if;
  if p_col like 'tot%' then
    v_id := nfl_resolve_model('line' || substr(p_col, 4));
    if v_id is not null then
      update nfl_source_models set csv_aliases = array_append(coalesce(csv_aliases, '{}'), p_col) where id = v_id;
      return v_id;
    end if;
  elsif p_col like 'line%' then
    v_id := nfl_resolve_model('tot' || substr(p_col, 5));
    if v_id is not null then
      update nfl_source_models set csv_aliases = array_append(coalesce(csv_aliases, '{}'), p_col) where id = v_id;
      return v_id;
    end if;
  end if;
  insert into nfl_source_models (model_key, display_name, is_active, is_aggregate, first_seen_season, notes)
  values (p_col, p_col, true, false, extract(year from now())::int, 'auto-added from PredictionTracker by nfl2 pull')
  on conflict (model_key) do nothing returning id into v_id;
  return coalesce(v_id, nfl_resolve_model(p_col));
end $$;

-- ---------------------------------------------------------------------------
-- ESPN
-- ---------------------------------------------------------------------------
create or replace function nfl2_espn_get(p_query text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  return cbb_http_get('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' || coalesce(p_query, ''))::jsonb;
end $$;

-- Current season and DB week (postseason weeks are 18 + ESPN week).
create or replace function nfl2_espn_current() returns jsonb
language plpgsql security definer set search_path = public as $$
declare j jsonb; v_type int; v_week int;
begin
  j := nfl2_espn_get('');
  v_type := (j->'season'->>'type')::int;
  v_week := (j->'week'->>'number')::int;
  return jsonb_build_object('season', (j->'season'->>'year')::int, 'season_type', v_type, 'espn_week', v_week,
    'week', case when v_type = 3 then 18 + v_week when v_type = 1 then 1 else v_week end);
end $$;

-- Upserts one ESPN slate into nfl_games. Scores are written only for finals.
create or replace function nfl2_sync_espn_week(p_season int, p_week int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j jsonb; v_type int := case when p_week > 18 then 3 else 2 end; v_ew int := case when p_week > 18 then p_week - 18 else p_week end;
  v_n int; v_unmatched text[];
begin
  if p_week = 22 then return jsonb_build_object('week', p_week, 'skipped', 'pro bowl'); end if;
  j := nfl2_espn_get(format('?dates=%s&seasontype=%s&week=%s&limit=100', p_season, v_type, v_ew));
  drop table if exists _ev;
  create temp table _ev on commit drop as
  select e->>'id' sid, (e->>'date')::timestamptz kick, coalesce((c->>'neutralSite')::boolean, false) neutral,
         nfl2_team(h->'team'->>'displayName') home, nfl2_team(a->'team'->>'displayName') away,
         h->'team'->>'displayName' espn_home, a->'team'->>'displayName' espn_away,
         coalesce((e->'status'->'type'->>'completed')::boolean, false) done,
         nullif(h->>'score', '')::int hs, nullif(a->>'score', '')::int aws,
         (select string_agg(n, '/') from jsonb_array_elements_text(
            coalesce((select b from jsonb_array_elements(c->'broadcasts') b where b->>'market' = 'national' limit 1),
                     c->'broadcasts'->0)->'names') n) tv
  from jsonb_array_elements(j->'events') e
  cross join lateral (select e->'competitions'->0 c) x
  cross join lateral (select co h from jsonb_array_elements(x.c->'competitors') co where co->>'homeAway' = 'home' limit 1) hh
  cross join lateral (select co a from jsonb_array_elements(x.c->'competitors') co where co->>'homeAway' = 'away' limit 1) aa;

  select array_agg(coalesce(espn_away, '?') || ' @ ' || coalesce(espn_home, '?')) into v_unmatched from _ev where home is null or away is null;

  insert into nfl_games (season, week, season_type, game_date, home_team, away_team, neutral_site, tv_network,
                         completed, home_score, away_score, source_game_id)
  select p_season, p_week, case when v_type = 3 then 'POST' else 'REG' end, kick, home, away, neutral, tv,
         done, case when done then hs end, case when done then aws end, sid
  from _ev where home is not null and away is not null
  on conflict (season, week, home_team, away_team) do update set
    game_date = excluded.game_date, neutral_site = excluded.neutral_site,
    tv_network = coalesce(excluded.tv_network, nfl_games.tv_network),
    completed = excluded.completed or nfl_games.completed,
    home_score = coalesce(excluded.home_score, nfl_games.home_score),
    away_score = coalesce(excluded.away_score, nfl_games.away_score),
    source_game_id = excluded.source_game_id
  where nfl_games.game_date is distinct from excluded.game_date
     or nfl_games.tv_network is distinct from coalesce(excluded.tv_network, nfl_games.tv_network)
     or nfl_games.completed is distinct from (excluded.completed or nfl_games.completed)
     or nfl_games.home_score is distinct from coalesce(excluded.home_score, nfl_games.home_score)
     or nfl_games.source_game_id is distinct from excluded.source_game_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('week', p_week, 'events', (select count(*) from _ev), 'changed', v_n, 'unmatched', v_unmatched);
end $$;

-- Days since each team's previous game, for every game of the season.
create or replace function nfl2_rest_days(p_season int) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with tg as (
    select id, game_date, home_team team, true is_home from nfl_games where season = p_season and game_date is not null
    union all
    select id, game_date, away_team, false from nfl_games where season = p_season and game_date is not null),
  r as (select id, is_home, (game_date at time zone 'America/New_York')::date
          - (lag(game_date) over (partition by team order by game_date) at time zone 'America/New_York')::date rest from tg)
  update nfl_games g set
    home_rest_days = coalesce((select rest from r where r.id = g.id and r.is_home), g.home_rest_days),
    away_rest_days = coalesce((select rest from r where r.id = g.id and not r.is_home), g.away_rest_days)
  where g.season = p_season
    and (g.home_rest_days is distinct from (select rest from r where r.id = g.id and r.is_home)
      or g.away_rest_days is distinct from (select rest from r where r.id = g.id and not r.is_home));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- PredictionTracker season archive (backfill + scores)
-- ---------------------------------------------------------------------------
create or replace function nfl2_load_archive(p_season int, p_market text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  yy text := lpad((p_season % 100)::text, 2, '0');
  v_url text := 'https://www.thepredictiontracker.com/' || case when p_market = 'spread' then 'nfl' else 'nfltotals' end || yy || '.csv';
  v_rows int; v_unmatched int; v_lines int; v_scores int := 0; v_preds int;
begin
  drop table if exists _a;
  create temp table _a on commit drop as
    select j, cbb_num(j->>'week')::int wk, nfl2_team(j->>'home') home, nfl2_team(j->>'road') road,
           cbb_num(j->>'line') line, cbb_num(j->>'lineopen') lopen,
           cbb_num(j->>'hscore')::int hs, cbb_num(j->>'rscore')::int rs
    from cbb_parse_csv(cbb_http_get(v_url)) j where j ? 'home' and j ? 'road';
  select count(*) into v_rows from _a;
  if v_rows = 0 then raise exception 'Archive % parsed to zero rows', v_url; end if;

  -- match to nfl_games; PT sometimes lists neutral-site games the other way round
  drop table if exists _m;
  create temp table _m on commit drop as
    select distinct on (a.ctid) a.*, g.id gid, (g.home_team = a.road) flip
    from _a a join nfl_games g on g.season = p_season
      and ((g.home_team = a.home and g.away_team = a.road) or (g.home_team = a.road and g.away_team = a.home))
      and (g.week = a.wk or (a.wk >= 19 and g.week >= 19))
    order by a.ctid, (g.week = a.wk) desc, (g.home_team = a.home) desc;
  v_unmatched := v_rows - (select count(*) from _m);

  if p_market = 'spread' then
    update nfl_games g set
      spread_line = coalesce(g.spread_line, case when m.flip then -m.line else m.line end),
      spread_open = coalesce(g.spread_open, case when m.flip then -m.lopen else m.lopen end)
    from _m m where g.id = m.gid and ((g.spread_line is null and m.line is not null) or (g.spread_open is null and m.lopen is not null));
    get diagnostics v_lines = row_count;
    update nfl_games g set
      home_score = case when m.flip then m.rs else m.hs end, away_score = case when m.flip then m.hs else m.rs end, completed = true
    from _m m where g.id = m.gid and g.home_score is null and m.hs is not null and m.rs is not null
      and (g.game_date is null or g.game_date < now() - interval '4 hours');
    get diagnostics v_scores = row_count;
  else
    update nfl_games g set total_line = coalesce(g.total_line, m.line), total_open = coalesce(g.total_open, m.lopen)
    from _m m where g.id = m.gid and ((g.total_line is null and m.line is not null) or (g.total_open is null and m.lopen is not null));
    get diagnostics v_lines = row_count;
  end if;

  with ins as (
    insert into nfl_raw_predictions (game_id, model_id, market, predicted_line)
    select m.gid, nfl2_model_for(kv.key), p_market,
           case when p_market = 'spread' and m.flip then -cbb_num(kv.value) else cbb_num(kv.value) end
    from _m m cross join lateral jsonb_each_text(m.j) kv
    where not nfl2_skip_col(kv.key) and cbb_num(kv.value) is not null
    on conflict (game_id, model_id, market) do nothing returning 1)
  select count(*) into v_preds from ins;

  return jsonb_build_object('market', p_market, 'rows', v_rows, 'unmatched', v_unmatched,
                            'lines_filled', v_lines, 'scores_added', v_scores, 'preds_added', v_preds);
end $$;

-- ---------------------------------------------------------------------------
-- PredictionTracker live files (this week's slate)
-- ---------------------------------------------------------------------------
-- The live spread file has no week column, so each row is matched to the next
-- unplayed game between those two teams. Nothing changes for a game once it
-- has kicked off: that is the lock.
create or replace function nfl2_ingest_live(p_market text, p_season int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text := 'https://www.thepredictiontracker.com/' || case when p_market = 'spread' then 'nflpredictions.csv' else 'nfltotals.csv' end;
  v_rows int; v_open int; v_line int := 0; v_ins int := 0; v_upd int := 0; v_unmatched text[];
begin
  drop table if exists _l;
  create temp table _l on commit drop as
    select j, nfl2_team(j->>'home') home, nfl2_team(j->>'road') road, cbb_num(j->>'line') line, cbb_num(j->>'lineopen') lopen
    from cbb_parse_csv(cbb_http_get(v_url)) j where j ? 'home' and j ? 'road';
  select count(*) into v_rows from _l;
  if v_rows = 0 then return jsonb_build_object('market', p_market, 'status', 'empty'); end if;

  drop table if exists _lm;
  create temp table _lm on commit drop as
    select distinct on (l.ctid) l.*, l.ctid lrow, g.id gid, (g.home_team = l.road) flip, g.game_date > now() is_open
    from _l l join nfl_games g on g.season = p_season and coalesce(g.completed, false) = false
      and ((g.home_team = l.home and g.away_team = l.road) or (g.home_team = l.road and g.away_team = l.home))
      and g.game_date > now() - interval '5 hours'
    order by l.ctid, g.game_date;
  select array_agg(coalesce(j->>'road', '?') || ' @ ' || coalesce(j->>'home', '?')) into v_unmatched
    from _l where ctid not in (select lrow from _lm);
  select count(*) into v_open from _lm where is_open;
  delete from _lm where not is_open;

  -- lines
  with nl as (select gid, case when p_market = 'spread' and flip then -line else line end line,
                     case when p_market = 'spread' and flip then -lopen else lopen end lopen from _lm where line is not null),
  ch as (
    select g.id, nl.line, case when p_market = 'spread' then g.spread_line else g.total_line end prev, nl.lopen
    from nfl_games g join nl on nl.gid = g.id),
  h as (insert into nfl2_line_history (game_id, market, line, prev_line)
        select id, p_market, line, prev from ch where prev is distinct from line returning game_id)
  select count(*) into v_line from h;
  if p_market = 'spread' then
    update nfl_games g set spread_line = case when m.flip then -m.line else m.line end,
                           spread_open = coalesce(g.spread_open, case when m.flip then -m.lopen else m.lopen end)
    from _lm m where g.id = m.gid and m.line is not null
      and (g.spread_line is distinct from case when m.flip then -m.line else m.line end or g.spread_open is null);
  else
    update nfl_games g set total_line = m.line, total_open = coalesce(g.total_open, m.lopen)
    from _lm m where g.id = m.gid and m.line is not null and (g.total_line is distinct from m.line or g.total_open is null);
  end if;

  -- predictions
  drop table if exists _lp;
  create temp table _lp on commit drop as
    select m.gid, nfl2_model_for(kv.key) mid,
           -- stored as numeric(6,2); round here so unchanged values do not log as changes
           round(case when p_market = 'spread' and m.flip then -cbb_num(kv.value) else cbb_num(kv.value) end, 2) v
    from _lm m cross join lateral jsonb_each_text(m.j) kv
    where not nfl2_skip_col(kv.key) and cbb_num(kv.value) is not null;
  delete from _lp a using _lp b where a.gid = b.gid and a.mid = b.mid and a.ctid > b.ctid;

  insert into nfl2_prediction_history (game_id, model_id, market, value, prev_value)
    select p.gid, p.mid, p_market, p.v, r.predicted_line from _lp p
    join nfl_raw_predictions r on r.game_id = p.gid and r.model_id = p.mid and r.market = p_market
    where r.predicted_line is distinct from p.v;
  update nfl_raw_predictions r set predicted_line = p.v, updated_at = now()
    from _lp p where r.game_id = p.gid and r.model_id = p.mid and r.market = p_market and r.predicted_line is distinct from p.v;
  get diagnostics v_upd = row_count;
  insert into nfl_raw_predictions (game_id, model_id, market, predicted_line)
    select gid, mid, p_market, v from _lp on conflict (game_id, model_id, market) do nothing;
  get diagnostics v_ins = row_count;

  return jsonb_build_object('market', p_market, 'status', 'ok', 'rows', v_rows, 'open_games', v_open,
    'lines_changed', v_line, 'preds_added', v_ins, 'preds_changed', v_upd, 'unmatched', v_unmatched);
end $$;

revoke execute on function nfl2_model_for(text), nfl2_espn_get(text), nfl2_espn_current(), nfl2_sync_espn_week(int, int),
  nfl2_rest_days(int), nfl2_load_archive(int, text), nfl2_ingest_live(text, int) from public, anon, authenticated;
