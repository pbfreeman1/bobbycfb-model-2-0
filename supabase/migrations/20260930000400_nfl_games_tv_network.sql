-- nfl_games had no broadcast column. The CFB `games` table has tv_network and
-- the dashboard card shows it, so the NFL card needs the same field. ESPN
-- supplies it on every competition as broadcasts[].names, preferring the
-- national market and joining co-carriers ("ESPN/ABC", "NBC/Peacock").
alter table nfl_games add column if not exists tv_network text;

comment on column nfl_games.tv_network is
  'Lead broadcast carrier(s) from ESPN, national market preferred. Also used by nfl_classify_games as a primetime hint.';
