-- Outside picks ("scout") for CBB and NFL: one intake pipeline for the scheduled
-- article import and the on-demand agents.
--
-- Flow (import):
--   pg_cron -> scout_kick(sport)            one run, one 'hub' job per active source
--   pg_cron -> scout_dispatch() every min   sends queued jobs to /api/scout/job (pg_net, async)
--   hub job      site reads the source's listing page, picks today's picks articles,
--                scout_add_articles() queues one 'article' job each (skips ones read recently)
--   article job  site reads the article, Claude extracts picks against scout_slate,
--                scout_submit() validates and stores them in scout_picks
--   scout_dispatch() closes the run once no job is queued or in flight.
-- Flow (agent): scout_agent_start() -> scout_submit(...) per batch -> scout_agent_finish().
--
-- Matching: the model is given the slate (scout_slate) and answers with a game
-- number and the team name copied from the list, so the site maps picks to
-- game ids directly. scout_submit then checks every spread against the market
-- line and marks big gaps as 'check' (usually the wrong side or wrong game).
-- Picks for games not on the slate are kept as 'unmatched' for review.
--
-- No shared secret: the site claims a job (scout_job_claim) before working on
-- it, and only a job the dispatcher sent in the last 5 minutes can be claimed.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists scout_config (
  key text primary key,
  value text not null,
  note text
);

insert into scout_config (key, value, note) values
  ('base_url', 'https://bobbymodels.app', 'Site that serves /api/scout/job'),
  ('dispatch_per_minute', '6', 'Jobs sent to the site per minute'),
  ('reextract_hours', '3', 'An article read this recently is not read again'),
  ('max_articles_per_source', '3', 'Articles taken from one source per run'),
  ('manual_cooldown_minutes', '10', 'Minimum gap between pulls of one sport (Pull picks now)'),
  ('manual_daily_cap', '8', 'Pull picks now presses allowed per sport per ET day'),
  ('line_tol_cbb', '4', 'Spread gap to the market line that marks a CBB pick "check"'),
  ('line_tol_nfl', '3', 'Spread gap to the market line that marks an NFL pick "check"'),
  ('total_tol_nfl', '4', 'Total gap to the market total that marks an NFL pick "check"'),
  ('model_links', 'claude-haiku-5-5', 'Model that picks articles from a listing page'),
  ('model_extract', 'claude-sonnet-5-5', 'Model that reads an article into picks')
on conflict (key) do nothing;

create table if not exists scout_sources (
  id serial primary key,
  sport text not null check (sport in ('cbb', 'nfl', 'cfb')),
  name text not null,
  hub_url text,
  active boolean not null default true,
  sort_order int not null default 100,
  note text,
  last_status text,
  last_checked_at timestamptz,
  last_error text,
  unique (sport, name)
);

create table if not exists scout_runs (
  id bigserial primary key,
  sport text not null check (sport in ('cbb', 'nfl', 'cfb')),
  origin text not null check (origin in ('import', 'agent')),
  trigger text not null check (trigger in ('scheduled', 'manual', 'agent')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'error')),
  note text
);
create index if not exists scout_runs_sport on scout_runs (sport, id desc);

create table if not exists scout_jobs (
  id bigserial primary key,
  run_id bigint not null references scout_runs on delete cascade,
  sport text not null,
  kind text not null check (kind in ('hub', 'article')),
  source_id int references scout_sources on delete set null,
  url text,
  title text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'done', 'error', 'skipped')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error text
);
create index if not exists scout_jobs_queue on scout_jobs (status, id);
create index if not exists scout_jobs_run on scout_jobs (run_id);
create index if not exists scout_jobs_url on scout_jobs (sport, url, finished_at desc) where kind = 'article';

