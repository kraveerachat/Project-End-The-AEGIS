// server/middleware/requireIdea3IntegrationKey.js — AEGIS Monitor (IDEA2)
// ── ด่านตรวจ service-to-service สำหรับ IDEA3 (AEGIS Lockdown) ──────────────────
// เหตุผลใกล้เคียง requireDetectionEngineKey.js: IDEA3 อ่านสถานะความปลอดภัยแบบ
// read-only ไม่ใช่ SOC session ในเบราว์เซอร์ — แต่ต่างตรงรูปแบบ header: ต้องเป็น
// `Authorization: Bearer <token>` เพราะ IDEA3 (fetchJsonDocument / httpJsonClient.js)
// เป็นฝั่งที่กำหนดสัญญานี้ตายตัวและ IDEA2 ต้องไม่บังคับให้ IDEA3 เปลี่ยน — ไม่ผ่าน
// cookie/CSRF และไม่ผูก identity กับผู้ใช้ Monitor คนใด
//
// ⚠️ Source-specific credential (K3 review fix): IDEA3's config.js already keys
// this per-source (config.adapters.idea1Token ← AEGIS_IDEA1_INTEGRATION_TOKEN,
// idea2Token ← AEGIS_IDEA2_INTEGRATION_TOKEN — see web/server/config.js). A
// single shared token here would let one leaked credential authenticate to
// BOTH IDEA1 and IDEA2, which breaks that existing per-source contract. This
// middleware therefore reads only AEGIS_IDEA2_INTEGRATION_TOKEN; it must never
// accept the IDEA1 token or any shared/generic token name.
//
//   1. Fail-secure: ไม่ตั้งค่า AEGIS_IDEA2_INTEGRATION_TOKEN → ปิดตาย (503)
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
  const expected = process.env.AEGIS_IDEA2_INTEGRATION_TOKEN
  if (!expected) {
    return res.status(503).json({ error: 'Integration feed disabled' })
  }
  const provided = bearerToken(req)
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
