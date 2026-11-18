-- CFB automation, part 1: tables plus the building blocks the cycle calls.
--
-- Same pattern as CBB and NFL: everything runs inside Postgres on pg_cron and
-- the app only reads. Schedule, kickoffs and finals come from ESPN's public
-- college-football scoreboard (ESPN event ids are the same ids CFBD uses, so
-- they match games.external_game_id directly). Predictions and PT's line come
-- from PredictionTracker's live CSV through the existing cfb_ingest_predictions.

create table if not exists cfb_runs (
  id bigint generated always as identity primary key,
  kind text not null default 'cycle',
  trigger text not null default 'schedule',
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  detail jsonb
);

create table if not exists cfb_refresh_requests (
  id bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  picked_up_at timestamptz,
  run_id bigint
);

-- PT line moves on games that have not kicked off (the line used to compute and grade).
create table if not exists cfb_line_history (
  id bigint generated always as identity primary key,
  game_id uuid not null references games(id) on delete cascade,
  pt_line numeric,
  prev_line numeric,
  seen_at timestamptz not null default now(),
  run_id bigint
);
create index if not exists cfb_line_history_game on cfb_line_history (game_id, seen_at);

alter table cfb_runs enable row level security;
alter table cfb_refresh_requests enable row level security;
alter table cfb_line_history enable row level security;
create policy cfb_runs_read on cfb_runs for select using (true);
create policy cfb_refresh_requests_read on cfb_refresh_requests for select using (true);
create policy cfb_line_history_read on cfb_line_history for select using (true);

-- Season year for a date: Aug-Dec is that year, Jan-Jul is the previous year.
create or replace function cfb_season_now() returns int
language sql stable as $$
  select case when extract(month from (now() at time zone 'America/New_York')) >= 7
              then extract(year from (now() at time zone 'America/New_York'))::int
              else extract(year from (now() at time zone 'America/New_York'))::int - 1 end
$$;

-- PT columns that are not systems.
create or replace function cfb_skip_col(c text) returns boolean
language sql immutable as $$
  select c not like 'line%' or c in ('line', 'lineopen', 'linemidweek', 'lineavg', 'linemedian', 'linestd', 'linecons', 'lineca')
$$;

-- ---------------------------------------------------------------------------
-- ESPN: one scoreboard week. p_type 2 = regular season, 3 = postseason.
-- Postseason weeks are stored as games.week 15 + ESPN week (bowls = 16).
-- Updates kickoff, status, finals, current line / total (unstarted games only)
-- and inserts FBS-vs-FBS games not yet in the table. A team counts as FBS when
-- it already appears in games (which only ever held FBS-vs-FBS games).
-- ---------------------------------------------------------------------------
create or replace function cfb_sync_espn_week(p_season int, p_type int, p_week int)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  j jsonb;
  v_db_week int := case when p_type = 3 then 15 + p_week else p_week end;
  v_events int; v_upd int := 0; v_ins int := 0; v_fin int := 0;
