-- Research tags v2: a preset source list and structured tag columns.
--
-- Additive only. Nothing is dropped or renamed, so the production app on `main`
-- (which still writes a free-text source_label) keeps working unchanged.
--
--   research_sources     preset list the tag forms pick from (VSIN and Pickem are
--                        separate sources; a source can opt in to a rank)
--   research_picks       + source_id, rank, conviction, line_at_tag, total_at_tag,
--                        line_basis, legacy_label, split_from
--   BEFORE INSERT trigger  stamps the line/total when the tag is logged and builds
--                        the display label ("KAM #2", "KAM Topish") from the
--                        structured fields, whichever client wrote the row
--   backfill             maps the existing free-text labels to sources, parses KAM
--                        ranks, splits multi-source labels into one row per source
--                        (split rows carry split_from, so it is reversible)

-- ---------------------------------------------------------------------------
-- 1. Sources
-- ---------------------------------------------------------------------------
create table if not exists public.research_sources (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  uses_rank  boolean not null default false,   -- show rank / Top / Topish controls
  active     boolean not null default true,    -- false = hidden from the picker
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  constraint research_sources_name_nonblank check (btrim(name) <> '')
);
create unique index if not exists research_sources_name_lower_key
  on public.research_sources (lower(btrim(name)));

alter table public.research_sources enable row level security;
create policy "public read research_sources"   on public.research_sources for select using (true);
create policy "public insert research_sources" on public.research_sources for insert with check (true);
create policy "public update research_sources" on public.research_sources for update using (true) with check (true);

insert into public.research_sources (name, uses_rank, sort_order) values
  ('KAM', true, 10), ('VSIN', false, 20), ('Pickem', false, 30), ('SportsLine', false, 40),
  ('ESPN', false, 50), ('Yahoo', false, 60), ('Action Network', false, 70), ('Covers', false, 80),
  ('NBC', false, 90), ('Twitter', false, 100), ('CBS 6 Pack', false, 110),
  ('Big Cat (BC)', false, 120), ('Dave', false, 130), ('Rico', false, 140), ('Bear', false, 150)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Structured columns on research_picks
