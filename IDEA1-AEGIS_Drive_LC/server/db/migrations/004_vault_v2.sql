-- IDEA1 · existing-database migration: Private Vault V2 — chunked zero-knowledge (LFT-V2-B)
--
-- New databases receive the same tables from ../schema.sql. This migration is the
-- reviewed path for an already-initialised aegis_drive database. Run it as the
-- migration/superuser role; `drive_app` deliberately cannot create tables.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────────────
-- It is **purely additive**. It creates four new tables and grants DML on them.
--   * `vault_meta` and `vault_blobs` (V1) are not altered, not relaxed, not
--     migrated and not read. Every existing V1 blob stays listable, unlockable,
--     previewable, downloadable and deletable through exactly the code path it
--     always used, and no existing ciphertext byte is rewritten or moved.
--   * No V1 column is made nullable. The V1 envelope keeps every NOT NULL it has.
--     V2 is a separate table set precisely so that V1's constraints survive
--     untouched — the alternative (one table with nullable envelope columns and a
--     format discriminator) would have required dropping NOT NULL from
--     `vault_blobs.iv_b64`, which is the one column that proves a V1 row is a
--     complete whole-file GCM message. A sentinel such as `iv_b64 = 'v2'` was
--     rejected for the same reason: it makes an invalid row representable.
--
-- ── THE EXPLICIT GRANT IS NOT OPTIONAL ──────────────────────────────────────
-- PR #43 measured this against PostgreSQL 15: `ALTER DEFAULT PRIVILEGES` only
-- applies to objects created by the role that executed it (pg_default_acl
-- .defaclrole), not to the database. A migration applied by any other superuser
-- account produces **zero** grants, and the application then fails at runtime
-- with `permission denied for table …` after a migration that reported success.
-- Every new table below is therefore granted explicitly, guarded on the role
-- existing so a development database without `drive_app` still applies cleanly.
--
-- ── WHAT THE SERVER LEARNS, STATED HONESTLY ─────────────────────────────────
-- No column here can hold a plaintext filename, a MIME type, a passphrase, a KEK
-- or an unwrapped DEK — there is nowhere to put one. What the server does see is
-- `ciphertext_size`, `chunk_size` and `chunk_count`, and from those the logical
-- plaintext size is derivable: plainSize = ciphertext_size - 16 * chunk_count,
-- because every chunk carries one 16-byte GCM tag. That is the same class of
-- disclosure V1 already makes (V1 stores ciphertext size, which is plaintext size
-- + 16). It is recorded here rather than described as hidden.

BEGIN;

-- ── Published V2 blobs ──────────────────────────────────────────────────────
-- ⚠️ `id` is TEXT, not BIGSERIAL, and is a random 24-byte opaque value. Two
--    reasons, both load-bearing:
--      1. V1 ids are numeric. A user-facing inventory returns V1 and V2 rows
--         together, so the two id spaces must not be able to collide — with TEXT
--         opaque ids they cannot, by construction rather than by convention.
--      2. Sequential ids let an owner-scoped 404 be probed for gaps. An opaque id
--         cannot be enumerated, so a cross-owner request is indistinguishable
--         from a request for something that never existed.
--    A consequence recorded on purpose: no sequence exists on these tables, so no
--    sequence grant is required (verified against PostgreSQL 15, not assumed).
CREATE TABLE IF NOT EXISTS vault_v2_blobs (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- pinned to 2: a future V3 gets its own explicit migration and its own review,
  -- rather than silently flowing through code written for this format
  format_version  SMALLINT NOT NULL DEFAULT 2 CHECK (format_version = 2),
  storage_key     TEXT NOT NULL UNIQUE,           -- 'vault/<uuid>.aegisenc', opaque
  -- the logical content identifier the client binds into every chunk's AAD;
  -- server-visible and non-secret, but it is what makes a chunk from another file
  -- fail authentication instead of decrypting into the wrong document
  content_id_b64  TEXT NOT NULL,
  ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),   -- ciphertext bytes per full chunk
  chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),  -- never 0: an empty file is one authenticated chunk
  wrapped_dek_b64 TEXT NOT NULL,                  -- DEK wrapped by the KEK — opaque here
  wrap_iv_b64     TEXT NOT NULL,
  meta_iv_b64     TEXT NOT NULL,                  -- {name, type, plainSize} encrypted with the DEK
  meta_b64        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vault_v2_blobs_user_idx ON vault_v2_blobs (user_id, created_at DESC);

