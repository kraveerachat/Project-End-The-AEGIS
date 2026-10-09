-- IDEA1 · existing-database migration: D-1 separate encrypted preview index — opaque storage (PR-A)
--
-- New databases receive the same DDL from ../schema.sql (the block between the
-- "D-1 preview index" marker and the end of that file). This migration is the
-- reviewed path for an already-initialised aegis_drive database on PostgreSQL 15
-- that already has migration 011. Run it as the migration/superuser role with
-- `psql -v ON_ERROR_STOP=1`; `drive_app` deliberately cannot create or alter tables.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
-- 1. Creates three new owner-scoped tables (preview-index head, immutable
--    generation history, opaque blob references).
-- 2. Widens the CHECK on vault_tree_blob_state.lifecycle so it also accepts
--    'INDEX_STAGED' and 'INDEX_MANAGED'. This is the only change to an existing
--    table: the allowed set only grows, no row is rewritten, no column changes.
--    Every value that was valid before stays valid.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────────────
-- No existing table other than the lifecycle CHECK above is altered. No row is
-- updated or deleted. vault_meta, vault_blobs, vault_v2_* and every other
-- vault_tree_* table are untouched. There is NO down-migration: rollback keeps
-- these tables; servers that predate D-1 never read them and keep filtering
-- orphans by lifecycle = 'UNREFERENCED', so INDEX_* rows are invisible to them.
-- Re-running this file is a no-op.
--
-- ── WHAT THE SERVER LEARNS, STATED HONESTLY ─────────────────────────────────
-- No column below can hold a plaintext name, path, parent, node id, MIME type,
-- preview kind, shard prefix, thumbnail or key material — there is nowhere to put
-- one. The server stores: opaque tree/blob ids, a monotonic index generation, an
-- opaque root content id, idempotency keys and request digests, timestamps, and
-- which opaque blob ids a client attached to (or declared superseded by) a
-- generation. Sizes, timing, counts and co-occurrence of opaque ids remain
-- observable (accepted, documented D-1 limitation).
--
-- ── SUPERSEDED REFERENCES ARE ADVISORY ONLY ─────────────────────────────────
-- role = 'SUPERSEDED' rows are client-declared bookkeeping. They are NEVER
-- deletion or purge authority (SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO). Initial
-- destructive GC is forbidden in D-1.
--
-- ── GRANTS ──────────────────────────────────────────────────────────────────
-- drive_app ends with exactly SELECT, INSERT, UPDATE on the three new tables — never DELETE
-- or TRUNCATE. postgres/init/02-app-roles.sh installs ALTER DEFAULT PRIVILEGES (… SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO drive_app) for the superuser that runs this migration,
-- so CREATE TABLE below already hands drive_app DELETE; the role-guarded block at the end
-- therefore REVOKEs ALL on these three tables and re-grants SELECT, INSERT, UPDATE. Fresh
-- installs get the same narrowing from 02-app-roles.sh after its blanket grant. Owner deletion
-- still cascades (FK actions run with the table owner's rights). The triggers below remain a
-- second, independent guard against deleting generations and blob references.

BEGIN;

-- ── D-1 preview index ───────────────────────────────────────────────────────
-- Widen the blob lifecycle CHECK. The existing constraint is found by its
-- definition in pg_constraint (not by a guessed name), dropped only if it does not
-- yet accept INDEX_STAGED, and replaced by one named constraint in the same
-- transaction. ADD CONSTRAINT validates existing rows; every existing value is in
-- the widened set.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'vault_tree_blob_state'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%lifecycle%'
       AND pg_get_constraintdef(oid) NOT LIKE '%INDEX_STAGED%'
  LOOP
    EXECUTE format('ALTER TABLE vault_tree_blob_state DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'vault_tree_blob_state'::regclass AND conname = 'vault_tree_blob_state_lifecycle_check'
  ) THEN
    ALTER TABLE vault_tree_blob_state ADD CONSTRAINT vault_tree_blob_state_lifecycle_check
      CHECK (lifecycle IN ('UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED', 'INDEX_STAGED', 'INDEX_MANAGED'));
  END IF;
END
$$;

-- Immutable generation history. One row per committed index generation. Identity
-- columns never change; only superseded_at may move NULL → timestamp, once.
CREATE TABLE IF NOT EXISTS vault_preview_index_generations (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  index_generation     BIGINT NOT NULL CHECK (index_generation >= 1),
  tree_id              TEXT NOT NULL,
  base_generation      BIGINT NOT NULL CHECK (base_generation >= 0),
  root_blob_id         TEXT NOT NULL,
  root_content_id_b64  TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  request_digest       CHAR(64) NOT NULL,
  committed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at        TIMESTAMPTZ,
  PRIMARY KEY (user_id, index_generation),
  CONSTRAINT vault_preview_index_generations_idempotency UNIQUE (user_id, idempotency_key),
  CONSTRAINT vault_preview_index_generations_sequential CHECK (base_generation = index_generation - 1)
);

-- One optional head per owner. Points at a committed generation of that owner.
CREATE TABLE IF NOT EXISTS vault_preview_index_heads (
  user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tree_id              TEXT NOT NULL,
  index_generation     BIGINT NOT NULL CHECK (index_generation >= 1),
  root_blob_id         TEXT NOT NULL,
  root_content_id_b64  TEXT NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vault_preview_index_heads_generation_fk FOREIGN KEY (user_id, index_generation)
    REFERENCES vault_preview_index_generations (user_id, index_generation)
);

-- Opaque blob references per generation. No kind, prefix, node, MIME or name column.
-- role = 'SUPERSEDED' is advisory bookkeeping only — never deletion authority.
CREATE TABLE IF NOT EXISTS vault_preview_index_blob_refs (
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  index_generation  BIGINT NOT NULL,
  blob_id           TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('ATTACHED', 'SUPERSEDED')),
  PRIMARY KEY (user_id, index_generation, blob_id, role),
  CONSTRAINT vault_preview_index_blob_refs_generation_fk FOREIGN KEY (user_id, index_generation)
    REFERENCES vault_preview_index_generations (user_id, index_generation)
);

