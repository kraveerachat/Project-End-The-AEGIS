-- 001_vault_envelope.sql — AEGIS Drive (IDEA1)
-- ย้าย Private Vault จากโครงเดิม (PBKDF2 + ciphertext ใน TEXT) มาเป็นโครงใหม่
-- (Argon2id + envelope encryption + ciphertext เป็นไฟล์ .aegisenc บน Storage Layer)
--
-- ⚠️ ต้องรันด้วยมือกับฐานข้อมูลที่ "ถูกสร้างไปแล้ว" เท่านั้น
--    schema.sql ถูก mount เข้า /docker-entrypoint-initdb.d ซึ่ง Postgres รันให้
--    เฉพาะตอน initialize volume เปล่าครั้งแรก — ฐานข้อมูลที่มีอยู่แล้วจะไม่ได้ตารางใหม่
--    และ INSERT ของโค้ดใหม่จะล้มเหลวเพราะคอลัมน์ไม่ตรง
--
--    docker compose exec -T postgres psql -U postgres -d aegis_drive \
--      < IDEA1-AEGIS_Drive_LC/server/db/migrations/001_vault_envelope.sql
--
-- ⚠️ เหตุผลที่ DROP ได้อย่างปลอดภัย: โค้ดเวอร์ชันก่อนหน้าไม่เคยเขียนลงตารางสองตัวนี้เลย
--    (store.js เก็บ vault ไว้ใน object ในหน่วยความจำ ตารางถูกประกาศไว้แต่ไม่ถูกใช้)
--    ตารางเดิมจึงว่างเสมอ — บล็อก DO ด้านล่างยืนยันข้อนี้ก่อน แล้วค่อยลบ
--    ถ้าพบว่ามีแถวอยู่จริง จะ RAISE EXCEPTION แทนที่จะทำลายข้อมูลเงียบ ๆ

BEGIN;

DO $$
DECLARE
  n BIGINT;
BEGIN
  IF to_regclass('public.vault_blobs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM vault_blobs' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'vault_blobs มี % แถว — หยุดการ migrate เพื่อไม่ให้ ciphertext หาย กรุณาตรวจสอบด้วยมือก่อน', n;
    END IF;
  END IF;

  IF to_regclass('public.vault_meta') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM vault_meta' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'vault_meta มี % แถว — หยุดการ migrate เพราะการเขียนทับ salt/verifier ทำให้ ciphertext เดิมกำพร้าถาวร', n;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS vault_blobs;
DROP TABLE IF EXISTS vault_meta;

-- โครงใหม่ — ต้องตรงกับ schema.sql เป๊ะ (schema.sql คือแหล่งความจริงสำหรับ DB ที่สร้างใหม่)
CREATE TABLE vault_meta (
  user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt_b64        TEXT NOT NULL,
  kdf             TEXT NOT NULL DEFAULT 'argon2id',
  memory_kib      INTEGER NOT NULL DEFAULT 65536,
  iterations      INTEGER NOT NULL DEFAULT 3,
  parallelism     INTEGER NOT NULL DEFAULT 1,
  verifier_iv     TEXT NOT NULL,
  verifier_data   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vault_blobs (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key     TEXT NOT NULL UNIQUE,
  iv_b64          TEXT NOT NULL,
  wrapped_dek_b64 TEXT NOT NULL,
  wrap_iv_b64     TEXT NOT NULL,
  meta_iv_b64     TEXT NOT NULL,
  meta_b64        TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vault_blobs_user_idx ON vault_blobs (user_id, created_at DESC);

-- สิทธิ์ของ role แอป — ต้องตรงกับที่ 02-app-roles.sh ให้ไว้กับตารางอื่น
GRANT SELECT, INSERT, UPDATE, DELETE ON vault_meta, vault_blobs TO drive_app;
GRANT USAGE, SELECT ON SEQUENCE vault_blobs_id_seq TO drive_app;

COMMIT;
