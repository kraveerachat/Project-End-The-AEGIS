// server/middleware/requireIdea3IntegrationKey.js — AEGIS Drive (IDEA1)
// ── ด่านตรวจ service-to-service สำหรับ IDEA3 (AEGIS Lockdown) ──────────────────
// IDEA3 อ่านสถานะความปลอดภัยแบบ read-only ผ่าน endpoint นี้ ไม่ใช่ผู้ใช้ในเบราว์เซอร์
// จึงยืนยันตัวตนด้วย "credential เฉพาะทางที่แชร์กันล่วงหน้า" — ⚠️ ต้องเป็น header
// `Authorization: Bearer <token>` เท่านั้น เพราะ IDEA3 (fetchJsonDocument /
// httpJsonClient.js) เป็นฝั่งที่กำหนดสัญญานี้ตายตัวและ IDEA1 ต้องไม่บังคับให้ IDEA3
// เปลี่ยน — ไม่ใช่ cookie + CSRF ของผู้ใช้ทั่วไป ไม่มีการรวม/ผูก identity กับ Admin
// session ของ IDEA1 (คนละพื้นผิว คนละ trust boundary)
//
// หลักการเดียวกับด่าน auth อื่นทุกจุดในโปรเจกต์นี้ — ไม่มี "trust by default":
//   1. Fail-secure: ถ้าไม่ตั้งค่า AEGIS_IDEA3_INTEGRATION_TOKEN ฝั่งเซิร์ฟเวอร์ →
//      endpoint นี้ถูกปิดตายทั้งหมด (503) ไม่ใช่ "เปิดให้ผ่านชั่วคราว"
//   2. เทียบแบบ timing-safe (crypto.timingSafeEqual)
//   3. key หาย/ผิด → 401 เสมอ พร้อมข้อความ generic
import { timingSafeEqual } from 'node:crypto'

const BEARER_PREFIX = 'Bearer '

function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearerToken(req) {
  const header = req.get('authorization')
  if (!header || !header.startsWith(BEARER_PREFIX)) return null
  return header.slice(BEARER_PREFIX.length)
}

export function requireIdea3IntegrationKey(req, res, next) {
  const expected = process.env.AEGIS_IDEA3_INTEGRATION_TOKEN
  if (!expected) {
    return res.status(503).json({ error: 'Integration feed disabled' })
  }
  const provided = bearerToken(req)
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
