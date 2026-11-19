-- Outside picks (scout), phase 2: views behind the board "Tags" column, the
-- game drawer section and the CBB/NFL research pages. Read-only views.
--
-- Groups: 'side' = spread and moneyline picks on a team (both say "this team"),
--         'total' = game over/under. Full-game picks only; team totals and
--         halves stay in the drawer's pick list but are not counted.
-- Sources are counted by distinct site (source_name), so a site with eight
-- experts on one side counts once there; experts are counted separately.

-- One row per countable pick, graded at the line the source took (spreads and
-- totals) or straight up (moneylines). Units: spread/total win +1, lose -1.1;
-- moneyline from the stated odds (no odds -> no units).
create or replace view scout_pick_grades as
with p as (
  select p.*,
         case when p.market in ('spread', 'moneyline') then 'side' else 'total' end as grp
    from scout_picks p
   where p.status in ('ok', 'check') and p.period = 'full' and p.game_id is not null
     and p.market in ('spread', 'total', 'moneyline')
), g as (
  select p.*,
         case when p.sport = 'cbb' then cg.home_score - cg.road_score else ng.home_score - ng.away_score end as margin,
         case when p.sport = 'cbb' then cg.home_score + cg.road_score else ng.home_score + ng.away_score end as pts,
         case when p.sport = 'cbb' then cg.home_score is not null
              else coalesce(ng.completed, false) and ng.home_score is not null end as final,
         case when p.market = 'spread' then coalesce(p.home_line, p.market_line)
              when p.market = 'total' then coalesce(p.line, p.market_line) end as graded_line
    from p
    left join cbb_games cg on p.sport = 'cbb' and cg.id = p.game_id
    left join nfl_games ng on p.sport = 'nfl' and ng.id = p.game_id
), r as (
  select g.*,
         case
           when not g.final then null
           when g.market = 'spread' and g.graded_line is not null then
             sign(case g.side when 'home' then g.margin - g.graded_line else g.graded_line - g.margin end)
           when g.market = 'total' and g.graded_line is not null then
             sign(case g.side when 'over' then g.pts - g.graded_line else g.graded_line - g.pts end)
           when g.market = 'moneyline' then
             sign(case g.side when 'home' then g.margin else -g.margin end)
         end as res_sign
    from g
)
select r.id, r.sport, r.game_id, r.game_date, r.grp, r.market, r.side, r.line, r.home_line, r.odds, r.graded_line,
       r.source_name, r.expert, r.origin, r.created_at, r.status,
       case r.res_sign when 1 then 'W' when -1 then 'L' when 0 then 'P' end as result,
       case
         when r.res_sign is null then null
         when r.market = 'moneyline' then
           case r.res_sign when 0 then 0
                when -1 then case when r.odds is null then null else -1 end
                else case when r.odds is null then null
                          when r.odds > 0 then round(r.odds / 100.0, 3)
                          else round(100.0 / abs(r.odds), 3) end end
         else case r.res_sign when 1 then 1.0 when -1 then -1.1 else 0 end
       end as units
  from r;

-- Sources on each side of each game.
create or replace view scout_side_consensus as
  select sport, game_id, max(game_date) as game_date, grp, side,
         count(distinct lower(source_name)) as sources,
         count(distinct lower(source_name) || '|' || scout_expert_key(expert)) as experts,
         count(*) as picks,
         array_agg(distinct source_name order by source_name) as source_names,
         min(home_line) filter (where market = 'spread') as min_home_line,
         max(home_line) filter (where market = 'spread') as max_home_line,
         min(line) filter (where market = 'total') as min_total,
         max(line) filter (where market = 'total') as max_total,
         bool_or(origin = 'agent') as has_agent,
         max(created_at) as last_at
    from scout_pick_grades
   group by sport, game_id, grp, side;