begin
  j := cbb_http_get(format(
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?week=%s&seasontype=%s&year=%s&groups=80&limit=400',
    p_week, p_type, p_season))::jsonb;

  drop table if exists _ev;
  create temp table _ev on commit drop as
  select distinct on (ev->>'id')
    ev->>'id' eid,
    (ev->'competitions'->0->>'date')::timestamptz dt,
    coalesce((ev->'competitions'->0->>'timeValid')::boolean, true) tvalid,
    ev->'competitions'->0->'status'->'type'->>'name' st,
    coalesce((ev->'competitions'->0->'status'->'type'->>'completed')::boolean, false) done,
    (select c->'team'->>'location' from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'home') hname,
    (select c->'team'->>'location' from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'away') aname,
    (select cbb_num(c->>'score')::int from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'home') hs,
    (select cbb_num(c->>'score')::int from jsonb_array_elements(ev->'competitions'->0->'competitors') c where c->>'homeAway' = 'away') aws,
    -cbb_num(ev->'competitions'->0->'odds'->0->>'spread') line,      -- ESPN: negative = home favored
    cbb_num(ev->'competitions'->0->'odds'->0->>'overUnder') ou,
    ev->'competitions'->0->'broadcasts'->0->'names'->>0 tv
  from jsonb_array_elements(coalesce(j->'events', '[]'::jsonb)) ev
  order by ev->>'id';
  select count(*) into v_events from _ev;

  -- TBD kickoff: ESPN gives midnight ET. Use noon ET that day (locks early rather than late).
  update _ev set dt = (((dt at time zone 'America/New_York')::date + time '12:00') at time zone 'America/New_York') where not tvalid;

  -- Finals first, so the count is just the newly finished games.
  update games g set home_score = e.hs, away_score = e.aws, status = 'final'
  from _ev e
  where g.external_game_id = e.eid and e.done and e.st = 'STATUS_FINAL'
    and e.hs is not null and e.aws is not null
    and (g.home_score is distinct from e.hs or g.away_score is distinct from e.aws or g.status is distinct from 'final');
  get diagnostics v_fin = row_count;

  update games g set
    kickoff_at = case when g.status = 'final' or (g.kickoff_at is not null and g.kickoff_at <= now()) then g.kickoff_at
                      when e.tvalid or g.kickoff_at is null then e.dt else g.kickoff_at end,
    status = case when g.status = 'final' then 'final'
                  when e.st in ('STATUS_POSTPONED') then 'postponed'
                  when e.st in ('STATUS_CANCELED', 'STATUS_CANCELLED') then 'canceled'
                  when e.st in ('STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD') then 'in_progress'
                  else coalesce(g.status, 'scheduled') end,
    current_line = case when (g.kickoff_at is null or g.kickoff_at > now()) and e.line is not null then e.line else g.current_line end,
    over_under = case when (g.kickoff_at is null or g.kickoff_at > now()) and e.ou is not null then e.ou else g.over_under end,
    tv_network = coalesce(g.tv_network, e.tv)
  from _ev e
  where g.external_game_id = e.eid
    and row(g.kickoff_at, g.status, g.current_line, g.over_under, g.tv_network) is distinct from row(
      case when g.status = 'final' or (g.kickoff_at is not null and g.kickoff_at <= now()) then g.kickoff_at
           when e.tvalid or g.kickoff_at is null then e.dt else g.kickoff_at end,
      case when g.status = 'final' then 'final'
           when e.st in ('STATUS_POSTPONED') then 'postponed'
           when e.st in ('STATUS_CANCELED', 'STATUS_CANCELLED') then 'canceled'
           when e.st in ('STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD') then 'in_progress'
           else coalesce(g.status, 'scheduled') end,
      case when (g.kickoff_at is null or g.kickoff_at > now()) and e.line is not null then e.line else g.current_line end,
      case when (g.kickoff_at is null or g.kickoff_at > now()) and e.ou is not null then e.ou else g.over_under end,
      coalesce(g.tv_network, e.tv));
  get diagnostics v_upd = row_count;

  -- New games, FBS vs FBS only, named the way games already names each team.
  -- Name used most this season wins (older seasons used PT spellings like "Ohio St.").
  with known as (
    select distinct on (k) k, t
    from (select cfb_team_key(t) k, t, count(*) filter (where season = p_season) n_now, max(season) last_season
          from (select home_team t, season from games union all select away_team, season from games) x
          group by t) y
    order by k, n_now desc, last_season desc
  )
  insert into games (season, week, home_team, away_team, kickoff_at, current_line, over_under, tv_network,
                     external_game_id, home_classification, away_classification, status, home_score, away_score)
  select p_season, v_db_week, kh.t, ka.t, e.dt, e.line, e.ou, e.tv, e.eid, 'fbs', 'fbs',
    case when e.done and e.st = 'STATUS_FINAL' then 'final' else 'scheduled' end,
    case when e.done and e.st = 'STATUS_FINAL' then e.hs end,
    case when e.done and e.st = 'STATUS_FINAL' then e.aws end
  from _ev e
  join known kh on kh.k = cfb_team_key(e.hname)
  join known ka on ka.k = cfb_team_key(e.aname)
  where not exists (select 1 from games g where g.external_game_id = e.eid)
  on conflict do nothing;
  get diagnostics v_ins = row_count;

  drop table if exists _ev;
  return jsonb_build_object('type', p_type, 'week', p_week, 'events', v_events, 'updated', v_upd, 'inserted', v_ins, 'finals', v_fin);
end $$;

