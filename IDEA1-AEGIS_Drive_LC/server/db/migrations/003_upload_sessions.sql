-- IDEA1 · existing-database migration: resumable chunked upload sessions (LFT-V2-A)
--
-- New databases receive the same tables from ../schema.sql. This migration is the
-- reviewed path for an already-initialised aegis_drive database. It only adds two
-- new tables, so current drive_app privileges and the REVOKE CONNECT isolation
-- stay in force; the ALTER DEFAULT PRIVILEGES set by postgres/init/02-app-roles.sh
-- grants drive_app DML on tables created afterwards, so no new GRANT is issued
-- here and no role or database grant changes.
--
-- Nothing in this migration reads, rewrites, or migrates existing rows. Files
-- uploaded through the legacy single-request endpoint are untouched and stay
-- readable exactly as before.

BEGIN;

CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id       TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  logical_size    BIGINT NOT NULL CHECK (logical_size >= 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
  chunk_count     INTEGER NOT NULL CHECK (chunk_count >= 0),
  expected_sha256 CHAR(64),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'aborted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_user_idx ON upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx ON upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS upload_session_chunks (
  upload_id    TEXT NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256       CHAR(64) NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index)
);

COMMIT;