-- One row per game and group: the crowd's side, the model's side, the market
-- line, and how the crowd's side did against that line.
--   CBB: model side = sign of cbb_signals.edge (no CBB totals model); line = cbb_games.line (frozen at noon ET).
--   NFL: model side = nfl2_signals.pick_side for the market; line = nfl_games spread_line / total_line.
create or replace view scout_game_crowd as
with pairs as (
  select sport, game_id, grp, max(game_date) as game_date,
         coalesce(sum(sources) filter (where side in ('home', 'over')), 0) as a_src,
         coalesce(sum(sources) filter (where side in ('away', 'under')), 0) as b_src,
         coalesce(sum(experts) filter (where side in ('home', 'over')), 0) as a_exp,
         coalesce(sum(experts) filter (where side in ('away', 'under')), 0) as b_exp
    from scout_side_consensus
   group by sport, game_id, grp
), c as (
  select p.*,
         case when a_src > b_src then case grp when 'side' then 'home' else 'over' end
              when b_src > a_src then case grp when 'side' then 'away' else 'under' end end as crowd_side,
         greatest(a_src, b_src) as crowd_sources,
         least(a_src, b_src) as other_sources
    from pairs p
), m as (
  select c.*,
         case when c.sport = 'cbb' then
                case when c.grp = 'side' then case when cs.edge > 0 then 'home' when cs.edge < 0 then 'away' end end
              else ns.pick_side end as model_side,
         case when c.sport = 'cbb' then cs.tier else ns.tier end as model_tier,
         case when c.sport = 'cbb' then abs(cs.edge) else ns.kedge end as model_edge,
         case when c.sport = 'cbb' then case when c.grp = 'side' then cg.line end
              else case when c.grp = 'side' then ng.spread_line else ng.total_line end end as market_line,
         case when c.sport = 'cbb' then case when c.grp = 'side' then cg.open_line end
              else case when c.grp = 'side' then ng.spread_open else ng.total_open end end as open_line,
         case when c.sport = 'cbb' then cg.home_score - cg.road_score else ng.home_score - ng.away_score end as margin,
         case when c.sport = 'cbb' then cg.home_score + cg.road_score else ng.home_score + ng.away_score end as pts,
         case when c.sport = 'cbb' then cg.home_score is not null
              else coalesce(ng.completed, false) and ng.home_score is not null end as final,
         case when c.sport = 'cbb' then cg.road else ng.away_team end as away,
         case when c.sport = 'cbb' then cg.home else ng.home_team end as home,
         case when c.sport = 'cbb' then cg.tip_time else ng.game_date end as start_time
    from c
    left join cbb_games cg on c.sport = 'cbb' and cg.id = c.game_id
    left join cbb_signals cs on c.sport = 'cbb' and cs.game_id = c.game_id
    left join nfl_games ng on c.sport = 'nfl' and ng.id = c.game_id
    left join nfl2_signals ns on c.sport = 'nfl' and ns.game_id = c.game_id
                             and ns.market = case c.grp when 'side' then 'spread' else 'total' end
)
select m.*,
       case when m.crowd_side is null or m.model_side is null then null
            when m.crowd_side = m.model_side then 'with' else 'against' end as model_relation,
       case
         when not m.final or m.crowd_side is null or m.market_line is null then null
         else case sign(case m.crowd_side
                          when 'home' then m.margin - m.market_line
                          when 'away' then m.market_line - m.margin
                          when 'over' then m.pts - m.market_line
                          else m.market_line - m.pts end)
                when 1 then 'W' when -1 then 'L' else 'P' end
       end as crowd_result
  from m;

-- Records by site and by expert.
create or replace view scout_source_board as
  select sport, source_name, grp,
         count(*) as picks,
         count(*) filter (where result is not null) as graded,
         count(*) filter (where result = 'W') as w,
         count(*) filter (where result = 'L') as l,
         count(*) filter (where result = 'P') as p,
         round(coalesce(sum(units), 0), 2) as units,
         max(created_at) as last_pick
    from scout_pick_grades
   group by sport, source_name, grp;

create or replace view scout_expert_board as
  select sport, source_name, coalesce(expert, '(unnamed)') as expert, grp,
         count(*) as picks,
         count(*) filter (where result is not null) as graded,
         count(*) filter (where result = 'W') as w,
         count(*) filter (where result = 'L') as l,
         count(*) filter (where result = 'P') as p,
         round(coalesce(sum(units), 0), 2) as units,
         max(created_at) as last_pick
    from scout_pick_grades
   group by sport, source_name, coalesce(expert, '(unnamed)'), grp;
