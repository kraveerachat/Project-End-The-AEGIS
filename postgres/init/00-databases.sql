-- AEGIS · Postgres bootstrap — creates one isolated database PER IDEA.
--
-- ⚠️ Identity Decoupling (see each app's server/db/schema.sql): IDEA1 and
-- IDEA2 must never share a connection string or a schema namespace. A
-- single shared "aegis_db" with prefixed tables (aegis_drive_users,
-- aegis_monitor_users, ...) would still let one app's pool physically
-- reach the other app's rows if a query ever slipped its WHERE clause.
-- Two databases in the same Postgres instance close that hole at the
-- connection layer: aegis_drive's pool literally cannot see aegis_monitor's
-- tables, and vice versa. POSTGRES_DB (aegis_db, set in docker-compose.yml)
-- is only the container's bootstrap database — neither app connects to it.
CREATE DATABASE aegis_drive;
CREATE DATABASE aegis_monitor;
