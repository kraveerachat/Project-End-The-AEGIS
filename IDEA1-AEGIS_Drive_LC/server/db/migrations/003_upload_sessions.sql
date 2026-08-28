-- IDEA1 · existing-database migration: resumable chunked upload sessions (LFT-V2-A)
--
-- New databases receive the same tables from ../schema.sql. This migration is the
-- reviewed path for an already-initialised aegis_drive database. It only adds two
-- new tables; the REVOKE CONNECT isolation and every existing table privilege
-- stay exactly as they are, and no role or database-level grant changes.
--
-- Run it as the migration/superuser role. `drive_app` deliberately cannot create
-- tables, so it can never apply this file.
--
-- ⚠️ The DML grant at the bottom is EXPLICIT and is not optional. An earlier
--    revision of this file relied on the `ALTER DEFAULT PRIVILEGES` statements in
--    postgres/init/02-app-roles.sh to cover tables created by later migrations.
--    Measured against PostgreSQL 15, that reliance is only correct when the very
--    same role that executed `ALTER DEFAULT PRIVILEGES` also creates the tables:
--    default privileges are recorded per creating role (pg_default_acl.defaclrole),
--    not per database. Applying this migration with any other superuser account —
--    an ordinary thing for a DBA to do — produced **zero** grants on both tables,
--    and the application then failed at runtime with
--    `permission denied for table upload_sessions` on every upload, after a
--    migration that reported nothing but success. The explicit GRANT removes the
--    dependency on *who* runs the file.
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
  -- ⚠️ 'committing' is a short-lived CLAIM state, not a cosmetic label. Commit
  --    takes it with a conditional UPDATE (open -> committing) so that two
  --    concurrent commits of the same session cannot both proceed to publish.
  --    The loser sees the row is no longer 'open' and is refused. Cleanup also
  --    refuses to touch a session in this state — see listExpiredUploadSessions.
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'committing', 'committed', 'aborted')),
  -- ── Durable commit intent (LFT-V2-A crash recovery) ───────────────────────
  -- ⚠️ ทั้งสามคอลัมน์นี้มีไว้เพื่อให้ "การกู้คืนหลังโปรเซสตาย" ทำได้จริง ไม่ใช่เพื่อรายงาน
  --    ถ้าโปรเซสตายระหว่าง commit สิ่งที่ต้องรู้ให้ได้หลังบูตใหม่คือ "ไบต์ชุดสุดท้าย
  --    ถูกตั้งใจให้ไปอยู่ที่ key ไหน" — ถ้า key นั้นถูกสุ่มไว้ในตัวแปรของโปรเซสที่ตายไป
  --    ไบต์ที่ถูก rename ไปแล้วจะกลายเป็นของกำพร้าที่ไม่มีใครรู้จักตลอดกาล
  -- commit_started_at = จุดเริ่มของสัญญาเช่า (lease) งานกู้คืนแตะได้เฉพาะแถวที่เก่ากว่า
  --    UPLOAD_COMMIT_LEASE_MS เท่านั้น เพื่อไม่ดึงพรมออกจากใต้ commit ที่ยังทำงานอยู่
  -- commit_storage_key = key ปลายทางที่ถูกเลือกและบันทึก "ก่อน" การ rename ใด ๆ
  -- committed_file_id = แถวใน files ที่ commit นี้สร้าง/อัปเดต ถูกเขียนใน transaction
  --    เดียวกับที่เปลี่ยน status เป็น 'committed' จึงไม่มีวันมีค่าในแถวที่ยัง committing
  commit_started_at   TIMESTAMPTZ,
  commit_storage_key  TEXT,
  committed_file_id   BIGINT REFERENCES files(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

-- ⚠️ อัปเกรดฐานข้อมูลที่รับ Stage-A ของ migration นี้ไปแล้ว (ตารางมีอยู่แล้วแต่ยังไม่มี
--    คอลัมน์ commit intent) — CREATE TABLE IF NOT EXISTS ด้านบนจะข้ามไปเฉย ๆ จึงต้องมี
--    ALTER แยกไว้ตรงนี้ ทั้งสามคำสั่งเป็น IF NOT EXISTS จึงรันซ้ำได้ไม่จำกัดครั้ง
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS commit_started_at  TIMESTAMPTZ;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS commit_storage_key TEXT;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS committed_file_id  BIGINT;

-- FK ของคอลัมน์ที่เพิ่มด้วย ALTER ต้องเพิ่มแยกและต้องไม่พังเมื่อรันซ้ำ
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_committed_file_id_fkey'
  ) THEN
    ALTER TABLE upload_sessions
      ADD CONSTRAINT upload_sessions_committed_file_id_fkey
      FOREIGN KEY (committed_file_id) REFERENCES files(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS upload_sessions_user_idx ON upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx ON upload_sessions (status, expires_at);
CREATE INDEX IF NOT EXISTS upload_sessions_commit_idx ON upload_sessions (status, commit_started_at);

CREATE TABLE IF NOT EXISTS upload_session_chunks (
  upload_id    TEXT NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256       CHAR(64) NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index)
);

-- ── Scoped application DML — explicit, idempotent, and role-guarded ──────────
-- ⚠️ DML only. `drive_app` is never made the owner and never receives CREATE,
--    ALTER, DROP or TRUNCATE — the same boundary postgres/init/02-app-roles.sh
--    draws, so a compromised application process still cannot change the schema.
-- ⚠️ Neither table owns a sequence (`upload_id` is a TEXT primary key and
--    upload_session_chunks has a composite key), so no sequence grant is needed.
--    Verified against PostgreSQL 15 rather than assumed.
-- ⚠️ Guarded on role existence so a development database with no `drive_app`
--    role — the in-memory fallback deployment — still applies this file cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON upload_sessions, upload_session_chunks TO drive_app';
  END IF;
END
$$;

COMMIT;
