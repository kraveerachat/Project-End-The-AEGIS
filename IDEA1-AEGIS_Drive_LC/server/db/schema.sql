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

-- ── การตั้งค่าหน้าจอรายบัญชี ────────────────────────────────────────────────
-- ห้ามย้ายสี่ค่านี้ไป localStorage/sessionStorage: อุปกรณ์แต่ละเครื่องต้องอ่านค่า
-- เดียวกันจากบัญชี และค่าต้องไม่กลายเป็น state ฝั่ง client ที่ตรวจสอบไม่ได้
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_theme TEXT NOT NULL DEFAULT 'light'
  CHECK (ui_theme IN ('light', 'dark', 'system'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language TEXT NOT NULL DEFAULT 'th'
  CHECK (ui_language IN ('th', 'en', 'zh'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_density TEXT NOT NULL DEFAULT 'comfortable'
  CHECK (ui_density IN ('comfortable', 'compact'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_interface_style TEXT NOT NULL DEFAULT 'classic'
  CHECK (ui_interface_style IN ('classic', 'neo'));

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

-- ── Network zones — source CIDRs snapshotted into restricted shares ────────────
-- ⚠️ redemption เทียบ CIDR กับ source address ที่ Express มองเห็น เป็น defense in depth
--    ไม่ใช่ตัวแทน UFW/VLAN/Twingate policy และไม่กู้ endpoint IP ที่ ingress ทำหายไปแล้ว
--    เดิมข้อมูลชุดนี้เป็นอาเรย์ในหน่วยความจำที่หายทุก restart — การเก็บลงตารางทำให้มัน
--    "จริง" ในความหมายเดียวที่มันเป็นได้: อยู่รอด restart และตรวจย้อนหลังได้
CREATE TABLE IF NOT EXISTS network_zones (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  cidr        TEXT NOT NULL UNIQUE,   -- ซ้ำไม่ได้: สอง zone ที่คุมช่วงเดียวกันคือความสับสน
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── File versions — ประวัติของไฟล์ระดับแอปพลิเคชัน ───────────────────────────────
--
-- ⚠️ นี่ "ไม่ใช่" snapshot ของ filesystem และห้ามเรียกว่า snapshot ในจอใดก็ตาม
--    Data Lake ของ deployment นี้อยู่บน Docker named volume ธรรมดา (ดู docker-compose.yml)
--    ไม่ใช่ LVM/ZFS/Btrfs จึงไม่มีกลไก point-in-time image ของทั้งชั้นเก็บไฟล์ให้ใช้ และ
--    คอนเทนเนอร์รันด้วย user 'node' ไม่มี CAP_SYS_ADMIN/ไม่เห็น /dev/mapper จะทำก็ทำไม่ได้
--    สิ่งที่ทำได้จริงด้วยของที่มีอยู่คือ "เก็บไบต์ชุดก่อนของไฟล์แต่ละไฟล์ไว้" ซึ่งกู้ข้อมูล
--    กลับมาได้จริง (ต่างจากจอ Snapshots เดิมที่มีแปดแถวปลอมและปุ่ม rollback ที่แค่ตั้ง
--    ธง destroyed ในหน่วยความจำ ไม่ได้คืนไบต์ของใครเลย)
--
-- ⚠️ ขอบเขตที่ต่างจาก snapshot จริง และต้องบอกผู้ใช้ตรง ๆ:
--    - เป็นประวัติ "ต่อไฟล์" ไม่ใช่ภาพของทั้งคลังที่จุดเวลาหนึ่ง
--    - ไฟล์ที่ถูกลบไปแล้วไม่มีประวัติให้กู้ (แถวหาย → CASCADE ลบ version ตามไปด้วย)
--    - ไม่ช่วยอะไรถ้าดิสก์เสียทั้งลูก (version อยู่บน volume เดียวกับตัวไฟล์)
--      นั่นคืองานของการสำรองข้อมูลนอกเครื่อง ซึ่ง deployment นี้ยังไม่มี
CREATE TABLE IF NOT EXISTS file_versions (
  id            BIGSERIAL PRIMARY KEY,
  file_id       BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  -- ไบต์ของเวอร์ชันเก่าอยู่บนดิสก์ใต้ 'versions/' — ย้ายมาด้วย rename บน volume เดียวกัน
  -- (ไม่ copy: ไฟล์ใหญ่บน HDD ของ edge box การ copy คือการเสียเวลาและพื้นที่สองเท่าฟรี ๆ)
  storage_key   TEXT NOT NULL UNIQUE,
  size_bytes    BIGINT NOT NULL DEFAULT 0,   -- ขนาดจริงบนดิสก์ (เซิร์ฟเวอร์วัดเอง)
  sha256        CHAR(64),
  -- ใครเป็นคนทำให้เวอร์ชันนี้กลายเป็นของเก่า (อัปโหลดทับ หรือกู้เวอร์ชันอื่น)
  superseded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS file_versions_file_idx ON file_versions (file_id, created_at DESC);

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

-- ── Resumable upload sessions (LFT-V2-A) ────────────────────────────────────
--
-- ⚠️ ตารางนี้เก็บ "สถานะของการโอนที่ยังไม่เสร็จ" ไม่ใช่ไบต์ของไฟล์ — ไบต์อยู่ใน
--    Storage Layer ใต้ STORAGE_ROOT/.staging/uploads/<upload_id>/part เสมอ
--    (เหตุผลเดียวกับที่ vault_blobs ไม่เก็บ base64 ใน TEXT: ฐานข้อมูลไม่ใช่ที่เก็บไฟล์)
--
-- ⚠️ ทำไมต้องอยู่ในฐานข้อมูล ไม่ใช่ในหน่วยความจำของ React หรือของโปรเซส Express:
--    การ "ทำต่อจากที่ค้าง" ต้องอยู่รอดทั้งการ retry ของเบราว์เซอร์ เน็ตหลุดชั่วคราว
--    และคำขอที่ล้มเหลว — สถานะที่หายไปพร้อม tab หรือพร้อม restart ไม่ใช่ resume จริง
--
-- ⚠️ `name` เป็นชื่อไฟล์ที่ผู้ใช้ตั้ง (plaintext) — ถูกต้องเฉพาะกับ Normal Files ซึ่ง
--    ตาราง files ก็เก็บชื่อจริงอยู่แล้ว **ห้ามนำตารางนี้ไปใช้กับ Private Vault**
--    เส้นทาง Vault ต้องไม่มีคอลัมน์ที่เก็บชื่อไฟล์เป็น plaintext ได้เลย (ดู LFT-V2-B)
--
-- ⚠️ ownership อยู่ที่ user_id เท่านั้น และทุก query ที่ค้น session ต้องกรองด้วยมันเสมอ
--    session ของผู้ใช้อื่นต้อง "ไม่มีอยู่" ในสายตาผู้เรียก (404 ไม่ใช่ 403)
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id       TEXT PRIMARY KEY,               -- id ทึบ 24 ไบต์สุ่ม (hex) — ไม่ใช่ลำดับที่เดาต่อได้
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  logical_size    BIGINT NOT NULL CHECK (logical_size >= 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
  chunk_count     INTEGER NOT NULL CHECK (chunk_count >= 0),
  expected_sha256 CHAR(64),                       -- ค่าที่ client อ้าง — ไม่ใช่แหล่งความจริง
  -- ⚠️ 'committing' is a short-lived CLAIM state, not a cosmetic label. Commit
  --    takes it with a conditional UPDATE (open -> committing) so that two
  --    concurrent commits of the same session cannot both proceed to publish.
  --    The loser sees the row is no longer 'open' and is refused. Cleanup also
  --    refuses to touch a session in this state — see listExpiredUploadSessions.
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'committing', 'committed', 'aborted')),
  -- ── Durable commit intent (LFT-V2-A crash recovery) ───────────────────────
  -- ⚠️ ทั้งสามคอลัมน์นี้มีไว้เพื่อให้ "การกู้คืนหลังโปรเซสตาย" ทำได้จริง ไม่ใช่เพื่อรายงาน
  --    ถ้าโปรเซสตายระหว่าง commit สิ่งที่ต้องรู้ให้ได้หลังบูตใหม่คือ "ไบต์ชุดสุดท้าย
  --    ถูกตั้งใจให้ไปอยู่ที่ key ไหน" — ถ้า key นั้นถูกสุ่มไว้ในตัวแปรของโปรเซสที่ตายไป
  --    ไบต์ที่ถูก rename ไปแล้วจะกลายเป็นของกำพร้าที่ไม่มีใครรู้จักตลอดกาล
  -- commit_started_at = จุดเริ่มของสัญญาเช่า (lease) งานกู้คืนแตะได้เฉพาะแถวที่เก่ากว่า
  --    UPLOAD_COMMIT_LEASE_MS เท่านั้น เพื่อไม่ดึงพรมออกจากใต้ commit ที่ยังทำงานอยู่
  -- commit_storage_key = key ปลายทางที่ถูกเลือกและบันทึก "ก่อน" การ rename ใด ๆ
  -- committed_file_id = แถวใน files ที่ commit นี้สร้าง/อัปเดต ถูกเขียนใน transaction
  --    เดียวกับที่เปลี่ยน status เป็น 'committed' จึงไม่มีวันมีค่าในแถวที่ยัง committing
  commit_started_at   TIMESTAMPTZ,
  commit_storage_key  TEXT,
  committed_file_id   BIGINT REFERENCES files(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_user_idx ON upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx ON upload_sessions (status, expires_at);
-- งานกู้คืนสแกนด้วยเงื่อนไข (status, commit_started_at) — คนละแกนกับ expiry cleanup
CREATE INDEX IF NOT EXISTS upload_sessions_commit_idx ON upload_sessions (status, commit_started_at);

-- ⚠️ หนึ่งแถวต่อ chunk ที่ "ถึงเซิร์ฟเวอร์ครบและถูกเขียนลงดิสก์แล้ว" — ไม่ใช่อาเรย์ใน
--    แถวเดียวของ upload_sessions โดยเจตนา: chunk หลายก้อนอัปโหลดขนานกันได้ และการ
--    อ่าน-แก้-เขียนอาเรย์เดียวกันพร้อมกันจะทำให้สถานะ "หาย" แบบเงียบ ๆ (lost update)
--    ส่วน INSERT ... ON CONFLICT DO UPDATE ต่อแถวนั้นถูกต้องภายใต้การส่งซ้ำเสมอ
CREATE TABLE IF NOT EXISTS upload_session_chunks (
  upload_id    TEXT NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256       CHAR(64) NOT NULL,                 -- ของ chunk ก้อนนี้ (วินิจฉัย ไม่ใช่ด่านสุดท้าย)
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index)
);

-- ── Private Vault V2 — chunked zero-knowledge transfer (LFT-V2-B) ───────────
--
-- ⚠️ ตารางชุดนี้ "เพิ่มเข้ามา" ไม่ได้แทนที่ vault_meta / vault_blobs ของ V1 ซึ่งยัง
--    ทำงานเหมือนเดิมทุกประการและไม่มีคอลัมน์ใดถูกผ่อนคลาย blob V1 ที่มีอยู่ยังลิสต์ได้
--    ปลดล็อกได้ พรีวิวได้ ดาวน์โหลดได้ และลบได้ผ่านเส้นทางเดิม ไม่มี ciphertext ใดถูกแปลง
--
-- ⚠️ ทำไมเป็นตารางแยก ไม่ใช่คอลัมน์ format_version ใน vault_blobs:
--    V2 ไม่มี "IV ของทั้งไฟล์" (มี IV ต่อ chunk) การยัดลงตารางเดียวจึงต้อง DROP NOT NULL
--    ออกจาก vault_blobs.iv_b64 ซึ่งเป็นคอลัมน์เดียวที่พิสูจน์ว่าแถว V1 เป็นข้อความ GCM
--    ที่สมบูรณ์ — เท่ากับทำให้ "แถวที่ผิด" กลายเป็นสิ่งที่เขียนลงตารางได้ ส่วนการใส่ค่า
--    หลอกอย่าง iv_b64='v2' ยิ่งแย่กว่า เพราะมันคือ constraint ที่ยังอยู่แต่ไม่ได้ตรวจอะไร
--
-- ⚠️ สิ่งที่เซิร์ฟเวอร์ "รู้" จากตารางชุดนี้ พูดตามตรง: ciphertext_size, chunk_size และ
--    chunk_count ทำให้ derive ขนาด plaintext ได้ (plainSize = ciphertext_size −
--    16 × chunk_count เพราะทุก chunk มี GCM tag 16 ไบต์) นี่คือการเปิดเผยชนิดเดียวกับ
--    ที่ V1 มีอยู่แล้ว (V1 เก็บขนาด ciphertext ซึ่งคือ plaintext + 16) จึงบันทึกไว้ตรงนี้
--    ตามจริง ไม่ใช่อ้างว่าซ่อนได้
--
-- ⚠️ ไม่มีคอลัมน์ชื่อไฟล์/MIME ที่ใดในชุดนี้ และห้ามเพิ่มเด็ดขาด — ต่างจาก
--    upload_sessions ของ Normal Files ที่มีคอลัมน์ name เป็น plaintext ได้อย่างถูกต้อง
--    เพราะที่นั่นตาราง files ก็เก็บชื่อจริงอยู่แล้ว
--
-- ⚠️ id ของ blob เป็น TEXT ทึบ ไม่ใช่ BIGSERIAL ด้วยเหตุผลสองข้อ: (1) inventory เดียว
--    คืนทั้งแถว V1 (id ตัวเลข) และ V2 พร้อมกัน id สองชุดจึงต้องชนกันไม่ได้โดยโครงสร้าง
--    (2) id ที่เดาต่อได้ทำให้ 404 ของ cross-owner ถูกยิงหาช่องว่างได้ ส่วน id ทึบ
--    แยกไม่ออกจาก "ไม่เคยมีอยู่" — ผลพลอยได้ที่บันทึกไว้: ตารางชุดนี้ไม่มี sequence เลย
CREATE TABLE IF NOT EXISTS vault_v2_blobs (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format_version  SMALLINT NOT NULL DEFAULT 2 CHECK (format_version = 2),
  storage_key     TEXT NOT NULL UNIQUE,           -- 'vault/<uuid>.aegisenc' — ทึบเสมอ
  content_id_b64  TEXT NOT NULL,                  -- ตัวระบุเนื้อหาที่ถูกผูกไว้ใน AAD ของทุก chunk
  ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),   -- ciphertext ต่อ chunk เต็มก้อน
  chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),  -- ไฟล์ว่าง = 1 chunk ไม่ใช่ 0
  wrapped_dek_b64 TEXT NOT NULL,
  wrap_iv_b64     TEXT NOT NULL,
  meta_iv_b64     TEXT NOT NULL,                  -- {name,type,plainSize} เข้ารหัสด้วย DEK
  meta_b64        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vault_v2_blobs_user_idx ON vault_v2_blobs (user_id, created_at DESC);

-- ⚠️ iv_b64 อยู่ "ต่อ chunk" และ NOT NULL — นี่คือแก่นของรูปแบบ V2: หนึ่ง chunk = หนึ่ง
--    ข้อความ AES-GCM ที่สมบูรณ์พร้อม IV 96 บิตของตัวเอง คอลัมน์ IV ระดับไฟล์เพียงตัวเดียว
--    จะบังคับให้ IV ซ้ำข้าม chunk (ซึ่งทำลาย GCM ทั้งหมด) หรือบังคับกลับไปเป็น whole-file
-- ⚠️ ciphertext_sha256 คือค่าที่ "เซิร์ฟเวอร์" แฮชจากไบต์ที่มันรับมาเอง มันพิสูจน์ว่า
--    ciphertext ที่เก็บไว้คือ ciphertext ที่มาถึง — ไม่ได้พิสูจน์อะไรเกี่ยวกับ plaintext
--    เลย (เซิร์ฟเวอร์ไม่มีกุญแจ) ดูการแยก SERVER_CIPHERTEXT_INTEGRITY กับ
--    CLIENT_AEAD_PLAINTEXT_AUTHENTICATION
CREATE TABLE IF NOT EXISTS vault_v2_blob_chunks (
  blob_id           TEXT NOT NULL REFERENCES vault_v2_blobs(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  ciphertext_size   INTEGER NOT NULL CHECK (ciphertext_size > 0),
  ciphertext_sha256 CHAR(64) NOT NULL,
  iv_b64            TEXT NOT NULL,
  PRIMARY KEY (blob_id, chunk_index)
);

-- ⚠️ envelope ถูกบันทึกตั้งแต่ตอนเปิด session ไม่ใช่ตอน commit — session ที่ไม่เคย
--    commit จึงถือแค่ ciphertext กับกุญแจที่ถูกห่อไว้ และการล่มกลางคันไม่มีทางทิ้งไบต์ที่
--    เผยแพร่แล้วโดยไม่มี envelope
CREATE TABLE IF NOT EXISTS vault_v2_upload_sessions (
  upload_id       TEXT PRIMARY KEY,               -- id ทึบ 24 ไบต์สุ่ม (hex)
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format_version  SMALLINT NOT NULL DEFAULT 2 CHECK (format_version = 2),
  content_id_b64  TEXT NOT NULL,
  ciphertext_size BIGINT NOT NULL CHECK (ciphertext_size > 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
  chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),
  wrapped_dek_b64 TEXT NOT NULL,
  wrap_iv_b64     TEXT NOT NULL,
  meta_iv_b64     TEXT NOT NULL,
  meta_b64        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'committing', 'committed', 'aborted')),
  commit_started_at  TIMESTAMPTZ,
  commit_storage_key TEXT,                        -- เลือกและบันทึก "ก่อน" การ rename ใด ๆ
  committed_blob_id  TEXT REFERENCES vault_v2_blobs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_v2_sessions_user_idx ON vault_v2_upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_v2_sessions_expiry_idx ON vault_v2_upload_sessions (status, expires_at);
CREATE INDEX IF NOT EXISTS vault_v2_sessions_commit_idx ON vault_v2_upload_sessions (status, commit_started_at);

-- ⚠️ สองสถานะ และความต่างสำคัญต่อความปลอดภัยหลังโปรเซสตาย:
--      'writing'  = มีคำขอจองช่องนี้ไว้และอาจกำลังส่งไบต์อยู่ หรือตายไปกลางทาง
--                   ช่องนี้ "ไม่นับว่ารับแล้ว" commit จึงถูกบล็อก และการส่งซ้ำเขียนทับได้
--                   ทั้งก้อน — โปรเซสที่ตายกลางการเขียนจึงทิ้งช่องที่กู้ได้ ไม่ใช่ช่องที่
--                   อ้างว่ามีไบต์ทั้งที่ไม่มี
--      'received' = ไบต์ครบและเซิร์ฟเวอร์แฮชไว้แล้ว
-- ⚠️ writer_token คือครึ่งหลังของกติกาความสอดคล้องในการเขียน: คำสั่ง UPDATE ตอนปิดงาน
--    ต้องตรงกับ token ผู้เขียนที่ช้ากว่าและถูกแซงไปแล้วจึงเอา metadata ของตัวเองไปแปะกับ
--    ไบต์ของผู้เขียนคนหลังไม่ได้ ครึ่งแรกคือ advisory lock ของ PostgreSQL ที่ถือไว้ตลอด
--    การเขียน ซึ่งกันผู้เขียนสองคนของช่องเดียวกัน "ข้ามโปรเซส" ได้จริง — Map ในโปรเซส
--    เดียวทำไม่ได้ และ production อาจมีหลายโปรเซส
-- ⚠️ สามคอลัมน์ล่างเป็น NULL ได้ "เฉพาะเพราะ" ช่องที่ยัง writing ยังไม่มีไบต์ CHECK
--    ด้านล่างคือ constraint ชดเชย: แถวที่ received ต้องมีครบทั้งสามเสมอ
CREATE TABLE IF NOT EXISTS vault_v2_upload_chunks (
  upload_id         TEXT NOT NULL REFERENCES vault_v2_upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  state             TEXT NOT NULL CHECK (state IN ('writing', 'received')),
  writer_token      TEXT NOT NULL,
  ciphertext_size   INTEGER CHECK (ciphertext_size > 0),
  ciphertext_sha256 CHAR(64),
  iv_b64            TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index),
  CONSTRAINT vault_v2_chunk_received_is_complete CHECK (
    state <> 'received'
    OR (ciphertext_size IS NOT NULL AND ciphertext_sha256 IS NOT NULL AND iv_b64 IS NOT NULL)
  )
);
