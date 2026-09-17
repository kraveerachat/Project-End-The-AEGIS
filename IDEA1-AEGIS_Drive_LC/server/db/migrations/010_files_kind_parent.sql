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
--      ไฟล์     path LIKE 'uploads/%'   AND sha256 IS NOT NULL AND sha256 <> ''
--      โฟลเดอร์ path LIKE '/datalake/%' AND size_bytes = 0 AND sha256 IS NULL
--
-- ⚠️ ทั้งสองข้อเป็นหลักฐาน **เชิงบวก** — โฟลเดอร์ต้องมีรูปร่างที่ pgCreateFolder เขียนเอง
--    ('/datalake/<name>') "path ที่ไม่ได้อยู่ใต้ uploads/" ไม่ใช่หลักฐาน มันบอกแค่ว่า
--    ไม่ใช่ไฟล์ แถวอย่าง path='legacy/unknown' ขนาด 0 ไม่มี checksum ต้องทำให้การ
--    ย้ายสคีมาหยุด ไม่ใช่กลายเป็นโฟลเดอร์เงียบ ๆ (Production ยังไม่ได้วัดว่ามีหรือไม่)
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
-- ⚠️ checksum ต้อง "มีอยู่และไม่ว่าง": เซิร์ฟเวอร์วัด sha256 เองเสมอ ค่าว่างจึงไม่ใช่
--    หลักฐานการสร้าง และ preflight (hasChecksum ใน legacyKindClassifier.js) ก็ปฏิเสธ
--    ค่าว่างอยู่แล้ว — ถ้า SQL รับ '' ไว้ preflight จะบอกว่า "หยุด" ขณะที่ migration
--    เดินต่อ ซึ่งผิดกติกาที่สองที่นี้ต้องตัดสินแถวปกติเหมือนกันทุกแถว
--    (sha256 เป็น CHAR(64) — bpchar เทียบโดยไม่นับช่องว่างท้าย '' ที่ถูกเก็บจึงยังเท่ากับ '')
UPDATE files
   SET kind = 'file'
 WHERE kind IS NULL
   AND path LIKE 'uploads/%'
   AND sha256 IS NOT NULL
   AND sha256 <> '';

-- ⚠️ ต้องเป็นหลักฐานเชิงบวก: path ตามธรรมเนียมที่ pgCreateFolder เขียนเองเท่านั้น
--    (FOLDER_PATH_PREFIX ใน legacyKindClassifier.js) แถวที่ path เป็น NULL ว่าง หรือ
--    ขึ้นต้นด้วยอย่างอื่น ไม่ได้พิสูจน์ว่าเป็นโฟลเดอร์ มันพิสูจน์ว่าเราไม่รู้ — ปล่อยให้
--    kind เป็น NULL ต่อไปเพื่อให้ประตูด้านล่างหยุดการย้ายสคีมา
UPDATE files
   SET kind = 'folder'
 WHERE kind IS NULL
   AND path LIKE '/datalake/%'
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

-- ── ค่าเริ่มต้น "หลัง" ประตู ─────────────────────────────────────────────
-- ⚠️ ต้องตั้ง DEFAULT ตรงนี้เท่านั้น ไม่ใช่ตอน ADD COLUMN ด้านบน: ถ้าใส่ตอนเพิ่มคอลัมน์
--    PostgreSQL จะเติม 'file' ให้ทุกแถวเก่าทันที แถวกำกวมจะกลายเป็นไฟล์ก่อนที่ประตู
--    ล้มแบบปิดจะได้ตรวจ — นั่นคือการเดาแทนเจ้าของที่ทั้งไฟล์นี้เขียนขึ้นมาเพื่อกัน
--    ถึงบรรทัดนี้ทุกแถวเดิมถูกจำแนกจากหลักฐานและล็อก NOT NULL แล้ว ค่าเริ่มต้นจึงมีผล
--    กับแถวใหม่เท่านั้น และทำให้ฐานที่อัปเกรดมีรูปเดียวกับ schema.sql (การติดตั้งใหม่)
--    INSERT ที่ไม่ระบุ kind จะได้ผลเหมือนกันบนทุกเครื่อง แทนที่จะระเบิด 23502 เฉพาะฝั่งอัปเกรด
ALTER TABLE files ALTER COLUMN kind SET DEFAULT 'file';

-- ลูกของโฟลเดอร์ถูกอ่านทุกครั้งที่เปิดโฟลเดอร์ และถูกนับตอนกัน FOLDER_NOT_EMPTY
CREATE INDEX IF NOT EXISTS files_parent_id_idx ON files (parent_id);

-- ⚠️ ปลายทางเชิงตรรกะของการอัปโหลดอยู่ที่ "เซสชัน" ไม่ใช่ที่คำขอ commit
--    จอ Files ใช้เส้นทาง V2 ซึ่งกินเวลาหลายนาทีสำหรับไฟล์ใหญ่ ถ้าปลายทางมาจาก
--    คำขอสุดท้าย ผู้ใช้ที่ refresh แล้วเปิดโฟลเดอร์อื่นจะได้ไฟล์ไปลงผิดที่ และคำขอ
--    commit ที่ถูกแก้ระหว่างทางจะ "เปลี่ยนปลายทาง" ได้ ซึ่งไม่ควรเป็นไปได้เลย
ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS parent_id BIGINT NULL
  REFERENCES files(id) ON DELETE RESTRICT;

-- ชื่อต้องไม่ซ้ำภายในโฟลเดอร์เดียวกันของเจ้าของคนเดียวกัน (เฉพาะแถวที่ยังไม่ถูกลบ)
-- ⚠️ parent_id เป็น NULL ที่ราก และ NULL ไม่เท่ากับ NULL ใน UNIQUE ปกติ จึงต้องใช้
--    COALESCE เพื่อให้รากถูกบังคับเหมือนโฟลเดอร์อื่น
CREATE UNIQUE INDEX IF NOT EXISTS files_unique_name_per_parent_idx
  ON files (uploaded_by, COALESCE(parent_id, 0), lower(name))
  WHERE deleted_at IS NULL AND vault = false;

COMMIT;
