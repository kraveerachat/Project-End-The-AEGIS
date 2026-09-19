-- IDEA1 · existing-database migration: Private Vault encrypted hierarchy — opaque tree coordination (PR #157)
--
-- New databases receive the same tables from ../schema.sql. This migration is the
-- reviewed path for an already-initialised aegis_drive database on PostgreSQL 15.
-- Run it as the migration/superuser role with `psql -v ON_ERROR_STOP=1`;
-- `drive_app` deliberately cannot create tables or triggers.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────────────
-- It is **purely additive**. No existing table (vault_meta, vault_blobs,
-- vault_v2_*) is altered, relaxed, rewritten or read. Existing V1/V2 ciphertext
-- and envelopes are untouched byte-for-byte. Re-running it is a no-op.
--
-- ── WHAT THE SERVER LEARNS, STATED HONESTLY ─────────────────────────────────
-- No column below can hold a plaintext name, path, parent reference, child
-- list, MIME type, node id, thumbnail or key material — there is nowhere to put
-- one. The server stores: an owner-scoped protocol state, opaque migration lease
-- and frozen-inventory identities, two KEK-wrapped TRK slots (opaque), an opaque
-- head pointer with a monotonic generation, immutable encrypted manifest revisions
-- (ciphertext location/size/hash/IV/wrapped DEK), opaque blob lifecycle states and
-- opaque purge candidates. Timing, sizes and counts remain observable (traffic
-- analysis is acknowledged, not prevented).
--
-- ── THE EXPLICIT GRANT IS NOT OPTIONAL ──────────────────────────────────────
-- ALTER DEFAULT PRIVILEGES only covers objects created by the same role; the
-- new tables are therefore granted explicitly, guarded on the role existing.

BEGIN;

-- ── Owner protocol state ─────────────────────────────────────────────────────
-- ⚠️ One CHECK encodes the per-state invariants explicitly (a valid TREE_V1 row
--    has every migration field NULL and head_ever_committed = true; a valid
--    MIGRATING row has all four migration fields NOT NULL; FLAT has them NULL and
--    no head ever). migration_lease_epoch is a monotonic counter that survives every
--    transition (takeover and re-begin after an abandon continue it).
CREATE TABLE IF NOT EXISTS vault_tree_state (
  user_id                     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  protocol_state              TEXT NOT NULL DEFAULT 'FLAT'
                                CHECK (protocol_state IN ('FLAT', 'MIGRATING_TREE_V1', 'TREE_V1')),
  min_protocol_version        SMALLINT NOT NULL DEFAULT 1 CHECK (min_protocol_version >= 1),
  head_ever_committed         BOOLEAN NOT NULL DEFAULT false,
  tree_mutation_count         BIGINT NOT NULL DEFAULT 0 CHECK (tree_mutation_count >= 0),
  migration_lease_id          TEXT,
  migration_lease_epoch       BIGINT NOT NULL DEFAULT 0 CHECK (migration_lease_epoch >= 0),
  migration_lease_expires_at  TIMESTAMPTZ,
  frozen_inventory_id         TEXT,
  frozen_inventory_digest     CHAR(64),                  -- sha256 over the sorted opaque "v:id" list
  purge_barrier_generation    BIGINT NOT NULL DEFAULT 0 CHECK (purge_barrier_generation >= 0),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vault_tree_state_invariants CHECK (
    CASE protocol_state
      WHEN 'FLAT' THEN
        migration_lease_id IS NULL AND migration_lease_expires_at IS NULL
        AND frozen_inventory_id IS NULL AND frozen_inventory_digest IS NULL
        AND head_ever_committed = false
      WHEN 'MIGRATING_TREE_V1' THEN
        migration_lease_id IS NOT NULL AND migration_lease_expires_at IS NOT NULL
        AND frozen_inventory_id IS NOT NULL AND frozen_inventory_digest IS NOT NULL
        AND head_ever_committed = false
      WHEN 'TREE_V1' THEN
        migration_lease_id IS NULL AND migration_lease_expires_at IS NULL
        AND frozen_inventory_id IS NULL AND frozen_inventory_digest IS NULL
        AND head_ever_committed = true
      ELSE false
    END
  )
);

-- ── Frozen opaque inventory of one migration attempt ────────────────────────
CREATE TABLE IF NOT EXISTS vault_tree_frozen_inventory (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frozen_inventory_id  TEXT NOT NULL,
  blob_format_version  SMALLINT NOT NULL CHECK (blob_format_version IN (1, 2)),
  blob_id              TEXT NOT NULL,
  PRIMARY KEY (user_id, frozen_inventory_id, blob_format_version, blob_id)
);

-- ── Wrapped-TRK key envelope (two opaque, independently authenticated slots) ─
CREATE TABLE IF NOT EXISTS vault_tree_key_envelope (
  user_id                   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tree_id                   TEXT NOT NULL,
  owner_scope_id_b64        TEXT NOT NULL,             -- opaque owner-scope id used in the TRK AAD (not the user id)
  key_envelope_version      SMALLINT NOT NULL DEFAULT 1 CHECK (key_envelope_version >= 1),
  envelope_cas_version      BIGINT NOT NULL DEFAULT 1 CHECK (envelope_cas_version >= 1),
  primary_wrapped_trk_b64   TEXT NOT NULL,
  primary_wrap_iv_b64       TEXT NOT NULL,
  recovery_wrapped_trk_b64  TEXT NOT NULL,
  recovery_wrap_iv_b64      TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vault_tree_key_envelope_distinct_ivs CHECK (primary_wrap_iv_b64 <> recovery_wrap_iv_b64)
);

-- ── Immutable encrypted manifest revisions ───────────────────────────────────
-- ⚠️ Identity/location columns are writable exactly once (CREATED → PUBLISHED) and
--    frozen afterwards; later transitions may change only state/committed_at/
--    retired_at along the allowed edges. Enforced by the trigger below, not by
--    application discipline alone.
CREATE TABLE IF NOT EXISTS vault_tree_revisions (
  revision_id               TEXT PRIMARY KEY,
  user_id                   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tree_id                   TEXT NOT NULL,
  base_revision_id          TEXT,
  generation                BIGINT NOT NULL CHECK (generation >= 1),
  manifest_schema_version   SMALLINT NOT NULL CHECK (manifest_schema_version >= 1),
  storage_key               TEXT UNIQUE,
  ciphertext_size           BIGINT CHECK (ciphertext_size > 0),
  ciphertext_sha256         CHAR(64),
  iv_b64                    TEXT NOT NULL,
  wrapped_manifest_dek_b64  TEXT NOT NULL,
  wrap_iv_b64               TEXT NOT NULL,
  state                     TEXT NOT NULL CHECK (state IN (
                              'CREATED', 'PUBLISHED', 'HEAD_COMMITTED', 'SUPERSEDED',
                              'ORPHANED', 'NON_RECOVERABLE', 'FORENSIC_DELETED')),
  idempotency_key           TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at              TIMESTAMPTZ,
  committed_at              TIMESTAMPTZ,
  retired_at                TIMESTAMPTZ,
  CONSTRAINT vault_tree_revisions_created_has_no_identity CHECK (
    state <> 'CREATED'
    OR (storage_key IS NULL AND ciphertext_size IS NULL AND ciphertext_sha256 IS NULL AND published_at IS NULL)
  ),
  CONSTRAINT vault_tree_revisions_published_has_identity CHECK (
    state IN ('CREATED', 'ORPHANED')
    OR (storage_key IS NOT NULL AND ciphertext_size IS NOT NULL AND ciphertext_sha256 IS NOT NULL AND published_at IS NOT NULL)
  ),
  CONSTRAINT vault_tree_revisions_idempotency UNIQUE (user_id, idempotency_key)
);

-- one committed revision per generation per owner (candidates that lost CAS are ORPHANED and excluded)
CREATE UNIQUE INDEX IF NOT EXISTS vault_tree_revisions_generation_idx
  ON vault_tree_revisions (user_id, generation)
  WHERE state IN ('HEAD_COMMITTED', 'SUPERSEDED', 'NON_RECOVERABLE', 'FORENSIC_DELETED');
CREATE INDEX IF NOT EXISTS vault_tree_revisions_state_idx ON vault_tree_revisions (user_id, state, created_at);

CREATE OR REPLACE FUNCTION vault_tree_revisions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- a committed revision may only disappear together with its owner (ON DELETE CASCADE from users:
    -- the users row is already gone inside that transaction); the application can delete ORPHANED /
    -- FORENSIC_DELETED rows only
    IF OLD.state NOT IN ('ORPHANED', 'FORENSIC_DELETED') AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
      RAISE EXCEPTION 'vault_tree_revisions: delete forbidden in state %', OLD.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- columns that are immutable for the whole life of the row
  IF NEW.revision_id <> OLD.revision_id OR NEW.user_id <> OLD.user_id OR NEW.tree_id <> OLD.tree_id
     OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id OR NEW.generation <> OLD.generation
     OR NEW.manifest_schema_version <> OLD.manifest_schema_version OR NEW.iv_b64 <> OLD.iv_b64
     OR NEW.wrapped_manifest_dek_b64 <> OLD.wrapped_manifest_dek_b64 OR NEW.wrap_iv_b64 <> OLD.wrap_iv_b64
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'vault_tree_revisions: identity column is immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- CREATED → PUBLISHED: the only transition that may set the content identity, exactly once
  IF OLD.state = 'CREATED' AND NEW.state = 'PUBLISHED' THEN
    IF OLD.storage_key IS NOT NULL OR OLD.ciphertext_size IS NOT NULL OR OLD.ciphertext_sha256 IS NOT NULL OR OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'vault_tree_revisions: identity already set' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.storage_key IS NULL OR NEW.ciphertext_size IS NULL OR NEW.ciphertext_sha256 IS NULL OR NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'vault_tree_revisions: publish must set the full identity' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.committed_at IS DISTINCT FROM OLD.committed_at OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
      RAISE EXCEPTION 'vault_tree_revisions: publish may not touch lifecycle timestamps' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- every other update: content identity/location is frozen (whatever it currently is)
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.ciphertext_size IS DISTINCT FROM OLD.ciphertext_size
     OR NEW.ciphertext_sha256 IS DISTINCT FROM OLD.ciphertext_sha256 OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'vault_tree_revisions: content identity is immutable after publish' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
       (OLD.state = 'PUBLISHED' AND NEW.state = 'HEAD_COMMITTED'
          AND OLD.committed_at IS NULL AND NEW.committed_at IS NOT NULL AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at)
    OR (OLD.state = 'HEAD_COMMITTED' AND NEW.state = 'SUPERSEDED'
          AND NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at)
    OR (OLD.state IN ('CREATED', 'PUBLISHED') AND NEW.state = 'ORPHANED'
          AND NEW.retired_at IS NOT NULL AND NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at)
    OR (OLD.state IN ('HEAD_COMMITTED', 'SUPERSEDED') AND NEW.state = 'NON_RECOVERABLE'
          AND NEW.retired_at IS NOT NULL AND NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at)
    OR (OLD.state = 'NON_RECOVERABLE' AND NEW.state = 'FORENSIC_DELETED'
          AND NEW.retired_at IS NOT NULL AND NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at)
    OR (OLD.state = NEW.state
          AND NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at)
  ) THEN
    RAISE EXCEPTION 'vault_tree_revisions: transition % -> % not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vault_tree_revisions_immutable ON vault_tree_revisions;
