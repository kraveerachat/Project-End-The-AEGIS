-- IDEA1 · existing-database migration: per-account security settings
--
-- Two independent settings live here, both additive and both bounded by a CHECK
-- constraint so an out-of-range value cannot be stored even if a future caller
-- forgets to validate:
--
--   vault_autolock_minutes          how long an UNLOCKED Vault screen may sit idle
--                                   before the browser discards the in-memory KEK.
--                                   DEFAULT 10 reproduces the constant this column
--                                   replaces (Vault.jsx IDLE_LOCK_MS = 10 * 60_000),
--                                   so every existing account keeps its current
--                                   behaviour byte-for-byte until it opts to change.
--
--   share_default_*                 the values the Create Share form starts from.
--                                   Defaults match the form's current initial state
--                                   ('24h' / 'zones' / password required) so opening
--                                   the form after this migration looks unchanged.
--
-- ⚠️ There is deliberately NO default share password column. A stored share password
--    would be a reusable credential sitting at rest for every future share; the
--    boolean below only decides whether the form REQUIRES the user to type one.
--
-- New databases receive the same columns from ../schema.sql. Re-running this
-- migration is safe (IF NOT EXISTS) and adds no role, grant, or shared contract —
-- the existing drive_app table privileges and REVOKE CONNECT isolation stand.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_autolock_minutes INTEGER NOT NULL DEFAULT 10
  CHECK (vault_autolock_minutes IN (5, 10, 15, 30, 60));
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_default_expiry TEXT NOT NULL DEFAULT '24h'
  CHECK (share_default_expiry IN ('1h', '24h', '7d', '30d'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_default_scope TEXT NOT NULL DEFAULT 'zones'
  CHECK (share_default_scope IN ('any', 'zones'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_default_require_password BOOLEAN NOT NULL DEFAULT true;

COMMIT;
