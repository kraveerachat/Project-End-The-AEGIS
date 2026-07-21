-- IDEA2 · AEGIS Monitor — seed สำหรับเดโม่
-- เดโม่ใช้ "สองบัญชีจริง" ล็อกอินสลับกัน — ไม่มี role switcher ใน UI เด็ดขาด
--
-- รหัสผ่านเดโม่ (bcrypt cost=10):
--   soc      / aegis-soc       → role 'SOC-Responder'  (Aggregate View — เห็นทุกกล้อง)
--   operator / aegis-operator  → role 'CCTV-Operator'  (Scoped View — เห็นเฉพาะกล้องที่มอบหมาย)
-- ⚠️ ระบบจริง: เปลี่ยนรหัสเหล่านี้ทันทีหลังติดตั้ง

INSERT INTO users (username, password_hash, role, display_name) VALUES
  ('soc',      '$2a$10$mxld5o2Gi4jgHikH5svVHOGIkr7fV1.0sRRhR5x7Ynx76mgsFwrRS', 'SOC-Responder', 'A. Okafor'),
  ('operator', '$2a$10$BfbaBmC1Lm/2SZxuPgTW2eJ38JTopi44karUs4SblUfNZkZH8NdEO', 'CCTV-Operator', 'M. Reyes')
ON CONFLICT (username) DO NOTHING;

INSERT INTO cameras (id, name, zone, res, online) VALUES
  ('CAM-01', 'Main entrance', 'Perimeter',  '1920×1080', TRUE),
  ('CAM-02', 'Parking lot',   'Perimeter',  '1920×1080', TRUE),
  ('CAM-03', 'Server room',   'Restricted', '1280×720',  FALSE),
  ('CAM-04', 'Loading dock',  'Restricted', '1920×1080', TRUE),
  ('CAM-05', 'Reception',     'Public',     '1920×1080', TRUE),
  ('CAM-06', 'Corridor B',    'Internal',   '1280×720',  TRUE)
ON CONFLICT (id) DO NOTHING;

-- CCTV-Operator เดโม่ได้รับมอบหมาย CAM-05 — Scoped View ทั้งหมดกรองผ่านแถวนี้
-- (กล้องที่ user_id เป็น NULL = เส้นทางกลุ่ม SOC-Team)
INSERT INTO camera_assignment (camera_id, user_id)
SELECT 'CAM-05', id FROM users WHERE username = 'operator'
ON CONFLICT (camera_id) DO NOTHING;
