-- CFB automation, part 2: the cycle, manual refresh queue, pull-log view and schedule.

create or replace function cfb_cycle(p_trigger text default 'schedule')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_season int := cfb_season_now();
  v_run bigint; v_espn jsonb; v_grade jsonb; v_arch jsonb; v_live jsonb; v_ref jsonb;
  v_err text;
begin
  insert into cfb_runs (kind, status, trigger) values ('cycle', 'running', p_trigger) returning id into v_run;

  -- 1. ESPN: schedule, kickoffs, finals, current line.
  begin
    v_espn := cfb_sync_espn(v_season);
    if jsonb_array_length(coalesce(v_espn->'errors', '[]'::jsonb)) > 0 then
      v_err := 'espn: ' || (v_espn->'errors'->0->>'error');
    end if;
  exception when others then v_err := 'espn: ' || sqlerrm; end;

  -- 2. Grade anything newly final (THE Bobby Model, every system, My Card).
  begin
    v_grade := cfb_grade_all(v_season);
  exception when others then v_err := concat_ws(' | ', v_err, 'grade: ' || sqlerrm); end;

  -- 3. Once a day: PT season file fills predictions missing on completed games.
  begin
    if not exists (select 1 from cfb_ingest_runs where source = 'pt-season' and status = 'ok'
                   and (started_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date) then
      v_arch := cfb_load_season_file(v_season);
    end if;
  exception when others then v_err := concat_ws(' | ', v_err, 'season file: ' || sqlerrm); end;

  -- 4. PT live CSV: this week's predictions, PT line and opener (unstarted games only).
  begin
    v_live := cfb_ingest_live(v_season, v_run);
  exception when others then v_err := concat_ws(' | ', v_err, 'live: ' || sqlerrm); end;

  -- 5. Recalibrate weights from every graded game, then compute the current week.
  begin
    v_ref := cfb_refresh(v_season, true);
  exception when others then v_err := concat_ws(' | ', v_err, 'compute: ' || sqlerrm); end;

  update cfb_runs set finished_at = now(), status = case when v_err is null then 'ok' else 'error' end,
    detail = jsonb_build_object('run_id', v_run, 'season', v_season, 'espn', v_espn - 'weeks', 'espn_weeks', v_espn->'weeks',
                                'grade', v_grade, 'season_file', v_arch, 'live', v_live, 'refresh', v_ref, 'error', v_err)
  where id = v_run;
  return (select detail from cfb_runs where id = v_run);
end $$;

create or replace function cfb_request_refresh()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if exists (select 1 from cfb_refresh_requests where picked_up_at is null) then
    return jsonb_build_object('status', 'pending', 'message', 'A refresh is already queued.');
  end if;
  if exists (select 1 from cfb_runs where kind = 'cycle' and started_at > now() - interval '2 minutes') then
    return jsonb_build_object('status', 'throttled', 'message', 'A pull ran in the last 2 minutes. Try again shortly.');
  end if;
  insert into cfb_refresh_requests default values returning id into v_id;
  return jsonb_build_object('status', 'queued', 'request_id', v_id);
end $$;

create or replace function cfb_run_pending()
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_req bigint; v_detail jsonb;
begin
  select id into v_req from cfb_refresh_requests where picked_up_at is null order by id limit 1 for update skip locked;
  if v_req is null then return null; end if;
  update cfb_refresh_requests set picked_up_at = now() where picked_up_at is null;
  v_detail := cfb_cycle('manual');
  update cfb_refresh_requests set run_id = (v_detail->>'run_id')::bigint where id = v_req;
  return v_req;
end $$;

revoke execute on function cfb_cycle(text), cfb_run_pending() from public, anon, authenticated;
grant execute on function cfb_request_refresh() to anon, authenticated;

create or replace view cfb_run_log as
select r.id, r.started_at, r.finished_at, r.trigger, r.status,
  (r.detail->'refresh'->>'week')::int as week,
  (r.detail->'espn'->>'updated')::int + (r.detail->'espn'->>'inserted')::int as espn_changed,
  (r.detail->'espn'->>'inserted')::int as games_added,
  (r.detail->'espn'->>'finals')::int as finals,
  (r.detail->'live'->>'csv_rows')::int as pt_rows,
  (r.detail->'live'->>'games_matched')::int as pt_matched,
  (r.detail->'live'->>'lines_moved')::int as lines_moved,
  (r.detail->'live'->>'inserted')::int as preds_added,
  (r.detail->'live'->>'updated')::int as preds_changed,
  (r.detail->'season_file'->>'inserted')::int as backfilled,
  (r.detail->'refresh'->>'signals_written')::int as signals,
  (r.detail->'grade'->>'signals_graded')::int as graded,
  (r.detail->'grade'->>'my_picks_graded')::int as my_picks_graded,
  (select string_agg(x, ', ') from jsonb_array_elements_text(r.detail->'live'->'unmatched') x) as unmatched,
  (select string_agg(x, ', ') from jsonb_array_elements_text(r.detail->'live'->'new_columns') x) as new_columns,
  r.detail->>'error' as error
from cfb_runs r;
grant select on cfb_run_log to anon, authenticated;

-- Schedule (UTC). In winter: 8:30 AM, 12:30 PM, 4:30 PM ET daily, plus
-- 10:30 AM, 2:30 PM and 6:30 PM ET on Saturdays.
select cron.schedule('cfb-cycle-daily', '30 13,17,21 * * *', 'select public.cfb_cycle()');
select cron.schedule('cfb-cycle-saturday', '30 15,19,23 * * 6', 'select public.cfb_cycle()');
select cron.schedule('cfb-run-pending', '* * * * *', 'select public.cfb_run_pending()');
