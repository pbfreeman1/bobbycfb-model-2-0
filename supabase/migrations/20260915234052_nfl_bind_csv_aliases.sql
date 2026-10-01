-- PARITY EXPORT ONLY — ALREADY APPLIED TO zpmdrazbqgzheqkvfltv.
-- Exported verbatim from supabase_migrations.schema_migrations
-- version 20260915234052 (nfl_bind_csv_aliases). Recorded so the repo matches the
-- database. DO NOT re-apply.
-- >>> verbatim below this line
-- The live weekly CSV uses different column names than the season
-- archives for several systems. Store aliases so ingest resolves to
-- the existing model row instead of creating a duplicate with no history.
alter table nfl_source_models
  add column if not exists csv_aliases text[] default '{}';

-- Bind the 2026-new systems that had placeholder keys
update nfl_source_models set model_key = 'linepve'       where model_key = 'tmp_pve_sports_ratings';
update nfl_source_models set model_key = 'linebetbetter' where model_key = 'tmp_bet_better';
update nfl_source_models set model_key = 'lineblitz'     where model_key = 'tmp_statblitz_index';
update nfl_source_models set model_key = 'linenewbury'   where model_key = 'tmp_max_newbury';
update nfl_source_models set model_key = 'linekam'       where model_key = 'tmp_kambour_rating';

-- Alias live CSV column names onto the canonical archive keys
update nfl_source_models sm
   set csv_aliases = array(select distinct unnest(sm.csv_aliases || a.alias))
  from (values
    ('linepz',   'linepfz'),        -- PerformanZ Ratings
    ('linemore', 'linemoore'),      -- Sonny Moore
    ('linesagp', 'linesagpred'),    -- Sagarin Points
    ('linejohns','linejohnson'),    -- Roger Johnson
    ('linemed',  'linemedian')      -- System Median (aggregate)
  ) as a(key, alias)
 where sm.model_key = a.key;

-- Resolve a CSV column name to a model row: exact key, then alias.
create or replace function nfl_resolve_model(p_col text)
returns bigint
language sql stable as $$
  select id from nfl_source_models where model_key = lower(trim(p_col))
  union all
  select id from nfl_source_models where lower(trim(p_col)) = any(csv_aliases)
  limit 1;
$$;