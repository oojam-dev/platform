#!/usr/bin/env bash
# shellcheck disable=SC2016 # SQL in single quotes uses $$ dollar-quoting on purpose
# Tests deploy/postgres/initdb (roles, privileges, pg_hba and the SPEC §3.3
# data-loss guards) against a throwaway postgres:17 container.
#
#   deploy/postgres/test/guards.sh            # uses the image pinned in compose.yml
#   POSTGRES_IMAGE=postgres:17 deploy/postgres/test/guards.sh
#
# Starts a database container with no network (--network none) and the initdb
# scripts mounted exactly as compose mounts them, and a client container that
# shares its network namespace and connects over TCP to 127.0.0.1 (01-init.sh's
# pg_hba has no loopback exceptions, so pg_hba and passwords are exercised as
# for any network client). Everything is removed on exit.
set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INITDB=$(cd "$HERE/../initdb" && pwd)
IMAGE=${POSTGRES_IMAGE:-postgres:17.11-trixie@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f}
RUN_ID=oojam-guards-test-$$
DB=$RUN_ID-db
CLIENT=$RUN_ID-client

pw() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
SU_PW=$(pw)
PLATFORM_OWNER_PW=$(pw)
PLATFORM_APP_PW=$(pw)
SITE_MIGRATOR_PW=$(pw)
SITE_APP_PW=$(pw)
BACKUP_PW=$(pw)

pass=0
fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

cleanup() {
  docker rm -f "$DB" "$CLIENT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

password_for() {
  case $1 in
    postgres) echo "$SU_PW" ;;
    platform_owner) echo "$PLATFORM_OWNER_PW" ;;
    platform_app) echo "$PLATFORM_APP_PW" ;;
    site_migrator) echo "$SITE_MIGRATOR_PW" ;;
    site_app) echo "$SITE_APP_PW" ;;
    backup) echo "$BACKUP_PW" ;;
    *) echo "unknown role $1" >&2; return 1 ;;
  esac
}

# sql ROLE DB  (SQL on stdin) — over the network from the client container.
sql() {
  docker exec -i -e PGPASSWORD="$(password_for "$1")" -e PGCONNECT_TIMEOUT=5 "$CLIENT" \
    psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d "$2" -At
}
# su_sql DB  (SQL on stdin) — the superuser, over the socket inside the db container.
su_sql() {
  docker exec -i "$DB" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$1" -At
}

# ok NAME ROLE DB SQL — expects success.
ok() {
  local name=$1 role=$2 db=$3 query=$4 out
  if out=$( (if [[ $role == SU ]]; then su_sql "$db"; else sql "$role" "$db"; fi) <<<"$query" 2>&1); then
    green "PASS  $name"; pass=$((pass + 1))
  else
    red "FAIL  $name (expected success)"; printf '      %s\n' "$out"; fail=$((fail + 1))
  fi
}
# denied NAME ROLE DB PATTERN SQL — expects failure with PATTERN (ERE) in the output.
denied() {
  local name=$1 role=$2 db=$3 pattern=$4 query=$5 out
  if out=$( (if [[ $role == SU ]]; then su_sql "$db"; else sql "$role" "$db"; fi) <<<"$query" 2>&1); then
    red "FAIL  $name (expected an error, it succeeded)"; printf '      %s\n' "$out"; fail=$((fail + 1))
  elif grep -Eq -- "$pattern" <<<"$out"; then
    green "PASS  $name"; pass=$((pass + 1))
  else
    red "FAIL  $name (failed, but not with /$pattern/)"; printf '      %s\n' "$out"; fail=$((fail + 1))
  fi
}
# equals NAME ROLE DB EXPECTED SQL — expects the (trimmed) output to equal EXPECTED.
equals() {
  local name=$1 role=$2 db=$3 expected=$4 query=$5 out
  if out=$( (if [[ $role == SU ]]; then su_sql "$db"; else sql "$role" "$db"; fi) <<<"$query" 2>&1) && [[ $out == "$expected" ]]; then
    green "PASS  $name"; pass=$((pass + 1))
  else
    red "FAIL  $name (expected '$expected')"; printf '      %s\n' "$out"; fail=$((fail + 1))
  fi
}

