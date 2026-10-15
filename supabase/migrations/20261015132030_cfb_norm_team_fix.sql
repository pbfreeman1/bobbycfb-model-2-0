create or replace function cfb_norm_team(t text) returns text language plpgsql immutable as $$
declare s text;
begin
  s := lower(trim(coalesce(t,'')));
  s := translate(s, 'éáíóúñüç', 'eaiounuc');
  s := replace(s, '&', ' and ');
  s := regexp_replace(s, '\(ohio\)', '(oh)', 'g');
  s := regexp_replace(s, '\yst\.', 'state', 'g');
  s := regexp_replace(s, '\yst$', 'state');
  s := regexp_replace(s, '\ymich\.', 'michigan', 'g');
  s := regexp_replace(s, '\yintl\.', 'international', 'g');
  s := regexp_replace(s, '\ytenn\.', 'tennessee', 'g');
  s := regexp_replace(s, '\yconn\.', 'connecticut', 'g');
  s := regexp_replace(s, '\ymiss\.', 'miss', 'g');
  return regexp_replace(s, '[^a-z0-9]', '', 'g');
end $$;

-- The applied migration re-derived the alias map here, because changing
-- cfb_norm_team above (word boundary `\b` -> `\y`, so "St." and "Mich." are
-- matched by Postgres' regex dialect rather than silently missed) changes the
-- keys the map has to be stored under.
--
-- Nothing to re-derive in a rebuild: 20261015132007_cfb_ingest_foundation now
-- seeds cfb_team_alias with literal keys already in this function's output
-- form, so the map is correct as soon as it is inserted. The original
-- `insert ... select` is dropped rather than reproduced because it read the
-- one-off `cfb_import_staging` table, which is not part of the schema.
--
-- Re-asserted as a no-op guard: if the foundation seed is ever edited, this
-- fails loudly here rather than leaving the matcher quietly unable to resolve
-- an aliased name.
do $$
declare bad int;
begin
  select count(*) into bad
  from cfb_team_alias
  where norm_key <> cfb_norm_team(norm_key);
  if bad > 0 then
    raise exception
      'cfb_team_alias has % row(s) whose norm_key is not in cfb_norm_team() normal form', bad;
  end if;
end $$;
