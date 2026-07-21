// server/auth/rateLimit.js — AEGIS Drive (IDEA1)
// ล็อกหลังพยายามผิด 5 ครั้ง — บังคับ "ฝั่งเซิร์ฟเวอร์" (client-side lock ถูก bypass ได้ทันที)
// นับสองแกนแยกกัน:
//   1) ต่อบัญชี (per-account)  — กัน brute-force รายบัญชีจากหลาย IP
//   2) ต่อ IP ต้นทาง (per-IP)  — กันเครื่องเดียวไล่ทั้งรายชื่อบัญชี (credential stuffing)
// Lockout ใช้ exponential backoff: ครั้งแรก 1 นาที แล้ว 2, 4, 8 ... สูงสุด 1 ชั่วโมง
// ⚠️ เก็บใน memory — instance เดียวพอสำหรับเดโม่; หลายเครื่องต้องใช้ store ร่วม (Redis)
const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000
const BASE_LOCK_MS = 60 * 1000
const MAX_LOCK_MS = 60 * 60 * 1000

/** @type {Map<string, { count: number, first: number, lockedUntil: number, episodes: number }>} */
const byAccount = new Map()
/** @type {Map<string, { count: number, first: number, lockedUntil: number, episodes: number }>} */
const byIp = new Map()

const norm = (username) => String(username ?? '').trim().toLowerCase()
const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown'

function check(map, key) {
  const rec = map.get(key)
  if (!rec) return 0
  const now = Date.now()
  if (rec.lockedUntil > now) return rec.lockedUntil - now
  return 0
}

function bump(map, key) {
  const now = Date.now()
  const rec = map.get(key)
  if (!rec || (now - rec.first > WINDOW_MS && rec.lockedUntil <= now)) {
    map.set(key, { count: 1, first: now, lockedUntil: 0, episodes: rec?.episodes ?? 0 })
    return null
  }
  rec.count += 1
  if (rec.count >= MAX_ATTEMPTS) {
    // exponential backoff: โทษเพิ่มเป็นเท่าตัวทุกครั้งที่โดนล็อกซ้ำ
    rec.episodes += 1
    const lockMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (rec.episodes - 1))
    rec.lockedUntil = now + lockMs
    rec.count = 0
    rec.first = now
    return lockMs
  }
  return null
}

/**
 * เรียก "ก่อน" ตรวจรหัส — ล็อกอยู่ให้ตอบ 429 ทันทีโดยไม่แตะ DB
 * (เช็คทั้งแกนบัญชีและแกน IP — ติดแกนใดแกนหนึ่งก็ล็อก)
 */
export function checkLock(req, username) {
  const a = check(byAccount, norm(username))
  const b = check(byIp, ipOf(req))
  const retryAfterMs = Math.max(a, b)
  return { locked: retryAfterMs > 0, retryAfterMs }
}

/**
 * เรียกเมื่อรหัสผิด — เพิ่มตัวนับทั้งสองแกน
 * คืนรายละเอียด lockout (ถ้าเพิ่งเกิด) เพื่อให้ route เอาไปเขียน audit log
 * @returns {{ accountLockMs: number|null, ipLockMs: number|null }}
 */
export function recordFailure(req, username) {
  return {
    accountLockMs: bump(byAccount, norm(username)),
    ipLockMs: bump(byIp, ipOf(req)),
  }
}

/** เรียกเมื่อล็อกอินสำเร็จ — ล้างตัวนับของบัญชีนั้น (แกน IP ปล่อยให้หมดอายุตาม window) */
export function recordSuccess(req, username) {
  byAccount.delete(norm(username))
}

export const rateLimitConfig = Object.freeze({ MAX_ATTEMPTS, WINDOW_MS, BASE_LOCK_MS, MAX_LOCK_MS })
