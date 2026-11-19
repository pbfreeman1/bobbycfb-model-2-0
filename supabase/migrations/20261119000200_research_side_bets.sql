-- "Other bets": research tags that are tracked but never graded.
--
-- Moneylines, team totals and half / quarter bets that outside sources make.
-- Kept out of research_picks on purpose, so the research report, Play Finder,
-- the drawer's season records and every grading query are unchanged. The only
-- use is the consensus view: how many sources are on the same bet this week.
--
-- Additive only: one new table, its policies and indexes.

create table if not exists public.research_side_bets (
  id           uuid primary key default gen_random_uuid(),
  season       integer not null,
  week         integer not null,
  game_id      uuid not null references public.games(id) on delete cascade,
  home_team    text,
  away_team    text,
  period       text not null default 'full',   -- full | 1h | 2h | 1q..4q
  market       text not null,                  -- spread | total | moneyline | team_total
  team_side    text,                           -- home | away (spread, moneyline, team_total)
  ou_side      text,                           -- over | under (total, team_total)
  line         numeric,                        -- spread from the picked team's side, or the total
  odds         integer,                        -- American price, optional
  source_id    uuid references public.research_sources(id),
  source_label text,
  expert       text,
  note         text,
  created_at   timestamptz not null default now(),
  constraint research_side_bets_period_check check (period in ('full', '1h', '2h', '1q', '2q', '3q', '4q')),
  constraint research_side_bets_market_check check (market in ('spread', 'total', 'moneyline', 'team_total')),
  -- full-game spreads and totals are graded research_picks, not side bets
  constraint research_side_bets_not_graded_check check (not (period = 'full' and market in ('spread', 'total'))),
  constraint research_side_bets_team_check check (
    (market in ('spread', 'moneyline', 'team_total') and team_side in ('home', 'away'))
    or (market = 'total' and team_side is null)),
  constraint research_side_bets_ou_check check (
    (market in ('total', 'team_total') and ou_side in ('over', 'under'))
    or (market in ('spread', 'moneyline') and ou_side is null)),
  constraint research_side_bets_odds_check check (odds is null or abs(odds) >= 100)
);

create index if not exists research_side_bets_week_idx on public.research_side_bets (season, week);
create index if not exists research_side_bets_game_idx on public.research_side_bets (game_id);

alter table public.research_side_bets enable row level security;
create policy "public read research_side_bets"   on public.research_side_bets for select using (true);
create policy "public insert research_side_bets" on public.research_side_bets for insert with check (true);
create policy "public delete research_side_bets" on public.research_side_bets for delete using (true);
