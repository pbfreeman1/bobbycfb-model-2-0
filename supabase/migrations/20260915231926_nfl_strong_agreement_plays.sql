-- PARITY EXPORT ONLY — ALREADY APPLIED TO zpmdrazbqgzheqkvfltv.
-- Exported verbatim from supabase_migrations.schema_migrations
-- version 20260915231926 (nfl_strong_agreement_plays). Recorded so the repo matches the
-- database. DO NOT re-apply.
-- >>> verbatim below this line
insert into nfl_model_config (config_key, config_value, description) values
  ('sap_pool_size',      5,    'Strong Agreement: models in the pool (3-7)'),
  ('sap_min_edge',       1.5,  'Strong Agreement: minimum |consensus - line|'),
  ('sap_min_agreement',  1.0,  'Strong Agreement: share of pool on the same side (1.0 = unanimous)'),
  ('sap_min_pool_games', 15,   'Strong Agreement: minimum graded games before a model is pool-eligible')
on conflict (config_key) do update
  set description = excluded.description, updated_at = now();

create or replace function nfl_pool_as_of(
  p_season int, p_week int, p_pool_size int default null
)
returns table (
  model_id bigint, model_key text, display_name text,
  ats_pct numeric, ats_wins int, ats_losses int,
  games_graded int, as_of_week int, pool_rank bigint
)
language sql stable as $$
  with cfg as (
    select coalesce(p_pool_size,
             (select config_value::int from nfl_model_config where config_key='sap_pool_size'),
             5) as pool_size,
           coalesce((select config_value::int from nfl_model_config
                      where config_key='sap_min_pool_games'), 15) as min_games
  ),
  latest as (
    select distinct on (mg.model_id) mg.*
      from nfl_model_grades mg
     where mg.season = p_season and mg.week < p_week and mg.market = 'spread'
     order by mg.model_id, mg.week desc
  )
  select l.model_id, sm.model_key, sm.display_name,
         l.ats_pct, l.ats_wins, l.ats_losses, l.games_graded, l.week,
         row_number() over (
           order by l.ats_pct desc nulls last, l.mae asc nulls last, sm.model_key
         )
    from latest l
    join nfl_source_models sm on sm.id = l.model_id
   cross join cfg
   where sm.is_active and not sm.is_aggregate
     and l.games_graded >= cfg.min_games
     and l.ats_pct is not null
   order by 9
   limit (select pool_size from cfg);
$$;

create or replace function nfl_strong_agreement_plays(
  p_season int, p_week int,
  p_pool_size int default null,
  p_min_edge numeric default null,
  p_min_agree numeric default null
)
returns table (
  game_id bigint, matchup text, home_team text, away_team text,
  vegas_line numeric, consensus numeric, edge numeric,
  pick_side text, pick_team text, pick_spread numeric,
  pool_size int, models_on_pick int, agreement numeric, pool_std_dev numeric,
  crosses_key boolean, keys_crossed text, strength numeric,
  pool_detail jsonb, result text
)
language sql stable as $$
  with cfg as (
    select coalesce(p_min_edge,
             (select config_value from nfl_model_config where config_key='sap_min_edge'), 1.5) as min_edge,
           coalesce(p_min_agree,
             (select config_value from nfl_model_config where config_key='sap_min_agreement'), 1.0) as min_agree
  ),
  pool as (select * from nfl_pool_as_of(p_season, p_week, p_pool_size)),
  preds as (
    select g.id, g.home_team, g.away_team, g.spread_line, g.home_score, g.away_score, g.completed,
           p.model_id, p.display_name, p.ats_pct, rp.predicted_line
      from nfl_games g
      join nfl_raw_predictions rp on rp.game_id = g.id and rp.market = 'spread'
      join pool p on p.model_id = rp.model_id
     where g.season = p_season and g.week = p_week
       and g.spread_line is not null and rp.predicted_line is not null
  ),
  agg as (
    select pr.id, pr.home_team, pr.away_team, pr.spread_line,
           pr.home_score, pr.away_score, pr.completed,
           count(*)::int as n_models,
           avg(pr.predicted_line) as consensus,
           stddev_samp(pr.predicted_line) as sd,
           count(*) filter (where pr.predicted_line > pr.spread_line)::int as n_home,
           jsonb_agg(jsonb_build_object(
             'model', pr.display_name,
             'prediction', round(pr.predicted_line, 2),
             'side', case when pr.predicted_line > pr.spread_line then 'home' else 'away' end,
             'ats', pr.ats_pct
           ) order by pr.ats_pct desc nulls last) as detail
      from preds pr group by 1,2,3,4,5,6,7
  ),
  scored as (
    select a.*, (a.consensus - a.spread_line) as edge,
           case when a.consensus > a.spread_line then 'home' else 'away' end as side,
           case when a.consensus > a.spread_line then a.n_home
                else a.n_models - a.n_home end as on_pick
      from agg a
  )
  select s.id,
    s.away_team || ' @ ' || s.home_team,
    s.home_team, s.away_team,
    round(s.spread_line,2), round(s.consensus,2), round(s.edge,2),
    s.side,
    case when s.side='home' then s.home_team else s.away_team end,
    round(case when s.side='home' then s.spread_line else -s.spread_line end, 2),
    s.n_models, s.on_pick,
    round(s.on_pick::numeric / nullif(s.n_models,0), 4),
    round(s.sd, 3),
    exists (select 1 from unnest(array[3,7,10]) k
             where (least(s.consensus,s.spread_line) < k and greatest(s.consensus,s.spread_line) >= k)
                or (least(-s.consensus,-s.spread_line) < k and greatest(-s.consensus,-s.spread_line) >= k)),
    (select string_agg(k::text, ',' order by k) from unnest(array[3,7,10]) k
      where (least(s.consensus,s.spread_line) < k and greatest(s.consensus,s.spread_line) >= k)
         or (least(-s.consensus,-s.spread_line) < k and greatest(-s.consensus,-s.spread_line) >= k)),
    round(abs(s.edge) * (s.on_pick::numeric / nullif(s.n_models,0))
          / (1 + coalesce(s.sd,0)/4.0), 3),
    s.detail,
    case when not s.completed then null
         when (s.home_score - s.away_score) = s.spread_line then 'P'
         when (s.consensus > s.spread_line) = ((s.home_score - s.away_score) > s.spread_line) then 'W'
         else 'L' end
  from scored s, cfg
  where abs(s.edge) >= cfg.min_edge
    and (s.on_pick::numeric / nullif(s.n_models,0)) >= cfg.min_agree
  order by 17 desc;
$$;

create or replace view nfl_strong_agreement_log as
with weeks as (select distinct season, week from nfl_games where season = 2026 and week > 1),
plays as (select w.season, w.week, p.* from weeks w
            cross join lateral nfl_strong_agreement_plays(w.season, w.week) p)
select season, week,
       count(*) as plays,
       count(*) filter (where result='W') as wins,
       count(*) filter (where result='L') as losses,
       count(*) filter (where result='P') as pushes,
       count(*) filter (where result is null) as pending,
       round(count(*) filter (where result='W')::numeric
             / nullif(count(*) filter (where result in ('W','L')),0), 4) as ats_pct,
       round((count(*) filter (where result='W')
              - 1.1*count(*) filter (where result='L'))::numeric, 2) as units_pl
  from plays group by 1,2 order by 1,2;