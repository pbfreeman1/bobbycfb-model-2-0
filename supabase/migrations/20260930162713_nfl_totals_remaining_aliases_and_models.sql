-- PARITY EXPORT ONLY — ALREADY APPLIED TO zpmdrazbqgzheqkvfltv.
-- Exported verbatim from supabase_migrations.schema_migrations
-- version 20260930162713 (nfl_totals_remaining_aliases_and_models). Recorded so the repo matches the
-- database. DO NOT re-apply.
-- >>> verbatim below this line
-- The 2021-2025 totals archive carries tot* columns the 2026-only map did not
-- show. Resolved under the standing rule: a tot* column with no unambiguous
-- spread counterpart becomes a totals-only model row; ask only when a column
-- plausibly matches two or more existing systems.
--
-- Four unambiguous aliases onto existing rows (all four are retired spread
-- systems, which is fine — priors deliberately ignore is_active):
--   totargh   -> lineargh    ARGH Power Ratings   1,137 rows
--   totshark  -> lineshark   Odds Shark             852 rows
--   totexcel2 -> lineexcel2  RP Excel 2             549 rows
--   totgrok   -> linegrok    Grok                   284 rows
update nfl_source_models set csv_aliases =
  (select array_agg(distinct a) from unnest(coalesce(csv_aliases,'{}') || v.alias) a)
from (values
  ('lineargh','totargh'), ('lineshark','totshark'),
  ('lineexcel2','totexcel2'), ('linegrok','totgrok')
) as v(key, alias)
where nfl_source_models.model_key = v.key;

-- Two totals-only rows. Neither has a spread counterpart:
--   totturing  298 rows. NOT aliased to lineturner "Turner Ratings" — Turing
--              and Turner are different names and nothing links the feeds.
--   totwhatif  0 rows in every file we hold. Created anyway so that if the
--              system starts publishing it is ingested with no code change;
--              a null column is skipped at ingest regardless.
insert into nfl_source_models (model_key, display_name, is_active, is_aggregate, notes)
values
  ('totturing', 'Turing (totals)', true, false,
   'Totals-only. Deliberately NOT aliased to lineturner (Turner Ratings) — different name, no established link.'),
  ('totwhatif', 'What If (totals)', true, false,
   'Totals-only. Empty in every archive file as of 2026-09-30; created so a future publish needs no code change.')
on conflict (model_key) do nothing;

select model_key, display_name, coalesce(array_to_string(csv_aliases,'|'),'') aliases
from nfl_source_models
where model_key in ('lineargh','lineshark','lineexcel2','linegrok','totpirate','totturing','totwhatif')
order by model_key;