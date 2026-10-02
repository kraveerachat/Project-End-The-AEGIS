#!/bin/sh
# Runs only inside the isolated H1 PostgreSQL image; no Production DSN input.
set -eu

for migration in \
  /aegis-h1/schema.sql \
  /aegis-h1/migrations/001_device_owned_local_runtime.sql \
  /aegis-h1/migrations/002_physical_camera_logical_alias.sql \
  /aegis-h1/migrations/003_deprecate_node_camera_identity.sql \
  /aegis-h1/migrations/004_detection_node_ingest_auth_mode.sql
do
  test -r "$migration"
  psql -X -v ON_ERROR_STOP=1 -h postgres -U postgres_h1_admin -d aegis_h1_lab -f "$migration" >/dev/null
done

echo 'H1 lab schema and migrations applied (5 files); credentials not logged'