-- ── Per-chunk facts of a published blob ─────────────────────────────────────
-- ⚠️ `iv_b64` is per chunk and NOT NULL. This is the whole point of the format:
--    one AES-GCM message per chunk, each with its own 96-bit IV. A single
--    file-level IV column would either force IV reuse across chunks (catastrophic
--    for GCM) or force one whole-file message (the V1 architecture this replaces).
-- ⚠️ `ciphertext_sha256` is what the SERVER hashed from the bytes it received. It
--    proves the stored ciphertext is the ciphertext that arrived. It does NOT
--    prove anything about the plaintext — the server has no key. See the
--    SERVER_CIPHERTEXT_INTEGRITY / CLIENT_AEAD_PLAINTEXT_AUTHENTICATION split.
CREATE TABLE IF NOT EXISTS vault_v2_blob_chunks (
  blob_id           TEXT NOT NULL REFERENCES vault_v2_blobs(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  ciphertext_size   INTEGER NOT NULL CHECK (ciphertext_size > 0),
  ciphertext_sha256 CHAR(64) NOT NULL,
  iv_b64            TEXT NOT NULL,
  PRIMARY KEY (blob_id, chunk_index)
);

-- ── In-flight upload sessions ───────────────────────────────────────────────
-- ⚠️ Compare with `upload_sessions` (Normal Files), which has a plaintext `name`
--    column. This table has none and must never gain one: the Vault path must not
--    be able to store a plaintext filename even if someone later wants to. The
--    filename lives inside `meta_b64`, encrypted with a DEK the server cannot
--    unwrap, and is carried through commit unchanged.
-- ⚠️ The envelope columns are captured at session creation, not at commit. A
--    session that never commits therefore still holds only ciphertext and wrapped
--    key material, and a crash cannot leave published bytes with no envelope.
CREATE TABLE IF NOT EXISTS vault_v2_upload_sessions (
  upload_id       TEXT PRIMARY KEY,               -- opaque 24 random bytes, hex
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format_version  SMALLINT NOT NULL DEFAULT 2 CHECK (format_version = 2),
  content_id_b64  TEXT NOT NULL,
  ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
  chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),
  wrapped_dek_b64 TEXT NOT NULL,
  wrap_iv_b64     TEXT NOT NULL,
  meta_iv_b64     TEXT NOT NULL,
  meta_b64        TEXT NOT NULL,
  -- 'committing' is a short-lived CLAIM, taken with a conditional UPDATE so two
  -- concurrent commits cannot both publish; the loser is refused. Cleanup and the
  -- user's cancel button both refuse to touch it, which is why the lease columns
  -- below exist — see server/storage/vaultCommitRecovery.js.
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'committing', 'committed', 'aborted')),
  commit_started_at  TIMESTAMPTZ,
  commit_storage_key TEXT,                        -- chosen and recorded BEFORE any rename
  committed_blob_id  TEXT REFERENCES vault_v2_blobs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_v2_sessions_user_idx ON vault_v2_upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_v2_sessions_expiry_idx ON vault_v2_upload_sessions (status, expires_at);
CREATE INDEX IF NOT EXISTS vault_v2_sessions_commit_idx ON vault_v2_upload_sessions (status, commit_started_at);

-- ── Per-chunk state of an in-flight session ─────────────────────────────────
-- ⚠️ Two states, and the difference matters for crash consistency:
--      'writing'  — a request claimed this slot and may be streaming bytes right
--                   now, or died halfway through. The slot does NOT count as
--                   received, so commit is blocked and a retry may overwrite the
--                   whole bounded chunk. A process that dies mid-write therefore
--                   leaves a slot that is recoverable rather than a slot that
--                   claims bytes it does not have.
--      'received' — bytes are fully written and the server has hashed them.
-- ⚠️ `writer_token` is the second half of the write-consistency rule. The
--    finalising UPDATE matches on it, so a slow writer that was overtaken cannot
--    attach ITS metadata to the bytes a later writer put on disk. The first half
--    is a PostgreSQL advisory lock held for the duration of the write, which
--    serialises two concurrent writers of the same slot across processes — an
--    in-process Map would not, and production may run more than one process.
-- ⚠️ The three payload columns are nullable ONLY because a 'writing' slot has no
--    bytes yet. The CHECK below is the compensating constraint: a row can never
--    be 'received' with any of them missing.
CREATE TABLE IF NOT EXISTS vault_v2_upload_chunks (
  upload_id         TEXT NOT NULL REFERENCES vault_v2_upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  state             TEXT NOT NULL CHECK (state IN ('writing', 'received')),
  writer_token      TEXT NOT NULL,
  ciphertext_size   INTEGER CHECK (ciphertext_size > 0),
  ciphertext_sha256 CHAR(64),
  iv_b64            TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index),
  CONSTRAINT vault_v2_chunk_received_is_complete CHECK (
    state <> 'received'
    OR (ciphertext_size IS NOT NULL AND ciphertext_sha256 IS NOT NULL AND iv_b64 IS NOT NULL)
  )
);

-- ── Scoped application DML — explicit, idempotent, role-guarded ─────────────
-- ⚠️ DML only. `drive_app` is never made the owner and never receives CREATE,
--    ALTER, DROP or TRUNCATE, matching postgres/init/02-app-roles.sh, so a
--    compromised application process still cannot change the schema.
-- ⚠️ No sequence grant: every primary key here is TEXT or composite, so these
--    tables own no sequence at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON '
         || 'vault_v2_blobs, vault_v2_blob_chunks, '
         || 'vault_v2_upload_sessions, vault_v2_upload_chunks TO drive_app';
  END IF;
END
$$;

COMMIT;
