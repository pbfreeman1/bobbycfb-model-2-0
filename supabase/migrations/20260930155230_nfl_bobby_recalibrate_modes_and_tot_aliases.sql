-- PARITY EXPORT ONLY — ALREADY APPLIED TO zpmdrazbqgzheqkvfltv.
-- Exported verbatim from supabase_migrations.schema_migrations
-- version 20260930155230 (nfl_bobby_recalibrate_modes_and_tot_aliases). Recorded so the repo matches the
-- database. DO NOT re-apply.
--
-- NOTE: this SUPERSEDES 20260930000200_nfl_bobby_engine.sql, which still holds
-- the pre-mode 3-arg nfl_recalibrate and the is_active-filtered
-- nfl_bobby_build_priors. Live is the 4-arg nfl_recalibrate defined here.
-- >>> verbatim below this line
-- Three things:
--   1. nfl_recalibrate gains a live/backtest mode, because filtering on today's
--      is_active inside a walk-forward backtest is survivorship bias.
--   2. nfl_bobby_build_priors stops filtering on is_active for the same reason.
--   3. The approved tot* aliases and the totals-only Pi-Rate model row.

-- ---------------------------------------------------------------------------
-- 1 + 2. Survivorship bias
-- ---------------------------------------------------------------------------
-- 8 of the 67 non-aggregate systems are is_active = false: lineargh, lineround,
-- linefox, lineesp, lineesp2, lineexcel2, lineturner, lineshark. They have 283
-- to 1,121 graded games between them and simply stopped publishing.
--
-- For LIVE compute, excluding them is right: a system that no longer publishes
-- cannot vote on this week's games.
--
-- For a BACKTEST of 2021, excluding them is wrong and flattering. Those systems
-- were publishing in 2021, they were in the pool a real user would have seen,
-- and dropping them both shrinks the pool and biases the median MAE that every
-- other system's mae_score is measured against. In backtest mode, eligibility
-- comes from having predictions in the season being evaluated, which the join to
-- nfl_raw_predictions already enforces — so the fix is simply not to apply the
-- is_active filter. Aggregates stay excluded in both modes.
--
-- Priors are never filtered by is_active either: a system's own μ is its own
-- history, and whether it still publishes today has no bearing on what it did
-- in 2023.

create or replace function nfl_bobby_build_priors(
  p_market text, p_from_season integer, p_through_season integer)
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare v_rows integer;
begin
  delete from nfl_bobby_system_priors
   where market = p_market and through_season = p_through_season;

  with y as (
    select rp.model_id, rp.predicted_line pl, gl.line, gl.actual
      from nfl_raw_predictions rp
      join nfl_bobby_game_lines gl
        on gl.game_id = rp.game_id and gl.market = rp.market
      join nfl_source_models sm on sm.id = rp.model_id
     where rp.market = p_market
       and gl.season between p_from_season and p_through_season
       and gl.actual is not null and gl.line is not null
       and rp.predicted_line is not null
       -- NOT filtered on is_active: a retired system's own history is still its
       -- own history, and excluding it here would bias every backtest season.
       and not sm.is_aggregate
  )
  insert into nfl_bobby_system_priors
    (model_id, market, through_season, from_season, wins, losses, pushes, hist_ats, hist_mae)
  select model_id, p_market, p_through_season, p_from_season,
    count(*) filter (where pl <> line and actual <> line and sign(pl - line) = sign(actual - line)),
    count(*) filter (where pl <> line and actual <> line and sign(pl - line) <> sign(actual - line)),
    count(*) filter (where actual = line),
    nullif(count(*) filter (where pl <> line and actual <> line and sign(pl - line) = sign(actual - line)), 0)::numeric
      / nullif(count(*) filter (where pl <> line and actual <> line), 0),
    avg(abs(pl - actual))
  from y group by model_id;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- Dropped rather than overloaded: CREATE OR REPLACE cannot add a parameter, and
