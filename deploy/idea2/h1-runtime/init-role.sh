#!/bin/sh
# Sourced by the official PostgreSQL entrypoint only on a new lab volume.
(
set -eu
test -n "${H1_APP_PASSWORD:-}"
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$H1_APP_PASSWORD" <<'SQL'
CREATE ROLE monitor_h1_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE aegis_h1_lab TO monitor_h1_app;
GRANT USAGE ON SCHEMA public TO monitor_h1_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres_h1_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monitor_h1_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres_h1_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO monitor_h1_app;
SQL
)
