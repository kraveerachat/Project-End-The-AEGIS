// server/auth/session.js — AEGIS Drive (IDEA1)
// เซสชันถูกเก็บฝั่งเซิร์ฟเวอร์ทั้งหมด — cookie เป็นแค่ session id ทึบ (opaque) + HttpOnly
// ⚠️ role ไม่เคยอยู่ใน cookie — อยู่ใน session store ฝั่งเซิร์ฟเวอร์เท่านั้น
//    client อ่าน/แก้ role ไม่ได้ ต่อให้เกิด XSS ก็ขโมย session ไม่ได้ (HttpOnly)
// ⚠️ ชื่อ cookie เป็นของ Drive โดยเฉพาะ — IDEA2 มี cookie ของตัวเอง ("aegis.monitor.sid")
//    สองแอปไม่มีวันอ่าน session ข้ามกัน (Identity Decoupling)
import session from 'express-session'
import { randomBytes } from 'node:crypto'

export const SESSION_COOKIE = 'aegis.drive.sid'

const IDLE_MS = 30 * 60 * 1000            // idle timeout — cookie ต่ออายุเมื่อยัง active (rolling)
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000
const ABSOLUTE_MS = 12 * 60 * 60 * 1000   // absolute timeout — เกิน 12 ชม. ต้อง login ใหม่เสมอ

export function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    // ⚠️ ห้ามรัน production โดยไม่มี SESSION_SECRET — secret สุ่มใหม่ทุก restart
    //    ทำให้เซสชันหลุดหมดและปลอม cookie ได้ง่ายขึ้น
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET is required in production')
    }
    console.warn('[aegis-drive] SESSION_SECRET not set — using an ephemeral dev secret')
  }
  return session({
    name: SESSION_COOKIE,
    secret: secret || randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false, // ไม่ตั้ง cookie จนกว่าจะล็อกอินสำเร็จ
    rolling: true,            // ต่ออายุ idle timeout ทุก request ที่ยัง active
    cookie: {
      httpOnly: true,                                // JS ฝั่ง client อ่านไม่ได้
      sameSite: 'strict',                            // cookie ไม่ถูกส่งจาก cross-site เลย → กัน CSRF ชั้นแรก
      // secure ผูกกับ NODE_ENV โดยปริยาย แต่ override เป็น false ได้ด้วย COOKIE_SECURE=false
      // (ใช้เฉพาะ localhost test stack ที่ gateway เป็น HTTP ล้วน — ห้ามตั้งใน deployment จริง)
      secure: process.env.COOKIE_SECURE === 'false' ? false : process.env.NODE_ENV === 'production',
      maxAge: IDLE_MS,
    },
  })
  // หมายเหตุ: MemoryStore เหมาะกับ instance เดียว (เดโม่/Beelink) — หลายเครื่อง
  // ต้องใช้ store ร่วม (เช่น Redis หรือ connect-pg-simple) ไม่งั้น session ไม่ sync กัน
}

/**
 * สร้างเซสชันใหม่หลัง login สำเร็จ
 * ⚠️ regenerate ก่อนเสมอ — กัน session fixation (id ก่อน login ต้องใช้ต่อไม่ได้)
 * พร้อมออก CSRF token ผูกกับเซสชัน (synchronizer token pattern)
 */
export function establishSession(req, user, remember) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err)
      // role อยู่ตรงนี้ — ฝั่งเซิร์ฟเวอร์ ไม่ใช่ใน cookie
      // mustResetPassword เก็บในเซสชันด้วย เพื่อให้ requireAuth/requireRole เช็คได้ทุก request
      // โดยไม่ต้องยิง DB ซ้ำ — ต้องอัปเดตคู่กับ DB เสมอเมื่อรีเซ็ตสำเร็จ (ดู markPasswordReset ด้านล่าง)
      req.session.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        mustResetPassword: Boolean(user.mustResetPassword),
      }
      req.session.createdAt = Date.now() // ฐานของ absolute timeout
      // CSRF token เก็บใน session (ฝั่งเซิร์ฟเวอร์) และส่งให้ client ทาง JSON เท่านั้น
      // client เก็บใน memory (React state) — ไม่มี cookie ที่ JS ต้องอ่าน จึงไม่แตะ document.cookie
      req.session.csrfToken = randomBytes(32).toString('hex')
      req.session.cookie.maxAge = remember ? REMEMBER_MS : IDLE_MS
      req.session.save((err2) => (err2 ? reject(err2) : resolve()))
    })
  })
}

/**
 * user ปัจจุบัน (null ถ้ายังไม่ล็อกอิน) — บังคับ absolute timeout ที่นี่:
 * เซสชันที่อายุเกินเพดานถูกทำลายทันที แม้ผู้ใช้ยัง active (กัน session ค้างยาว)
 */
export function currentUser(req) {
  const s = req.session
  if (!s?.user) return null
  if (!s.createdAt || Date.now() - s.createdAt > ABSOLUTE_MS) {
    s.destroy(() => {})
    return null
  }
  return s.user
}

/** CSRF token ของเซสชันปัจจุบัน (null ถ้าไม่มีเซสชัน) */
export function currentCsrfToken(req) {
  return req.session?.csrfToken ?? null
}

/**
 * เคลียร์ mustResetPassword ในเซสชันปัจจุบันหลังรีเซ็ตรหัสผ่านสำเร็จ (DB ถูกอัปเดตแล้วโดยผู้เรียก)
 * ⚠️ ต้องเรียกคู่กับ updatePasswordHash เสมอ — ไม่งั้น session เก่ายังติด flag ค้าง
 *    ทั้งที่ DB สะอาดแล้ว ผู้ใช้จะโดนบล็อกทุก endpoint ต่อไปทั้งที่เพิ่งเปลี่ยนรหัสสำเร็จ
 */
export function markPasswordReset(req) {
  if (req.session?.user) req.session.user.mustResetPassword = false
}

/** ทำลายเซสชันฝั่งเซิร์ฟเวอร์ + ล้าง cookie ฝั่ง client */
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
