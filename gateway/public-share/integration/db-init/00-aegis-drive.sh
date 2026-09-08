#!/bin/sh
# PUBLIC-SHARE-6 · provision the harness database as an 008-era AEGIS Drive.
# Keep this file LF-only: Docker executes it inside Linux during first boot.
#
# Runs once, as the bootstrap superuser, from /docker-entrypoint-initdb.d.
#
# ⚠️ WHY THIS DELIBERATELY BUILDS AN OLD DATABASE
#    server/db/schema.sql already carries `public` in the shares scope CHECK, so
#    a database created straight from it would make migration 009 a no-op and the
#    PS6 evidence row for it worthless — the test would "pass" without the
#    migration ever having done anything.
#
#    Production is not a fresh schema.sql database. It is a database that was
#    built before PUBLIC-SHARE-2 existed and has migrations 001–008 applied. The
#    only honest rehearsal of applying 009 is against that shape, so this script
#    rolls the constraint back to its exact pre-009 definition and leaves 009
#    UNAPPLIED. The test then observes the before state, applies the real
#    migration file, and observes the after state.
#
#    The rolled-back CHECK below is the "from" half of
#    server/db/migrations/009_public_share_scope.sql, verbatim. It is asserted
#    against that file by the test rather than trusted from this comment.
set -eu

: "${DRIVE_DB_PASSWORD:?DRIVE_DB_PASSWORD is required}"

echo "[ps6-db] creating aegis_drive"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d postgres -c 'CREATE DATABASE aegis_drive;'

echo "[ps6-db] aegis_drive <- IDEA1-AEGIS_Drive_LC/server/db/{schema,seed}.sql"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -f /sql-src/idea1-schema.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -f /sql-src/idea1-seed.sql

echo "[ps6-db] rolling the shares scope CHECK back to its pre-009 (008-era) definition"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive <<'SQL'
ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_scope_check;
ALTER TABLE shares ADD CONSTRAINT shares_scope_check
  CHECK (scope IN ('any', 'zones', 'vlan', 'subnet'));
SQL

# ── the scoped application role, with the production attributes ──────────────
# Mirrors postgres/init/02-app-roles.sh for this one database, including the
# REVOKE ... FROM PUBLIC that makes the grant meaningful. The application is not
# a superuser and does not own its tables, so a migration it was never meant to
# run is a privilege error here exactly as it would be in Production.
echo "[ps6-db] creating scoped role drive_app"
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

echo "[ps6-db] ready — aegis_drive at the 008-era shape, migration 009 NOT applied"
