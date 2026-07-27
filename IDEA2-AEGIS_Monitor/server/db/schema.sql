-- IDEA2 · AEGIS Monitor — schema (ฐานข้อมูล aegis_monitor — แยกขาดจาก IDEA1 โดยสิ้นเชิง)
-- ⚠️ Identity Decoupling: ตาราง users นี้เป็นของ AEGIS Monitor "เท่านั้น"
--    IDEA1 (AEGIS Drive) มีตาราง users ของตัวเองในฐานข้อมูล aegis_drive
--    HUB ไม่มีตาราง users เลย (เป็นแค่ traffic router) — ไม่มีโมดูลใดออกเซสชันแทนกันได้
--
-- ผู้เขียนข้อมูล detection/clip คือ Detection Engine (Laptop, VLAN 20) ผ่าน LAN
-- เว็บแอปนี้ "อ่านอย่างเดียว" — ไม่เปิดกล้อง ไม่รัน inference ไม่ถือ video handle

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                 -- bcrypt เท่านั้น
  role          TEXT NOT NULL DEFAULT 'CCTV-Operator'
                CHECK (role IN ('SOC-Responder', 'CCTV-Operator')), -- สอง role เท่านั้น (default-deny)
  display_name  TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE, -- ปิดใช้งาน operator → เส้นทาง alert ตกไป SOC-Team
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- ⚠️ Force Password Reset: TRUE = รหัสผ่านปัจจุบันเป็นรหัสชั่วคราวที่ตั้งไว้โดย CLI
--    (server/cli/manage_users.py, รันผ่าน SSH เท่านั้น — ดูเหตุผลใน README ข้างไฟล์นั้น)
--    ต้องถูกบังคับเปลี่ยนก่อนใช้งานอย่างอื่น ยกเว้น /me, /logout, /password/reset
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS cameras (
  id         TEXT PRIMARY KEY,                 -- 'CAM-01' … ตรงกับ Detection Engine
  name       TEXT NOT NULL,
  zone       TEXT NOT NULL,
  res        TEXT NOT NULL DEFAULT '1920×1080',
  online     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── camera_assignment — หัวใจของ Scoped View ────────────────────────────────
-- ⚠️ ตารางนี้เป็นของ IDEA2 เท่านั้น (ห้ามอยู่ใต้ IDEA1 เด็ดขาด)
--    ทุก endpoint ที่ CCTV-Operator เรียก ต้อง JOIN ผ่านตารางนี้ "ฝั่งเซิร์ฟเวอร์"
--    — กรอง camera ตาม camera_assignment ที่ฝั่ง server — ห้ามเชื่อ filter จาก client
--    Operator ที่ยิง API ตรงถามกล้องที่ไม่ได้รับมอบหมายต้องได้ 403
CREATE TABLE IF NOT EXISTS camera_assignment (
  camera_id  TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE, -- NULL = เส้นทางกลุ่ม SOC-Team
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (camera_id)
);

-- ── detections — หนึ่งแถวต่อ "คนหนึ่งคนในเฟรม" ─────────────────────────────
-- เฟรมที่มีหลายคน → หลายแถว (แชร์ frame_id เดียวกัน) — ทำให้เห็น tailgating
-- ⚠️ PDPA scope: ไม่มี job title / employee id / department โดยเจตนา
CREATE TABLE IF NOT EXISTS detections (
  id          BIGSERIAL PRIMARY KEY,
  frame_id    TEXT NOT NULL,                   -- กลุ่มของคนในเฟรมเดียวกัน
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  camera_id   TEXT NOT NULL REFERENCES cameras(id),
  faces_in_frame INTEGER NOT NULL DEFAULT 1,
  result      TEXT NOT NULL CHECK (result IN ('Authorized', 'Unknown')),
  matched_name TEXT,                           -- ชื่อที่ระบบจดจำได้ (NULL เมื่อ Unknown)
  confidence  NUMERIC(5,2),
  synced_to_nas BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS detections_at_idx ON detections (at DESC);
CREATE INDEX IF NOT EXISTS detections_camera_idx ON detections (camera_id, at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity   TEXT NOT NULL CHECK (severity IN ('amber', 'red')),
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  camera_id  TEXT NOT NULL REFERENCES cameras(id),
  snapshot_path TEXT,
  telegram_sent BOOLEAN NOT NULL DEFAULT FALSE,
  acked      BOOLEAN NOT NULL DEFAULT FALSE,   -- Acknowledge = การเขียนเดียวที่อนุญาตใน console
  acked_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  acked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alerts_at_idx ON alerts (at DESC);

-- ── camera_heartbeat — สภาพจริงของ Detection Engine ต่อกล้องหนึ่งตัว ────────────
-- ⚠️ ตารางนี้คือ "แหล่งความจริงเดียว" ของสถานะ Edge link ที่เว็บแอปแสดง
--    ก่อนหน้านี้ /api/link เดาเอาจากตัวแปรในหน่วยความจำสองตัว + ปุ่มสาธิต — ไม่มี
--    ข้อมูลจริงอยู่เบื้องหลังเลย ตอนนี้ Detection Engine (Laptop, VLAN 20) POST
--    /internal/heartbeat เข้ามาเป็นระยะ แล้ว /api/link คำนวณสถานะจาก "อายุของ
--    heartbeat ล่าสุด" (recency) เท่านั้น — engine เงียบ = lost จริง ๆ ไม่ใช่แค่แสดงผล
--
--    หนึ่งแถวต่อหนึ่งกล้อง (UPSERT) — เก็บเฉพาะค่าล่าสุด ไม่ใช่ time-series
--    ประวัติย้อนหลัง (uptime %, disconnects 24h) ยังไม่มี — UI ต้องแสดง "unavailable"
--    ไม่ใช่ตัวเลขที่ดูสมจริงแต่แต่งขึ้น (ดู src/views/Diagnostics.jsx)
CREATE TABLE IF NOT EXISTS camera_heartbeat (
  camera_id       TEXT PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- เวลาที่ Monitor "รับ" heartbeat
  node_id         TEXT,                               -- edge node ที่ส่งมา
  camera_connected BOOLEAN NOT NULL DEFAULT FALSE,    -- engine เปิดกล้องได้จริงไหม
  camera_reconnects INTEGER NOT NULL DEFAULT 0,
  capture_fps     NUMERIC(6,2),
  detect_fps      NUMERIC(6,2),
  latency_ms      NUMERIC(8,2),
  latency_ms_avg  NUMERIC(8,2),
  uptime_s        NUMERIC(12,1),
  frames_captured BIGINT,
  segments_written INTEGER,
  nas_last_status TEXT,                               -- idle | ok | failed
  nas_pending     INTEGER
);

-- ── clips — บันทึกต่อเนื่องตัดเป็นช่วง ~10 นาที (interval-based, ไม่ใช่ detection-triggered) ──
CREATE TABLE IF NOT EXISTS clips (
  id            BIGSERIAL PRIMARY KEY,
  camera_id     TEXT NOT NULL REFERENCES cameras(id),
  started_at    TIMESTAMPTZ NOT NULL,
  duration_sec  INTEGER NOT NULL DEFAULT 600,
  file_path     TEXT NOT NULL,
  stored_on_nas BOOLEAN NOT NULL DEFAULT FALSE, -- rsync/scp + verify แล้วจึงเป็น TRUE
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_camera_idx ON clips (camera_id, started_at DESC);
