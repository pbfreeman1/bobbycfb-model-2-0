-- Grade the shadow variant on the side it actually took.
--
-- cfb_signal_grades.ats_result grades sign(edge), i.e. the pick_side play. The
-- bobcat_eq variant is judged on eq_edge, and the two can point at opposite
-- teams (2026 wk4 Tulsa @ Arkansas: edge +5.66 home, eq_edge -2.77 away). Reusing
-- ats_result there records the wrong team's result: Arkansas covered, so the row
-- read 'win' while the shadow variant's Tulsa +7 lost. On a handful of plays a
-- year that single sign error is the difference between 100% and 0%.
--
-- So: ats_result / flat_pl stay as they were — the pick_side grade — and the eq
-- variant gets its own eq_ats_result / eq_flat_pl, derived from the final margin
-- against sign(eq_edge). cfb_bobcat_variants hands the bobcat_eq variant those,
-- which is what the summary then aggregates.

create or replace view cfb_bobcat_log with (security_invoker = true) as
select
  s.id signal_id, s.season, s.week, s.game_id,
  g.away_team || ' @ ' || g.home_team teams,
  g.home_team, g.away_team,
  s.pick_side, s.vegas_line, s.edge, s.eq_edge,
  s.hit_side, s.hit_count, s.hit_opp, s.models_n, s.coverage,
  s.tier, s.units,
  s.bobcat, s.bobcat_eq,
  case when s.week >= cfb_cfg('bobcat_forward_week') then 'forward' else 'backfill' end cohort,
  gr.ats_result,
  case gr.ats_result when 'win' then 1.0 when 'loss' then -1.1 when 'push' then 0 end flat_pl,
  case when g.actual_margin is null or s.eq_edge is null or s.eq_edge = 0 then null
       when g.actual_margin = s.vegas_line then 'push'
       when sign(s.eq_edge) * (g.actual_margin - s.vegas_line) > 0 then 'win'
       else 'loss' end eq_ats_result,
  case when g.actual_margin is null or s.eq_edge is null or s.eq_edge = 0 then null
       when g.actual_margin = s.vegas_line then 0
       when sign(s.eq_edge) * (g.actual_margin - s.vegas_line) > 0 then 1.0
       else -1.1 end eq_flat_pl,
  -- the side the shadow variant is actually on. New columns go last: CREATE OR
  -- REPLACE VIEW can only append, never reorder or rename.
  case when s.eq_edge > 0 then 'home' when s.eq_edge < 0 then 'away' end eq_side
from cfb_game_signals s
join games g on g.id = s.game_id
left join cfb_signal_grades gr on gr.signal_id = s.id
where s.bobcat or s.bobcat_eq;

create or replace view cfb_bobcat_variants with (security_invoker = true) as
with base as (
  select s.id signal_id, s.season, s.week,
    case when s.week >= cfb_cfg('bobcat_forward_week') then 'forward' else 'backfill' end cohort,
    s.bobcat, s.bobcat_eq,
    (abs(s.edge) >= cfb_cfg('bobcat_edge_min')
      and abs(s.edge) < cfb_cfg('bobcat_edge_max')
      and s.hit_side is not null
      and s.hit_side = s.pick_side
      and not s.bobcat) is_control,
    gr.ats_result,
    case gr.ats_result when 'win' then 1.0 when 'loss' then -1.1 when 'push' then 0 end flat_pl,
    case when g.actual_margin is null or s.eq_edge is null or s.eq_edge = 0 then null
         when g.actual_margin = s.vegas_line then 'push'
         when sign(s.eq_edge) * (g.actual_margin - s.vegas_line) > 0 then 'win'
         else 'loss' end eq_ats_result,
    case when g.actual_margin is null or s.eq_edge is null or s.eq_edge = 0 then null
         when g.actual_margin = s.vegas_line then 0
         when sign(s.eq_edge) * (g.actual_margin - s.vegas_line) > 0 then 1.0
         else -1.1 end eq_flat_pl
  from cfb_game_signals s
  join games g on g.id = s.game_id
  left join cfb_signal_grades gr on gr.signal_id = s.id
)
select signal_id, season, week, cohort, 'bobcat' variant, ats_result, flat_pl from base where bobcat
union all
select signal_id, season, week, cohort, 'bobcat_eq' variant, eq_ats_result, eq_flat_pl from base where bobcat_eq
union all
select signal_id, season, week, cohort, 'control' variant, ats_result, flat_pl from base where is_control;

grant select on cfb_bobcat_log, cfb_bobcat_variants to anon, authenticated;
