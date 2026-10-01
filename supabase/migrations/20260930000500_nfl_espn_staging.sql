-- TRANSIENT loader for the one-time ESPN archive backfill (2022-2025).
--
-- The backfill payload was ~120KB of (season, week, home, away, kickoff,
-- network, espn id) tuples. Loading it over PostgREST instead of as one giant
-- SQL statement kept the statements small, which needed a table anon could
-- insert into.
--
-- That is a write surface on a production database, so it was: (a) a table
-- nothing else reads, (b) verified by row count, distinctness, team-name
-- resolution and a full join against nfl_games before anything was applied
-- from it, and (c) dropped immediately, which drops the policies with it.
--
-- Create and drop are both kept here so the file is a no-op on replay and the
-- reasoning survives. The backfill itself was data, not DDL, and is
-- reproducible from scripts/nfl-espn-backfill.mjs.
create table if not exists nfl_espn_staging (
  season      integer not null,
  week        integer not null,
  home_team   text not null,
  away_team   text not null,
  game_date   timestamptz,
  tv_network  text,
  source_game_id text,
  neutral_site boolean,
  loaded_at   timestamptz not null default now()
);

alter table nfl_espn_staging enable row level security;
create policy nfl_espn_staging_select_all on nfl_espn_staging for select using (true);
create policy nfl_espn_staging_insert_all on nfl_espn_staging for insert with check (true);
create policy nfl_espn_staging_delete_all on nfl_espn_staging for delete using (true);

-- Applied: 1,140 staged rows -> 1,139 nfl_games updated across 2022-2025.
-- The one staged row with no match is 2022 week 17 Buffalo @ Cincinnati, the
-- game abandoned after Damar Hamlin's cardiac arrest and never resumed. It has
-- no result and no ATS outcome, which is why predictiontracker's archive omits
-- it and why 2022 has 284 rows rather than 285.

drop table if exists nfl_espn_staging;