echo "image: $IMAGE"
docker run -d --name "$DB" --network none \
  -e POSTGRES_PASSWORD="$SU_PW" \
  -e PLATFORM_OWNER_PASSWORD="$PLATFORM_OWNER_PW" \
  -e PLATFORM_APP_PASSWORD="$PLATFORM_APP_PW" \
  -e SITE_MIGRATOR_PASSWORD="$SITE_MIGRATOR_PW" \
  -e SITE_APP_PASSWORD="$SITE_APP_PW" \
  -e BACKUP_DB_PASSWORD="$BACKUP_PW" \
  -v "$INITDB:/docker-entrypoint-initdb.d:ro" \
  "$IMAGE" >/dev/null
docker run -d --name "$CLIENT" --network "container:$DB" --entrypoint sleep "$IMAGE" infinity >/dev/null

# The init phase listens on the socket only, so a TCP answer means init is done.
for i in $(seq 1 90); do
  if [[ $(docker inspect -f '{{.State.Running}}' "$DB") != true ]]; then
    red "database container exited during init:"; docker logs "$DB" 2>&1 | tail -n 40; exit 1
  fi
  if docker exec "$CLIENT" pg_isready -q -h 127.0.0.1 -t 1 2>/dev/null; then break; fi
  if [[ $i == 90 ]]; then red "database not ready after 90s"; docker logs "$DB" 2>&1 | tail -n 40; exit 1; fi
  sleep 1
done
if docker logs "$DB" 2>&1 | grep -q 'ERROR'; then
  red "errors during init:"; docker logs "$DB" 2>&1 | grep -B2 -A2 ERROR; exit 1
fi
echo "database ready"
echo

echo "── authentication and isolation"
denied "superuser cannot log in over the network" postgres postgres "pg_hba.conf rejects|no pg_hba.conf entry" "SELECT 1"
if out=$(docker exec -e PGPASSWORD=wrong "$CLIENT" psql -X -h 127.0.0.1 -U site_app -d site -c 'SELECT 1' 2>&1); then
  red "FAIL  wrong password is refused (it was accepted)"; fail=$((fail + 1))
elif grep -q 'password authentication failed' <<<"$out"; then
  green "PASS  wrong password is refused"; pass=$((pass + 1))
else
  red "FAIL  wrong password is refused (unexpected: $out)"; fail=$((fail + 1))
fi
denied "site_app cannot connect to platform" site_app platform "permission denied for database" "SELECT 1"
denied "site_migrator cannot connect to platform" site_migrator platform "permission denied for database" "SELECT 1"
denied "site_migrator cannot connect to postgres db" site_migrator postgres "permission denied for database" "SELECT 1"
denied "site_migrator cannot connect to template1" site_migrator template1 "permission denied for database" "SELECT 1"
denied "platform_app cannot connect to site" platform_app site "permission denied for database" "SELECT 1"
denied "platform_owner cannot connect to site" platform_owner site "permission denied for database" "SELECT 1"
equals "no application role is a superuser or can create roles/dbs" SU postgres "0" \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('platform_owner','platform_app','site_migrator','site_app','backup') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)"
denied "site_migrator cannot SET ROLE postgres" site_migrator site "permission denied to set role" "SET ROLE postgres"
denied "site_migrator cannot SET SESSION AUTHORIZATION postgres" site_migrator site "permission denied" "SET SESSION AUTHORIZATION postgres"
denied "site_migrator cannot set session_replication_role" site_migrator site "permission denied" "SET session_replication_role = replica"
denied "site_migrator cannot DROP DATABASE site" site_migrator site "must be owner|cannot drop the currently open database" "DROP DATABASE site"
denied "site_migrator cannot ALTER DATABASE site" site_migrator site "must be owner" "ALTER DATABASE site SET statement_timeout = 0"
equals "site_app has statement_timeout 30s" site_app site "30s" "SHOW statement_timeout"
equals "platform_app has statement_timeout 30s" platform_app platform "30s" "SHOW statement_timeout"