create table if not exists scout_picks (
  id bigserial primary key,
  sport text not null check (sport in ('cbb', 'nfl', 'cfb')),
  run_id bigint references scout_runs on delete set null,
  job_id bigint references scout_jobs on delete set null,
  origin text not null check (origin in ('import', 'agent')),
  source_id int references scout_sources on delete set null,
  source_name text not null,
  expert text,
  game_id bigint,                -- cbb_games.id or nfl_games.id; null when unmatched
  game_date date,
  market text not null check (market in ('spread', 'total', 'moneyline', 'team_total')),
  period text not null default 'full',
  side text check (side in ('home', 'away', 'over', 'under')),
  ou text check (ou in ('over', 'under')),   -- team totals only
  line numeric,                  -- as written: the picked team's spread, or the total
  home_line numeric,             -- spreads: the same number home-relative (+3 = home favored)
  odds int,
  market_line numeric,           -- the game's line (spread home-relative, or total) when stored
  team_text text,                -- team as the source wrote it
  pick_text text,
  url text,
  status text not null default 'ok' check (status in ('ok', 'check', 'unmatched')),
  check_reason text,
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists scout_picks_game on scout_picks (sport, game_id);
create index if not exists scout_picks_recent on scout_picks (sport, created_at desc);

alter table scout_config enable row level security;
alter table scout_sources enable row level security;
alter table scout_runs enable row level security;
alter table scout_jobs enable row level security;
alter table scout_picks enable row level security;
create policy scout_config_read on scout_config for select using (true);
create policy scout_sources_read on scout_sources for select using (true);
create policy scout_runs_read on scout_runs for select using (true);
create policy scout_jobs_read on scout_jobs for select using (true);
create policy scout_picks_read on scout_picks for select using (true);

-- ---------------------------------------------------------------------------
-- Sources (listing pages). Edit freely; inactive ones are skipped.
-- ---------------------------------------------------------------------------

insert into scout_sources (sport, name, hub_url, sort_order, note) values
  ('cbb', 'VSIN', 'https://vsin.com/college-basketball/', 10, 'Daily picks article (Adam Burke, Greg Peterson) plus game predictions'),
  ('cbb', 'Action Network', 'https://www.actionnetwork.com/ncaab', 20, 'Daily staff best bets'),
  ('cbb', 'Covers', 'https://www.covers.com/ncaab', 30, 'Daily top picks roundup'),
  ('cbb', 'RotoWire', 'https://www.rotowire.com/cbasketball/', 40, 'Daily best bets'),
  ('cbb', 'Sportsbook Review', 'https://www.sportsbookreview.com/picks/ncaa-basketball/', 50, 'Daily best bets'),
  ('cbb', 'Pickswise', 'https://www.pickswise.com/college-basketball/', 60, 'Daily best bets'),
  ('cbb', 'BetSided', 'https://fansided.com/betsided/', 70, 'Mixed sports listing; the model keeps CBB only'),
  ('nfl', 'ESPN', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=100', 10, 'ESPN news API (the betting page needs JavaScript)'),
  ('nfl', 'CBS Sports', 'https://www.cbssports.com/nfl/', 20, 'Expert picks and best bets'),
  ('nfl', 'Action Network', 'https://www.actionnetwork.com/nfl', 30, 'Expert picks'),
  ('nfl', 'VSIN', 'https://vsin.com/nfl/', 40, 'Best bets'),
  ('nfl', 'Covers', 'https://www.covers.com/nfl', 50, 'Picks against the spread'),
  ('nfl', 'SI Betting', 'https://www.si.com/betting', 60, 'ATS picks for every game'),
  ('nfl', 'Fox Sports', 'https://www.foxsports.com/nfl', 70, 'Will''s Wagers and others'),
  ('nfl', 'Yahoo', 'https://sports.yahoo.com/nfl/', 80, 'Weekly picks'),
  ('nfl', 'Pickswise', 'https://www.pickswise.com/nfl/', 90, 'Best bets')
on conflict (sport, name) do nothing;

-- ---------------------------------------------------------------------------
-- Slate: the games a pick can be matched to
-- ---------------------------------------------------------------------------

create or replace view scout_slate as
  select 'cbb'::text as sport, g.id as game_id, g.game_date, g.tip_time as start_time,
         g.road as away, g.home, g.line as home_line, null::numeric as total, g.neutral
    from cbb_games g
   where g.game_date between (now() at time zone 'America/New_York')::date
                         and (now() at time zone 'America/New_York')::date + 1
     and g.home_score is null
  union all
  select 'nfl', g.id, (g.game_date at time zone 'America/New_York')::date, g.game_date,
         g.away_team, g.home_team, g.spread_line, g.total_line, coalesce(g.neutral_site, false)
    from nfl_games g
   where g.game_date between now() - interval '6 hours' and now() + interval '6 days'
     and not coalesce(g.completed, false);

-- ---------------------------------------------------------------------------
-- Store picks (import route and agents)
-- ---------------------------------------------------------------------------

create or replace function scout_expert_key(p text) returns text
language sql immutable as $$
  select lower(coalesce(nullif(regexp_replace(trim(coalesce(p, '')), '^.*\s', ''), ''), ''))
$$;

-- p_picks: [{game_id, market, period, side, ou, line, odds, expert, team_text, text,
--            source_name?, url?, reason?}]
--   side: home|away for spread/moneyline/team_total, over|under for total.
create or replace function scout_submit(
  p_sport text, p_run_id bigint, p_job_id bigint, p_origin text,
  p_source_id int, p_source_name text, p_url text, p_picks jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  v_tol numeric := coalesce((select value::numeric from scout_config where key = 'line_tol_' || p_sport), 4);
  v_ttol numeric := coalesce((select value::numeric from scout_config where key = 'total_tol_' || p_sport), 4);
  v_added int := 0; v_dup int := 0; v_unm int := 0; v_chk int := 0; v_bad int := 0; v_n int;
  v_gid bigint; v_date date; v_gline numeric; v_gtotal numeric; v_found boolean;
  v_market text; v_period text; v_side text; v_ou text; v_line numeric; v_odds int;
  v_home_line numeric; v_mline numeric; v_status text; v_reason text; v_src text; v_exp text; v_key text; v_url text;
begin
  if p_sport not in ('cbb', 'nfl') then raise exception 'scout_submit: unknown sport %', p_sport; end if;
  for r in select * from jsonb_array_elements(coalesce(p_picks, '[]'::jsonb)) loop
    v_market := lower(coalesce(nullif(r->>'market', ''), 'spread'));
    v_period := lower(coalesce(nullif(r->>'period', ''), 'full'));
    v_side := lower(nullif(r->>'side', ''));
    v_ou := lower(nullif(r->>'ou', ''));
    v_line := case when (r->>'line') ~ '^\s*[-+]?[0-9]*\.?[0-9]+\s*$' then (r->>'line')::numeric end;
    v_odds := case when (r->>'odds') ~ '^\s*[-+]?[0-9]+\s*$' then (r->>'odds')::int end;
    v_src := coalesce(nullif(trim(r->>'source_name'), ''), nullif(trim(p_source_name), ''), 'Unknown');
    v_exp := nullif(trim(r->>'expert'), '');
    v_url := coalesce(nullif(r->>'url', ''), p_url);
    v_gid := case when (r->>'game_id') ~ '^\s*[0-9]+\s*$' then (r->>'game_id')::bigint end;
    v_status := 'ok'; v_reason := null; v_home_line := null; v_mline := null; v_date := null;
    v_gline := null; v_gtotal := null; v_found := false;

    if v_market not in ('spread', 'total', 'moneyline', 'team_total') then
      v_bad := v_bad + 1;
      continue;
    end if;
    if v_market <> 'team_total' then v_ou := null; end if;

    if v_gid is not null then
      if p_sport = 'cbb' then
        select true, g.game_date, g.line, null::numeric into v_found, v_date, v_gline, v_gtotal
          from cbb_games g where g.id = v_gid;
      else
        select true, (g.game_date at time zone 'America/New_York')::date, g.spread_line, g.total_line
          into v_found, v_date, v_gline, v_gtotal from nfl_games g where g.id = v_gid;
      end if;
    end if;

    if not coalesce(v_found, false) then
      -- kept for review; the side may be unknown
      v_gid := null; v_status := 'unmatched';
      v_reason := coalesce(nullif(r->>'reason', ''), 'game not on the slate');
      if v_side not in ('home', 'away', 'over', 'under') then v_side := null; end if;
      if v_ou not in ('over', 'under') then v_ou := null; end if;
    elsif (v_market = 'total' and coalesce(v_side, '') not in ('over', 'under'))
       or (v_market <> 'total' and coalesce(v_side, '') not in ('home', 'away'))
       or (v_market = 'team_total' and coalesce(v_ou, '') not in ('over', 'under')) then
      v_bad := v_bad + 1;
      continue;
    elsif v_market = 'spread' and v_period = 'full' then
      if v_line is not null then
        v_home_line := case v_side when 'home' then -v_line else v_line end;
      end if;
      v_mline := v_gline;
      if v_home_line is not null and v_mline is not null then
        if abs(v_home_line - v_mline) > v_tol then
          v_status := 'check';
          v_reason := format('line %s vs market %s (wrong side or game?)', v_home_line, v_mline);
        elsif sign(v_home_line) <> sign(v_mline) and abs(v_home_line) >= 1.5 and abs(v_mline) >= 1.5 then
          v_status := 'check';
          v_reason := format('favorite flipped: %s vs market %s', v_home_line, v_mline);
        end if;
      end if;
    elsif v_market = 'total' and v_period = 'full' then
      v_mline := v_gtotal;
      if v_line is not null and v_mline is not null and abs(v_line - v_mline) > v_ttol then
        v_status := 'check';
        v_reason := format('total %s vs market %s', v_line, v_mline);
      end if;
    end if;

    if v_status = 'unmatched' then
      v_key := p_sport || '|u|' || md5(lower(v_src) || '|' || scout_expert_key(v_exp) || '|' || lower(coalesce(r->>'text', '')));
    else
      v_key := concat_ws('|', p_sport, v_gid, v_market, v_period, v_side, coalesce(v_ou, '-'), lower(v_src), scout_expert_key(v_exp));
    end if;

    insert into scout_picks (sport, run_id, job_id, origin, source_id, source_name, expert, game_id, game_date,
                             market, period, side, ou, line, home_line, odds, market_line, team_text, pick_text, url,
                             status, check_reason, dedupe_key)
    values (p_sport, p_run_id, p_job_id, p_origin, p_source_id, v_src, v_exp, v_gid, v_date,
            v_market, v_period, v_side, v_ou, v_line, v_home_line, v_odds, v_mline,
            left(nullif(r->>'team_text', ''), 80), left(nullif(r->>'text', ''), 200), v_url,
            v_status, v_reason, v_key)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then v_dup := v_dup + 1;
    else
      v_added := v_added + 1;
      if v_status = 'unmatched' then v_unm := v_unm + 1; elsif v_status = 'check' then v_chk := v_chk + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'duplicates', v_dup, 'unmatched', v_unm, 'check', v_chk, 'invalid', v_bad);
end $$;

-- ---------------------------------------------------------------------------
-- Runs and jobs
-- ---------------------------------------------------------------------------

create or replace function scout_kick(p_sport text, p_trigger text default 'scheduled') returns bigint
language plpgsql security definer set search_path = public as $$
declare v_run bigint; v_n int;
begin
  insert into scout_runs (sport, origin, trigger) values (p_sport, 'import', p_trigger) returning id into v_run;
  insert into scout_jobs (run_id, sport, kind, source_id, url)
    select v_run, p_sport, 'hub', s.id, s.hub_url from scout_sources s
     where s.sport = p_sport and s.active and s.hub_url is not null
     order by s.sort_order, s.id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    update scout_runs set status = 'error', finished_at = now(), note = 'No active sources' where id = v_run;
  end if;
  return v_run;
end $$;

-- "Pull picks now". Callable with the public key, so it is throttled and capped.
create or replace function scout_request_run(p_sport text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cool int := coalesce((select value::int from scout_config where key = 'manual_cooldown_minutes'), 10);
  v_cap int := coalesce((select value::int from scout_config where key = 'manual_daily_cap'), 8);
  v_run bigint;
begin
  if p_sport not in ('cbb', 'nfl') then
    return jsonb_build_object('status', 'error', 'message', 'Unknown sport.');
  end if;
  select id into v_run from scout_runs
   where sport = p_sport and origin = 'import' and status = 'running' and started_at > now() - interval '30 minutes'
   order by id desc limit 1;
  if v_run is not null then
    return jsonb_build_object('status', 'running', 'run_id', v_run, 'message', 'A picks pull is already running.');
  end if;
  if exists (select 1 from scout_runs where sport = p_sport and origin = 'import'
              and started_at > now() - make_interval(mins => v_cool)) then
    return jsonb_build_object('status', 'throttled', 'message', format('Picks were pulled in the last %s minutes. Try again shortly.', v_cool));
  end if;
  if (select count(*) from scout_runs where sport = p_sport and origin = 'import' and trigger = 'manual'
       and (started_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date) >= v_cap then
    return jsonb_build_object('status', 'capped', 'message', format('Daily limit of %s manual pulls reached.', v_cap));
  end if;
  v_run := scout_kick(p_sport, 'manual');
  return jsonb_build_object('status', 'queued', 'run_id', v_run);
end $$;

-- Called by the site after a hub job: queue the chosen articles.
-- p_articles: [{url, title}]
create or replace function scout_add_articles(p_job_id bigint, p_articles jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j scout_jobs; a jsonb; v_added int := 0; v_skipped int := 0; v_url text;
  v_hours int := coalesce((select value::int from scout_config where key = 'reextract_hours'), 3);
begin
  select * into j from scout_jobs where id = p_job_id;
  if j.id is null then raise exception 'scout_add_articles: job % not found', p_job_id; end if;
  for a in select * from jsonb_array_elements(coalesce(p_articles, '[]'::jsonb)) loop
    v_url := nullif(trim(a->>'url'), '');
    if v_url is null then continue; end if;
    if exists (select 1 from scout_jobs x where x.sport = j.sport and x.kind = 'article' and x.url = v_url
                 and (x.status in ('queued', 'sent')
                      or (x.status = 'done' and x.finished_at > now() - make_interval(hours => v_hours)))) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into scout_jobs (run_id, sport, kind, source_id, url, title)
      values (j.run_id, j.sport, 'article', j.source_id, v_url, left(nullif(a->>'title', ''), 200));
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('queued', v_added, 'skipped_recent', v_skipped);
end $$;

create or replace function scout_job_finish(p_job_id bigint, p_status text, p_result jsonb, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
declare j scout_jobs;
begin
  update scout_jobs set status = p_status, result = p_result, error = left(p_error, 500), finished_at = now()
   where id = p_job_id returning * into j;
  if j.kind = 'hub' and j.source_id is not null then
    update scout_sources set last_status = p_status, last_checked_at = now(), last_error = left(p_error, 500)
     where id = j.source_id;
  end if;
end $$;

-- The site claims a job before working on it. Only a job the dispatcher sent in
-- the last 5 minutes, and nobody has claimed, can be claimed, so the public
-- route cannot start work the database did not queue, and a job never runs twice.
create or replace function scout_job_claim(p_job_id bigint) returns scout_jobs
language plpgsql security definer set search_path = public as $$
declare j scout_jobs;
begin
  update scout_jobs set claimed_at = now()
   where id = p_job_id and status = 'sent' and claimed_at is null and sent_at > now() - interval '5 minutes'
  returning * into j;
  return j;
end $$;

-- Every minute: retry or fail stuck jobs, send queued jobs, close finished runs.
create or replace function scout_dispatch() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_base text := (select value from scout_config where key = 'base_url');
  v_per int := coalesce((select value::int from scout_config where key = 'dispatch_per_minute'), 6);
  v_sent int := 0; j record;
begin
  update scout_jobs set status = case when attempts < 2 then 'queued' else 'error' end,
         claimed_at = null,
         error = case when attempts < 2 then error else 'No reply from the site after 2 tries' end
   where status = 'sent' and sent_at < now() - interval '4 minutes';

  for j in select id from scout_jobs where status = 'queued' order by id limit v_per for update skip locked loop
    perform net.http_post(
      url := v_base || '/api/scout/job',
      body := jsonb_build_object('job_id', j.id),
      headers := jsonb_build_object('content-type', 'application/json'),
      timeout_milliseconds := 65000
    );
    update scout_jobs set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = j.id;
    v_sent := v_sent + 1;
  end loop;

  update scout_runs r
     set finished_at = now(),
         status = case
           when not exists (select 1 from scout_jobs x where x.run_id = r.id and x.status in ('done', 'skipped')) then 'error'
           when exists (select 1 from scout_jobs x where x.run_id = r.id and x.status = 'error') then 'partial'
           else 'ok' end
   where r.status = 'running' and r.origin = 'import'
     and (not exists (select 1 from scout_jobs x where x.run_id = r.id and x.status in ('queued', 'sent'))
          or r.started_at < now() - interval '45 minutes');

  return jsonb_build_object('sent', v_sent);
end $$;

-- Agents: open a run, submit with scout_submit(sport, run_id, null, 'agent', null, <source>, <url>, picks), close it.
create or replace function scout_agent_start(p_sport text, p_note text default null) returns bigint
language sql security definer set search_path = public as $$
  insert into scout_runs (sport, origin, trigger, note) values (p_sport, 'agent', 'agent', p_note) returning id
$$;

create or replace function scout_agent_finish(p_run_id bigint, p_status text default 'ok', p_note text default null)
returns void language sql security definer set search_path = public as $$
  update scout_runs set status = p_status, finished_at = now(), note = coalesce(p_note, note) where id = p_run_id
$$;

-- ---------------------------------------------------------------------------
-- Views for the pages
-- ---------------------------------------------------------------------------

create or replace view scout_run_log as
  select r.id, r.sport, r.origin, r.trigger, r.started_at, r.finished_at, r.status, r.note,
         (select count(*) from scout_jobs j where j.run_id = r.id and j.kind = 'hub') as sources,
         (select count(*) from scout_jobs j where j.run_id = r.id and j.kind = 'article') as articles,
         (select count(*) from scout_jobs j where j.run_id = r.id and j.status = 'error') as errors,
         (select count(*) from scout_picks p where p.run_id = r.id) as picks,
         (select count(*) from scout_picks p where p.run_id = r.id and p.status = 'unmatched') as unmatched,
         (select count(*) from scout_picks p where p.run_id = r.id and p.status = 'check') as checks,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'kind', j.kind, 'source', s.name, 'url', j.url, 'title', j.title, 'status', j.status,
                   'error', j.error, 'result', j.result) order by j.id), '[]'::jsonb)
            from scout_jobs j left join scout_sources s on s.id = j.source_id where j.run_id = r.id) as jobs
    from scout_runs r;

create or replace view scout_pick_list as
  select p.*,
         coalesce(cg.road, ng.away_team) as away,
         coalesce(cg.home, ng.home_team) as home,
         coalesce(cg.tip_time, ng.game_date) as start_time
    from scout_picks p
    left join cbb_games cg on p.sport = 'cbb' and cg.id = p.game_id
    left join nfl_games ng on p.sport = 'nfl' and ng.id = p.game_id;

-- ---------------------------------------------------------------------------
-- Privileges: only "Pull picks now" is open to the public key.
-- ---------------------------------------------------------------------------

revoke all on function scout_submit(text, bigint, bigint, text, int, text, text, jsonb) from public, anon, authenticated;
revoke all on function scout_kick(text, text) from public, anon, authenticated;
revoke all on function scout_add_articles(bigint, jsonb) from public, anon, authenticated;
revoke all on function scout_job_finish(bigint, text, jsonb, text) from public, anon, authenticated;
revoke all on function scout_dispatch() from public, anon, authenticated;
revoke all on function scout_job_claim(bigint) from public, anon, authenticated;
revoke all on function scout_agent_start(text, text) from public, anon, authenticated;
revoke all on function scout_agent_finish(bigint, text, text) from public, anon, authenticated;
grant execute on function scout_submit(text, bigint, bigint, text, int, text, text, jsonb) to service_role;
grant execute on function scout_kick(text, text) to service_role;
grant execute on function scout_add_articles(bigint, jsonb) to service_role;
grant execute on function scout_job_finish(bigint, text, jsonb, text) to service_role;
grant execute on function scout_dispatch() to service_role;
grant execute on function scout_job_claim(bigint) to service_role;
grant execute on function scout_agent_start(text, text) to service_role;
grant execute on function scout_agent_finish(bigint, text, text) to service_role;
grant execute on function scout_request_run(text) to anon, authenticated, service_role;