-- Which ESPN weeks to sync: ESPN's current week, the one before and after, plus
-- any stored week with a game that has kicked off but has no final score yet.
create or replace function cfb_sync_espn(p_season int)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  j jsonb; v_t int; v_w int; r record; v_out jsonb := '[]'::jsonb; v_res jsonb;
begin
  begin
    j := cbb_http_get('https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=1')::jsonb;
    v_t := (j->'season'->>'type')::int;
    v_w := (j->'week'->>'number')::int;
    if (j->'season'->>'year')::int <> p_season then v_t := null; end if;
  exception when others then v_t := null; end;

  drop table if exists _wk;
  create temp table _wk (t int, w int) on commit drop;
  if v_t = 2 then
    insert into _wk values (2, v_w - 1), (2, v_w), (2, v_w + 1);
    if v_w >= 15 then insert into _wk values (3, 1); end if;
  elsif v_t = 3 then
    insert into _wk values (3, v_w - 1), (3, v_w), (3, v_w + 1);
    if v_w = 1 then insert into _wk values (2, 15); end if;
  end if;
  insert into _wk
  select distinct case when week > 15 then 3 else 2 end, case when week > 15 then week - 15 else week end
  from games where season = p_season and kickoff_at <= now() and actual_margin is null
    and coalesce(status, '') not in ('postponed', 'canceled');

  for r in select distinct t, w from _wk where w >= 1 and ((t = 2 and w <= 16) or (t = 3 and w <= 3)) order by t, w loop
    begin
      v_res := cfb_sync_espn_week(p_season, r.t, r.w);
    exception when others then
      v_res := jsonb_build_object('type', r.t, 'week', r.w, 'error', sqlerrm);
    end;
    v_out := v_out || jsonb_build_array(v_res);
  end loop;
  drop table if exists _wk;

  return jsonb_build_object(
    'espn_type', v_t, 'espn_week', v_w, 'weeks', v_out,
    'updated', (select coalesce(sum((x->>'updated')::int), 0) from jsonb_array_elements(v_out) x),
    'inserted', (select coalesce(sum((x->>'inserted')::int), 0) from jsonb_array_elements(v_out) x),
    'finals', (select coalesce(sum((x->>'finals')::int), 0) from jsonb_array_elements(v_out) x),
    'errors', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v_out) x where x ? 'error'));
end $$;