echo
echo "── site_migrator: allowed DDL"
ok "create table" site_migrator site "CREATE TABLE ideas_t (id serial PRIMARY KEY, title text NOT NULL)"
equals "guard triggers attached to the new table" SU site "oojam_delete_limit,oojam_no_truncate" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.ideas_t'::regclass"
ok "add column" site_migrator site "ALTER TABLE ideas_t ADD COLUMN body text"
ok "add column with default + set/drop default" site_migrator site "ALTER TABLE ideas_t ADD COLUMN score int NOT NULL DEFAULT 0; ALTER TABLE ideas_t ALTER COLUMN score SET DEFAULT 1; ALTER TABLE ideas_t ALTER COLUMN body DROP DEFAULT"
ok "create index" site_migrator site "CREATE INDEX ideas_t_title_idx ON ideas_t (title)"
ok "drop index" site_migrator site "DROP INDEX ideas_t_title_idx"
ok "add + drop constraint" site_migrator site "ALTER TABLE ideas_t ADD CONSTRAINT title_len CHECK (length(title) < 500); ALTER TABLE ideas_t DROP CONSTRAINT title_len"
ok "create enum + add value" site_migrator site "CREATE TYPE mood AS ENUM ('happy'); ALTER TYPE mood ADD VALUE 'sad'"
ok "create + drop view" site_migrator site "CREATE VIEW ideas_v AS SELECT id, title FROM ideas_t; DROP VIEW ideas_v"
ok "create schema" site_migrator site "CREATE SCHEMA extra"
ok "create sequence" site_migrator site "CREATE SEQUENCE extra.counter"
ok "create materialized view" site_migrator site "CREATE MATERIALIZED VIEW ideas_mv AS SELECT count(*) AS n FROM ideas_t"
ok "temporary tables are not guarded (create, truncate, drop)" SU site "CREATE TEMP TABLE scratch (x int); INSERT INTO scratch SELECT generate_series(1, 1000); TRUNCATE scratch; DROP TABLE scratch"
ok "create table with quoted schema/table names" site_migrator site 'CREATE SCHEMA "Odd Schema"; CREATE TABLE "Odd Schema"."Odd ""Table""" (id int)'
equals "guards attached to the quoted table" SU site "2" \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid = '\"Odd Schema\".\"Odd \"\"Table\"\"\"'::regclass AND tgname LIKE 'oojam\_%'"
ok "create table as" site_migrator site "CREATE TABLE ideas_copy AS SELECT * FROM ideas_t"
equals "guards attached to CREATE TABLE AS" SU site "2" \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.ideas_copy'::regclass AND tgname LIKE 'oojam\_%'"
ok "create partitioned table + partition" site_migrator site "CREATE TABLE events_p (id int, at date) PARTITION BY RANGE (at); CREATE TABLE events_2026 PARTITION OF events_p FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')"

