-- IDEA1 · AEGIS Drive — seed สำหรับเดโม่ (บัญชีละ role — เดโม่ใช้ "สองบัญชีจริง"
-- ล็อกอินสลับกัน ไม่มี role switcher ใน UI เด็ดขาด เพราะ switcher ฝั่ง client
-- ขัดแย้งกับข้อโต้แย้งด้านความปลอดภัยของโปรเจกต์เอง)
--
-- รหัสผ่านเดโม่ (bcrypt cost=10):
--   admin / aegis-drive-admin  → role 'Admin'
--   user  / aegis-drive-user   → role 'DataLake-User'
-- ⚠️ ระบบจริง: เปลี่ยนรหัสเหล่านี้ทันทีหลังติดตั้ง และห้าม commit hash ของรหัสจริง

INSERT INTO users (username, password_hash, role, display_name) VALUES
  ('admin', '$2a$10$x.s.qVZEnNDozB6hLZu9Wu3tAD/HebtRwTu/mkbtHM/4QeqisPmnO', 'Admin',         'Veerachat J.'),
  ('user',  '$2a$10$KvFvKFdx6OnPCjxIlwYXiOw0i0mmdmwcO1rNgHvqwtxuOgZfsVj1i', 'DataLake-User', 'Kanya Srisuwan')
ON CONFLICT (username) DO NOTHING;
