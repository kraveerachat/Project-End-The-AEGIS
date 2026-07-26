-- IDEA1 · AEGIS Drive — seed สำหรับเดโม่ (บัญชีละ role — เดโม่ใช้ "สองบัญชีจริง"
-- ล็อกอินสลับกัน ไม่มี role switcher ใน UI เด็ดขาด เพราะ switcher ฝั่ง client
-- ขัดแย้งกับข้อโต้แย้งด้านความปลอดภัยของโปรเจกต์เอง)
--
-- รหัสผ่านเดโม่ (bcrypt cost=10):
--   admin / aegis-drive-admin  → role 'Admin'
--   user  / aegis-drive-user   → role 'DataLake-User'
--
-- ⚠️ ทั้งสองบัญชีถูก seed ด้วย must_reset_password = TRUE โดยเจตนา
--    เหตุผล: hash สองก้อนด้านล่างอยู่ใน git สาธารณะ รหัสผ่านที่ตรงกับมันจึงเป็น
--    "ความรู้สาธารณะ" ไปตลอดกาล ใครที่ clone repo นี้ก็รู้รหัสของทุก deployment
--    ที่รัน seed นี้ การพึ่งคำเตือน "เปลี่ยนรหัสทันทีหลังติดตั้ง" ในคอมเมนต์ไม่ใช่
--    การควบคุม — มันคือความหวัง ด่าน must_reset_password ทำให้รหัสสาธารณะนี้
--    "ใช้ได้ครั้งเดียวเพื่อตั้งรหัสใหม่" เท่านั้น: ทุก endpoint นอกจาก
--    /me, /logout, /password/reset ตอบ 403 PASSWORD_RESET_REQUIRED จนกว่าจะเปลี่ยน
--    (ดู RESET_EXEMPT_PATHS ใน server/middleware/requireRole.js)
--    แบบแผนเดียวกับ operator onboarding ของ IDEA2 (ดู IDEA2-AEGIS_Monitor/server/db/store.js
--    — INSERT ... must_reset_password TRUE) และกับ Day-0 bootstrap ของ Drive เอง
--    (server/db/bootstrapAdmin.js) — ตอนนี้ทั้งสามเส้นทางที่สร้างบัญชีบังคับรีเซ็ตหมด

INSERT INTO users (username, password_hash, role, display_name, must_reset_password) VALUES
  ('admin', '$2a$10$x.s.qVZEnNDozB6hLZu9Wu3tAD/HebtRwTu/mkbtHM/4QeqisPmnO', 'Admin',         'Veerachat J.',   TRUE),
  ('user',  '$2a$10$KvFvKFdx6OnPCjxIlwYXiOw0i0mmdmwcO1rNgHvqwtxuOgZfsVj1i', 'DataLake-User', 'Kanya Srisuwan', TRUE)
ON CONFLICT (username) DO NOTHING;

-- ⚠️ ฐานข้อมูลที่ถูก init ไว้ "ก่อน" คอมมิตนี้มีสองแถวนี้อยู่แล้วด้วย
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
     '$2a$10$x.s.qVZEnNDozB6hLZu9Wu3tAD/HebtRwTu/mkbtHM/4QeqisPmnO',
     '$2a$10$KvFvKFdx6OnPCjxIlwYXiOw0i0mmdmwcO1rNgHvqwtxuOgZfsVj1i'
   );