echo
echo "── site_migrator: blocked DDL"
denied "DROP TABLE" site_migrator site "oojam guard" "CREATE TABLE lonely_t (id int); DROP TABLE lonely_t"
denied "DROP TABLE ... CASCADE" site_migrator site "oojam guard" "DROP TABLE ideas_t CASCADE"
denied "ALTER TABLE DROP COLUMN" site_migrator site "oojam guard" "ALTER TABLE ideas_t DROP COLUMN body"
denied "DROP SCHEMA" site_migrator site "oojam guard" "DROP SCHEMA extra CASCADE"
denied "DROP SCHEMA (empty)" site_migrator site "oojam guard" "CREATE SCHEMA empty_s; DROP SCHEMA empty_s"
denied "DROP SEQUENCE" site_migrator site "oojam guard" "DROP SEQUENCE extra.counter"
denied "DROP MATERIALIZED VIEW" site_migrator site "oojam guard" "DROP MATERIALIZED VIEW ideas_mv"
denied "DROP TYPE" site_migrator site "oojam guard" "DROP TYPE mood"
denied "DROP partition" site_migrator site "oojam guard" "DROP TABLE events_2026"
denied "DROP OWNED BY" site_migrator site "oojam guard" "DROP OWNED BY site_migrator"
denied "TRUNCATE" site_migrator site "oojam guard: TRUNCATE" "TRUNCATE ideas_t"
denied "TRUNCATE ... CASCADE" site_migrator site "oojam guard: TRUNCATE" "TRUNCATE ideas_t CASCADE"
denied "TRUNCATE quoted table" site_migrator site "oojam guard: TRUNCATE" 'TRUNCATE "Odd Schema"."Odd ""Table"""'
denied "TRUNCATE partitioned table" site_migrator site "oojam guard: TRUNCATE" "TRUNCATE events_p"
denied "DISABLE guard trigger" site_migrator site "oojam guard" "ALTER TABLE ideas_t DISABLE TRIGGER oojam_no_truncate"
denied "DISABLE TRIGGER ALL/USER" site_migrator site "oojam guard|permission denied" "ALTER TABLE ideas_t DISABLE TRIGGER USER"
denied "ENABLE REPLICA guard trigger" site_migrator site "oojam guard" "ALTER TABLE ideas_t ENABLE REPLICA TRIGGER oojam_delete_limit"
denied "DROP guard trigger" site_migrator site "oojam guard" "DROP TRIGGER oojam_no_truncate ON ideas_t"
denied "rename guard trigger" site_migrator site "oojam guard" "ALTER TRIGGER oojam_no_truncate ON ideas_t RENAME TO harmless"
denied "ALTER EVENT TRIGGER ... DISABLE" site_migrator site "must be owner" "ALTER EVENT TRIGGER oojam_block_drops DISABLE"
denied "DROP EVENT TRIGGER" site_migrator site "must be owner" "DROP EVENT TRIGGER oojam_block_drops"
denied "ALTER EVENT TRIGGER (new tables)" site_migrator site "must be owner" "ALTER EVENT TRIGGER oojam_guard_new_tables DISABLE"
denied "replace a guard function" site_migrator site "permission denied|must be owner" \
  'CREATE OR REPLACE FUNCTION oojam_guard.block_drops() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$'
denied "call the attach helper" site_migrator site "permission denied" "SELECT oojam_guard.attach('ideas_t'::regclass)"
denied "create a table in oojam_guard" site_migrator site "permission denied" "CREATE TABLE oojam_guard.x (id int)"
denied "create an event trigger" site_migrator site "permission denied|must be superuser" \
  "CREATE EVENT TRIGGER evil ON sql_drop EXECUTE FUNCTION oojam_guard.block_drops()"
equals "all guard triggers still present and enabled" SU site "0" \
  "SELECT count(*) FROM pg_class c WHERE c.relkind IN ('r','p') AND c.relnamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'pg\_%' OR nspname IN ('information_schema','oojam_guard')) AND (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname LIKE 'oojam\_%' AND t.tgenabled = 'O') < 2"
equals "event triggers enabled" SU site "oojam_block_drops:O,oojam_guard_new_tables:O,oojam_guard_triggers:O" \
  "SELECT string_agg(evtname || ':' || evtenabled::text, ',' ORDER BY evtname) FROM pg_event_trigger"

