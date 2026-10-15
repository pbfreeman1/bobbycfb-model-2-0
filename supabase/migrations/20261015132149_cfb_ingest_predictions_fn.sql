create or replace function cfb_ingest_predictions(p_season int, p_rows jsonb, p_backfill boolean default false, p_source text default 'predictiontracker')
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_run bigint; v_recv int; v_matched int; v_ins int := 0; v_upd int := 0; v_same int := 0; v_lock int := 0;
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
  select t.ord, trim(t.r->>'home') h, trim(t.r->>'road') rd from jsonb_array_elements(p_rows) with ordinality t(r, ord);

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
  end if;

  update cfb_ingest_runs set games_matched = v_matched, preds_inserted = v_ins, preds_updated = v_upd, preds_unchanged = v_same,
    preds_locked = v_lock, games_unmatched = jsonb_array_length(v_unmatched), new_columns = v_newcols,
    status = case when v_recv = 0 then 'empty' when v_matched = 0 then 'no_matches' else 'ok' end,
    detail = jsonb_build_object('unmatched', v_unmatched, 'backfill', p_backfill)
  where id = v_run;

  return jsonb_build_object('run_id', v_run, 'rows_received', v_recv, 'games_matched', v_matched, 'inserted', v_ins,
    'updated', v_upd, 'unchanged', v_same, 'locked_skipped', v_lock, 'unmatched', v_unmatched, 'new_columns', coalesce(to_jsonb(v_newcols), '[]'::jsonb));
end $fn$;

revoke execute on function cfb_ingest_predictions(int, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function cfb_ingest_predictions(int, jsonb, boolean, text) to service_role;;