-- leaving a 3-arg version behind would keep a second, mode-less copy of the
-- engine alive. The new defaults mean existing 3-arg calls still resolve here.
drop function if exists nfl_recalibrate(integer, integer, text);

create or replace function nfl_recalibrate(
  p_season integer, p_week integer, p_market text default 'spread',
  p_mode text default 'live')
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_min      numeric := nfl_bobby_cfg(p_market, 'min_games');
  v_priork   numeric := nfl_bobby_cfg(p_market, 'prior_k');
  v_priormu  numeric := nfl_bobby_cfg(p_market, 'prior_mean');
  v_usehist  boolean := coalesce(nfl_bobby_cfg(p_market, 'use_historical_prior'), 0) = 1;
  v_wa       numeric := nfl_bobby_cfg(p_market, 'w_ats');
  v_wm       numeric := nfl_bobby_cfg(p_market, 'w_mae');
  v_scale    numeric := nfl_bobby_cfg(p_market, 'mae_scale');
  v_pool     integer := coalesce(nfl_bobby_cfg(p_market, 'pool_size'), 0)::int;
  -- live: only systems still publishing may vote.
  -- backtest: any non-aggregate system with predictions in the source season,
  --           so a 2021 walk-forward sees the 2021 pool, not the 2026 one.
  v_live     boolean := (p_mode = 'live');
  v_src      integer := case when p_week = 0 then p_season - 1 else p_season end;
  v_max      integer := case when p_week = 0 then 99 else p_week end;
  v_rows     integer;
  v_run      bigint;
begin
  if p_mode not in ('live','backtest') then
    raise exception 'nfl_recalibrate: p_mode must be live or backtest, got %', p_mode;
  end if;

  insert into nfl_bobby_runs (kind, market, season, week, config_version, detail)
    values ('recalibrate', p_market, p_season, p_week,
            nfl_bobby_config_version(p_market), jsonb_build_object('mode', p_mode))
    returning id into v_run;

  delete from nfl_bobby_system_grades
   where market = p_market and season = p_season and week = p_week + 1;

  with
  seed as (
    select distinct on (model_id) model_id, through_week, wins, losses, pushes, mae
      from nfl_bobby_system_seeds
     where market = p_market and season = v_src and through_week <= v_max
     order by model_id, through_week desc
  ),
  y as (
    select rp.model_id, rp.predicted_line pl, gl.line, gl.actual
      from nfl_raw_predictions rp
      join nfl_bobby_game_lines gl
        on gl.game_id = rp.game_id and gl.market = rp.market
      join nfl_source_models sm on sm.id = rp.model_id
      left join seed s on s.model_id = rp.model_id
     where rp.market = p_market
       and gl.season = v_src and gl.week <= v_max
       and gl.week > coalesce(s.through_week, 0)
       and gl.actual is not null and gl.line is not null
       and rp.predicted_line is not null
       and not sm.is_aggregate
       and (not v_live or sm.is_active)
  ),
  live as (
    select model_id,
      count(*) filter (where pl <> line and actual <> line and sign(pl - line) = sign(actual - line)) w,
      count(*) filter (where pl <> line and actual <> line and sign(pl - line) <> sign(actual - line)) l,
      count(*) filter (where actual = line) p,
      count(*) n,
      avg(abs(pl - actual)) mae,
      avg(pl - actual) bias
    from y group by model_id
  ),
  st as (
    select
      coalesce(live.model_id, seed.model_id) model_id,
      coalesce(live.w, 0) + coalesce(seed.wins, 0) w,
      coalesce(live.l, 0) + coalesce(seed.losses, 0) l,
      coalesce(live.p, 0) + coalesce(seed.pushes, 0) p,
      coalesce(seed.wins, 0) + coalesce(seed.losses, 0) + coalesce(seed.pushes, 0) seed_games,
      case
        when live.mae is not null and seed.mae is not null then
          (live.mae * live.n + seed.mae * (seed.wins + seed.losses + seed.pushes))
            / nullif(live.n + seed.wins + seed.losses + seed.pushes, 0)
        else coalesce(live.mae, seed.mae)
      end mae,
      live.bias
    from live full outer join seed on seed.model_id = live.model_id
  ),
  pri as (
    select model_id, hist_ats from nfl_bobby_system_priors
     where market = p_market and through_season = v_src - 1
  ),
  -- Median MAE is taken over st, which already reflects the mode, so a backtest
  -- season's median comes from the systems eligible in that season.
  med as (
    select percentile_cont(0.5) within group (order by mae) m
      from st where w + l >= v_min and mae is not null
  ),
  f as (
    select st.*,
      case when v_usehist then coalesce(pri.hist_ats, v_priormu) else v_priormu end mu,
      pri.hist_ats
    from st left join pri using (model_id)
  ),
  g as (
    select f.*,
      (f.w + v_priork * f.mu) / (f.w + f.l + v_priork) shr,
      f.w::numeric / nullif(f.w + f.l, 0) raw_ats,
      case when med.m > 0 and f.mae is not null
           then (med.m - f.mae) / med.m * v_scale end mae_s
    from f cross join med
  ),
  h as (
    select g.*, g.shr - 0.5 ats_s,
      case when g.w + g.l >= v_min
           then greatest(0, v_wa * (g.shr - 0.5) + v_wm * coalesce(g.mae_s, 0))
           else 0 end wt
    from g
  ),
  ranked as (
    select h.*, rank() over (order by wt desc, mae asc nulls last) rk from h
  )
  insert into nfl_bobby_system_grades
    (model_id, market, season, week, source_season, games_graded, wins, losses,
     pushes, seed_games, raw_ats, hist_ats, shrunk_ats, mae, bias, ats_score,
     mae_score, weight, rank)
  select model_id, p_market, p_season, p_week + 1, v_src,
    w + l + p, w, l, p, seed_games, raw_ats, hist_ats, shr, mae, bias, ats_s, mae_s,
    case when v_pool > 0 and rk > v_pool then 0 else wt end,
    rk
  from ranked;

  get diagnostics v_rows = row_count;
  update nfl_bobby_runs
     set rows_written = v_rows, finished_at = now(), ok = true
   where id = v_run;
  return v_rows;
