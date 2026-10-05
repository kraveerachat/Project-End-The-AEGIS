-- PR2 existing-database parity:
-- fresh schema uses 300 seconds, but an already-created clips table retains
-- its historical DEFAULT 600 until explicitly migrated.
--
-- This migration changes metadata only. Historical clip rows and their measured
-- duration_sec values must never be rewritten.

BEGIN;

ALTER TABLE clips
  ALTER COLUMN duration_sec SET DEFAULT 300;

COMMIT;