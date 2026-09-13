-- IDEA2 physical camera identity and logical alias reconciliation.
-- Additive and idempotent: legacy logical camera columns and tables remain.

CREATE TABLE IF NOT EXISTS physical_cameras (
  physical_camera_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id             TEXT NOT NULL UNIQUE REFERENCES detection_nodes(node_id) ON DELETE RESTRICT,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO physical_cameras (node_id)
SELECT node_id
  FROM detection_nodes
ON CONFLICT (node_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS node_camera_alias_policy (
  node_id          TEXT PRIMARY KEY REFERENCES detection_nodes(node_id) ON DELETE CASCADE,
  mode             TEXT NOT NULL CHECK (mode IN ('fixed', 'account')),
  fixed_camera_id  TEXT REFERENCES cameras(id) ON DELETE RESTRICT,
  CHECK (
    (mode = 'fixed' AND fixed_camera_id IS NOT NULL) OR
    (mode = 'account' AND fixed_camera_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS node_account_camera_alias (
  node_id            TEXT NOT NULL REFERENCES detection_nodes(node_id) ON DELETE CASCADE,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logical_camera_id  TEXT NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  PRIMARY KEY (node_id, user_id)
);

INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
SELECT node_id, 'fixed', camera_id
  FROM detection_nodes
 WHERE camera_id IS NOT NULL
ON CONFLICT (node_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS camera_producer_epochs (
  producer_generation BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  logical_camera_id    TEXT NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  physical_camera_id   BIGINT NOT NULL REFERENCES physical_cameras(physical_camera_id) ON DELETE RESTRICT,
  node_id              TEXT NOT NULL REFERENCES detection_nodes(node_id) ON DELETE RESTRICT,
  acquired_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at     TIMESTAMPTZ NOT NULL,
  released_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS camera_producer_epochs_active_logical_idx
  ON camera_producer_epochs (logical_camera_id)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS camera_producer_epochs_active_physical_idx
  ON camera_producer_epochs (physical_camera_id)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS camera_producer_demands (
  producer_generation  BIGINT NOT NULL REFERENCES camera_producer_epochs(producer_generation) ON DELETE CASCADE,
  demand_owner_id      TEXT NOT NULL,
  session_binding_hash TEXT NOT NULL,
  lease_expires_at     TIMESTAMPTZ NOT NULL,
  released_at          TIMESTAMPTZ,
  PRIMARY KEY (producer_generation, demand_owner_id)
);

CREATE TABLE IF NOT EXISTS physical_camera_heartbeat (
  physical_camera_id BIGINT PRIMARY KEY REFERENCES physical_cameras(physical_camera_id) ON DELETE CASCADE,
  node_id            TEXT NOT NULL REFERENCES detection_nodes(node_id) ON DELETE RESTRICT,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  camera_connected   BOOLEAN NOT NULL DEFAULT FALSE,
  camera_reconnects  INTEGER NOT NULL DEFAULT 0,
  capture_fps        NUMERIC(6,2),
  detect_fps         NUMERIC(6,2),
  latency_ms         NUMERIC(8,2),
  latency_ms_avg     NUMERIC(8,2),
  uptime_s           NUMERIC(12,1),
  frames_captured    BIGINT,
  segments_written   INTEGER,
  nas_last_status    TEXT,
  nas_pending        INTEGER,
  stream_url         TEXT
);

ALTER TABLE detections
  ADD COLUMN IF NOT EXISTS physical_camera_id BIGINT REFERENCES physical_cameras(physical_camera_id),
  ADD COLUMN IF NOT EXISTS producer_generation BIGINT REFERENCES camera_producer_epochs(producer_generation);

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS physical_camera_id BIGINT REFERENCES physical_cameras(physical_camera_id),
  ADD COLUMN IF NOT EXISTS producer_generation BIGINT REFERENCES camera_producer_epochs(producer_generation);

ALTER TABLE clips
  ADD COLUMN IF NOT EXISTS physical_camera_id BIGINT REFERENCES physical_cameras(physical_camera_id),
  ADD COLUMN IF NOT EXISTS producer_generation BIGINT REFERENCES camera_producer_epochs(producer_generation);

WITH unique_legacy_camera_nodes AS (
  SELECT camera_id, min(node_id) AS node_id
    FROM detection_nodes
   WHERE camera_id IS NOT NULL
   GROUP BY camera_id
  HAVING count(*) = 1
)
INSERT INTO physical_camera_heartbeat (
  physical_camera_id, node_id, last_seen_at, camera_connected,
  camera_reconnects, capture_fps, detect_fps, latency_ms, latency_ms_avg,
  uptime_s, frames_captured, segments_written, nas_last_status, nas_pending,
  stream_url
)
SELECT
  pc.physical_camera_id, dn.node_id, h.last_seen_at, h.camera_connected,
  h.camera_reconnects, h.capture_fps, h.detect_fps, h.latency_ms, h.latency_ms_avg,
  h.uptime_s, h.frames_captured, h.segments_written, h.nas_last_status,
  h.nas_pending, h.stream_url
FROM camera_heartbeat h
JOIN unique_legacy_camera_nodes dn ON dn.camera_id = h.camera_id
JOIN physical_cameras pc ON pc.node_id = dn.node_id
WHERE h.node_id IS NULL OR h.node_id = dn.node_id
ON CONFLICT (physical_camera_id) DO NOTHING;

WITH unique_legacy_camera_nodes AS (
  SELECT camera_id, min(node_id) AS node_id
    FROM detection_nodes
   WHERE camera_id IS NOT NULL
   GROUP BY camera_id
  HAVING count(*) = 1
)
UPDATE detections d
   SET physical_camera_id = pc.physical_camera_id
  FROM unique_legacy_camera_nodes dn
  JOIN physical_cameras pc ON pc.node_id = dn.node_id
 WHERE d.camera_id = dn.camera_id
   AND d.physical_camera_id IS NULL;

WITH unique_legacy_camera_nodes AS (
  SELECT camera_id, min(node_id) AS node_id
    FROM detection_nodes
   WHERE camera_id IS NOT NULL
   GROUP BY camera_id
  HAVING count(*) = 1
)
UPDATE alerts a
   SET physical_camera_id = pc.physical_camera_id
  FROM unique_legacy_camera_nodes dn
  JOIN physical_cameras pc ON pc.node_id = dn.node_id
 WHERE a.camera_id = dn.camera_id
   AND a.physical_camera_id IS NULL;

WITH unique_legacy_camera_nodes AS (
  SELECT camera_id, min(node_id) AS node_id
    FROM detection_nodes
   WHERE camera_id IS NOT NULL
   GROUP BY camera_id
  HAVING count(*) = 1
)
UPDATE clips c
   SET physical_camera_id = pc.physical_camera_id
  FROM unique_legacy_camera_nodes dn
  JOIN physical_cameras pc ON pc.node_id = dn.node_id
 WHERE c.camera_id = dn.camera_id
   AND c.physical_camera_id IS NULL;
