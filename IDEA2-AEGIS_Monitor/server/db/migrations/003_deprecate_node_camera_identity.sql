-- IDEA2 compatibility migration: detection_nodes.camera_id remains available
-- as a legacy logical alias, but no longer identifies the node's physical
-- camera. Physical authority lives in physical_cameras.

ALTER TABLE detection_nodes
  ALTER COLUMN camera_id DROP NOT NULL;

ALTER TABLE detection_nodes
  DROP CONSTRAINT IF EXISTS detection_nodes_camera_id_key;
