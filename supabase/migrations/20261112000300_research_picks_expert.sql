-- Per-expert tags. Several experts at one outlet (VSIN, ESPN, ...) can credit
-- the same side of a game; each gets its own tag, labelled "VSIN - Makinen".
-- The report folds any label containing "vsin" back to the VSIN source, so the
-- source rollups are unchanged while every tag still counts individually.
-- Additive: one nullable column and a trigger tweak. Existing rows untouched.

alter table public.research_picks add column if not exists expert text;

create or replace function public.research_picks_before_insert()
returns trigger language plpgsql as $$
declare
  v_name text;
begin
  if new.source_id is not null then
    select name into v_name from public.research_sources where id = new.source_id;
    if new.rank is not null and new.conviction is null then
      new.conviction := case when new.rank <= 5 then 'top' when new.rank <= 15 then 'topish' end;
    end if;
    if v_name is not null then
      new.source_label := case
        when nullif(btrim(new.expert), '') is not null and new.rank is null
          then v_name || ' - ' || btrim(new.expert)
        else public.research_display_label(v_name, new.rank, new.conviction) end;
    end if;
  end if;

  -- Freeze the line and total as they stood when the tag was logged. A row that
  -- names its own basis (the backfill) is left alone.
  if new.line_basis is null and new.game_id is not null then
    select coalesce(
             (select s.vegas_line from public.cfb_game_signals s
               where s.game_id = new.game_id order by s.computed_at desc limit 1),
             g.current_line),
           g.over_under
      into new.line_at_tag, new.total_at_tag
      from public.games g where g.id = new.game_id;
    new.line_basis := 'tag_time';
  end if;
  return new;
end $$;
