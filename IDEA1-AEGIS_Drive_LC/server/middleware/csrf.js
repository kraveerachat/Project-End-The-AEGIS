// server/middleware/csrf.js — AEGIS Drive (IDEA1)
// CSRF protection แบบ synchronizer token pattern (ไม่ใช่ double-submit cookie โดยเจตนา):
// token ถูกสร้างตอน login, เก็บใน session "ฝั่งเซิร์ฟเวอร์", ส่งให้ client ทาง JSON
// client เก็บใน React state (memory) แล้วแนบกลับมาใน header X-CSRF-Token
// → ไม่มี cookie ที่ JS ต้องอ่าน จึงไม่แตะ document.cookie เลย (ตามข้อบังคับ zero browser storage)
//
// ชั้นป้องกันซ้อนกันสามชั้น:
//   1) SameSite=Strict — เบราว์เซอร์ไม่ส่ง session cookie จาก cross-site request เลย
//   2) Origin check — request เปลี่ยนสถานะต้องมาจาก origin ของเราเอง
//   3) Synchronizer token — token ใน header ต้องตรงกับใน session
import { currentCsrfToken } from '../auth/session.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// เส้นทางที่ "ยังไม่มีเซสชัน" จึงยังไม่มี token — พึ่งชั้น 1+2 และเนื้อ request เป็น JSON
// (form ธรรมดาส่ง JSON ไม่ได้ → form-based CSRF ใช้ไม่ได้กับ endpoint นี้)
const PRE_SESSION_PATHS = new Set(['/login'])

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next()

  // ชั้นที่ 2 — Origin ต้องเป็นของเราเอง (ถ้าเบราว์เซอร์แนบมา)
  const origin = req.headers.origin
  if (origin) {
    let host = null
    try {
      host = new URL(origin).host
    } catch {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (host !== req.headers.host) {
      // ไม่บอกรายละเอียดว่าผิดตรงไหน — error ฝั่ง client ต้อง generic เสมอ
      return res.status(403).json({ error: 'Forbidden' })
    }
  }

  if (PRE_SESSION_PATHS.has(req.path)) return next()

  // ชั้นที่ 3 — token ใน header ต้องตรงกับใน session (ฝั่งเซิร์ฟเวอร์)
  const sessionToken = currentCsrfToken(req)
  const headerToken = req.headers['x-csrf-token']
  if (!sessionToken || !headerToken || headerToken !== sessionToken) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}