CREATE TRIGGER vault_tree_revisions_immutable
  BEFORE UPDATE OR DELETE ON vault_tree_revisions
  FOR EACH ROW EXECUTE FUNCTION vault_tree_revisions_guard();

-- ── Tree head (one per owner; generation is monotonic; updated only by CAS) ─
CREATE TABLE IF NOT EXISTS vault_tree_heads (
  user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tree_id      TEXT NOT NULL,
  revision_id  TEXT NOT NULL REFERENCES vault_tree_revisions(revision_id),
  generation   BIGINT NOT NULL CHECK (generation >= 1),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Tree-aware opaque blob lifecycle ─────────────────────────────────────────
-- V1 ids are BIGINT and V2 ids are TEXT, so the pair (format version, id-as-text)
-- is the key; referential consistency with vault_blobs / vault_v2_blobs is
-- enforced inside the CAS/genesis transactions, not by a foreign key.
CREATE TABLE IF NOT EXISTS vault_tree_blob_state (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blob_format_version  SMALLINT NOT NULL CHECK (blob_format_version IN (1, 2)),
  blob_id              TEXT NOT NULL,
  lifecycle            TEXT NOT NULL CHECK (lifecycle IN ('UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED')),
  attached_generation  BIGINT,
  purge_id             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blob_format_version, blob_id)
);
CREATE INDEX IF NOT EXISTS vault_tree_blob_state_lifecycle_idx ON vault_tree_blob_state (user_id, lifecycle, created_at);

