// server/auth/session.js — AEGIS Drive (IDEA1)
// เซสชันถูกเก็บฝั่งเซิร์ฟเวอร์ทั้งหมด — cookie เป็นแค่ session id ทึบ (opaque) + HttpOnly
// ⚠️ role ไม่เคยอยู่ใน cookie — อยู่ใน session store ฝั่งเซิร์ฟเวอร์เท่านั้น
//    client อ่าน/แก้ role ไม่ได้ ต่อให้เกิด XSS ก็ขโมย session ไม่ได้ (HttpOnly)
// ⚠️ ชื่อ cookie เป็นของ Drive โดยเฉพาะ — IDEA2 มี cookie ของตัวเอง ("aegis.monitor.sid")
//    สองแอปไม่มีวันอ่าน session ข้ามกัน (Identity Decoupling)
import session from 'express-session'
import { createHash, randomBytes } from 'node:crypto'

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
        // displayName ในเซสชันคือ "ชื่อที่ใช้แสดงผล" (profile_name ถ้าตั้งไว้) — ผู้ใช้
        // เปลี่ยนได้กลางเซสชัน จึงต้องอัปเดตที่นี่ด้วยทุกครั้ง (ดู setSessionDisplayName)
        displayName: user.displayName,
        // ชื่อที่ Admin ตั้งไว้ — เก็บแยกเพื่อให้จอ Settings แสดงได้ว่า "ชื่อบัญชี" คืออะไร
        // แม้ผู้ใช้จะตั้งชื่อโปรไฟล์ของตัวเองทับไปแล้ว
        accountName: user.accountName ?? user.displayName,
        role: user.role,
        mustResetPassword: Boolean(user.mustResetPassword),
      }
      // ── ข้อมูลของ "เซสชันนี้" สำหรับจอ Settings → Active sessions ──────────────
      // ⚠️ ค่าจริงทั้งหมด: ip จาก connection, device จาก User-Agent ที่เบราว์เซอร์ส่งมา
      //    ไม่มีการเดา/แต่งค่า และ userAgent ถูกตัดความยาวก่อนเก็บ (header นี้ผู้ใช้
      //    ควบคุมได้ — ปล่อยยาวไม่จำกัดคือปล่อยให้เขียนขยะเข้า session store ของเรา)
      req.session.meta = {
        ip: req.ip ?? null,
        userAgent: String(req.get('user-agent') ?? '').slice(0, 200) || null,
        loginAt: Date.now(),
        lastSeenAt: Date.now(),
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

/** อัปเดตชื่อแสดงผลในเซสชันปัจจุบันหลังผู้ใช้แก้ชื่อโปรไฟล์ (DB ถูกอัปเดตแล้วโดยผู้เรียก) */
export function setSessionDisplayName(req, displayName) {
  if (req.session?.user) req.session.user.displayName = displayName
}

/** ประทับเวลาที่เซสชันนี้ถูกใช้ครั้งล่าสุด — จอ Active sessions อ่านค่านี้ */
export function touchSession(req) {
  if (req.session?.meta) req.session.meta.lastSeenAt = Date.now()
}

/**
 * เซสชันที่ยัง active ของ "ผู้ใช้คนนี้เท่านั้น" อ่านจาก session store จริง
 *
 * ⚠️ กรองด้วย user.id ที่มาจากเซสชันของผู้เรียกเสมอ — store.all() คืนเซสชันของ
 *    "ทุกคน" การลืมกรองคือการเปิดให้ผู้ใช้คนหนึ่งเห็น IP/อุปกรณ์ของทุกคนในระบบ
 * ⚠️ ไม่คืน session id ดิบ: id คือ credential — ใครถือก็ปลอมเป็นเจ้าของเซสชันได้
 *    จึงคืน sha256 ตัดสั้นเป็น "ตัวอ้างอิง" ให้ endpoint เพิกถอนใช้เทียบแทน
 * ⚠️ MemoryStore (ค่าเริ่มต้นของ express-session) = รายการนี้หายทั้งหมดเมื่อ restart
 *    และเป็นของ process เดียว ถ้าวันหนึ่งสเกลเป็นหลาย instance ต้องเปลี่ยนไปใช้ store
 *    ร่วม (connect-pg-simple) ไม่งั้นจอนี้จะแสดง "เฉพาะเซสชันที่บังเอิญตกมาที่ instance นี้"
 *    ซึ่งแย่กว่าไม่แสดงเลย เพราะดูเหมือนครบ
 * @returns {Promise<Array<{ ref: string, ip: string|null, userAgent: string|null,
 *                           loginAt: number|null, lastSeenAt: number|null, current: boolean }>>}
 */
export function listSessionsForUser(req) {
  const store = req.sessionStore
  const userId = req.session?.user?.id
  if (!store?.all || userId == null) return Promise.resolve([])

  return new Promise((resolve) => {
    store.all((err, sessions) => {
      if (err || !sessions) return resolve([])
      // store.all() คืน object (map sid → session) หรือ array ขึ้นกับ store — รองรับทั้งคู่
      const entries = Array.isArray(sessions)
        ? sessions.map((s) => [s.id ?? null, s])
        : Object.entries(sessions)

      const rows = []
      for (const [sid, s] of entries) {
        const data = typeof s === 'string' ? safeParse(s) : s
        if (!data?.user || String(data.user.id) !== String(userId)) continue
        rows.push({
          ref: sid ? sessionRef(sid) : null,
          ip: data.meta?.ip ?? null,
          userAgent: data.meta?.userAgent ?? null,
          loginAt: data.meta?.loginAt ?? null,
          lastSeenAt: data.meta?.lastSeenAt ?? null,
          current: sid != null && sid === req.sessionID,
        })
      }
      rows.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
      resolve(rows)
    })
  })
}

/**
 * นับเซสชันต่อ user จาก store ของ Express อินสแตนซ์นี้จริง ๆ สำหรับจอ Admin
 *
 * ⚠️ คืนเฉพาะจำนวน ไม่คืน IP/user-agent/session ref ของคนอื่น เพื่อลดการเปิดเผยข้อมูล
 * ⚠️ null หมายถึง store นี้ไม่มี all() หรืออ่านล้มเหลว — ห้ามแทนด้วย 0 เพราะ 0 จะเป็น
 *    คำกล่าวอ้างว่าไม่มีเซสชัน ทั้งที่ความจริงคืออินสแตนซ์นี้นับไม่ได้
 * ⚠️ MemoryStore มีขอบเขตแค่ process ปัจจุบันและหายเมื่อ restart; API/UI ต้องระบุ
 *    "อินสแตนซ์นี้" ไม่เรียกตัวเลขนี้ว่าเซสชันทั่วทั้งระบบ
 * @returns {Promise<Map<string, number>|null>}
 */
export function countSessionsByUser(req) {
  const store = req.sessionStore
  if (!store?.all) return Promise.resolve(null)

  return new Promise((resolve) => {
    store.all((err, sessions) => {
      if (err || !sessions) return resolve(null)
      const entries = Array.isArray(sessions) ? sessions : Object.values(sessions)
      const counts = new Map()
      const now = Date.now()
      for (const raw of entries) {
        const data = typeof raw === 'string' ? safeParse(raw) : raw
        const userId = data?.user?.id
        if (userId == null) continue
        const expiresAt = data.cookie?.expires ? new Date(data.cookie.expires).getTime() : null
        if (Number.isFinite(expiresAt) && expiresAt <= now) continue
        const key = String(userId)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      resolve(counts)
    })
  })
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

/** ตัวอ้างอิงเซสชันที่ปลอดภัยจะส่งออกไป — ไม่สามารถย้อนกลับเป็น session id ได้ */
export const sessionRef = (sid) =>
  createHash('sha256').update(String(sid)).digest('hex').slice(0, 16)

/**
 * เพิกถอนเซสชันของ "ผู้ใช้คนนี้" ตัวหนึ่งด้วย ref
 * ⚠️ ต้องยืนยันว่าเซสชันเป้าหมายเป็นของผู้เรียกจริงก่อนทำลายทุกครั้ง — ถ้าเทียบแค่ ref
 *    โดยไม่ดู user.id ผู้ใช้คนหนึ่งจะเตะคนอื่นออกจากระบบได้ (DoS ต่อบัญชีอื่น)
 * @returns {Promise<boolean>} false = ไม่พบ หรือไม่ใช่ของผู้เรียก (ไม่แยกสองกรณี)
 */
export function revokeSessionByRef(req, ref) {
  const store = req.sessionStore
  const userId = req.session?.user?.id
  if (!store?.all || !store?.destroy || userId == null || typeof ref !== 'string') {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    store.all((err, sessions) => {
      if (err || !sessions) return resolve(false)
      const entries = Array.isArray(sessions)
        ? sessions.map((s) => [s.id ?? null, s])
        : Object.entries(sessions)

      for (const [sid, s] of entries) {
        if (!sid || sessionRef(sid) !== ref) continue
        const data = typeof s === 'string' ? safeParse(s) : s
        if (!data?.user || String(data.user.id) !== String(userId)) return resolve(false)
        return store.destroy(sid, (destroyErr) => resolve(!destroyErr))
      }
      resolve(false)
    })
  })
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
