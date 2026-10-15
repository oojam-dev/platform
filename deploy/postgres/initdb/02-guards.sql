-- oojam data-loss guards (SPEC §3.3).
--
-- Installed by 01-init.sh, as the superuser, into the `site` and `platform`
-- databases. Idempotent: bin/restore re-applies it after a restore. If the
-- postgres entrypoint runs it by itself (it executes every *.sql file in
-- /docker-entrypoint-initdb.d against POSTGRES_DB) it skips any other
-- database; pass `-v oojam_guard_force=1` to install it into one anyway (a
-- scratch copy, say).
--
-- What it installs, in schema `oojam_guard` (owned by the superuser, no
-- privileges for anyone else):
--
--   oojam_block_drops       (event trigger, sql_drop)
--       Raises when a command drops a table, table column, schema, sequence,
--       materialized view or type, or one of the guard triggers below.
--       Indexes, constraints, views, functions and temporary objects may go.
--   oojam_guard_new_tables  (event trigger, ddl_command_end: CREATE TABLE,
--                            CREATE TABLE AS, SELECT INTO)
--       Attaches to each new table:
--         oojam_no_truncate   BEFORE TRUNCATE           -> raise
--         oojam_delete_limit  AFTER DELETE, per statement, with the deleted
--                             rows as a transition table -> raise when more
--                             than oojam.max_delete_rows (default 500) go.
--   oojam_guard_triggers    (event trigger, ddl_command_end: ALTER TABLE,
--                            ALTER TRIGGER)
--       Raises if a guard trigger was disabled (ALTER TABLE ... DISABLE
--       TRIGGER) or renamed (so it could then be dropped under another name).
--
-- oojam.max_delete_rows may be LOWERED by anyone (SET oojam.max_delete_rows =
-- 50). Raising it above 500 only counts in a superuser's session: any role can
-- SET a custom setting, so otherwise the limit would be one statement away.
--
-- Event triggers can only be altered or dropped by their owner, a superuser,
-- so none of the application roles can remove any of this. Superuser escape
-- hatch for maintenance: `SET session_replication_role = replica` (disables
-- ordinary and event triggers for that session; superuser-only), or
-- ALTER EVENT TRIGGER ... DISABLE (deploy/bin/platform-migrate --allow-drops).
--
-- All functions run with search_path = pg_catalog and refer to everything
-- schema-qualified (regclass output is quoted and qualified under that path).

\set ON_ERROR_STOP on

\if :{?oojam_guard_force}
\else
SELECT current_database() IN ('site', 'platform') AS oojam_guard_target \gset
\if :oojam_guard_target
\else
\echo 'oojam guards: not installing into database' :DBNAME '(only site and platform)'
\quit
\endif
\endif

DO $check$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'oojam guards must be installed by a superuser (current_user is %)', current_user;
  END IF;
END
$check$;

BEGIN;

CREATE SCHEMA IF NOT EXISTS oojam_guard;
REVOKE ALL ON SCHEMA oojam_guard FROM PUBLIC;
COMMENT ON SCHEMA oojam_guard IS 'oojam data-loss guards (SPEC §3.3). Superuser-owned; do not modify from migrations.';

-- ── Table triggers ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION oojam_guard.block_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION 'oojam guard: TRUNCATE of %.% is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Data written by other ideas must survive. Delete specific rows instead (at most oojam.max_delete_rows per statement).';
END
$fn$;

CREATE OR REPLACE FUNCTION oojam_guard.limit_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  max_rows bigint := 500;
  wanted   text   := current_setting('oojam.max_delete_rows', true);
  deleted  bigint;
BEGIN
  IF wanted ~ '^\s*[0-9]{1,15}\s*$' THEN
    IF btrim(wanted)::bigint <= max_rows
       OR (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user) THEN
      max_rows := btrim(wanted)::bigint;
    END IF;
  END IF;
  -- Count no further than needed.
  SELECT count(*) INTO deleted FROM (SELECT 1 FROM oojam_old_rows LIMIT max_rows + 1) AS d;
  IF deleted > max_rows THEN
    RAISE EXCEPTION 'oojam guard: a single DELETE on %.% may remove at most % rows', TG_TABLE_SCHEMA, TG_TABLE_NAME, max_rows
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Bulk deletion of data is not allowed. Delete in smaller, deliberate batches if this is really intended.';
  END IF;
  RETURN NULL;
END
$fn$;