-- ---------------------------------------------------------------------------
alter table public.research_picks
  add column if not exists source_id    uuid references public.research_sources(id),
  add column if not exists rank         integer,
  add column if not exists conviction   text,
  add column if not exists line_at_tag  numeric,   -- home-positive, same convention as games.current_line
  add column if not exists total_at_tag numeric,
  add column if not exists line_basis   text,      -- 'tag_time' | 'backfill'
  add column if not exists legacy_label text,      -- the original free-text source_label, before standardizing
  add column if not exists split_from   uuid;      -- set on rows created by splitting a multi-source label

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'research_picks_rank_check') then
    alter table public.research_picks add constraint research_picks_rank_check check (rank is null or rank between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_picks_conviction_check') then
    alter table public.research_picks add constraint research_picks_conviction_check check (conviction is null or conviction in ('top', 'topish'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_picks_line_basis_check') then
    alter table public.research_picks add constraint research_picks_line_basis_check check (line_basis is null or line_basis in ('tag_time', 'backfill'));
  end if;
end $$;

create index if not exists research_picks_source_idx on public.research_picks (source_id);
create index if not exists research_picks_game_idx   on public.research_picks (game_id);

-- ---------------------------------------------------------------------------
-- 3. Display label + BEFORE INSERT trigger
-- ---------------------------------------------------------------------------
create or replace function public.research_display_label(p_name text, p_rank integer, p_conv text)
returns text language sql immutable as $$
  select p_name || case
    when p_rank is not null then ' #' || p_rank
    when p_conv = 'top'     then ' Top'
    when p_conv = 'topish'  then ' Topish'
    else '' end
$$;

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
      new.source_label := public.research_display_label(v_name, new.rank, new.conviction);
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

create or replace trigger research_picks_before_insert
  before insert on public.research_picks
  for each row execute function public.research_picks_before_insert();

-- ---------------------------------------------------------------------------
-- 4. Backfill the existing tags
-- ---------------------------------------------------------------------------
-- 4a. Split each free-text label on , & / + and map every piece to a source.
create temp table _rp_pieces on commit drop as
select r.id, r.source_label as orig, t.ord::int as ord, btrim(t.tok) as tok,
  case
    when btrim(t.tok) ~* 'sportsline'       then 'SportsLine'
    when btrim(t.tok) ~* 'vsin'             then 'VSIN'
    when btrim(t.tok) ~* 'pickem'           then 'Pickem'
    when btrim(t.tok) ~* 'action'           then 'Action Network'
    when btrim(t.tok) ~* 'covers'           then 'Covers'
    when btrim(t.tok) ~* 'espn'             then 'ESPN'
    when btrim(t.tok) ~* 'yahoo'            then 'Yahoo'
    when btrim(t.tok) ~* 'nbc'              then 'NBC'
    when btrim(t.tok) ~* 'twitter'          then 'Twitter'
    when btrim(t.tok) ~* '6 ?pack|cbs'      then 'CBS 6 Pack'
    when btrim(t.tok) ~* '^(kam|kap)'       then 'KAM'
    when btrim(t.tok) ~* '^bc\y|big ?cat'   then 'Big Cat (BC)'
    when btrim(t.tok) ~* '^dave'            then 'Dave'
    when btrim(t.tok) ~* '^rico'            then 'Rico'
    when btrim(t.tok) ~* '^bear'            then 'Bear'
  end as src_name
from public.research_picks r,
     lateral regexp_split_to_table(r.source_label, '\s*(,|&|/|\+)\s*') with ordinality as t(tok, ord)
where r.source_label is not null
  and r.source_id is null
  and r.legacy_label is null;

-- 4b. One mapped piece per (row, source); KAM pieces also get a rank / conviction.
create temp table _rp_map on commit drop as
with mapped as (
  select p.id, p.orig, p.ord, s.id as source_id, p.src_name, p.tok,
         row_number() over (partition by p.id, p.src_name order by p.ord) as dup
    from _rp_pieces p join public.research_sources s on s.name = p.src_name
   where p.src_name is not null
), picked as (
  select m.*, row_number() over (partition by m.id order by m.ord) as rn
    from mapped m where m.dup = 1
), parsed as (
  select p.*,
    case when p.src_name <> 'KAM' then null
         when p.tok ~* 'top'  then null                      -- "Top", "Top 5", "Top Play", "Topish": no number
         when p.tok ~ '>'     then null                      -- "KAM >60" is not a rank
         else nullif(substring(p.tok from '(\d+)'), '')::int end as rank_raw
  from picked p
)
select id, orig, ord, source_id, src_name, rn,
  case when rank_raw between 1 and 50 then rank_raw end as rank,
  case when src_name <> 'KAM' then null
       when tok ~* 'topish' then 'topish'
       when tok ~* 'top'    then 'top'
       when rank_raw between 1 and 5  then 'top'
       when rank_raw between 6 and 15 then 'topish' end as conviction
from parsed;

-- 4c. First piece updates the original row.
update public.research_picks r
   set source_id    = m.source_id,
       rank         = m.rank,
       conviction   = m.conviction,
       legacy_label = m.orig,
       source_label = public.research_display_label(m.src_name, m.rank, m.conviction)
  from _rp_map m
 where m.id = r.id and m.rn = 1;

-- 4d. Further pieces (a label naming several sources) become their own rows.
insert into public.research_picks
  (season, week, game_id, home_team, away_team, pick_side, pick_type, note, created_at,
   source_id, rank, conviction, legacy_label, split_from, line_basis)
select r.season, r.week, r.game_id, r.home_team, r.away_team, r.pick_side, r.pick_type, r.note, r.created_at,
       m.source_id, m.rank, m.conviction, m.orig, r.id, 'backfill'
  from _rp_map m join public.research_picks r on r.id = m.id
 where m.rn > 1;

-- 4e. Labels that name no source ("Lean", "Under", "2 hits") keep their text
--     as a note and stay unattributed.
update public.research_picks r
   set legacy_label = r.source_label,
       note = coalesce(nullif(btrim(r.note), ''), r.source_label)
 where r.source_label is not null and r.source_id is null and r.legacy_label is null;

-- 4f. Stamp the best available line and total on every untouched row. These are
--     NOT tag-time values: the signal's frozen compute line, and games.over_under
--     (which the results sync may have overwritten after the game).
update public.research_picks r
   set line_at_tag  = coalesce((select s.vegas_line from public.cfb_game_signals s
                                 where s.game_id = r.game_id order by s.computed_at desc limit 1),
                               g.current_line),
       total_at_tag = g.over_under,
       line_basis   = 'backfill'
  from public.games g
 where g.id = r.game_id and r.line_basis is distinct from 'tag_time';
