-- IDEA1 · existing-database migration: server-owned appearance preferences
--
-- New databases receive the same columns from ../schema.sql. This migration is
-- the reviewed path for an already-initialised aegis_drive database. It changes
-- only the existing users table, so the current drive_app table privileges and
-- REVOKE CONNECT isolation remain in force; no new role or database grant is made.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_theme TEXT NOT NULL DEFAULT 'light'
  CHECK (ui_theme IN ('light', 'dark', 'system'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language TEXT NOT NULL DEFAULT 'th'
  CHECK (ui_language IN ('th', 'en', 'zh'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_density TEXT NOT NULL DEFAULT 'comfortable'
  CHECK (ui_density IN ('comfortable', 'compact'));

COMMIT;
