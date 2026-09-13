-- IDEA2 device-owned local runtime: authoritative Node -> Camera registry.
-- This migration is intentionally data-free. Registrations are provisioned
-- explicitly through server/cli/manage_nodes.py after review and rollout.

CREATE TABLE IF NOT EXISTS detection_nodes (
  node_id                TEXT PRIMARY KEY,
  camera_id              TEXT NOT NULL UNIQUE REFERENCES cameras(id) ON DELETE RESTRICT,
  public_key             TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL UNIQUE,
  key_version            INTEGER NOT NULL CHECK (key_version > 0),
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_request_nonces (
  node_id      TEXT NOT NULL REFERENCES detection_nodes(node_id) ON DELETE CASCADE,
  nonce_digest TEXT NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (node_id, nonce_digest)
);

CREATE INDEX IF NOT EXISTS node_request_nonces_expires_at_idx
  ON node_request_nonces (observed_at);
