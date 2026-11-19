-- Outside picks (scout): schedules. Times are UTC, set for Eastern Standard
-- Time like the other jobs (an hour later in ET once daylight saving starts).
--   scout-dispatch   every minute: sends queued jobs to the site, closes runs (idle when nothing is queued)
--   scout-cbb-am     11:00 AM ET daily
--   scout-cbb-pm      5:00 PM ET daily
--   scout-nfl-thu    noon ET Thursday
--   scout-nfl-sun    11:00 AM ET Sunday
select cron.schedule('scout-dispatch', '* * * * *', 'select public.scout_dispatch()');
select cron.schedule('scout-cbb-am', '0 16 * * *', $$select public.scout_kick('cbb', 'scheduled')$$);
select cron.schedule('scout-cbb-pm', '0 22 * * *', $$select public.scout_kick('cbb', 'scheduled')$$);
select cron.schedule('scout-nfl-thu', '0 17 * * 4', $$select public.scout_kick('nfl', 'scheduled')$$);
select cron.schedule('scout-nfl-sun', '0 16 * * 0', $$select public.scout_kick('nfl', 'scheduled')$$);
