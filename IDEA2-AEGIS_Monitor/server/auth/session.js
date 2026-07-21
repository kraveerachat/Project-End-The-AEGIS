// server/auth/session.js — AEGIS Monitor (IDEA2)
// เซสชันถูกเก็บฝั่งเซิร์ฟเวอร์ทั้งหมด — cookie เป็นแค่ session id ทึบ (opaque) + HttpOnly
// ⚠️ role ไม่เคยอยู่ใน cookie — อยู่ใน session store ฝั่งเซิร์ฟเวอร์เท่านั้น
// ⚠️ ชื่อ cookie เป็นของ Monitor โดยเฉพาะ ("aegis.monitor.sid") — Drive มีของตัวเอง
//    สองแอปไม่มีวันอ่าน session ข้ามกัน และไม่มีแอปใดยอมรับ cookie ของ HUB (SSO ถูกถอนทิ้ง)
import session from 'express-session'
import { randomBytes } from 'node:crypto'

export const SESSION_COOKIE = 'aegis.monitor.sid'

const IDLE_MS = 30 * 60 * 1000            // idle timeout (rolling)
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000
const ABSOLUTE_MS = 12 * 60 * 60 * 1000   // absolute timeout — เกิน 12 ชม. ต้อง login ใหม่เสมอ

export function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    // ⚠️ ห้ามรัน production โดยไม่มี SESSION_SECRET
    //    (โค้ดเดิมมี default string ฝังไว้ — ถูกถอนออก: default secret = ปลอม cookie ได้)
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET is required in production')
    }
    console.warn('[aegis-monitor] SESSION_SECRET not set — using an ephemeral dev secret')
  }
  return session({
    name: SESSION_COOKIE,
    secret: secret || randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false, // ไม่ตั้ง cookie จนกว่าจะล็อกอินสำเร็จ
    rolling: true,
    cookie: {
      httpOnly: true,                                // JS ฝั่ง client อ่านไม่ได้
      sameSite: 'strict',                            // cookie ไม่ถูกส่งจาก cross-site เลย
      // secure ผูกกับ NODE_ENV โดยปริยาย แต่ override เป็น false ได้ด้วย COOKIE_SECURE=false
      // (ใช้เฉพาะ localhost test stack ที่ gateway เป็น HTTP ล้วน — ห้ามตั้งใน deployment จริง)
      secure: process.env.COOKIE_SECURE === 'false' ? false : process.env.NODE_ENV === 'production',
      maxAge: IDLE_MS,
    },
  })
  // MemoryStore = instance เดียว (เดโม่/Beelink) — หลายเครื่องต้องใช้ store ร่วม
}

/**
 * สร้างเซสชันใหม่หลัง login สำเร็จ
 * ⚠️ regenerate ก่อนเสมอ — กัน session fixation
 */
export function establishSession(req, user, remember) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err)
      // mustResetPassword เก็บในเซสชันด้วย เพื่อให้ requireAuth/requireRole เช็คได้ทุก request
      // โดยไม่ต้องยิง DB ซ้ำ — ต้องอัปเดตคู่กับ DB เสมอเมื่อรีเซ็ตสำเร็จ (ดู markPasswordReset)
      req.session.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        mustResetPassword: Boolean(user.mustResetPassword),
      }
      req.session.createdAt = Date.now()
      // CSRF token (synchronizer pattern) — เก็บใน session, ส่งให้ client ทาง JSON เท่านั้น
      req.session.csrfToken = randomBytes(32).toString('hex')
      req.session.cookie.maxAge = remember ? REMEMBER_MS : IDLE_MS
      req.session.save((err2) => (err2 ? reject(err2) : resolve()))
    })
  })
}

/** user ปัจจุบัน — บังคับ absolute timeout ที่นี่ */
export function currentUser(req) {
  const s = req.session
  if (!s?.user) return null
  if (!s.createdAt || Date.now() - s.createdAt > ABSOLUTE_MS) {
    s.destroy(() => {})
    return null
  }
  return s.user
}

export function currentCsrfToken(req) {
  return req.session?.csrfToken ?? null
}

/** เคลียร์ mustResetPassword ในเซสชันปัจจุบันหลังรีเซ็ตรหัสผ่านสำเร็จ (DB ถูกอัปเดตแล้วโดยผู้เรียก) */
export function markPasswordReset(req) {
  if (req.session?.user) req.session.user.mustResetPassword = false
}

export function destroySession(req, res) {
  return new Promise((resolve) => {
    if (!req.session) {
      res.clearCookie(SESSION_COOKIE)
      return resolve()
    }
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE)
      resolve()
    })
  })
}