CREATE OR REPLACE FUNCTION vault_preview_index_generations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- a generation may only disappear together with its owner (ON DELETE CASCADE from users)
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
      RAISE EXCEPTION 'vault_preview_index_generations: delete forbidden' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.index_generation <> OLD.index_generation OR NEW.tree_id <> OLD.tree_id
     OR NEW.base_generation <> OLD.base_generation OR NEW.root_blob_id <> OLD.root_blob_id
     OR NEW.root_content_id_b64 <> OLD.root_content_id_b64 OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_digest <> OLD.request_digest OR NEW.committed_at <> OLD.committed_at THEN
    RAISE EXCEPTION 'vault_preview_index_generations: identity column is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at AND (OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'vault_preview_index_generations: superseded_at may be set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vault_preview_index_generations_immutable ON vault_preview_index_generations;
CREATE TRIGGER vault_preview_index_generations_immutable
  BEFORE UPDATE OR DELETE ON vault_preview_index_generations
  FOR EACH ROW EXECUTE FUNCTION vault_preview_index_generations_guard();

CREATE OR REPLACE FUNCTION vault_preview_index_blob_refs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
      RAISE EXCEPTION 'vault_preview_index_blob_refs: delete forbidden' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'vault_preview_index_blob_refs: rows are immutable' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vault_preview_index_blob_refs_immutable ON vault_preview_index_blob_refs;
CREATE TRIGGER vault_preview_index_blob_refs_immutable
  BEFORE UPDATE OR DELETE ON vault_preview_index_blob_refs
  FOR EACH ROW EXECUTE FUNCTION vault_preview_index_blob_refs_guard();

-- ── Scoped application DML — explicit, idempotent, role-guarded ─────────────
-- ⚠️ SELECT/INSERT/UPDATE only. drive_app never owns these tables and never holds DELETE,
--    TRUNCATE, REFERENCES, TRIGGER, ALTER or DROP on them. REVOKE ALL first removes whatever
--    ALTER DEFAULT PRIVILEGES granted at CREATE TABLE above (Production: … DELETE). Only these
--    three tables are touched; every other table keeps its existing grants. No sequence grant.
--    Re-running is a no-op (same end state).
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    FOREACH t IN ARRAY ARRAY['vault_preview_index_heads', 'vault_preview_index_generations', 'vault_preview_index_blob_refs'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM drive_app', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO drive_app', t);
    END LOOP;
  END IF;
END
$$;

COMMIT;
