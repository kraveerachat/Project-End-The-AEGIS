-- Add an explicit per-Node ingest authentication mode without changing any
-- existing registration to strict Ed25519-only operation.

ALTER TABLE detection_nodes
  ADD COLUMN IF NOT EXISTS ingest_auth_mode TEXT NOT NULL
  DEFAULT 'legacy_shared_key'
  CHECK (ingest_auth_mode IN ('legacy_shared_key', 'ed25519_required'));
