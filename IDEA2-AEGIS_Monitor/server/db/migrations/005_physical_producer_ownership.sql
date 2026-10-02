-- Producer generations belong to physical cameras, not account/node aliases.
-- Keep historical epoch aliases and event provenance; each demand owns its
-- logical alias and (for new runtime demands) authenticated viewer context.

BEGIN;

ALTER TABLE camera_producer_demands
  ADD COLUMN IF NOT EXISTS logical_camera_id TEXT REFERENCES cameras(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS viewer_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT;

-- Only a demand's referenced historical epoch can supply its former alias.
-- Reruns must not overwrite account aliases or invent historical viewers.
UPDATE camera_producer_demands AS demand
   SET logical_camera_id = epoch.logical_camera_id
  FROM camera_producer_epochs AS epoch
 WHERE demand.producer_generation = epoch.producer_generation
   AND demand.logical_camera_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM camera_producer_demands WHERE logical_camera_id IS NULL) THEN
    RAISE EXCEPTION 'cannot backfill historical producer demand logical alias';
  END IF;
END
$$;

ALTER TABLE camera_producer_demands
  ALTER COLUMN logical_camera_id SET NOT NULL;

DROP INDEX IF EXISTS camera_producer_epochs_active_logical_idx;

-- Deprecated history only: new physical epochs leave this alias NULL.
-- The active physical unique index remains the producer ownership guard.
ALTER TABLE camera_producer_epochs
  ALTER COLUMN logical_camera_id DROP NOT NULL;

COMMIT;
