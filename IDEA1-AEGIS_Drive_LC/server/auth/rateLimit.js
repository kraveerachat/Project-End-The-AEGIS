// server/auth/rateLimit.js — AEGIS Drive (IDEA1)
// ล็อกหลังพยายามผิด 5 ครั้ง — บังคับ "ฝั่งเซิร์ฟเวอร์" (client-side lock ถูก bypass ได้ทันที)
// นับสองแกนแยกกัน:
//   1) ต่อบัญชี (per-account)  — กัน brute-force รายบัญชีจากหลาย IP
//   2) ต่อ IP ต้นทาง (per-IP)  — กันเครื่องเดียวไล่ทั้งรายชื่อบัญชี (credential stuffing)
// Lockout ใช้ exponential backoff: ครั้งแรก 1 นาที แล้ว 2, 4, 8 ... สูงสุด 1 ชั่วโมง
// ⚠️ เก็บใน memory — instance เดียวพอสำหรับเดโม่; หลายเครื่องต้องใช้ store ร่วม (Redis)
import { requestSourceIp } from '../request/sourceIp.js'

const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000
const BASE_LOCK_MS = 60 * 1000
const MAX_LOCK_MS = 60 * 60 * 1000

/** @type {Map<string, { count: number, first: number, lockedUntil: number, episodes: number }>} */
const byAccount = new Map()
/** @type {Map<string, { count: number, first: number, lockedUntil: number, episodes: number }>} */
const byIp = new Map()

const norm = (username) => String(username ?? '').trim().toLowerCase()

// ⚠️ scope แยกตัวนับของ "คนละเรื่อง" ออกจากกัน — ไม่ใช่ความสวยงาม แต่กัน DoS ที่เรา
//    ยิงตัวเอง: เดิมด่านนี้มีตัวนับ IP ชุดเดียว ถ้าเส้นทางอื่นเอาไปใช้ด้วย (เช่นการเดา
//    รหัสของลิงก์แชร์) การเดาผิดครบโควตาจะล็อก "หน้าล็อกอิน" ของ IP นั้นไปด้วย
//    ในออฟฟิศที่ทุกเครื่องออกเน็ตผ่าน NAT เดียวกัน = คนหนึ่งกรอกรหัสลิงก์ผิดห้าครั้ง
//    แล้วทั้งบริษัทล็อกอินไม่ได้ (พบจากเทสต์ brute-force ของลิงก์แชร์ ไม่ใช่จากทฤษฎี)
//    ทั้งสองแกนถูก namespace ด้วย scope: การกันเดารหัสของลิงก์ยังทำงานเต็มที่
//    แต่ไปโดนแค่ตัวมันเอง
const ipOf = (req, scope) => `${scope}|${requestSourceIp(req)}`
const accountOf = (username, scope) => `${scope}|${norm(username)}`

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
export function checkLock(req, username, scope = 'login') {
  const a = check(byAccount, accountOf(username, scope))
  const b = check(byIp, ipOf(req, scope))
  const retryAfterMs = Math.max(a, b)
  return { locked: retryAfterMs > 0, retryAfterMs }
}

/**
 * เรียกเมื่อรหัสผิด — เพิ่มตัวนับทั้งสองแกน
 * คืนรายละเอียด lockout (ถ้าเพิ่งเกิด) เพื่อให้ route เอาไปเขียน audit log
 * @returns {{ accountLockMs: number|null, ipLockMs: number|null }}
 */
export function recordFailure(req, username, scope = 'login') {
  return {
    accountLockMs: bump(byAccount, accountOf(username, scope)),
    ipLockMs: bump(byIp, ipOf(req, scope)),
  }
}

/** เรียกเมื่อสำเร็จ — ล้างตัวนับของบัญชีนั้น (แกน IP ปล่อยให้หมดอายุตาม window) */
export function recordSuccess(req, username, scope = 'login') {
  byAccount.delete(accountOf(username, scope))
}

export const rateLimitConfig = Object.freeze({ MAX_ATTEMPTS, WINDOW_MS, BASE_LOCK_MS, MAX_LOCK_MS })
