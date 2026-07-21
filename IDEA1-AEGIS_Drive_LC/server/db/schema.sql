-- IDEA1 · AEGIS Drive — schema (ฐานข้อมูล aegis_drive — แยกขาดจาก IDEA2 โดยสิ้นเชิง)
-- ⚠️ Identity Decoupling: ตาราง users นี้เป็นของ AEGIS Drive "เท่านั้น"
--    IDEA2 (AEGIS Monitor) มีตาราง users ของตัวเองในฐานข้อมูล aegis_monitor
--    ห้ามแชร์ ห้าม JOIN ข้ามฐานข้อมูล ห้ามมี foreign key ข้ามโมดูล — การผูกกันคือ
--    การรื้อ boundary ที่สถาปัตยกรรมตั้งใจแยกไว้ (แยกระบบล่มไม่ลามกัน / least privilege)

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                 -- bcrypt เท่านั้น — ห้ามเก็บ plaintext
  role          TEXT NOT NULL DEFAULT 'DataLake-User'
                CHECK (role IN ('Admin', 'DataLake-User')),  -- สอง role เท่านั้น (default-deny)
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ค้นหา user แบบ case-insensitive เร็ว ๆ (ตรงกับ query ใน connection.js)
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- ⚠️ Force Password Reset: TRUE = รหัสผ่านปัจจุบันเป็นรหัสชั่วคราวที่ Admin ตั้งให้
--    (provisioning API หรือ Day-0 bootstrap) — ต้องถูกบังคับเปลี่ยนก่อนใช้งานอย่างอื่น
--    ใน request ถัดไปทุกเส้นทาง ยกเว้น /me, /logout, /password/reset (ดู requireRole.js)
--    ADD COLUMN IF NOT EXISTS ปลอดภัยทั้งกับ DB ใหม่และ DB เดิมที่รันสคริปต์นี้ซ้ำ
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT FALSE;

-- ── ไฟล์ใน Data Lake (Metadata Layer — ไฟล์จริงอยู่บนดิสก์/Storage Layer) ──────
CREATE TABLE IF NOT EXISTS files (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  mime         TEXT,
  sha256       CHAR(64),                       -- checksum สำหรับ integrity verify
  vault        BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE = ciphertext จาก client (Zero-Knowledge)
  verified     BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Secure Shares — ลิงก์แชร์ที่ล็อกขอบเขตเครือข่ายได้ (VLAN-Aware) ─────────────
CREATE TABLE IF NOT EXISTS shares (
  id            BIGSERIAL PRIMARY KEY,
  file_id       BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  auth_type     TEXT NOT NULL CHECK (auth_type IN ('password', 'otc', 'none')),
  password_hash TEXT,                          -- bcrypt ของรหัสลิงก์ (ถ้า auth_type='password')
  -- scope คือ label เชิงสัญลักษณ์ที่ UI แสดง ('vlan' | 'subnet' | 'any') — vlan_scope คือ
  -- CIDR ที่ label นั้น "แปลว่า" จริง ณ เวลาที่สร้างลิงก์ (ดู SCOPE_CIDRS ใน server/db/store.js)
  scope         TEXT NOT NULL DEFAULT 'any' CHECK (scope IN ('vlan', 'subnet', 'any')),
  -- ขอบเขตเครือข่ายเป็น array ของ CIDR เช่น {'192.168.10.0/24','192.168.30.0/24'}
  -- การบังคับจริงเกิดที่ UFW บนโฮสต์ (network layer) — คอลัมน์นี้คือ "เจตนา" ที่ UI แสดง
  vlan_scope    TEXT[] NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Privacy-Preserving Audit Log ─────────────────────────────────────────────
-- ⚠️ ชื่อไฟล์ถูกเก็บเป็น SHA-256 (target_hash) — ผู้ตรวจ log เห็นว่า "มีเหตุการณ์กับไฟล์ไหน
--    (ระบุซ้ำได้)" โดยไม่เห็นชื่อไฟล์จริง → การอ่าน audit เองไม่รั่วเนื้อหา/ชื่อเอกสาร
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_label  TEXT,                           -- username/ระบบ — ไม่ใช่ชื่อไฟล์
  role         TEXT,
  action       TEXT NOT NULL,                  -- LOGIN / FILE_UPLOAD / SHARE_CREATE / LOCKOUT ...
  target_hash  CHAR(64),                       -- sha256(ชื่อไฟล์/เป้าหมาย) — ห้ามเก็บชื่อจริง
  result       TEXT NOT NULL CHECK (result IN ('OK', 'DENIED', 'BLOCKED')),
  source_ip    INET
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

-- ── Zero-Knowledge Vault — server เก็บ "ciphertext เท่านั้น" ─────────────────
-- เข้ารหัสฝั่ง client เท่านั้น (WebCrypto: PBKDF2-600k → AES-256-GCM)
-- salt/iv ไม่ใช่ความลับ; ไม่มีคอลัมน์ใดเก็บกุญแจ/plaintext — โดยโครงสร้าง ไม่ใช่โดยสัญญา
CREATE TABLE IF NOT EXISTS vault_meta (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt_b64      TEXT NOT NULL,          -- per-user PBKDF2 salt
  iterations    INTEGER NOT NULL DEFAULT 600000,
  verifier_iv   TEXT NOT NULL,          -- blob เล็กที่ client ใช้พิสูจน์ passphrase
  verifier_data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_blobs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  iv_b64     TEXT NOT NULL,             -- IV สุ่มใหม่ต่อ blob (GCM: ห้ามซ้ำ)
  data_b64   TEXT NOT NULL,             -- ciphertext — server อ่านไม่ออกโดยคณิตศาสตร์
  size_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
