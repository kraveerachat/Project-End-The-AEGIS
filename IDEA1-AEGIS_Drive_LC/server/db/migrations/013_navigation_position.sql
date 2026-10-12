-- IDEA1 · account-owned placement of the authenticated navigation.
-- Apply before deploying a server build that reads ui_navigation_position.
-- Additive and safe to rerun; existing accounts retain the current left rail.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_navigation_position TEXT NOT NULL DEFAULT 'left'
  CHECK (ui_navigation_position IN ('left', 'top', 'bottom'));

COMMIT;
