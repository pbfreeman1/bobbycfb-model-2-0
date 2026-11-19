-- CBB tip times from ESPN.
--
-- PredictionTracker has no game times, so each cbb_cycle also reads the ESPN
-- men's college basketball scoreboard for the slate date and stamps
-- cbb_games.tip_time. A team plays once a day, so one matching team is
-- enough to place a game; cbb_team_alias covers names the two sources spell
-- differently. Times are display only and never feed cbb_compute.

alter table cbb_games
  add column if not exists tip_time timestamptz,
  add column if not exists espn_id text;

create table if not exists cbb_team_alias (
  pt_name text primary key,          -- name as PredictionTracker writes it
  espn_location text not null,       -- ESPN team "location"
  note text
);
alter table cbb_team_alias enable row level security;
drop policy if exists "cbb_team_alias read" on cbb_team_alias;
create policy "cbb_team_alias read" on cbb_team_alias for select using (true);

insert into cbb_team_alias (pt_name, espn_location) values
  ('Albany-NY', 'UAlbany'), ('Appalachian St.', 'App State'), ('Arkansas-Little Rock', 'Little Rock'),
  ('Boston', 'Boston University'), ('CS Bakersfield', 'Cal State Bakersfield'), ('CS Northridge', 'Cal State Northridge'),
  ('CS Sacramento', 'Sacramento State'), ('Cal Poly SLO', 'Cal Poly'), ('Cal Riverside', 'UC Riverside'),
  ('Cal St. Fullerton', 'Cal State Fullerton'), ('Central Conn. St.', 'Central Connecticut'), ('Central Florida', 'UCF'),
  ('Citadel', 'The Citadel'), ('Connecticut', 'UConn'), ('Detroit', 'Detroit Mercy'), ('Grambling St.', 'Grambling'),
  ('IPFW', 'Purdue Fort Wayne'), ('Illinois-Chicago', 'UIC'), ('LIU Brooklyn', 'Long Island University'),
  ('Louisiana-Lafayette', 'Louisiana'), ('Louisiana-Monroe', 'UL Monroe'), ('MD Baltimore Co', 'UMBC'),
  ('McNeese St.', 'McNeese'), ('Md. Eastern Shore', 'Maryland Eastern Shore'), ('Miami-Florida', 'Miami'),
  ('Miami-Ohio', 'Miami (OH)'), ('Middle Tenn St.', 'Middle Tennessee'), ('Mississippi', 'Ole Miss'),
  ('Mo Kansas City', 'Kansas City'), ('NC Asheville', 'UNC Asheville'), ('NC Charlotte', 'Charlotte'),
  ('NC Greensboro', 'UNC Greensboro'), ('NC Wilmington', 'UNC Wilmington'), ('Nebraska Omaha', 'Omaha'),
  ('New Orleans', 'LSU New Orleans'), ('Nicholls St.', 'Nicholls'), ('North Carolina St.', 'NC State'),
  ('SE Missouri St.', 'Southeast Missouri State'), ('SW Missouri St.', 'Missouri State'), ('Sam Houston St.', 'Sam Houston'),
  ('San Jose St.', 'San José State'), ('Seattle', 'Seattle U'), ('South Carolina Upstat', 'South Carolina Upstate'),
  ('St. Joseph''s PA', 'Saint Joseph''s'), ('St. Mary''s', 'Saint Mary''s'), ('St. Peter''s', 'Saint Peter''s'),
  ('St. Thomas (Mn)', 'St. Thomas'), ('Tennessee-Martin', 'UT Martin'), ('Texas A&M Corpus', 'Texas A&M-Corpus Christi'),
  ('Texas Arlington', 'UT Arlington'), ('Texas San Antonio', 'UTSA'), ('Troy St.', 'Troy'),
  ('VA Commonwealth', 'VCU'), ('Wisconsin-Green Bay', 'Green Bay'), ('Wisconsin-Milwaukee', 'Milwaukee')
on conflict (pt_name) do nothing;

-- Lowercase, drop punctuation, trailing "St" -> "State" ("Murray St." = "Murray State").
create or replace function cbb_tnorm(t text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    lower(coalesce(t, '')), '[.''’()]', '', 'g'), '[-&/]', ' ', 'g'), '\s+', ' ', 'g'), ' st$', ' state')
$$;

