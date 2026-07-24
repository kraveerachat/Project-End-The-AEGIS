-- IDEA2 · AEGIS Monitor — seed สำหรับเดโม่
-- เดโม่ใช้ "สองบัญชีจริง" ล็อกอินสลับกัน — ไม่มี role switcher ใน UI เด็ดขาด
--
-- รหัสผ่านเดโม่ (bcrypt cost=10):
--   soc       / aegis-soc        → role 'SOC-Responder'  (Aggregate View — เห็นทุกกล้อง)
--   operator  / aegis-operator   → role 'CCTV-Operator'  (Scoped View — เห็นเฉพาะ CAM-05)
--   operator2 / aegis-operator2  → role 'CCTV-Operator'  (Scoped View — เห็นเฉพาะ CAM-06)
-- ⚠️ ระบบจริง: เปลี่ยนรหัสเหล่านี้ทันทีหลังติดตั้ง

INSERT INTO users (username, password_hash, role, display_name) VALUES
  ('soc',       '$2a$10$mxld5o2Gi4jgHikH5svVHOGIkr7fV1.0sRRhR5x7Ynx76mgsFwrRS', 'SOC-Responder', 'A. Okafor'),
  ('operator',  '$2a$10$BfbaBmC1Lm/2SZxuPgTW2eJ38JTopi44karUs4SblUfNZkZH8NdEO', 'CCTV-Operator', 'M. Reyes'),
  ('operator2', '$2a$10$AHkuSfR6eQucPhR118X21.oPTdzQVgk9VY7Tx9JEL4R9Pq.aXu7uu', 'CCTV-Operator', 'T. Nakamura')
ON CONFLICT (username) DO NOTHING;

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
