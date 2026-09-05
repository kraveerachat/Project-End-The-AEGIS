-- IDEA1 · existing-database migration: allow a 1-minute Vault auto-lock
--
-- Widens the CHECK on users.vault_autolock_minutes from (5, 10, 15, 30, 60) to
-- (1, 5, 10, 15, 30, 60). Nothing else about the column changes.
--
-- ⚠️ 007_security_settings.sql is DEPLOYED and is not edited. A CHECK constraint
--    cannot be altered in place in PostgreSQL, so the only correct move on an
--    existing database is to drop the old constraint and add the new one inside
--    one transaction — which is what this file does.
--
-- ⚠️ The constraint NAME is not assumed. 007 declared the CHECK inline on
--    `ALTER TABLE ... ADD COLUMN`, so PostgreSQL generated the name itself
--    (`users_vault_autolock_minutes_check` on a clean run) — but a database that
--    was restored, renamed, or built by a different path may carry a different
--    generated name, and `DROP CONSTRAINT <guess>` would fail there. The DO block
--    below looks the name up in the catalog by what the constraint actually
--    CHECKS, and drops whatever it finds.
--
-- What is deliberately NOT done here:
--   * the column is not dropped and recreated — that would rewrite the table and
--     lose per-user values;
--   * DEFAULT 10 is not changed. 1 minute is now an option, not the new default;
--     an existing account keeps whatever it chose, and a new account still gets
--     10 (server/db/connection.js DEFAULT_SECURITY_SETTINGS agrees);
--   * NOT NULL is not touched;
--   * no row is updated. Every value that satisfied the old constraint satisfies
--     the new one, because the new set is a strict superset, so `ADD CONSTRAINT`
--     validates the existing rows and passes.
--
-- Re-running is safe: the lookup simply finds the constraint this migration
-- added last time and replaces it with an identical one.

BEGIN;

DO $$
DECLARE
  existing_constraint text;
BEGIN
  -- Find the CHECK constraint on users that governs this column, whatever it is
  -- called. `contype = 'c'` restricts the search to CHECK constraints, so a
  -- foreign key or unique index can never be dropped by this block.
  SELECT con.conname INTO existing_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = current_schema()
    AND rel.relname = 'users'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%vault_autolock_minutes%'
  LIMIT 1;

  IF existing_constraint IS NOT NULL THEN
    -- format(%I) quotes the identifier, so a hostile or unusual constraint name
    -- cannot become SQL here.
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', existing_constraint);
  END IF;
END
$$;

-- Added under the name PostgreSQL would have generated anyway, so a database
-- migrated through this file and one created fresh from schema.sql end up
-- describing the column identically.
ALTER TABLE users
  ADD CONSTRAINT users_vault_autolock_minutes_check
  CHECK (vault_autolock_minutes IN (1, 5, 10, 15, 30, 60));

COMMIT;