-- Attach both triggers to one table, if it is a permanent ordinary or
-- partitioned table outside the system schemas and doesn't have them yet.
-- Not SECURITY DEFINER: only the event trigger function (which is) and this
-- script (a superuser) call it.
CREATE OR REPLACE FUNCTION oojam_guard.attach(rel regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  c record;
BEGIN
  SELECT cl.relkind, cl.relpersistence, n.nspname
    INTO c
    FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE cl.oid = rel;
  IF NOT FOUND
     OR c.relkind NOT IN ('r', 'p')
     OR c.relpersistence = 't'
     OR c.nspname IN ('information_schema', 'oojam_guard')
     OR c.nspname LIKE 'pg\_%' THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = rel AND tgfoid = 'oojam_guard.block_truncate()'::regprocedure) THEN
    EXECUTE format('CREATE TRIGGER oojam_no_truncate BEFORE TRUNCATE ON %s '
                   'FOR EACH STATEMENT EXECUTE FUNCTION oojam_guard.block_truncate()', rel);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = rel AND tgfoid = 'oojam_guard.limit_delete()'::regprocedure) THEN
    BEGIN
      EXECUTE format('CREATE TRIGGER oojam_delete_limit AFTER DELETE ON %s '
                     'REFERENCING OLD TABLE AS oojam_old_rows '
                     'FOR EACH STATEMENT EXECUTE FUNCTION oojam_guard.limit_delete()', rel);
    EXCEPTION WHEN feature_not_supported THEN
      -- Transition tables aren't allowed on some partitions / inheritance
      -- children. Deletes through the parent are still limited.
      RAISE WARNING 'oojam guard: no delete limit on % (%)', rel, SQLERRM;
    END;
  END IF;
END
$fn$;

-- ── Event trigger functions ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION oojam_guard.block_drops() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    -- Temporary objects may go. So may objects that only disappear as an
    -- internal part of something allowed (a view's row type, say): those are
    -- neither the object named in the command (original) nor reached through
    -- a normal dependency, i.e. CASCADE (normal).
    CONTINUE WHEN obj.is_temporary OR NOT (obj.original OR obj.normal);

    IF obj.object_type IN ('table', 'table column', 'schema', 'sequence', 'materialized view', 'type') THEN
      RAISE EXCEPTION 'oojam guard: % may not drop % %', tg_tag, obj.object_type, obj.object_identity
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Migrations are additive only: add tables and columns, never drop them.';
    ELSIF obj.object_type = 'trigger'
          AND obj.address_names[array_upper(obj.address_names, 1)] LIKE 'oojam\_%' THEN
      RAISE EXCEPTION 'oojam guard: % may not drop guard trigger %', tg_tag, obj.object_identity
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION oojam_guard.guard_new_tables() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF cmd.classid = 'pg_class'::regclass AND cmd.object_type = 'table' THEN
      PERFORM oojam_guard.attach(cmd.objid::regclass);
    END IF;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION oojam_guard.protect_guard_triggers() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  cmd record;
  guard_fns oid[] := ARRAY['oojam_guard.block_truncate()'::regprocedure,
                           'oojam_guard.limit_delete()'::regprocedure]::oid[];
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF cmd.classid = 'pg_class'::regclass THEN
      -- 'O' fires normally, 'A' always; 'D' (disabled) and 'R' (replica only) don't.
      IF EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = cmd.objid AND t.tgfoid = ANY (guard_fns)
                    AND t.tgenabled NOT IN ('O', 'A')) THEN
        RAISE EXCEPTION 'oojam guard: % may not disable the guard triggers on %', tg_tag, cmd.object_identity
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF cmd.classid = 'pg_trigger'::regclass THEN
      IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.oid = cmd.objid AND t.tgfoid = ANY (guard_fns)) THEN
        RAISE EXCEPTION 'oojam guard: % may not change guard trigger %', tg_tag, cmd.object_identity
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END LOOP;
END
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA oojam_guard FROM PUBLIC;

-- ── Event triggers (create if missing, always (re-)enable) ──────────────────

DO $et$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = 'oojam_block_drops') THEN
    CREATE EVENT TRIGGER oojam_block_drops ON sql_drop
      EXECUTE FUNCTION oojam_guard.block_drops();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = 'oojam_guard_new_tables') THEN
    CREATE EVENT TRIGGER oojam_guard_new_tables ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      EXECUTE FUNCTION oojam_guard.guard_new_tables();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = 'oojam_guard_triggers') THEN
    CREATE EVENT TRIGGER oojam_guard_triggers ON ddl_command_end
      WHEN TAG IN ('ALTER TABLE', 'ALTER TRIGGER')
      EXECUTE FUNCTION oojam_guard.protect_guard_triggers();
  END IF;
  ALTER EVENT TRIGGER oojam_block_drops ENABLE;
  ALTER EVENT TRIGGER oojam_guard_new_tables ENABLE;
  ALTER EVENT TRIGGER oojam_guard_triggers ENABLE;
END
$et$;

-- ── Backfill: tables that exist already (after a restore, or a late install) ─

SELECT oojam_guard.attach(c.oid)
  FROM pg_catalog.pg_class c
 WHERE c.relkind IN ('r', 'p');

COMMIT;