-- ---------------------------------------------------------------------------
-- Grading: THE Bobby Model signals (cfb_grade, per week), every system's pick
-- (model_pick_grades, for the Weekly results page) and My Card picks
-- (user_picks.result, only where still blank so hand edits are kept).
-- ---------------------------------------------------------------------------
create or replace function cfb_grade_all(p_season int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare wk record; v_sig int := 0; v_n int; v_weeks int[] := '{}'; v_mpg int; v_picks int;
begin
  for wk in
    select distinct s.week from cfb_game_signals s join games g on g.id = s.game_id
    where s.season = p_season and g.actual_margin is not null and s.edge <> 0
      and not exists (select 1 from cfb_signal_grades sg where sg.signal_id = s.id)
    order by s.week
  loop
    v_n := cfb_grade(p_season, wk.week);
    v_sig := v_sig + v_n;
    v_weeks := v_weeks || wk.week;
  end loop;

  insert into model_pick_grades (model_id, game_id, season, week, predicted_margin, vegas_line, actual_margin,
                                 ats_result, abs_error, signed_error, graded_at)
  select r.model_id, g.id, g.season, g.week, r.predicted_margin, g.current_line, g.actual_margin,
    case when r.predicted_margin = g.current_line then 'push'
         when (r.predicted_margin > g.current_line) = (g.actual_margin > g.current_line) and g.actual_margin <> g.current_line then 'win'
         when g.actual_margin = g.current_line then 'push'
         else 'loss' end,
    round(abs(r.predicted_margin - g.actual_margin), 2), round(r.predicted_margin - g.actual_margin, 2), now()
  from raw_predictions r join games g on g.id = r.game_id
  where g.season = p_season and g.actual_margin is not null and g.current_line is not null and r.predicted_margin is not null
    and not exists (select 1 from model_pick_grades m where m.model_id = r.model_id and m.game_id = r.game_id)
  on conflict (model_id, game_id) do nothing;
  get diagnostics v_mpg = row_count;

  update user_picks p set result = x.res, updated_at = now()
  from (
    select p.id,
      case
        when p.pick_type = 'moneyline' then
          case when g.actual_margin = 0 then 'push' when (p.side = 'home') = (g.actual_margin > 0) then 'win' else 'loss' end
        else case sign(c.cover) when 1 then 'win' when -1 then 'loss' else 'push' end
      end res
    from user_picks p
    join games g on g.id = p.game_id
    cross join lateral (select case
        when p.pick_type = 'total' then
          case when p.side = 'over' then (g.home_score + g.away_score) - coalesce(p.line_played, 0)
               else coalesce(p.line_played, 0) - (g.home_score + g.away_score) end
        else (case when p.side = 'home' then g.actual_margin else -g.actual_margin end) + coalesce(p.line_played, 0)
      end cover) c
    where p.played and not coalesce(p.is_custom, false) and coalesce(p.pick_type, 'spread') <> 'custom'
      and p.result is null and g.home_score is not null and g.away_score is not null
  ) x
  where p.id = x.id;
  get diagnostics v_picks = row_count;

  return jsonb_build_object('signals_graded', v_sig, 'weeks', to_jsonb(v_weeks), 'model_picks_graded', v_mpg, 'my_picks_graded', v_picks);
end $$;

-- ---------------------------------------------------------------------------
-- PredictionTracker live CSV: predictions + PT line (+ opener) for games not
-- yet kicked off, through cfb_ingest_predictions (which owns the lock, the
-- history and the run row in cfb_ingest_runs).
-- ---------------------------------------------------------------------------
create or replace function cfb_ingest_live(p_season int, p_run bigint default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_csv text; v_rows jsonb; v_n int; v_cols int; v_res jsonb; v_open int := 0; v_moves int := 0;
begin
  v_csv := cbb_http_get('https://www.thepredictiontracker.com/ncaapredictions.csv');

  drop table if exists _pt;
  create temp table _pt on commit drop as select o from cbb_parse_csv(v_csv) o;
  select count(*) into v_n from _pt;
  if v_n = 0 then raise exception 'PredictionTracker CSV had no rows'; end if;
  if not exists (select 1 from _pt where o ? 'home' and o ? 'road') then raise exception 'PredictionTracker CSV has no Home/Road columns'; end if;
  select count(*) into v_cols from jsonb_object_keys((select o from _pt limit 1)) k where k like 'line%';
  if v_cols < 20 then raise exception 'PredictionTracker CSV has only % line columns', v_cols; end if;

  select jsonb_agg(jsonb_build_object(
      'home', o->>'home', 'road', o->>'road', 'line', o->>'line', 'open', o->>'lineopen',
      'preds', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each_text(o) e(k, v) where not cfb_skip_col(k) and v is not null)))
    into v_rows from _pt;

  drop table if exists _ptl;
  create temp table _ptl on commit drop as
    select id, pt_line from games where season = p_season and (kickoff_at is null or kickoff_at > now());

  drop table if exists _in, _rows, _gm, _todo;
  v_res := cfb_ingest_predictions(p_season, v_rows, false, 'pt-live');

  -- Opener from PT's lineopen, unstarted games only (same as the CSV upload did).
  update games g set opening_line = cbb_num(x.r->>'open')
  from _gm m join jsonb_array_elements(v_rows) with ordinality x(r, ord) on x.ord = m.ord
  where g.id = m.game_id and (g.kickoff_at is null or g.kickoff_at > now())
    and cbb_num(x.r->>'open') is not null and g.opening_line is distinct from cbb_num(x.r->>'open');
  get diagnostics v_open = row_count;
  drop table if exists _in, _rows, _gm, _todo;

  insert into cfb_line_history (game_id, pt_line, prev_line, run_id)
  select g.id, g.pt_line, b.pt_line, p_run from games g join _ptl b on b.id = g.id
  where g.pt_line is distinct from b.pt_line;
  get diagnostics v_moves = row_count;
  drop table if exists _ptl, _pt;

  return v_res || jsonb_build_object('csv_rows', v_n, 'line_columns', v_cols, 'openers_set', v_open, 'lines_moved', v_moves);
end $$;

-- PredictionTracker season file (ncaaYYYY.csv): fills predictions missing on
-- completed games (late posters), which feeds the weights. Never overwrites.
create or replace function cfb_load_season_file(p_season int)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_csv text; v_rows jsonb; v_res jsonb;
begin
  v_csv := cbb_http_get(format('https://www.thepredictiontracker.com/ncaa%s.csv', p_season));
  select jsonb_agg(jsonb_build_object('home', o->>'home', 'road', o->>'road',
      'preds', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each_text(o) e(k, v) where not cfb_skip_col(k) and v is not null)))
    into v_rows
  from cbb_parse_csv(v_csv) o
  where o->>'hscore' is not null and o->>'vscore' is not null;
  drop table if exists _in, _rows, _gm, _todo;
  v_res := cfb_ingest_predictions(p_season, coalesce(v_rows, '[]'::jsonb), true, 'pt-season');
  drop table if exists _in, _rows, _gm, _todo;
  return v_res - 'unmatched';   -- FCS opponents are expected to be unmatched
end $$;

revoke execute on function cfb_sync_espn_week(int, int, int), cfb_sync_espn(int), cfb_grade_all(int),
  cfb_ingest_live(int, bigint), cfb_load_season_file(int) from public, anon, authenticated;
