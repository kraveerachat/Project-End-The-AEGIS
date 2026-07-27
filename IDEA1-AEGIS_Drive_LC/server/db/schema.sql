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

-- ── โปรไฟล์ที่ "ผู้ใช้แก้เองได้" (แยกจากตัวตนเชิงสิทธิ์โดยเจตนา) ─────────────────
-- ⚠️ ทำไมเป็นคอลัมน์บน users ไม่ใช่ตารางแยก: ทุกเส้นทางที่ต้องใช้ชื่อแสดงผลอ่านแถว
--    users อยู่แล้ว (login, JOIN หา uploader ของไฟล์, JOIN หาคนสร้างลิงก์แชร์) การแยก
--    ตารางจะเปลี่ยน query เหล่านั้นให้เป็น LEFT JOIN เพิ่มอีกชั้นทุกจุด โดยไม่ได้อะไรกลับมา
--    — 1:1 กับ users และเกิด/ตายไปพร้อมกันเสมอ
--
-- ⚠️ สามอย่างนี้ "ไม่ใช่" ตัวตนเชิงสิทธิ์ และห้ามใช้ตัดสินสิทธิ์เด็ดขาด:
--    username = ตัวระบุที่ผู้ใช้แก้ไม่ได้ (แหล่งความจริงของ audit: actor_label)
--    display_name = ชื่อที่ Admin ตั้งให้ตอน provision (จอ Access ใช้ยืนยันว่าใครเป็นใคร)
--    profile_name = ชื่อที่ "เจ้าตัวแก้เองได้" — เปลี่ยนได้ตลอด ซ้ำกับคนอื่นได้ NULL = ยังไม่ตั้ง
--    เพราะ profile_name ซ้ำกันได้ ทุกจอที่แสดงมันต้องแสดง username คู่ไปด้วยเสมอ
--    ไม่งั้นผู้ใช้เปลี่ยนชื่อตัวเองเป็นชื่อคนอื่นแล้วอ่านไม่ออกว่าใครเป็นใคร
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_name TEXT;
-- avatar_key = ตำแหน่งไฟล์ใน Storage Layer ('avatars/<uuid>.<ext>') ไม่ใช่ชื่อที่ผู้ใช้ตั้ง
-- ⚠️ avatar_mime ถูกกำหนดจาก "ไบต์จริงที่เซิร์ฟเวอร์ sniff เอง" เท่านั้น (PNG/JPEG)
--    ไม่ใช่ค่าที่เบราว์เซอร์แจ้งมาใน Content-Type และไม่ใช่นามสกุลไฟล์ — ทั้งสองอย่างนั้น
--    ผู้ใช้ควบคุมได้ การเชื่อมันแล้วเสิร์ฟกลับเป็น Content-Type คือช่อง XSS (เช่นอัปโหลด
--    SVG ที่มี <script> แล้วให้เบราว์เซอร์ render ใน origin เดียวกับแอป)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime TEXT
  CONSTRAINT users_avatar_mime_allowed CHECK (avatar_mime IS NULL OR avatar_mime IN ('image/png', 'image/jpeg'));

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
  -- bcrypt ของรหัสลิงก์ เมื่อ auth_type='password' — ถูกตรวจจริงตอนไถ่ลิงก์
  -- (ดู POST /s/:token ใน server/routes/share.js) ห้ามเก็บรหัสดิบเด็ดขาด
  password_hash TEXT,
  -- scope คือ label ที่ UI แสดง — vlan_scope คือ CIDR ที่ label นั้น "แปลว่า" จริง
  -- ณ เวลาที่สร้างลิงก์ (snapshot จากตาราง network_zones ที่ Admin ดูแล)
  scope         TEXT NOT NULL DEFAULT 'any' CHECK (scope IN ('vlan', 'subnet', 'any')),
  -- ขอบเขตเครือข่ายเป็น array ของ CIDR เช่น {'192.168.10.0/24','10.10.0.0/28'}
  -- ⚠️ ว่าง = ไม่จำกัด; ไม่ว่าง = "บังคับจริงในโค้ด" ตอนไถ่ลิงก์ (เทียบ IP ต้นทางกับ
  --    ทุก CIDR ในนี้ อยู่นอกทั้งหมด → 403 ไม่ได้ไฟล์) ดูข้อจำกัดของการเทียบ IP
  --    ที่ชั้นแอปใน server/routes/share.js — มันคือ defense in depth ไม่ใช่ตัวแทนของ
  --    การแยก VLAN จริงที่ต้องทำที่ firewall/switch
  vlan_scope    TEXT[] NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Network zones — "บันทึกเจตนา" ของผู้ดูแลระบบ ไม่ใช่กลไกบังคับ ─────────────