-- ── Purge candidates (barrier-bound; physical deletion is flag-gated) ────────
CREATE TABLE IF NOT EXISTS vault_tree_purge_candidates (
  purge_id                    TEXT NOT NULL,
  user_id                     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  barrier_generation          BIGINT NOT NULL CHECK (barrier_generation >= 1),
  blob_format_version         SMALLINT NOT NULL CHECK (blob_format_version IN (1, 2)),
  blob_id                     TEXT NOT NULL,
  state                       TEXT NOT NULL CHECK (state IN ('RETENTION_WAIT', 'CONFIRMABLE', 'CONFIRMED', 'PURGED', 'FAILED')),
  confirmable_at              TIMESTAMPTZ NOT NULL,
  confirmed_idempotency_key   TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at                TIMESTAMPTZ,
  purged_at                   TIMESTAMPTZ,
  PRIMARY KEY (purge_id, blob_format_version, blob_id)
);
CREATE INDEX IF NOT EXISTS vault_tree_purge_candidates_state_idx ON vault_tree_purge_candidates (user_id, state, confirmable_at);
CREATE UNIQUE INDEX IF NOT EXISTS vault_tree_purge_candidates_confirm_idx
  ON vault_tree_purge_candidates (user_id, confirmed_idempotency_key, blob_format_version, blob_id)
  WHERE confirmed_idempotency_key IS NOT NULL;

-- ── Scoped application DML — explicit, idempotent, role-guarded ─────────────
-- ⚠️ DML only. `drive_app` never owns these tables and never receives CREATE,
--    ALTER, DROP or TRUNCATE. No sequence grant: every key is TEXT/composite/FK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON '
         || 'vault_tree_state, vault_tree_frozen_inventory, vault_tree_key_envelope, vault_tree_heads, '
         || 'vault_tree_revisions, vault_tree_blob_state, vault_tree_purge_candidates TO drive_app';
  END IF;
END
$$;

COMMIT;
