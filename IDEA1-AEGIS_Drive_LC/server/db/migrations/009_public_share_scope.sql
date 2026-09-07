-- IDEA1 · existing-database migration: allow the explicit `public` share scope
--
-- Widens the CHECK on shares.scope from ('any','zones','vlan','subnet') to
-- ('any','zones','public','vlan','subnet'). Nothing else about the table, the
-- column, or any row changes.
--
-- Why 'public' is a third value and not an alias of 'any' (PUBLIC-SHARE-2):
--   'any' means "no additional Share-layer CIDR restriction, but the recipient
--   still needs a route to AEGIS". 'public' means "intentionally eligible for
--   redemption through the dedicated Public Share Gateway". Overloading 'any'
--   would have made every share ever created with it Internet-redeemable the
--   moment a gateway was deployed — retroactively, without its creator ever
--   agreeing to that. See
--   Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md §7.
--
-- ⚠️ Migrations 001–008 are DEPLOYED and are not edited. A CHECK constraint
--    cannot be altered in place in PostgreSQL, so the only correct move on an
--    existing database is to drop the old constraint and add the new one inside
--    one transaction — the same shape 008 already uses for
--    users.vault_autolock_minutes.
--
-- ⚠️ The constraint NAME is not assumed. schema.sql names it explicitly today,
--    but a database that was restored, renamed, or built through an older path
--    may carry a generated name instead, and `DROP CONSTRAINT <guess>` would
--    fail there. The DO block looks the name up in the catalog by what the
--    constraint actually CHECKS, and drops whatever it finds. `contype = 'c'`
--    restricts the search to CHECK constraints, so a foreign key, a unique index,
--    or the NOT NULL on this column can never be dropped by this block.
--
-- What is deliberately NOT done here:
--   * the table is not dropped, recreated, or rewritten;
--   * no row is read, updated, or deleted. The new value set is a strict
--     superset of the old one, so every existing row already satisfies the new
--     constraint and `ADD CONSTRAINT` validates them and passes;
--   * token_hash, password_hash, vlan_scope, hits, expires_at and revoked are
--     untouched — no share token or link password is rewritten or re-derived;
--   * DEFAULT 'any' is unchanged. 'public' is a value a share may be created
--     with, never one it becomes on its own;
--   * users.share_default_scope is NOT widened. Its CHECK stays ('any','zones')
--     so a saved preference can never publish a file to the Internet on the
--     sharer's behalf;
--   * the legacy 'vlan' and 'subnet' values are preserved exactly as 008-era
--     databases carry them.
--
-- No GRANT is issued, deliberately. This migration creates no table, sequence,
-- or other object — it only replaces a constraint on a table drive_app already
-- holds privileges on, so the LFT-V2-A rule about granting explicitly when a
-- migration is applied by a different superuser has nothing to bite on here.
-- Adding a GRANT to satisfy prose would widen privileges for no reason.
--
-- Re-running is safe: the lookup finds the constraint this migration added last
-- time and replaces it with an identical one.

BEGIN;

DO $$
DECLARE
  existing_constraint text;
BEGIN
  SELECT con.conname INTO existing_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = current_schema()
    AND rel.relname = 'shares'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%scope%'
    AND pg_get_constraintdef(con.oid) NOT LIKE '%vlan_scope%'
  LIMIT 1;

  IF existing_constraint IS NOT NULL THEN
    -- format(%I) quotes the identifier, so an unusual constraint name cannot
    -- become SQL here.
    EXECUTE format('ALTER TABLE shares DROP CONSTRAINT %I', existing_constraint);
  END IF;
END
$$;

-- Added under the name schema.sql uses, so a database migrated through this file
-- and one created fresh describe the column identically.
ALTER TABLE shares
  ADD CONSTRAINT shares_scope_check
  CHECK (scope IN ('any', 'zones', 'public', 'vlan', 'subnet'));

COMMIT;
