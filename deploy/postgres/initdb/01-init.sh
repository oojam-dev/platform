#!/usr/bin/env bash
# oojam Postgres first-boot initialisation (SPEC §3.3).
#
# Run by the postgres image's entrypoint, as the superuser, once: when the data
# directory is empty. Nothing here runs again on later boots, so changing a
# password in .env afterwards needs an ALTER ROLE too (README › Rotating secrets).
#
# Creates:
#   roles     platform_owner, platform_app, site_migrator, site_app, backup
#   databases platform, site (owned by the superuser; see "Ownership" below)
#   guards    02-guards.sql in both databases (event triggers, SPEC §3.3)
#   pg_hba    the superuser may only connect over the container's Unix socket
#
# Ownership. The databases are owned by the superuser, not by platform_owner /
# site_migrator. Those roles get CONNECT + CREATE on their database and USAGE +
# CREATE on its `public` schema, which is everything migrations need (they own
# every table, sequence and schema they create). Not owning the database means
# they cannot DROP DATABASE, ALTER DATABASE ... (SET, CONNECTION LIMIT,
# ALLOW_CONNECTIONS, RENAME) or re-grant CREATE on `public`: none of which an
# event trigger can stop.
#
# Env (from compose): PLATFORM_OWNER_PASSWORD, PLATFORM_APP_PASSWORD,
# SITE_MIGRATOR_PASSWORD, SITE_APP_PASSWORD, BACKUP_DB_PASSWORD.
# They end up in postgres:// URLs, so they must be URL-safe (bin/bootstrap
# generates 64 hex characters).
set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GUARDS_SQL=${OOJAM_GUARDS_SQL:-$HERE/02-guards.sql}
SUPERUSER=${POSTGRES_USER:-postgres}

log() { echo "oojam-init: $*" >&2; }

for var in PLATFORM_OWNER_PASSWORD PLATFORM_APP_PASSWORD SITE_MIGRATOR_PASSWORD SITE_APP_PASSWORD BACKUP_DB_PASSWORD; do
  value=${!var:-}
  if [[ -z $value ]]; then
    log "$var is not set"; exit 1
  fi
  if [[ ! $value =~ ^[A-Za-z0-9._~-]{16,}$ ]]; then
    log "$var must be at least 16 URL-safe characters (A-Z a-z 0-9 . _ ~ -)"; exit 1
  fi
done
if [[ ! -r $GUARDS_SQL ]]; then
  log "guards SQL not found at $GUARDS_SQL"; exit 1
fi

psql_su() {
  psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet --username "$SUPERUSER" "$@"
}

log "creating roles and databases"
psql_su --dbname postgres \
  -v platform_owner_pw="$PLATFORM_OWNER_PASSWORD" \
  -v platform_app_pw="$PLATFORM_APP_PASSWORD" \
  -v site_migrator_pw="$SITE_MIGRATOR_PASSWORD" \
  -v site_app_pw="$SITE_APP_PASSWORD" \
  -v backup_pw="$BACKUP_DB_PASSWORD" <<'SQL'
-- None of these is a superuser, can create roles or databases, replicate or
-- bypass row-level security.
CREATE ROLE platform_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'platform_owner_pw';
CREATE ROLE platform_app   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'platform_app_pw';
CREATE ROLE site_migrator  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'site_migrator_pw';
CREATE ROLE site_app       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'site_app_pw';
-- Nightly pg_dump (backup service). Read-only: pg_read_all_data gives SELECT on
-- every table and sequence and USAGE on every schema, and nothing else. The
-- backup container has internet access (S3 upload), so it gets no superuser.
CREATE ROLE backup         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'backup_pw';
GRANT pg_read_all_data TO backup;

CREATE DATABASE platform;
CREATE DATABASE site;

-- Nobody connects to anything by default. Each role reaches only its own
-- database; template1 and postgres are closed too, so a database's roles have
-- nowhere else to connect from (DROP DATABASE needs a connection elsewhere).
REVOKE ALL ON DATABASE platform  FROM PUBLIC;
REVOKE ALL ON DATABASE site      FROM PUBLIC;
REVOKE ALL ON DATABASE postgres  FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;

GRANT CONNECT, CREATE ON DATABASE platform TO platform_owner;
GRANT CONNECT         ON DATABASE platform TO platform_app, backup;
GRANT CONNECT, CREATE ON DATABASE site     TO site_migrator;
GRANT CONNECT         ON DATABASE site     TO site_app, backup;

-- Runtime roles: bounded statements and transactions (SPEC §3.3 item 3).
ALTER ROLE site_app     IN DATABASE site     SET statement_timeout = '30s';
ALTER ROLE site_app     IN DATABASE site     SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE platform_app IN DATABASE platform SET statement_timeout = '30s';
ALTER ROLE platform_app IN DATABASE platform SET idle_in_transaction_session_timeout = '5min';
-- Migrations give up rather than queue behind (and block) live traffic.
ALTER ROLE site_migrator  IN DATABASE site     SET lock_timeout = '15s';
ALTER ROLE platform_owner IN DATABASE platform SET lock_timeout = '15s';
SQL

# Schema privileges, default privileges and guards, per database.
setup_db() { # db owner_role app_role
  local db=$1 owner=$2 app=$3
  log "setting up database $db (owner role $owner, app role $app)"
  psql_su --dbname "$db" -v owner="$owner" -v app="$app" <<'SQL'
-- `public` stays owned by pg_database_owner (= the superuser here). Only the
-- owner role may create in it; the app role may only use what's there.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"owner";
GRANT USAGE         ON SCHEMA public TO :"app";

-- Everything the owner role creates, in any schema, is DML-only for the app
-- role. (The app role still needs USAGE on a schema to reach it: it has it on
-- `public` only, so e.g. drizzle.__drizzle_migrations stays out of its reach.)
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT USAGE, SELECT ON SEQUENCES TO :"app";
SQL
  psql_su --dbname "$db" -f "$GUARDS_SQL"
}

setup_db platform platform_owner platform_app
setup_db site site_migrator site_app

# Client authentication. The superuser only over the Unix socket inside this
# container (`docker compose exec postgres psql -U postgres`); every network
# connection needs a password (SCRAM), and replication over the network is off.
log "writing pg_hba.conf"
cat > "$PGDATA/pg_hba.conf" <<EOF
# Written by oojam's 01-init.sh. TYPE DATABASE USER ADDRESS METHOD
local   all          all                    trust
host    all          ${SUPERUSER}  all      reject
host    replication  all           all      reject
host    all          all           all      scram-sha-256
EOF

log "done"