echo
echo "── delete limit"
ok "insert 600 rows" site_migrator site "INSERT INTO ideas_t (title) SELECT 'idea ' || g FROM generate_series(1, 600) g"
denied "DELETE 600 rows in one statement (site_migrator)" site_migrator site "may remove at most 500 rows" "DELETE FROM ideas_t"
denied "DELETE 600 rows in one statement (site_app)" site_app site "may remove at most 500 rows" "DELETE FROM ideas_t"
ok "DELETE 10 rows" site_app site "DELETE FROM ideas_t WHERE id <= 10"
equals "590 rows left" site_app site "590" "SELECT count(*) FROM ideas_t"
ok "DELETE exactly 500 rows" site_app site "DELETE FROM ideas_t WHERE id > 10 AND id <= 510"
ok "re-insert 500 rows" site_app site "INSERT INTO ideas_t (title) SELECT 'again ' || g FROM generate_series(1, 500) g"
denied "raising oojam.max_delete_rows is ignored for non-superusers" site_app site "may remove at most 500 rows" \
  "SET oojam.max_delete_rows = 100000; DELETE FROM ideas_t"
denied "lowering oojam.max_delete_rows works" site_app site "may remove at most 5 rows" \
  "SET oojam.max_delete_rows = 5; DELETE FROM ideas_t WHERE id IN (SELECT id FROM ideas_t ORDER BY id LIMIT 6)"
denied "cascade delete counts child rows" site_migrator site "may remove at most 500 rows" \
  "CREATE TABLE parent_t (id int PRIMARY KEY); CREATE TABLE child_t (id serial, parent_id int REFERENCES parent_t ON DELETE CASCADE);
   INSERT INTO parent_t VALUES (1); INSERT INTO child_t (parent_id) SELECT 1 FROM generate_series(1, 501);
   DELETE FROM parent_t WHERE id = 1"
denied "DELETE via partitioned parent" site_migrator site "may remove at most 500 rows" \
  "INSERT INTO events_p SELECT g, '2026-06-01' FROM generate_series(1, 501) g; DELETE FROM events_p"
ok "superuser may raise the limit in its own session" SU site \
  "SET oojam.max_delete_rows = 100000; DELETE FROM ideas_t WHERE id > 600"

echo
echo "── site_app: DML only"
ok "SELECT/INSERT/UPDATE/DELETE" site_app site \
  "SELECT count(*) FROM ideas_t; INSERT INTO ideas_t (title) VALUES ('from app') RETURNING id; UPDATE ideas_t SET body = 'x' WHERE title = 'from app'; DELETE FROM ideas_t WHERE title = 'from app'"
ok "uses sequences (serial insert)" site_app site "INSERT INTO ideas_t (title) VALUES ('seq') RETURNING id"
denied "CREATE TABLE" site_app site "permission denied for schema public" "CREATE TABLE nope (id int)"
denied "CREATE SCHEMA" site_app site "permission denied for database" "CREATE SCHEMA nope"
denied "ALTER TABLE" site_app site "must be owner" "ALTER TABLE ideas_t ADD COLUMN nope int"
denied "DROP TABLE" site_app site "must be owner|oojam guard" "DROP TABLE ideas_t"
denied "TRUNCATE" site_app site "permission denied|oojam guard" "TRUNCATE ideas_t"
denied "CREATE TEMP TABLE" site_app site "permission denied" "CREATE TEMP TABLE nope (id int)"
denied "GRANT itself CREATE has no effect" site_app site "permission denied for schema public" "GRANT CREATE ON SCHEMA public TO site_app; CREATE TABLE nope (id int)"

