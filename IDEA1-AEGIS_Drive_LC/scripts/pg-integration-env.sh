#!/bin/sh
# scripts/pg-integration-env.sh — AEGIS Drive (IDEA1)
#
# Provision a DISPOSABLE PostgreSQL 15 instance that mirrors the production
# security boundaries, so `tests/resumableUploadPostgres.test.js` (and the other
# TEST_DATABASE_URL-gated suites) can run against a real database instead of the
# in-memory fallback.
#
# ⚠️ THIS SCRIPT NEVER TOUCHES PRODUCTION.
#    It creates its own container, its own network, and its own databases, all
#    prefixed `aegis-lftv2pg-` / `aegis_drive_*_test`. It reads no .env file and
#    generates its own throwaway credentials. It never runs `docker compose
#    down`, `docker system prune`, or `docker volume prune`, and it creates no
#    named volume at all — the data lives in the container's own writable layer
#    and disappears with the container. Point it at a production endpoint and it
#    will not work, because it only ever talks to the container it just started.
#
# ⚠️ WHY THE ROLES LOOK LIKE THIS
#    The point of the exercise is that the application must NOT be a superuser.
#    Production splits this in postgres/init/02-app-roles.sh:
#      - a superuser initialises schema and applies migrations;
#      - `drive_app` gets LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT and
#        DML only — never table ownership, never CREATE/ALTER/DROP/TRUNCATE.
#    This script reproduces that split with the same role name, so a privilege
#    defect shows up here rather than in production.
#
# Usage:
#   sh scripts/pg-integration-env.sh up      # start and provision, prints exports
#   sh scripts/pg-integration-env.sh down    # remove the container and network
#
# After `up`, run for example:
#   TEST_DATABASE_URL="postgresql://drive_app:<pw>@127.0.0.1:55433/aegis_drive_test" \
#     node --test --test-concurrency=1 tests/resumableUploadPostgres.test.js
set -eu

CONTAINER=aegis-lftv2pg-db
NETWORK=aegis-lftv2pg-net
IMAGE=postgres:15-alpine
HOST_PORT="${AEGIS_PGTEST_PORT:-55433}"
ADMIN_ROLE=lftv2_admin
APP_ROLE=drive_app          # the production name on purpose — see above
FRESH_DB=aegis_drive_test   # PATH A: created from server/db/schema.sql
LEGACY_DB=aegis_drive_prev_test  # PATH B: pre-V2 schema + migration 003

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

case "${1:-up}" in
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    echo "[pg-integration-env] removed $CONTAINER and $NETWORK (no volume was ever created)"
    exit 0
    ;;
  up) ;;
  *) echo "usage: $0 [up|down]" >&2; exit 2 ;;
esac

# Throwaway credentials, generated here. Never read from, or written to, any .env.
SUPER_PW=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
APP_PW=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker network create "$NETWORK" >/dev/null 2>&1 || true

# No -v / --mount: nothing outside the container is written, and nothing survives it.
docker run -d --name "$CONTAINER" --network "$NETWORK" \
  -e POSTGRES_PASSWORD="$SUPER_PW" -e POSTGRES_USER="$ADMIN_ROLE" -e POSTGRES_DB=postgres \
  -p "127.0.0.1:$HOST_PORT:5432" "$IMAGE" >/dev/null

# ⚠️ `pg_isready` alone is not enough: the official entrypoint first runs a
#    bootstrap server that listens on the unix socket only, then restarts it for
#    real. Probing over TCP with an actual query is the only signal that the
#    server clients will connect to is the one that is up.
printf '[pg-integration-env] waiting for postgres'
i=0
until docker exec -e PGPASSWORD="$SUPER_PW" "$CONTAINER" psql -h 127.0.0.1 -U "$ADMIN_ROLE" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo ' FAILED'; docker logs --tail 20 "$CONTAINER"; exit 1; fi
  printf '.'; sleep 1
done
echo ' ready'

su_psql() { docker exec -i -e PGPASSWORD="$SUPER_PW" "$CONTAINER" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U "$ADMIN_ROLE" "$@"; }

# ── the scoped application role, with production attributes ──────────────────
su_psql -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
\$\$;
ALTER ROLE $APP_ROLE WITH PASSWORD '$APP_PW';
SQL

# grants() mirrors postgres/init/02-app-roles.sh for one database.
grants() {
  su_psql -d "$1" -q <<SQL
REVOKE CONNECT ON DATABASE $1 FROM PUBLIC;
GRANT CONNECT ON DATABASE $1 TO $APP_ROLE;
GRANT USAGE ON SCHEMA public TO $APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $APP_ROLE;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $APP_ROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP_ROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO $APP_ROLE;
SQL
}

# ── PATH A · a fresh database built from the current schema ──────────────────
# schema.sql then seed.sql, in the same order and by the same role as
# postgres/init/01-run-app-init.sh. The seeded demo accounts carry
# must_reset_password = TRUE, exactly as production does, so the suites walk the
# real first-login gate rather than skipping it (see tests/helpers/testClient.mjs).
su_psql -d postgres -q -c "CREATE DATABASE $FRESH_DB;"
su_psql -d "$FRESH_DB" -q -f - < "$HERE/server/db/schema.sql"
su_psql -d "$FRESH_DB" -q -f - < "$HERE/server/db/seed.sql"
grants "$FRESH_DB"
echo "[pg-integration-env] PATH A ready: $FRESH_DB (schema.sql + seed.sql)"

# ── PATH B · a database that predates the upload-session tables ──────────────
# The pre-V2 schema is the current schema.sql truncated at the LFT-V2-A section,
# so it is the real previous file rather than a hand-written imitation that could
# drift from it.
su_psql -d postgres -q -c "CREATE DATABASE $LEGACY_DB;"
awk '/^-- ── Resumable upload sessions \(LFT-V2-A\)/{exit} {print}' \
  "$HERE/server/db/schema.sql" | su_psql -d "$LEGACY_DB" -q -f -
grants "$LEGACY_DB"
echo "[pg-integration-env] PATH B ready: $LEGACY_DB (pre-V2 schema, migration NOT yet applied)"

cat <<INFO

[pg-integration-env] isolated instance is up. Nothing outside it was touched.

  export AEGIS_PGTEST_SUPER_URL="postgresql://$ADMIN_ROLE:$SUPER_PW@127.0.0.1:$HOST_PORT/postgres"
  export TEST_DATABASE_URL="postgresql://$APP_ROLE:$APP_PW@127.0.0.1:$HOST_PORT/$FRESH_DB"
  export AEGIS_PGTEST_LEGACY_URL="postgresql://$APP_ROLE:$APP_PW@127.0.0.1:$HOST_PORT/$LEGACY_DB"

Tear down with:  sh scripts/pg-integration-env.sh down
INFO