create or replace function cbb_sync_tips(p_date date) returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare j jsonb; v_n int; v_events int; v_missing text[];
begin
  j := cbb_http_get('https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates='
                    || to_char(p_date, 'YYYYMMDD') || '&groups=50&limit=500')::jsonb;
  v_events := jsonb_array_length(coalesce(j->'events', '[]'));

  with ev as (
    select e->>'id' eid,
           case when coalesce((e->'competitions'->0->>'timeValid')::boolean, true) then (e->>'date')::timestamptz end tip,
           cbb_tnorm(co->'team'->>'location') loc, cbb_tnorm(co->'team'->>'shortDisplayName') sh,
           cbb_tnorm(co->'team'->>'abbreviation') ab
    from jsonb_array_elements(coalesce(j->'events', '[]')) e
    cross join lateral jsonb_array_elements(e->'competitions'->0->'competitors') co
  ), teams as (
    select g.id, cbb_tnorm(coalesce(a.espn_location, x.name)) n
    from cbb_games g
    cross join lateral (values (g.home), (g.road)) x(name)
    left join cbb_team_alias a on a.pt_name = x.name
    where g.game_date = p_date
  ), m as (
    select t.id, min(ev.eid) eid, min(ev.tip) tip, count(distinct ev.eid) k
    from teams t join ev on t.n in (ev.loc, ev.sh, ev.ab)
    group by t.id
  )
  update cbb_games g set tip_time = m.tip, espn_id = m.eid
  from m
  where m.id = g.id and m.k = 1
    and (g.tip_time is distinct from m.tip or g.espn_id is distinct from m.eid);
  get diagnostics v_n = row_count;

  select array_agg(road || ' @ ' || home order by home) into v_missing
  from cbb_games where game_date = p_date and espn_id is null;

  return jsonb_build_object('date', p_date, 'events', v_events, 'updated', v_n, 'unmatched', coalesce(v_missing, '{}'));
end $$;
revoke all on function cbb_sync_tips(date) from public, anon, authenticated;

-- Same cycle as before, plus a non-fatal tip-time pass for the slate date.
create or replace function public.cbb_cycle(p_trigger text default 'schedule'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_today date := cbb_today(); v_run bigint; v_arch jsonb; v_live jsonb; v_graded int := 0; v_sig int := 0; v_err text; v_date date;
  v_tips jsonb;
begin
  insert into cbb_runs (kind, status, trigger) values ('cycle', 'running', p_trigger) returning id into v_run;
  begin
    v_arch := cbb_load_archive(cbb_season(v_today));
    v_graded := cbb_grade(v_today - 14);
    if (v_arch->>'scores_updated')::int > 0 or (v_arch->>'new_games')::int > 0
       or not exists (select 1 from cbb_system_weights where as_of_date = v_today) then
      perform cbb_recalibrate(v_today);
    end if;
  exception when others then v_err := 'archive/grade: ' || sqlerrm; end;
  begin
    v_live := cbb_ingest_live();
    if v_live->>'status' = 'ok' then
      v_date := (v_live->>'page_date')::date;
      v_sig := cbb_compute(v_date);
    end if;
  exception when others then v_err := concat_ws(' | ', v_err, 'live: ' || sqlerrm); end;
  begin
    v_tips := cbb_sync_tips(coalesce(v_date, v_today));
  exception when others then v_tips := jsonb_build_object('error', sqlerrm); end;
  update cbb_runs set finished_at = now(), status = case when v_err is null then 'ok' else 'error' end,
    detail = jsonb_build_object('archive', v_arch, 'graded', v_graded, 'live', v_live, 'signals', v_sig, 'error', v_err,
                                'tips', v_tips, 'run_id', v_run) where id = v_run;
  return (select detail from cbb_runs where id = v_run);
end $function$;

-- cbb_board: unchanged, with tip_time appended.
create or replace view cbb_board as
 select g.id as game_id, g.game_date, g.season, g.home, g.road, g.neutral, g.open_line, g.line, g.line_first,
    g.home_score, g.road_score, g.actual_margin, g.source,
    s.consensus, s.edge, s.pick_side, s.pick_team, s.vote_share, s.std_dev, s.conviction, s.voters, s.coverage,
    s.tier, s.units, s.score, s.rank_in_day, s.flags, s.computed_at,
    gr.result, gr.units_result, gr.cover_by,
    (select jsonb_agg(jsonb_build_object('system', sy.name, 'margin', p.margin, 'weight', coalesce(w.weight, 0::numeric), 'status', sy.status)
              order by (coalesce(w.weight, 0::numeric)) desc, sy.name)
       from cbb_predictions p
         join cbb_systems sy on sy.id = p.system_id
         left join cbb_system_weights w on w.system_id = p.system_id and w.as_of_date = ((select max(cbb_system_weights.as_of_date)
               from cbb_system_weights where cbb_system_weights.as_of_date <= g.game_date))
      where p.game_id = g.id) as systems,
    g.tip_time
   from cbb_games g
     left join cbb_signals s on s.game_id = g.id
     left join cbb_signal_grades gr on gr.game_id = g.id;