-- ⚠️ ตารางนี้ไม่มีผลต่อการเข้าถึงใด ๆ ในแอป: การบังคับขอบเขตเครือข่ายเกิดที่ UFW/VLAN
--    บนโฮสต์ (network layer) จอที่แสดงข้อมูลนี้ต้องบอกตรง ๆ ว่าเป็นบันทึก ไม่ใช่สวิตช์
--    เดิมข้อมูลชุดนี้เป็นอาเรย์ในหน่วยความจำที่หายทุก restart — การเก็บลงตารางทำให้มัน
--    "จริง" ในความหมายเดียวที่มันเป็นได้: อยู่รอด restart และตรวจย้อนหลังได้
CREATE TABLE IF NOT EXISTS network_zones (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  cidr        TEXT NOT NULL UNIQUE,   -- ซ้ำไม่ได้: สอง zone ที่คุมช่วงเดียวกันคือความสับสน
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Share tokens — ตัวลิงก์ที่เอาไปไถ่ไฟล์ได้จริง ────────────────────────────────
-- ⚠️ เก็บ "sha256 ของ token" ไม่ใช่ token ดิบ เหตุผลเดียวกับที่รหัสผ่านเป็น bcrypt:
--    token คือ bearer credential — ใครถือก็ดาวน์โหลดไฟล์ได้โดยไม่ต้องล็อกอิน
--    ถ้าเก็บดิบไว้ ใครที่อ่านตารางนี้ได้ (backup ที่หลุด, dump, สิทธิ์ SELECT ที่กว้างเกิน)
--    จะได้ลิงก์ที่ใช้งานได้ทันทีของทุกไฟล์ที่ยังแชร์อยู่ การเก็บ hash ทำให้แถวที่ถูกขโมย
--    ไปใช้ไม่ได้ — สอดคล้องกับหลักของโปรเจกต์นี้ที่ว่า "ขโมยดิสก์ไปทั้งลูกก็ยังไม่ได้อะไร"
-- ⚠️ ผลที่ตามมาและต้องยอมรับ: เซิร์ฟเวอร์ "แสดงลิงก์เดิมซ้ำไม่ได้" เพราะไม่มีค่าดิบ
--    เก็บไว้ — ค่าดิบถูกคืนครั้งเดียวตอนสร้าง (แบบเดียวกับรหัสผ่านชั่วคราวของบัญชีใหม่)
--    ทำลิงก์หาย = เพิกถอนแล้วสร้างใหม่
-- UNIQUE index ยอมให้มี NULL ได้หลายแถวใน PostgreSQL — แถวเก่าก่อน migration
-- จึงยังอยู่ได้ (และไถ่ไม่ได้ ซึ่งถูกต้อง: มันไม่เคยมีลิงก์ให้ใครตั้งแต่แรก)
ALTER TABLE shares ADD COLUMN IF NOT EXISTS token_hash CHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS shares_token_hash_idx ON shares (token_hash);

-- 'zones' = จำกัดตาม network_zones ที่ Admin ดูแล (snapshot ลง vlan_scope ตอนสร้าง)
-- ค่าเดิม 'vlan'/'subnet' ยังถูกยอมรับเพื่อไม่ทำให้แถวที่มีอยู่ผิด constraint
ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_scope_check;
ALTER TABLE shares ADD CONSTRAINT shares_scope_check
  CHECK (scope IN ('any', 'zones', 'vlan', 'subnet'));

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
-- เข้ารหัสฝั่ง client เท่านั้น (WebCrypto + Argon2id → AES-256-GCM, envelope 2 ชั้น)
-- salt/iv ไม่ใช่ความลับ; ไม่มีคอลัมน์ใดเก็บกุญแจ/plaintext — โดยโครงสร้าง ไม่ใช่โดยสัญญา
--
-- ⚠️ ตารางเหล่านี้ถูกออกแบบให้ "ไม่มีที่ว่างให้เก็บ plaintext ได้แม้จะอยากเก็บ":
--    ไม่มีคอลัมน์ name, ไม่มีคอลัมน์ mime, ไม่มีคอลัมน์ passphrase/kek/dek
--    ชื่อไฟล์จริงอยู่ใน meta_b64 ซึ่งถูกเข้ารหัสด้วย DEK ที่เซิร์ฟเวอร์แกะไม่ได้
CREATE TABLE IF NOT EXISTS vault_meta (
  user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt_b64        TEXT NOT NULL,        -- per-vault Argon2id salt (เปิดเผยได้)
  kdf             TEXT NOT NULL DEFAULT 'argon2id',
  memory_kib      INTEGER NOT NULL DEFAULT 65536,  -- พารามิเตอร์ถูกบันทึกไว้เพื่อให้
  iterations      INTEGER NOT NULL DEFAULT 3,      -- ปรับขึ้นในอนาคตได้โดย vault เก่า
  parallelism     INTEGER NOT NULL DEFAULT 1,      -- ยังเปิดได้ด้วยค่าเดิมของตัวเอง
  verifier_iv     TEXT NOT NULL,        -- blob เล็กที่ client ใช้พิสูจน์ passphrase
  verifier_data   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vault_blobs (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Storage Layer: ciphertext อยู่เป็นไฟล์ .aegisenc บนดิสก์ ไม่ใช่ใน Postgres
  -- (base64 ใน TEXT กิน RAM/พื้นที่ +33% และดึงทั้งไฟล์เข้า RAM ทุกครั้งที่ query)
  storage_key     TEXT NOT NULL UNIQUE, -- เช่น 'vault/2f1c….aegisenc'
  iv_b64          TEXT NOT NULL,        -- IV ของเนื้อไฟล์ (GCM: ห้ามซ้ำต่อกุญแจ)
  -- envelope: DEK ต่อไฟล์ถูกห่อด้วย KEK ที่ derive จาก passphrase ฝั่ง client
  wrapped_dek_b64 TEXT NOT NULL,        -- DEK ที่ถูกห่อ — ไร้ KEK ก็แกะไม่ได้
  wrap_iv_b64     TEXT NOT NULL,
  -- metadata ของไฟล์ (ชื่อ/ชนิด/ขนาดจริง) เข้ารหัสด้วย DEK — server ไม่รู้แม้แต่ชื่อไฟล์
  meta_iv_b64     TEXT NOT NULL,
  meta_b64        TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL DEFAULT 0, -- ขนาด "ciphertext" บนดิสก์ (server วัดเอง)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vault_blobs_user_idx ON vault_blobs (user_id, created_at DESC);
