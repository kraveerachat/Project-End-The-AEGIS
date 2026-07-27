// server/middleware/requireRole.js — AEGIS Drive (IDEA1)
// Authorization ต่อ endpoint — การกรองเมนูฝั่ง UI เป็นแค่ความสะดวก ไม่ใช่ control
// ทุก endpoint ต้องตรวจ role ของผู้เรียกเอง "ทุกครั้ง" — ห้ามเชื่อ filter จาก client
import { currentUser, touchSession } from '../auth/session.js'
import { isValidRole } from '../rbac/permissions.js'

// ── Force Password Reset gate ───────────────────────────────────────────
// บัญชีที่ยังใช้รหัสผ่านชั่วคราว (must_reset_password = TRUE) ต้องผ่านได้แค่เส้นทาง
// เล็ก ๆ กลุ่มนี้เท่านั้น จนกว่าจะรีเซ็ตสำเร็จ — endpoint อื่นทุกตัวถูกบล็อกด้วย 403
// รหัส PASSWORD_RESET_REQUIRED ที่ client ใช้แยกแยะจาก Forbidden ทั่วไปเพื่อพาไปหน้ารีเซ็ต
// ⚠️ ต้อง exempt เฉพาะเท่าที่จำเป็นจริง ๆ — ยิ่ง exempt น้อย ยิ่งบังคับ flow ได้แน่นขึ้น
const RESET_EXEMPT_PATHS = new Set(['/password/reset', '/logout', '/me'])

function blockedByPasswordReset(req, user) {
  return user.mustResetPassword && !RESET_EXEMPT_PATHS.has(req.path)
}

/** ต้องล็อกอินแล้วเท่านั้น — แนบ req.user ให้ handler ถัดไป */
export function requireAuth(req, res, next) {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  if (blockedByPasswordReset(req, user)) {
    return res.status(403).json({ error: 'PASSWORD_RESET_REQUIRED' })
  }
  // ประทับเวลาการใช้งานล่าสุดของเซสชันนี้ — จอ Active sessions แสดงค่าจริงจากที่นี่
  // (rolling: true ทำให้ express-session save/touch ให้เองอยู่แล้วทุก request)
  touchSession(req)
  req.user = user
  next()
}

/**
 * ต้องมี role ตามที่ระบุเท่านั้น — default-deny:
 * ไม่ล็อกอิน → 401, ล็อกอินแต่ role ไม่อยู่ในลิสต์ → 403 (ข้อความ generic เสมอ)
 * ติดรหัสผ่านชั่วคราวค้าง → 403 PASSWORD_RESET_REQUIRED (เช็คก่อน role เสมอ — ยังไม่รีเซ็ต
 * ก็ยังไม่ควรได้ทำอะไรที่ต้องใช้สิทธิ์สูง แม้จะเป็น Admin ที่ถูก Day-0 bootstrap มาก็ตาม)
 * @param {...string} roles
 */
export function requireRole(...roles) {
  const allowed = new Set(roles.filter(isValidRole))
  return (req, res, next) => {
    const user = currentUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (blockedByPasswordReset(req, user)) {
      return res.status(403).json({ error: 'PASSWORD_RESET_REQUIRED' })
    }
    if (!allowed.has(user.role)) {
      // ไม่บอกว่า endpoint นี้ "มีอยู่สำหรับ role อื่น" — คืนข้อความเดียวกันเสมอ
      return res.status(403).json({ error: 'Forbidden' })
    }
    touchSession(req)
    req.user = user
    next()
  }
}