echo
echo "── drizzle migrator"
DRIZZLE_BOOT='CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1;'
ok "bootstrap drizzle schema + __drizzle_migrations" site_migrator site "$DRIZZLE_BOOT"
ok "bootstrap again (IF NOT EXISTS path)" site_migrator site "$DRIZZLE_BOOT"
ok "apply a migration in a transaction" site_migrator site 'BEGIN;
CREATE TABLE "comments" ("id" serial PRIMARY KEY NOT NULL, "idea_id" integer NOT NULL, "body" text NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE "comments" ADD CONSTRAINT "comments_idea_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas_t"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX IF NOT EXISTS "comments_idea_idx" ON "comments" USING btree ("idea_id");
INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($$abc123$$, 1760000000000);
COMMIT;'
equals "migration recorded" site_migrator site "1" 'SELECT count(*) FROM "drizzle"."__drizzle_migrations"'
ok "site_app can use the new table" site_app site "INSERT INTO comments (idea_id, body) SELECT id, 'hi' FROM ideas_t LIMIT 1"
denied "site_app cannot read drizzle's journal" site_app site "permission denied for schema drizzle" 'SELECT * FROM "drizzle"."__drizzle_migrations"'

echo
echo "── platform database"
ok "platform_owner creates a table" platform_owner platform "CREATE TABLE users_t (id serial PRIMARY KEY, login text)"
ok "platform_app DML" platform_app platform "INSERT INTO users_t (login) VALUES ('octocat'); UPDATE users_t SET login = 'x'; SELECT count(*) FROM users_t; DELETE FROM users_t"
denied "platform_app cannot CREATE TABLE" platform_app platform "permission denied for schema public" "CREATE TABLE nope (id int)"
denied "platform_owner DROP TABLE is blocked" platform_owner platform "oojam guard" "DROP TABLE users_t"
denied "platform_owner DROP COLUMN is blocked" platform_owner platform "oojam guard" "ALTER TABLE users_t DROP COLUMN login"
denied "platform TRUNCATE is blocked" platform_owner platform "oojam guard: TRUNCATE" "TRUNCATE users_t"
ok "superuser disables oojam_block_drops (platform-migrate --allow-drops)" SU platform "ALTER EVENT TRIGGER oojam_block_drops DISABLE"
ok "platform_owner DROP COLUMN while disabled" platform_owner platform "ALTER TABLE users_t DROP COLUMN login"
ok "superuser re-enables oojam_block_drops" SU platform "ALTER EVENT TRIGGER oojam_block_drops ENABLE"
denied "DROP blocked again" platform_owner platform "oojam guard" "DROP TABLE users_t"

echo
echo "── backup role, dump and restore"
denied "backup cannot write" backup site "permission denied" "INSERT INTO ideas_t (title) VALUES ('nope')"
denied "backup cannot create" backup site "permission denied" "CREATE TABLE nope (id int)"
if docker exec -e PGPASSWORD="$BACKUP_PW" "$CLIENT" pg_dump -h 127.0.0.1 -U backup -d site -Fc -f /tmp/site.dump 2>/tmp/oojam-guards-dump.err \
  && docker exec -e PGPASSWORD="$BACKUP_PW" "$CLIENT" pg_dump -h 127.0.0.1 -U backup -d platform -Fc -f /tmp/platform.dump; then
  green "PASS  pg_dump -Fc of both databases as backup"; pass=$((pass + 1))
else
  red "FAIL  pg_dump as backup"; cat /tmp/oojam-guards-dump.err; fail=$((fail + 1))
fi
rm -f /tmp/oojam-guards-dump.err
docker cp "$CLIENT:/tmp/site.dump" - | docker cp - "$DB:/tmp/" >/dev/null
# The bin/restore procedure: fresh database, grants, pg_restore, guards re-applied.
ok "restore into a fresh database (bin/restore procedure)" SU postgres "CREATE DATABASE site_restored"
if out=$(docker exec "$DB" sh -c 'pg_restore -U postgres -d site_restored --exit-on-error /tmp/site.dump && psql -X -q -v ON_ERROR_STOP=1 -U postgres -d site_restored -v oojam_guard_force=1 -f /docker-entrypoint-initdb.d/02-guards.sql' 2>&1); then
  green "PASS  pg_restore + re-apply guards"; pass=$((pass + 1))
else
  red "FAIL  pg_restore + re-apply guards"; printf '      %s\n' "$out"; fail=$((fail + 1))
fi
equals "restored data matches" SU site_restored "$(su_sql site <<<'SELECT count(*) FROM ideas_t')" "SELECT count(*) FROM ideas_t"
equals "restored tables keep exactly one set of guards" SU site_restored "2" \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.ideas_t'::regclass AND tgname LIKE 'oojam\_%'"
ok "superuser: GRANT CONNECT on restored db to site_migrator (test only)" SU postgres "GRANT CONNECT ON DATABASE site_restored TO site_migrator"
denied "restored db: guards active (DROP)" site_migrator site_restored "oojam guard" "DROP TABLE ideas_t CASCADE"
denied "restored db: guards active (TRUNCATE)" site_migrator site_restored "oojam guard: TRUNCATE" "TRUNCATE ideas_t CASCADE"
ok "restored db: new tables still get guards" site_migrator site_restored "CREATE TABLE after_restore (id int)"
equals "restored db: ownership kept" SU site_restored "site_migrator" "SELECT tableowner FROM pg_tables WHERE tablename = 'ideas_t'"

echo
echo "── idempotence"
ok "re-applying 02-guards.sql to site is a no-op" SU site "\\i /docker-entrypoint-initdb.d/02-guards.sql"
equals "still exactly two guard triggers per table" SU site "2" \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.ideas_t'::regclass AND tgname LIKE 'oojam\_%'"
equals "guards not installed in the postgres maintenance db" SU postgres "0" "SELECT count(*) FROM pg_event_trigger"

echo
echo "── full restore over 'site' (bin/restore: DROP DATABASE, pg_restore --create, guards)"
rows_before=$(su_sql site <<<'SELECT count(*) FROM ideas_t')
if docker exec -e PGPASSWORD="$BACKUP_PW" "$CLIENT" pg_dump -h 127.0.0.1 -U backup -d site -Fc -f /tmp/site2.dump \
  && docker cp "$CLIENT:/tmp/site2.dump" - | docker cp - "$DB:/tmp/" >/dev/null \
  && out=$(docker exec "$DB" sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "DROP DATABASE site WITH (FORCE)" \
       && pg_restore -U postgres --create --dbname postgres --exit-on-error /tmp/site2.dump \
       && psql -X -q -v ON_ERROR_STOP=1 -U postgres -d site -f /docker-entrypoint-initdb.d/02-guards.sql' 2>&1); then
  green "PASS  drop + pg_restore --create + guards"; pass=$((pass + 1))
else
  red "FAIL  drop + pg_restore --create + guards"; printf '      %s\n' "${out:-}"; fail=$((fail + 1))
fi
equals "data back" site_app site "$rows_before" "SELECT count(*) FROM ideas_t"
equals "site_app statement_timeout restored" site_app site "30s" "SHOW statement_timeout"
equals "site_migrator lock_timeout restored" site_migrator site "15s" "SHOW lock_timeout"
denied "platform_app still cannot connect to site" platform_app site "permission denied for database" "SELECT 1"
denied "site_app still cannot CREATE TABLE" site_app site "permission denied for schema public" "CREATE TABLE nope (id int)"
denied "DROP still blocked" site_migrator site "oojam guard" "DROP TABLE ideas_t CASCADE"
denied "TRUNCATE still blocked" site_migrator site "oojam guard: TRUNCATE" "TRUNCATE ideas_t CASCADE"
ok "new tables still guarded + usable by site_app" site_migrator site "CREATE TABLE post_restore (id serial PRIMARY KEY)"
ok "site_app DML on a post-restore table (default privileges restored)" site_app site "INSERT INTO post_restore DEFAULT VALUES"
equals "database owned by the superuser" SU postgres "postgres" "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'site'"

echo
total=$((pass + fail))
if [[ $fail -eq 0 ]]; then
  green "all $total checks passed"
else
  red "$fail of $total checks failed"
  exit 1
fi