end $function$;

-- ---------------------------------------------------------------------------
-- 3. Approved tot* aliases, one model_id per system across both markets.
-- ---------------------------------------------------------------------------
update nfl_source_models set csv_aliases =
  (select array_agg(distinct a) from unnest(coalesce(csv_aliases,'{}') || v.alias) a)
from (values
  ('linemass','totmass'), ('linebihl','totbihl'), ('lineexcel','totexcel'),
  ('linedonchess','totdonchess'), ('linedok','totdokter'), ('linepve','totpve'),
  ('linetalis','tottalis'), ('linepugh','totpugh'), ('lineclean','totclean'),
  ('lineround','totround'), ('linehanson','tothanson'), ('lineffw','totffw'),
  ('linerwp','totrwp'), ('linesag','totsag'), ('linestjohn','totstjohn'),
  ('linebetbetter','totbetbetter'), ('lineash','totashby'), ('linecurry','totcurry'),
  ('linecoff','totcoffey'), ('linekerns','totkerns'), ('linenewbury','totnewbury')
) as v(key, alias)
where nfl_source_models.model_key = v.key;

-- totpirate has no unambiguous spread counterpart: there are three Pi-Rate
-- spread variants (linepi Ratings, linepim Mean, linepib Bias) and nothing says
-- which one the totals feed corresponds to. A separate row keeps the grades
-- honest rather than attributing them to a guess.
insert into nfl_source_models (model_key, display_name, is_active, is_aggregate, notes)
values ('totpirate', 'Pi-Rate (totals)', true, false,
        'Totals-only. Deliberately NOT aliased to linepi/linepim/linepib — three Pi-Rate spread variants exist and the correspondence is unknown.')
on conflict (model_key) do nothing;