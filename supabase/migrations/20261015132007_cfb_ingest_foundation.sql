create table if not exists cfb_ingest_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  source text, season int, rows_received int, games_matched int,
  preds_inserted int, preds_updated int, preds_unchanged int, preds_locked int,
  games_unmatched int, new_columns text[], status text, detail jsonb
);
create table if not exists raw_prediction_history (
  id bigint generated always as identity primary key,
  game_id uuid not null references games(id) on delete cascade,
  model_id uuid not null references source_models(id),
  predicted_margin numeric not null,
  prev_margin numeric,
  seen_at timestamptz not null default now(),
  run_id bigint
);
create index if not exists raw_prediction_history_game_idx on raw_prediction_history (game_id, model_id, seen_at);
create table if not exists cfb_team_alias (norm_key text primary key, team text not null);
create table if not exists cfb_header_alias (alias text primary key, colname text not null);
alter table cfb_ingest_runs enable row level security;
alter table raw_prediction_history enable row level security;
alter table cfb_team_alias enable row level security;
alter table cfb_header_alias enable row level security;

insert into cfb_header_alias(alias, colname) values
 ('linebill','linebillings'),('lineespn','linefpi'),('linemass','linemassey'),('lineargh','linedial')
on conflict do nothing;

create or replace function cfb_norm_team(t text) returns text language plpgsql immutable as $$
declare s text;
begin
  s := lower(trim(coalesce(t,'')));
  s := translate(s, 'éáíóúñüç', 'eaiounuc');
  s := replace(s, '&', ' and ');
  s := regexp_replace(s, '\(ohio\)', '(oh)', 'g');
  s := regexp_replace(s, '\bst\.', 'state', 'g');
  s := regexp_replace(s, '\bst$', 'state');
  s := regexp_replace(s, '\bmich\.', 'michigan', 'g');
  s := regexp_replace(s, '\bintl\.', 'international', 'g');
  s := regexp_replace(s, '\btenn\.', 'tennessee', 'g');
  s := regexp_replace(s, '\bconn\.', 'connecticut', 'g');
  s := regexp_replace(s, '\bmiss\.', 'miss', 'g');
  return regexp_replace(s, '[^a-z0-9]', '', 'g');
end $$;

create or replace function cfb_team_key(t text) returns text language sql stable as $$
  select coalesce((select cfb_norm_team(a.team) from cfb_team_alias a where a.norm_key = cfb_norm_team(t)), cfb_norm_team(t))
$$;

-- Seed the predictiontracker-name -> games.home_team alias map.
--
-- The applied migration derived these by joining a one-off `cfb_import_staging`
-- table (an archive CSV load) against `games` on week and final score, then
-- keeping the pairs whose normalized names disagreed. That staging table is not
-- part of the schema and no longer exists, so a fresh rebuild could not run it.
-- Captured here as the literal result of that derivation, read back from the
-- live table:
--
--   select norm_key, team from cfb_team_alias order by 1;   -- 49 rows
--
-- These keys are already in the FINAL normalized form produced by the
-- `\y`-based cfb_norm_team in 20261015132030_cfb_norm_team_fix. They are stored
-- as literals rather than recomputed, so the seed does not depend on which
-- version of the function is in place when it runs.
insert into cfb_team_alias(norm_key, team) values
  ('appalachianst'     , 'App State'),
  ('appalachianstate'  , 'App State'),
  ('arizonast'         , 'Arizona State'),
  ('arkansasst'        , 'Arkansas State'),
  ('ballst'            , 'Ball State'),
  ('boisest'           , 'Boise State'),
  ('centralflorida'    , 'UCF'),
  ('centralmich'       , 'Central Michigan'),
  ('coloradost'        , 'Colorado State'),
  ('connecticut'       , 'UConn'),
  ('easternmich'       , 'Eastern Michigan'),
  ('floridaintl'       , 'Florida International'),
  ('floridast'         , 'Florida State'),
  ('fresnost'          , 'Fresno State'),
  ('georgiast'         , 'Georgia State'),
  ('iowast'            , 'Iowa State'),
  ('jacksonvillest'    , 'Jacksonville State'),
  ('kansasst'          , 'Kansas State'),
  ('kennesawst'        , 'Kennesaw State'),
  ('kent'              , 'Kent State'),
  ('louisianalafayette', 'Louisiana'),
  ('louisianamonroe'   , 'UL Monroe'),
  ('miamifla'          , 'Miami'),
  ('michiganst'        , 'Michigan State'),
  ('middletenn'        , 'Middle Tennessee'),
  ('mississippi'       , 'Ole Miss'),
  ('mississippist'     , 'Mississippi State'),
  ('missourist'        , 'Missouri State'),
  ('ncst'              , 'NC State'),
  ('newmexicost'       , 'New Mexico State'),
  ('northdakotast'     , 'North Dakota State'),
  ('northernill'       , 'Northern Illinois'),
  ('ohiost'            , 'Ohio State'),
  ('oklahomast'        , 'Oklahoma State'),
  ('oregonst'          , 'Oregon State'),
  ('pennst'            , 'Penn State'),
  ('sacramentost'      , 'Sacramento State'),
  ('samhoustonst'      , 'Sam Houston'),
  ('samhoustonstate'   , 'Sam Houston'),
  ('sandiegost'        , 'San Diego State'),
  ('sanjosest'         , 'San José State'),
  ('texassanantonio'   , 'UTSA'),
  ('texasst'           , 'Texas State'),
  ('troyst'            , 'Troy'),
  ('troystate'         , 'Troy'),
  ('utahst'            , 'Utah State'),
  ('washingtonst'      , 'Washington State'),
  ('westernmich'       , 'Western Michigan'),
  ('westva'            , 'West Virginia')
on conflict (norm_key) do update set team = excluded.team;
