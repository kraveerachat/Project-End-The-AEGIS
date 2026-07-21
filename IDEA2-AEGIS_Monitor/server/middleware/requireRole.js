// server/middleware/requireRole.js — AEGIS Monitor (IDEA2)
// Authorization ต่อ endpoint — การกรองเมนูฝั่ง UI เป็นแค่ความสะดวก ไม่ใช่ control
// ทุก endpoint ตรวจ role เอง "ทุกครั้ง" และสำหรับ CCTV-Operator ต้องกรองข้อมูล
// ผ่าน camera_assignment ฝั่งเซิร์ฟเวอร์เสมอ — ห้ามเชื่อ filter จาก client
import { currentUser } from '../auth/session.js'
import { isValidRole } from '../rbac/permissions.js'

// ── Force Password Reset gate ───────────────────────────────────────────
// บัญชีที่ถูก CLI ตั้งรหัสผ่านชั่วคราวให้ (must_reset_password = TRUE) ผ่านได้แค่เส้นทาง
// เล็ก ๆ กลุ่มนี้ จนกว่าจะรีเซ็ตสำเร็จ — endpoint อื่นทุกตัวโดน 403 PASSWORD_RESET_REQUIRED
const RESET_EXEMPT_PATHS = new Set(['/password/reset', '/logout', '/me'])

function blockedByPasswordReset(req, user) {
  return user.mustResetPassword && !RESET_EXEMPT_PATHS.has(req.path)
}

export function requireAuth(req, res, next) {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  if (blockedByPasswordReset(req, user)) {
    return res.status(403).json({ error: 'PASSWORD_RESET_REQUIRED' })
  }
  req.user = user
  next()
}

export function requireRole(...roles) {
  const allowed = new Set(roles.filter(isValidRole))
  return (req, res, next) => {
    const user = currentUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (blockedByPasswordReset(req, user)) {
      return res.status(403).json({ error: 'PASSWORD_RESET_REQUIRED' })
    }
    if (!allowed.has(user.role)) {
      // ข้อความ generic เสมอ — ไม่บอกว่า resource นี้มีอยู่สำหรับ role อื่น
      return res.status(403).json({ error: 'Forbidden' })
    }
    req.user = user
    next()
  }
}
