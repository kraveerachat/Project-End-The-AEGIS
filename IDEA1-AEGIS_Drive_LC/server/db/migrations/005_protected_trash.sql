-- IDEA1 · existing-database migration: Protected Trash / Recycle Bin
-- Additive metadata only. It neither rewrites nor moves file bytes and does not
-- alter Private Vault tables. Apply as the migration owner before deploying the
-- application revision that queries these columns.

BEGIN;

ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_by BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_deleted_by_fkey'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_trash_state_check'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_trash_state_check CHECK (
        (deleted_at IS NULL AND purge_after IS NULL)
        OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after >= deleted_at)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS files_trash_owner_idx
  ON files (uploaded_by, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_trash_expiry_idx
  ON files (purge_after) WHERE purge_after IS NOT NULL;

-- Existing application role needs UPDATE for soft-delete/restore and DELETE for
-- final purge; both privileges already exist in current installs. This explicit
-- grant keeps migration application independent of the creating superuser.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON files TO drive_app';
  END IF;
END
$$;

COMMIT;
