-- Frozen PredictionTracker line (games.pt_line) + "Stale line" flag.
--
-- Problem: cfb_recalibrate graded systems against games.current_line, which the
-- results sync overwrites after games are played, and cfb_compute used whatever
-- current_line was at compute time. pt_line is the line that arrives WITH the
-- predictions (PT's `line` column), frozen at kickoff and never touched by the
-- results sync.
--
-- Behaviour changes (all fall back to current_line while pt_line is null, so
-- until the next ingest sets pt_line, compute output is unchanged):
--   * games.pt_line / pt_line_at, locked once the game has started (trigger).
--   * cfb_ingest_predictions reads `line` (top level or inside preds) and sets
--     pt_line for unstarted games when not a backfill.
--   * cfb_compute uses coalesce(pt_line, current_line) as the compute line.
--   * cfb_recalibrate grades systems on coalesce(pt_line, current_line).
--   * New display-only flag 'Stale line' when pt_line and current_line differ
--     by cfb_cfg('stale_line') (3) or more points, or flip sign. No tier effect.
--   * Started games with a stored signal are backfilled from
--     cfb_game_signals.vegas_line (the compute-time line).
--
-- cfb_grade is unchanged: it already grades on the frozen signal vegas_line.
-- /api/grade, /api/compute and the PSS routes (older models) still read
-- games.current_line and are intentionally left alone.

-- 1. Columns -----------------------------------------------------------------
alter table public.games
  add column if not exists pt_line numeric,
  add column if not exists pt_line_at timestamptz;

comment on column public.games.pt_line is 'PredictionTracker line (home-positive) frozen at ingest; locked at kickoff; never written by the results sync.';

insert into public.cfb_tracker_config (key, value, note)
values ('stale_line', 3, 'Stale line flag: pt_line and current_line differ by this many points or more (or flip sign)')
on conflict (key) do nothing;

-- 2. Backfill started games from the frozen compute-time line (before the lock trigger exists)
update public.games g
   set pt_line = s.vegas_line, pt_line_at = coalesce(s.computed_at, now())
  from public.cfb_game_signals s
 where s.game_id = g.id and g.pt_line is null and s.vegas_line is not null
   and (g.kickoff_at <= now() or g.actual_margin is not null);

-- 3. Lock: once a game has started, pt_line cannot change (set cfb.force = 'on' for manual repair)
create or replace function public.games_lock_pt_line()
returns trigger language plpgsql as $f$
begin
  if coalesce(current_setting('cfb.force', true), '') <> 'on'
     and ((old.kickoff_at is not null and old.kickoff_at <= now()) or old.actual_margin is not null) then
    new.pt_line := old.pt_line;
    new.pt_line_at := old.pt_line_at;
  elsif new.pt_line is distinct from old.pt_line then
    new.pt_line_at := now();
  end if;
  return new;
end $f$;

create or replace trigger trg_games_lock_pt_line
  before update on public.games
  for each row execute function public.games_lock_pt_line();

-- 4. Ingest RPC: capture PT's line ---------------------------------------------
create or replace function public.cfb_ingest_predictions(p_season integer, p_rows jsonb, p_backfill boolean default false, p_source text default 'predictiontracker')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_run bigint; v_recv int; v_matched int; v_ins int := 0; v_upd int := 0; v_same int := 0; v_lock int := 0; v_pt int := 0;
  v_unmatched jsonb; v_newcols text[];
begin
  v_recv := coalesce(jsonb_array_length(p_rows), 0);
  insert into cfb_ingest_runs(source, season, rows_received, status) values (p_source, p_season, v_recv, 'running') returning id into v_run;

  create temp table _in on commit drop as
  select t.ord, trim(t.r->>'home') h, trim(t.r->>'road') rd,
         coalesce(a.colname, lower(kv.key)) colname, kv.value v
  from jsonb_array_elements(p_rows) with ordinality t(r, ord)
  cross join lateral jsonb_each_text(coalesce(t.r->'preds', '{}'::jsonb)) kv
  left join cfb_header_alias a on a.alias = lower(kv.key)
  where lower(kv.key) like 'line%' and kv.value ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$';

  create temp table _rows on commit drop as
  select t.ord, trim(t.r->>'home') h, trim(t.r->>'road') rd,
         nullif(btrim(coalesce(t.r->>'line', t.r->'preds'->>'line')), '') ptl
  from jsonb_array_elements(p_rows) with ordinality t(r, ord);

  create temp table _gm on commit drop as
  select distinct on (x.ord) x.ord, g.id game_id, g.week, g.kickoff_at
  from _rows x join games g on g.season = p_season
    and cfb_team_key(g.home_team) = cfb_team_key(x.h) and cfb_team_key(g.away_team) = cfb_team_key(x.rd)
  order by x.ord, (g.kickoff_at is null or g.kickoff_at > now()) desc, abs(extract(epoch from (coalesce(g.kickoff_at, now()) - now())));

  select count(*) into v_matched from _gm;
  select coalesce(jsonb_agg(x.h || ' vs ' || x.rd), '[]'::jsonb) into v_unmatched from _rows x where not exists (select 1 from _gm m where m.ord = x.ord);

  with nc as (select distinct colname from _in where not exists (select 1 from source_models sm where sm.colname = _in.colname)),
  ins as (insert into source_models(colname, system_name, status) select colname, 'Unregistered (' || colname || ')', 'verify' from nc returning colname)
  select array_agg(colname) into v_newcols from ins;

  create temp table _todo on commit drop as
  select m.game_id, m.week, sm.id model_id, i.v::numeric pm, e.predicted_margin prev,
         (not p_backfill and m.kickoff_at is not null and m.kickoff_at <= now()) locked
  from _in i join _gm m on m.ord = i.ord
  join source_models sm on sm.colname = i.colname and sm.status = 'include'
  left join raw_predictions e on e.game_id = m.game_id and e.model_id = sm.id;

  select count(*) filter (where locked), count(*) filter (where not locked and prev is null),
         count(*) filter (where not locked and prev is not null and abs(prev - pm) > 0.0049 and not p_backfill),
         count(*) filter (where not locked and prev is not null and (abs(prev - pm) <= 0.0049 or p_backfill))
    into v_lock, v_ins, v_upd, v_same from _todo;

  insert into raw_prediction_history(game_id, model_id, predicted_margin, prev_margin, run_id)
  select game_id, model_id, pm, prev, v_run from _todo
  where not locked and (prev is null or (not p_backfill and abs(prev - pm) > 0.0049));

  if p_backfill then
    insert into raw_predictions(game_id, model_id, predicted_margin, pulled_at, season, week)
    select game_id, model_id, pm, now(), p_season, week from _todo where prev is null
    on conflict (game_id, model_id) do nothing;
  else
    insert into raw_predictions(game_id, model_id, predicted_margin, pulled_at, season, week)
    select game_id, model_id, pm, now(), p_season, week from _todo where not locked
    on conflict (game_id, model_id) do update set predicted_margin = excluded.predicted_margin, pulled_at = now()
      where abs(raw_predictions.predicted_margin - excluded.predicted_margin) > 0.0049;

    -- PT's line for unstarted games (the games trigger also refuses changes once started)
    update games g set pt_line = r.ptl::numeric
      from _gm m join _rows r on r.ord = m.ord
     where g.id = m.game_id
       and r.ptl ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
       and (m.kickoff_at is null or m.kickoff_at > now())
       and g.pt_line is distinct from r.ptl::numeric;
    get diagnostics v_pt = row_count;
  end if;

  update cfb_ingest_runs set games_matched = v_matched, preds_inserted = v_ins, preds_updated = v_upd, preds_unchanged = v_same,
    preds_locked = v_lock, games_unmatched = jsonb_array_length(v_unmatched), new_columns = v_newcols,
    status = case when v_recv = 0 then 'empty' when v_matched = 0 then 'no_matches' else 'ok' end,
    detail = jsonb_build_object('unmatched', v_unmatched, 'backfill', p_backfill, 'pt_lines_set', v_pt)
  where id = v_run;

  return jsonb_build_object('run_id', v_run, 'rows_received', v_recv, 'games_matched', v_matched, 'inserted', v_ins,
    'updated', v_upd, 'unchanged', v_same, 'locked_skipped', v_lock, 'pt_lines_set', v_pt, 'unmatched', v_unmatched, 'new_columns', coalesce(to_jsonb(v_newcols), '[]'::jsonb));
end $function$;

-- 5. Compute: use the frozen PT line, flag a stale one -------------------------
create or replace function public.cfb_compute(p_season integer, p_week integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows int;
  v_force boolean := coalesce(current_setting('cfb.force', true), '') = 'on';
begin
  if not exists (select 1 from cfb_system_weights where season = p_season and as_of_week = p_week and weight > 0) then
    raise exception 'No system weights for season % week %. Run Recalibrate for week % first.', p_season, p_week, p_week - 1;
  end if;

  with open_games as (
    select g.id from games g where g.season = p_season and g.week = p_week and (v_force or g.kickoff_at is null or g.kickoff_at > now())
  ),
  v as (
    select g.id gid, coalesce(g.pt_line, g.current_line) vl, g.current_line cl, g.opening_line ol, r.predicted_margin pm, w.weight wt
    from games g
    join open_games og on og.id = g.id
    join raw_predictions r on r.game_id = g.id
    join cfb_system_weights w on w.model_id = r.model_id and w.season = p_season and w.as_of_week = p_week
    where g.season = p_season and g.week = p_week and coalesce(g.pt_line, g.current_line) is not null
      and r.predicted_margin is not null and w.weight > 0
  ),
  g1 as (select gid, max(vl) vl, max(cl) cl, max(ol) ol, sum(wt * pm) / sum(wt) cons, sum(wt) sw, count(*) nv from v group by gid),
  g2 as (
    select g1.gid, g1.vl, g1.cl, g1.ol, g1.cons, g1.nv, g1.cons - g1.vl edge,
      sqrt(sum(v.wt * (v.pm - g1.cons) ^ 2) / g1.sw) sd,
      coalesce(sum(v.wt) filter (where sign(v.pm - g1.vl) = sign(g1.cons - g1.vl) and g1.cons <> g1.vl), 0) / g1.sw vs
    from g1 join v on v.gid = g1.gid
    group by g1.gid, g1.vl, g1.cl, g1.ol, g1.cons, g1.sw, g1.nv
  ),
  top2 as (
    select gid, array_agg(pm - vl order by wt desc) d
    from (select v.*, row_number() over (partition by gid order by wt desc) rn from v) x
    where rn <= 2 group by gid
  ),
  eq as (
    select g.id gid, avg(r.predicted_margin) - max(coalesce(g.pt_line, g.current_line)) eq_edge
    from games g
    join open_games og on og.id = g.id
    join raw_predictions r on r.game_id = g.id
    join source_models sm on sm.id = r.model_id
    where g.season = p_season and g.week = p_week and coalesce(g.pt_line, g.current_line) is not null
      and r.predicted_margin is not null and sm.status = 'include'
    group by g.id
  ),
  m as (
    select g2.*, abs(edge) ae, abs(edge) / greatest(sd, cfb_cfg('sd_floor')) conv, top2.d, eq.eq_edge
    from g2 left join top2 using (gid) left join eq using (gid)
  ),
  t as (
    select m.*,
      case
        when nv < cfb_cfg('min_voters') then 'No tier'
        when vs >= cfb_cfg('t3_vs') and ae >= cfb_cfg('t3_edge') and sd <= cfb_cfg('t3_sd') and conv >= cfb_cfg('t3_conv') then '3U'
        when vs >= cfb_cfg('t2_vs') and ae >= cfb_cfg('t2_edge') and sd <= cfb_cfg('t2_sd') and conv >= cfb_cfg('t2_conv') then '2U'
        when vs >= cfb_cfg('t1_vs') and ae >= cfb_cfg('t1_edge') and sd <= cfb_cfg('t1_sd') and conv >= cfb_cfg('t1_conv') then '1U'
        when vs >= cfb_cfg('lean_vs') and ae >= cfb_cfg('lean_edge') then 'Lean'
        else 'No tier'
      end tier
    from m
  ),
  cov as (select c.game_id gid, c.coverage from cfb_game_coverage(p_season, p_week) c),
  tg as (
    select t.*, cov.coverage, (cov.coverage is not null and cov.coverage < cfb_cfg('min_coverage')) low_cov
    from t left join cov using (gid)
  )
  insert into cfb_game_signals (game_id, season, week, snapshot_week, vegas_line, opening_line, consensus, edge,
    pick_side, vote_share, std_dev, conviction, voters, tier, units, flags, eq_edge, coverage, computed_at)
  select gid, p_season, p_week, p_week, vl, ol, cons, edge,
    case when edge > 0 then 'home' when edge < 0 then 'away' end,
    vs, sd, conv, nv,
    case when low_cov and tier in ('2U', '3U') then '1U' else tier end,
    case when low_cov and tier in ('2U', '3U') then 1
         else case tier when '3U' then 3 when '2U' then 2 when '1U' then 1 else 0 end end,
    array_remove(array[
      case when ae >= cfb_cfg('edge_flag') then '6+ edge' end,
      case when nv < cfb_cfg('thin_pool') then 'Thin pool' end,
      case when d[1] * d[2] < 0 then 'Split top' end,
      case when abs(eq_edge) >= cfb_cfg('fade_edge') then 'Fade watch' end,
      case when low_cov then 'Low coverage' end,
      case when cl is not null and (abs(vl - cl) >= cfb_cfg('stale_line') or (vl <> 0 and cl <> 0 and sign(vl) <> sign(cl))) then 'Stale line' end
    ], null),
    eq_edge, coverage, now()
  from tg
  on conflict (game_id) do update set
    snapshot_week = excluded.snapshot_week, vegas_line = excluded.vegas_line, opening_line = excluded.opening_line,
    consensus = excluded.consensus, edge = excluded.edge, pick_side = excluded.pick_side,
    vote_share = excluded.vote_share, std_dev = excluded.std_dev, conviction = excluded.conviction,
    voters = excluded.voters, tier = excluded.tier, units = excluded.units, flags = excluded.flags,
    eq_edge = excluded.eq_edge, coverage = excluded.coverage, computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;

  update cfb_game_signals s set rank_in_week = r.rk
  from (
    select id, row_number() over (order by conviction desc, vote_share desc, abs(edge) desc) rk
    from cfb_game_signals where season = p_season and week = p_week
  ) r
  where s.id = r.id
    and (v_force or s.game_id in (select g.id from games g where g.season = p_season and g.week = p_week and (g.kickoff_at is null or g.kickoff_at > now())));

  perform cfb_compute_bobcat(p_season, p_week);
  return v_rows;
end $function$;

-- 6. Recalibrate: grade systems on the frozen line -------------------------------
create or replace function public.cfb_recalibrate(p_season integer, p_week integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_min numeric := cfb_cfg('min_games');
  v_k numeric := cfb_cfg('shrink_k');
  v_wa numeric := cfb_cfg('w_ats');
  v_wm numeric := cfb_cfg('w_mae');
  v_scale numeric := cfb_cfg('mae_scale');
  v_src int := case when p_week = 0 then p_season - 1 else p_season end;
  v_max int := case when p_week = 0 then 99 else p_week end;
  v_rows int;
begin
  delete from cfb_system_weights where season = p_season and as_of_week = p_week + 1;

  with y as (
    select r.model_id, r.predicted_margin pm, coalesce(g.pt_line, g.current_line) vl, g.actual_margin am
    from raw_predictions r
    join games g on g.id = r.game_id
    join source_models sm on sm.id = r.model_id
    where g.season = v_src and g.week <= v_max
      and g.actual_margin is not null and coalesce(g.pt_line, g.current_line) is not null
      and r.predicted_margin is not null and sm.status = 'include'
  ),
  st as (
    select model_id,
      count(*) filter (where pm <> vl and am <> vl and sign(pm - vl) = sign(am - vl)) w,
      count(*) filter (where pm <> vl and am <> vl and sign(pm - vl) <> sign(am - vl)) l,
      count(*) filter (where am = vl) p,
      avg(abs(pm - am)) mae,
      avg(pm - am) bias
    from y group by model_id
  ),
  med as (select percentile_cont(0.5) within group (order by mae) m from st where w + l >= v_min),
  f as (
    select st.*, (w + v_k / 2) / (w + l + v_k) shr,
      (w + v_k / 2) / (w + l + v_k) - 0.5 ats_s,
      case when med.m > 0 then (med.m - mae) / med.m * v_scale end mae_s
    from st cross join med
  ),
  g as (
    select f.*, case when w + l >= v_min then greatest(0, v_wa * ats_s + v_wm * coalesce(mae_s, 0)) else 0 end wt
    from f
  )
  insert into cfb_system_weights (model_id, season, as_of_week, source_season, wins, losses, pushes,
    shrunk_ats, mae, bias, ats_score, mae_score, weight, rank)
  select model_id, p_season, p_week + 1, v_src, w, l, p, shr, mae, bias, ats_s, mae_s, wt,
    rank() over (order by wt desc, mae asc)
  from g;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;
