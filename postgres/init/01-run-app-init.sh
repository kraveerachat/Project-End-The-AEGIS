#!/bin/sh
# AEGIS · loads each app's OWN schema.sql + seed.sql (bind-mounted from its
# repo, see docker-compose.yml) into its OWN database. Nothing here is a
# copy — this script is the only thing that's AEGIS-specific; the SQL is
# the single source of truth already living in each app's server/db/.
set -eu

echo "[aegis-postgres] aegis_drive <- IDEA1-AEGIS_Drive_LC/server/db/{schema,seed}.sql"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -f /sql-src/idea1-schema.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -f /sql-src/idea1-seed.sql

echo "[aegis-postgres] aegis_monitor <- IDEA2-AEGIS_Monitor/server/db/{schema,seed}.sql"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_monitor -f /sql-src/idea2-schema.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_monitor -f /sql-src/idea2-seed.sql

echo "[aegis-postgres] done"
