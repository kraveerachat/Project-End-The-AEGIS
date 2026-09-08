#!/bin/sh
# PUBLIC-SHARE-7 · provision the harness database from the shipped schema.
# Keep this file LF-only: Docker executes it inside Linux during first boot.
#
# Runs once, as the bootstrap superuser, from /docker-entrypoint-initdb.d.
#
# ⚠️ DELIBERATELY NOT A REHEARSAL OF MIGRATION 009. PUBLIC-SHARE-6 owns that
#    evidence: its harness builds an 008-era database on purpose, shows a
#    `scope=public` share cannot be minted until the real migration file is
#    applied, and re-runs it to show idempotence. Repeating it here would add no
#    finding and would couple this task to a question it is not asking.
#
#    PUBLIC-SHARE-7 asks a different question — does the gateway's managed-proxy
#    trust model attribute the right recipient — so it starts from the current
#    schema, where `public` is already an allowed scope.
set -eu

: "${DRIVE_DB_PASSWORD:?DRIVE_DB_PASSWORD is required}"

echo "[ps7-db] creating aegis_drive"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d postgres -c 'CREATE DATABASE aegis_drive;'

echo "[ps7-db] aegis_drive <- IDEA1-AEGIS_Drive_LC/server/db/{schema,seed}.sql"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -f /sql-src/idea1-schema.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -f /sql-src/idea1-seed.sql

# ── the scoped application role, with the production attributes ──────────────
# Mirrors postgres/init/02-app-roles.sh for this one database, including the
# REVOKE ... FROM PUBLIC that makes the grant meaningful. The application is not
# a superuser and does not own its tables, exactly as in Production.
echo "[ps7-db] creating scoped role drive_app"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d postgres \
  -v drive_pw="$DRIVE_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    CREATE ROLE drive_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
ALTER ROLE drive_app WITH PASSWORD :'drive_pw';
REVOKE CONNECT ON DATABASE aegis_drive FROM PUBLIC;
GRANT CONNECT ON DATABASE aegis_drive TO drive_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive <<'SQL'
GRANT USAGE ON SCHEMA public TO drive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO drive_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO drive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO drive_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO drive_app;
SQL

echo "[ps7-db] ready — aegis_drive at the current shipped schema"
