-- 010_files_kind_parent.sql — AEGIS Drive (IDEA1) · FILES-MANAGEMENT-UX-1
--
-- ให้ไฟล์กับโฟลเดอร์มี "ตัวตนที่เก็บไว้จริง" และมีลำดับชั้นจริง
--
-- ⚠️ สิ่งที่การย้ายสคีมานี้กำลังลบทิ้งคือ heuristic ที่ตัดสินชนิดจากชื่อไฟล์
--    (ชื่อไม่มีจุด = โฟลเดอร์) มันทำให้ไฟล์ชื่อ `README` แสดงเป็นโฟลเดอร์ และทำให้
--    การเปลี่ยนชื่อ `report.pdf` → `report` แปลงไฟล์เป็นโฟลเดอร์เงียบ ๆ
--    **ห้าม backfill ด้วย heuristic เดิมเด็ดขาด** นั่นคือการเขียนบั๊กลงฐานข้อมูลถาวร
--
-- ⚠️ หลักฐานที่ใช้คือธรรมเนียมการสร้างแถว ตรงกับ server/db/legacyKindClassifier.js เป๊ะ
--    (สองที่นี้ต้องแก้พร้อมกันเสมอ ถ้าวันหนึ่งกติกาเปลี่ยน):
--      ไฟล์     path LIKE 'uploads/%'  AND sha256 IS NOT NULL
--      โฟลเดอร์ path NOT LIKE 'uploads/%' AND size_bytes = 0 AND sha256 IS NULL
--
-- ⚠️ แถวที่ไม่เข้าทั้งสองแบบ = การย้ายสคีมาทั้งก้อนถูกยกเลิก (RAISE EXCEPTION)
--    เจตนาคือ **ล้มแบบปิด**: หยุดให้เจ้าของตรวจ ดีกว่าเดาแล้วได้ไฟล์จริงที่กลายเป็น
--    โฟลเดอร์ถาวร หรือโฟลเดอร์ที่มีลูกกลายเป็นไฟล์ที่ดาวน์โหลดไม่ได้
--    ตรวจก่อนรันด้วย legacyKindPreflight() แล้วดูว่า ambiguousRows = 0
--
-- ⚠️ ON DELETE RESTRICT ไม่ใช่ CASCADE โดยเจตนา: Protected Trash ทำให้การลบโฟลเดอร์
--    เป็นการตั้ง deleted_at ไม่ใช่การลบแถว ถ้าใช้ CASCADE วันหนึ่งที่มีการลบจริง
--    (purge) ลูกทั้งซับทรีจะหายไปเงียบ ๆ พร้อมกัน — ดู FOLDER_NOT_EMPTY ใน routes/api.js
--    ที่กันไม่ให้โฟลเดอร์ซึ่งยังมีลูกที่ไม่ถูกลบถูกทิ้งลงถังตั้งแต่แรก

BEGIN;

ALTER TABLE files ADD COLUMN IF NOT EXISTS kind TEXT;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS parent_id BIGINT NULL
  REFERENCES files(id) ON DELETE RESTRICT;

-- ── backfill จากหลักฐานการสร้างเท่านั้น ───────────────────────────────────
UPDATE files
   SET kind = 'file'
 WHERE kind IS NULL
   AND path LIKE 'uploads/%'
   AND sha256 IS NOT NULL;

-- ⚠️ ต้องเป็นหลักฐานเชิงบวก: path ที่มีอยู่จริงและไม่ใช่ storage key ของการอัปโหลด
--    แถวที่ path เป็น NULL หรือว่างไม่ได้พิสูจน์ว่าเป็นโฟลเดอร์ มันพิสูจน์ว่าเราไม่รู้
UPDATE files
   SET kind = 'folder'
 WHERE kind IS NULL
   AND path IS NOT NULL
   AND path <> ''
   AND path NOT LIKE 'uploads/%'
   AND size_bytes = 0
   AND sha256 IS NULL;

-- แถว Vault เป็น ciphertext ที่อัปโหลดเข้ามาเสมอ และไม่เคยเป็นโฟลเดอร์
UPDATE files
   SET kind = 'file'
 WHERE kind IS NULL
   AND vault = true;

-- ── ประตูล้มแบบปิด ────────────────────────────────────────────────────────
-- ⚠️ ห้ามแปลงบล็อกนี้เป็นค่าเริ่มต้นหรือ COALESCE เพื่อให้การย้ายสคีมา "ผ่าน"
--    การผ่านโดยเดาคือผลลัพธ์ที่แย่ที่สุดที่เป็นไปได้ของงานทั้งงานนี้
DO $$
DECLARE
  unresolved BIGINT;
BEGIN
  SELECT count(*) INTO unresolved FROM files WHERE kind IS NULL;
  IF unresolved > 0 THEN
    RAISE EXCEPTION
      'migration 010 aborted: % files row(s) could not be classified from creation evidence. '
      'Run legacyKindPreflight() and have the owner resolve every ambiguous row before retrying. '
      'Classifying them by filename is the defect this migration removes.', unresolved;
  END IF;
END $$;

ALTER TABLE files ALTER COLUMN kind SET NOT NULL;

ALTER TABLE files
  DROP CONSTRAINT IF EXISTS files_kind_check;
ALTER TABLE files
  ADD CONSTRAINT files_kind_check CHECK (kind IN ('file', 'folder'));

-- ลูกของโฟลเดอร์ถูกอ่านทุกครั้งที่เปิดโฟลเดอร์ และถูกนับตอนกัน FOLDER_NOT_EMPTY
CREATE INDEX IF NOT EXISTS files_parent_id_idx ON files (parent_id);

-- ชื่อต้องไม่ซ้ำภายในโฟลเดอร์เดียวกันของเจ้าของคนเดียวกัน (เฉพาะแถวที่ยังไม่ถูกลบ)
-- ⚠️ parent_id เป็น NULL ที่ราก และ NULL ไม่เท่ากับ NULL ใน UNIQUE ปกติ จึงต้องใช้
--    COALESCE เพื่อให้รากถูกบังคับเหมือนโฟลเดอร์อื่น
CREATE UNIQUE INDEX IF NOT EXISTS files_unique_name_per_parent_idx
  ON files (uploaded_by, COALESCE(parent_id, 0), lower(name))
  WHERE deleted_at IS NULL AND vault = false;

COMMIT;
