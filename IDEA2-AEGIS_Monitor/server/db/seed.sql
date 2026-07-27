-- IDEA2 · AEGIS Monitor — seed สำหรับเดโม่
-- เดโม่ใช้ "บัญชีจริง" ล็อกอินสลับกัน — ไม่มี role switcher ใน UI เด็ดขาด
--   soc       → role 'SOC-Responder'  (Aggregate View — เห็นทุกกล้อง)
--   operator  → role 'CCTV-Operator'  (Scoped View — เห็นเฉพาะ CAM-05)
--   operator2 → role 'CCTV-Operator'  (Scoped View — เห็นเฉพาะ CAM-06)
--
-- ⚠️ รหัสผ่านเดโม่ "ไม่ถูกเขียนไว้ในไฟล์นี้" อีกต่อไป — คอมเมนต์ที่จดรหัส plaintext
--    ของบัญชีที่ deploy จริงก็คือการรั่วไหลด้วยตัวมันเอง (ไฟล์นี้อยู่ใน git สาธารณะ)
--    ผู้ติดตั้งรับรหัสมาทาง out-of-band แล้วเปลี่ยนทันทีตามด่านด้านล่าง
--
-- ⚠️ ทั้งสามบัญชีถูก seed ด้วย must_reset_password = TRUE โดยเจตนา
--    เหตุผล: hash สามก้อนด้านล่างอยู่ใน git สาธารณะ รหัสผ่านที่ตรงกับมันจึงเป็น
--    "ความรู้สาธารณะ" ไปตลอดกาล ใครที่ clone repo นี้ก็รู้รหัสของทุก deployment
--    ที่รัน seed นี้ การพึ่งคำเตือน "เปลี่ยนรหัสทันทีหลังติดตั้ง" ในคอมเมนต์ไม่ใช่
--    การควบคุม — มันคือความหวัง ด่าน must_reset_password ทำให้รหัสสาธารณะนี้
--    "ใช้ได้ครั้งเดียวเพื่อตั้งรหัสใหม่" เท่านั้น: ทุก endpoint นอกจาก
--    /me, /logout, /password/reset ตอบ 403 PASSWORD_RESET_REQUIRED จนกว่าจะเปลี่ยน
--    (ดู RESET_EXEMPT_PATHS ใน server/middleware/requireRole.js)
--    แบบแผนเดียวกับ IDEA1 (IDEA1-AEGIS_Drive_LC/server/db/seed.sql) และกับ
--    operator onboarding ของ Monitor เอง (store.js — INSERT ... must_reset_password TRUE)

INSERT INTO users (username, password_hash, role, display_name, must_reset_password) VALUES
  ('soc',       '$2a$10$mxld5o2Gi4jgHikH5svVHOGIkr7fV1.0sRRhR5x7Ynx76mgsFwrRS', 'SOC-Responder', 'A. Okafor',   TRUE),
  ('operator',  '$2a$10$BfbaBmC1Lm/2SZxuPgTW2eJ38JTopi44karUs4SblUfNZkZH8NdEO', 'CCTV-Operator', 'M. Reyes',    TRUE),
  ('operator2', '$2a$10$AHkuSfR6eQucPhR118X21.oPTdzQVgk9VY7Tx9JEL4R9Pq.aXu7uu', 'CCTV-Operator', 'T. Nakamura', TRUE)
ON CONFLICT (username) DO NOTHING;

-- ⚠️ ฐานข้อมูลที่ถูก init ไว้ "ก่อน" คอมมิตนี้มีสามแถวนี้อยู่แล้วด้วย
--    must_reset_password = FALSE และ ON CONFLICT DO NOTHING ด้านบนจะไม่แตะมันเลย
--    → deployment เดิมจะยังเปิดให้ใช้รหัสสาธารณะได้ต่อไปอย่างเงียบ ๆ ซึ่งคือ
--    ช่องโหว่เดิมทั้งดุ้น การแก้ seed เฉย ๆ จึงไม่พอ ต้องตามไปปิดของเดิมด้วย
--
--    เงื่อนไขคือ "hash ยังเป็นก้อนที่อยู่ใน git" เท่านั้น — จึงแม่นและ idempotent:
--    บัญชีที่เปลี่ยนรหัสไปแล้ว hash ไม่ตรง จะไม่ถูกบังคับรีเซ็ตซ้ำทุกครั้งที่รันสคริปต์
--    (การบังคับรีเซ็ตคนที่ทำถูกต้องไปแล้วคือการลงโทษพฤติกรรมที่เราต้องการ)
UPDATE users
   SET must_reset_password = TRUE
 WHERE must_reset_password = FALSE
   AND password_hash IN (
     '$2a$10$mxld5o2Gi4jgHikH5svVHOGIkr7fV1.0sRRhR5x7Ynx76mgsFwrRS',
     '$2a$10$BfbaBmC1Lm/2SZxuPgTW2eJ38JTopi44karUs4SblUfNZkZH8NdEO',
     '$2a$10$AHkuSfR6eQucPhR118X21.oPTdzQVgk9VY7Tx9JEL4R9Pq.aXu7uu'
   );

INSERT INTO cameras (id, name, zone, res, online) VALUES
  ('CAM-01', 'Main entrance', 'Perimeter',  '1920×1080', TRUE),
  ('CAM-02', 'Parking lot',   'Perimeter',  '1920×1080', TRUE),
  ('CAM-03', 'Server room',   'Restricted', '1280×720',  FALSE),
  ('CAM-04', 'Loading dock',  'Restricted', '1920×1080', TRUE),
  ('CAM-05', 'Reception',     'Public',     '1920×1080', TRUE),
  ('CAM-06', 'Corridor B',    'Internal',   '1280×720',  TRUE)
ON CONFLICT (id) DO NOTHING;

-- ── camera_assignment — คนละบัญชี คนละกล้อง ────────────────────────────────
-- operator  เห็นแค่ CAM-05, operator2 เห็นแค่ CAM-06 — คนละ account คนละกล้อง
-- SOC-Responder (soc) ไม่มีแถวในตารางนี้เลย = เห็นทุกกล้อง
-- ⚠️ ต้องมี operator สองคนขึ้นไป ถึงจะพิสูจน์ Scoped View ได้จริง: ของจริงที่ต้อง
--    พิสูจน์คือ "operator A มองไม่เห็นกล้องของ operator B" ไม่ใช่แค่ "เห็นน้อยกว่า SOC"
--    การกรองเกิดที่ SQL ฝั่งเซิร์ฟเวอร์เสมอ (ดู getVisibleCameras ใน connection.js)
--    operator ยิง API ขอกล้องที่ไม่ได้รับมอบหมาย → 403 (ห้ามเชื่อ camera_id จาก client)
-- (กล้องที่ user_id เป็น NULL = เส้นทางกลุ่ม SOC-Team)
INSERT INTO camera_assignment (camera_id, user_id)
SELECT 'CAM-05', id FROM users WHERE username = 'operator'
ON CONFLICT (camera_id) DO NOTHING;

INSERT INTO camera_assignment (camera_id, user_id)
SELECT 'CAM-06', id FROM users WHERE username = 'operator2'
ON CONFLICT (camera_id) DO NOTHING;
