// server/middleware/csrf.js — AEGIS Monitor (IDEA2)
// CSRF protection แบบ synchronizer token pattern — token อยู่ใน session ฝั่งเซิร์ฟเวอร์
// ส่งให้ client ทาง JSON; client เก็บใน React state (memory) แล้วแนบกลับใน X-CSRF-Token
// → ไม่มี cookie ที่ JS ต้องอ่าน จึงไม่แตะ document.cookie เลย (zero browser storage)
//
// สามชั้น: SameSite=Strict → Origin check → Synchronizer token
import { currentCsrfToken } from '../auth/session.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const PRE_SESSION_PATHS = new Set(['/login'])

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next()

  const origin = req.headers.origin
  if (origin) {
    let host = null
    try {
      host = new URL(origin).host
    } catch {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (host !== req.headers.host) {
      return res.status(403).json({ error: 'Forbidden' })
    }
  }

  if (PRE_SESSION_PATHS.has(req.path)) return next()

  const sessionToken = currentCsrfToken(req)
  const headerToken = req.headers['x-csrf-token']
  if (!sessionToken || !headerToken || headerToken !== sessionToken) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}
