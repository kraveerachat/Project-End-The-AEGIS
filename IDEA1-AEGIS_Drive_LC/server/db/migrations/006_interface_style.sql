-- IDEA1 · existing-database migration: authenticated interface style
--
-- Existing accounts intentionally receive Classic. The preference is stored on
-- the IDEA1 user row and is never exposed as a pre-authentication browser hint.
-- Re-running this migration is safe and adds no role, grant, or shared contract.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_interface_style TEXT NOT NULL DEFAULT 'classic'
  CHECK (ui_interface_style IN ('classic', 'neo'));

COMMIT;
