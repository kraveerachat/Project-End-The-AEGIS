// server/middleware/requireDetectionEngineKey.js — AEGIS Monitor (IDEA2)
// ── ด่านตรวจ service-to-service สำหรับ Detection Engine (Laptop, VLAN 20) ──────
// Detection Engine ไม่มี session / ผู้ใช้ / เบราว์เซอร์ — มันยิงเข้ามาตรง ๆ ผ่าน LAN
// จึงยืนยันตัวตนด้วย "API key ที่แชร์กันล่วงหน้า" ทาง header X-Detection-Engine-Key
// แทน cookie + CSRF ของผู้ใช้ทั่วไป (คนละกลไก คนละพื้นผิว)
//
// ⚠️ Detection Engine ไม่ถือ credential ต่อ Postgres โดยตรง — ยิงผ่าน endpoint นี้
//    เท่านั้น แล้วให้ backend ของ Monitor เป็นคนเขียนฐานข้อมูล ถ้า Laptop (VLAN 20)
//    ถูกยึด ก็ยังแตะฐานข้อมูลตรง ๆ ไม่ได้ (ลดพื้นผิวโจมตี — trust boundary เดียวกับ
//    ทุกโมดูลในโปรเจกต์: มีแต่ backend ของแอปเองที่แตะฐานของแอปตัวเอง)
//
// หลักการเดียวกับด่าน auth อื่นทุกจุดในโปรเจกต์นี้ — ไม่มี "trust by default":
//   1. Fail-secure: ถ้าไม่ตั้งค่า DETECTION_ENGINE_API_KEY ฝั่งเซิร์ฟเวอร์ →
//      endpoint กลุ่ม /internal ถูกปิดตายทั้งหมด (503) ไม่ใช่ "เปิดให้ผ่านชั่วคราว"
//   2. เทียบแบบ timing-safe (crypto.timingSafeEqual) — เวลาตอบกลับไม่บอกใบ้ว่าเดา
//      key ถูกกี่ตัว/ยาวเท่าไร
//   3. key หาย/ผิด → 401 เสมอ พร้อมข้อความ generic (ไม่บอกว่าพลาดตรงไหน)
import { timingSafeEqual } from 'node:crypto'

const HEADER = 'x-detection-engine-key'

// เทียบสองสตริงแบบ constant-time — คืน false ถ้าความยาวไม่เท่ากัน (timingSafeEqual
// ต้องบัฟเฟอร์ยาวเท่ากัน) โดยไม่ลัดวงจรตามเนื้อหา
function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function requireDetectionEngineKey(req, res, next) {
  const expected = process.env.DETECTION_ENGINE_API_KEY
  // Fail-secure: ไม่มี key ฝั่งเซิร์ฟเวอร์ = ปิดตาย (ปฏิเสธทุกคำขอ) ไม่ใช่เปิดผ่าน
  if (!expected) {
    return res.status(503).json({ error: 'Detection ingest disabled' })
  }
  const provided = req.get(HEADER)
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
