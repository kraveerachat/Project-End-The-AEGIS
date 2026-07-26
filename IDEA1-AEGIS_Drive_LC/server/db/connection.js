// server/db/connection.js — AEGIS Drive (IDEA1)
// จุดเชื่อมต่อฐานข้อมูล aegis_drive — "แหล่งความจริง" ของ user + role ของ Drive
// ⚠️ Identity Decoupling: ฐานข้อมูลนี้เป็นของ IDEA1 เท่านั้น — IDEA2 มี DB ของตัวเอง
//    (aegis_monitor) ห้ามใช้ connection string เดียวกัน ห้ามอ่านตารางข้ามโมดูล
// ⚠️ role ถูกเก็บและอ่านที่นี่ฝั่งเซิร์ฟเวอร์เท่านั้น — client ไม่มีทางแตะได้
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { ROLES, isValidRole } from '../rbac/permissions.js'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL

// ── โหมดจริง: PostgreSQL ───────────────────────────────────────────────
// pool ขนาดเล็กโดยเจตนา — Beelink 8GB รันหลาย container + DB ร่วมกัน
// (connection ละ ~5–10MB ฝั่ง postgres; 5 ต่อแอปเหลือเฟือสำหรับ SME edge)
let pool = null
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 })
}

export const usingPostgres = Boolean(pool)

/** query ทั่วไปสำหรับ store.js — เรียกได้เฉพาะเมื่อ usingPostgres === true */
export async function query(text, params) {
  return pool.query(text, params)
}

// ── โหมด dev fallback: in-memory ──────────────────────────────────────
// ใช้เฉพาะตอนไม่ได้ตั้ง DATABASE_URL — security model เหมือนโหมดจริงทุกอย่าง:
// รหัสผ่านถูกแฮชด้วย bcrypt ตอนบูต และ role มาจาก record ฝั่งเซิร์ฟเวอร์เท่านั้น
// ⚠️ ไม่ทน restart — production ต้องใช้ Postgres (docker compose รัน schema+seed ให้)
const DEV_SEED = DATABASE_URL
  ? []
  : [
      { id: 1, username: 'admin', displayName: 'Veerachat J.',   role: ROLES.ADMIN, password: 'aegis-drive-admin' },
      { id: 2, username: 'user',  displayName: 'Kanya Srisuwan', role: ROLES.USER,  password: 'aegis-drive-user' },
    ].map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      passwordHash: bcrypt.hashSync(u.password, 10), // ไม่มี plaintext ค้างในหน่วยความจำ
      mustResetPassword: false, // บัญชีเดโม่ล็อกอินได้ทันที ไม่ผ่าน force-reset
    }))
// ⚠️ mutable โดยเจตนา (ไม่ใช่ Object.freeze) — createUserWithTempPassword/updatePasswordHash
// ต้อง .push()/แก้ record ในนี้ได้ในโหมด dev fallback เพื่อให้ provisioning ทดสอบได้จริง
// โดยไม่ต้องมี Postgres (เหมือนโหมดจริงทุกอย่าง ยกเว้นไม่ทน restart)

/**
 * ค้น user ด้วย username (normalize: trim + lowercase)
 * ⚠️ role มาจาก record ในฐานข้อมูลเท่านั้น — ไม่มีวันมาจาก input ของ client
 * @param {string} username
 */
export async function getUserByUsername(username) {
  const uname = String(username ?? '').trim().toLowerCase()
  if (!uname) return null

  if (pool) {
    // parameterized query เท่านั้น — กัน SQL injection (ห้าม string-concat)
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role, password_hash, must_reset_password
         FROM users
        WHERE lower(username) = $1
        LIMIT 1`,
      [uname],
    )
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      passwordHash: r.password_hash,
      mustResetPassword: r.must_reset_password,
    }
  }

  return DEV_SEED.find((u) => u.username === uname) ?? null
}

/** ค้น user ด้วย id — ใช้โดย endpoint /password/reset (ต้องอ่าน password_hash จริงจาก DB
 *  เพราะ session ไม่เก็บ hash เอาไว้ตั้งแต่ต้น — client จึงไม่มีทางแตะ hash ได้เลย) */
export async function getUserById(id) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role, password_hash, must_reset_password
         FROM users WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (rows.length === 0) return null
    const r = rows[0]
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      passwordHash: r.password_hash,
      mustResetPassword: r.must_reset_password,
    }
  }
  return DEV_SEED.find((u) => u.id === id) ?? null
}

/** สุ่มรหัสผ่านชั่วคราว — เอนโทรปีสูง (~96 บิต) ไม่ต้องจำง่าย เพราะบังคับเปลี่ยนทันทีที่ล็อกอินครั้งแรก
 *  ⚠️ ค่านี้ถูกส่งกลับให้ Admin "ครั้งเดียว" ในผลลัพธ์ของ createUserWithTempPassword — ไม่ถูกเก็บ
 *  ที่ไหนอีกเลย (ไม่ลง log, ไม่ลง audit) — Admin ต้องส่งต่อให้ user นอกช่องทางนี้ (out-of-band)
 */
export function generateTempPassword() {
  return randomBytes(12).toString('base64url') // 16 ตัวอักษร, URL-safe
}

/**
 * Admin provisioning: สร้างบัญชีใหม่พร้อมรหัสผ่านชั่วคราว — บังคับ force-reset เสมอ
 * ⚠️ role ต้องผ่าน isValidRole เท่านั้น (default-deny) — คนเรียกต้องเป็น requireRole(Admin) แล้ว
 * คืนค่า null ถ้า input ไม่ถูกต้อง หรือ username ซ้ำ (unique constraint กันซ้ำที่ DB อีกชั้น)
 */
export async function createUserWithTempPassword({ username, displayName, role }) {
  const uname = String(username ?? '').trim().toLowerCase()
  const name = String(displayName ?? '').trim()
  if (!uname || uname.length > 40 || !name || name.length > 80 || !isValidRole(role)) return null

  const tempPassword = generateTempPassword()
  const passwordHash = bcrypt.hashSync(tempPassword, 12) // cost 12 สำหรับบัญชีที่สร้างใหม่ (สูงกว่า seed เดโม่)

  if (pool) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (username, password_hash, role, display_name, must_reset_password)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, username, display_name, role`,
        [uname, passwordHash, role, name],
      )
      const r = rows[0]
      return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, tempPassword }
    } catch (err) {
      if (err.code === '23505') return null // unique_violation — username ซ้ำ (ไม่ใช่ 500)
      throw err
    }
  }

  if (DEV_SEED.some((u) => u.username === uname)) return null // จำลอง unique constraint ในโหมด dev
  const id = (DEV_SEED.at(-1)?.id ?? 0) + 1
  const row = { id, username: uname, displayName: name, role, passwordHash, mustResetPassword: true }
  DEV_SEED.push(row)
  return { id, username: uname, displayName: name, role, tempPassword }
}

/**
 * รายชื่อบัญชีทั้งหมด — ใช้โดยจอ Access (GET /api/users, requireRole('Admin') ครอบไว้)
 *
 * ⚠️ ก่อนหน้านี้ฟังก์ชันนี้ไม่มีอยู่ และ GET /api/users อ่านอาเรย์เดโม่ที่ hard-code
 *    ไว้ใน store.js แทน โดยไม่มีการเช็ค usingPostgres เลย ผลคือจอที่ Admin ใช้ตอบ
 *    คำถาม "ใครเข้าถึงระบบนี้ได้" แสดงบัญชีสี่คนที่ไม่มีอยู่จริง และ **ไม่แสดง**
 *    บัญชีจริงที่ล็อกอินได้จริง — ความเสี่ยงคือ Admin เห็นภาพการเข้าถึงที่เป็นเท็จ
 *    แล้วตัดสินใจบนภาพนั้น (ไม่ใช่แค่ตัวเลขผิดสวย ๆ)
 *
 * ⚠️ คืน "เฉพาะสิ่งที่มีอยู่จริงในตาราง" เท่านั้น — ตาราง users ของ Drive ไม่มีคอลัมน์
 *    active/suspended และไม่มี session store ที่นับเซสชันต่อบัญชีได้ (express-session
 *    ใช้ MemoryStore) จึงไม่มีฟิลด์ status/sessions ในผลลัพธ์นี้ การเดาค่าให้ครบ
 *    ตามที่ UI เดิมวาดไว้ = สร้าง mock ขึ้นใหม่ในที่ที่เพิ่งถอดมันออก
 *
 * lastLogin มาจาก audit_log จริง (LOGIN/OK ล่าสุดของ actor_id นั้น) — เป็นข้อมูลที่
 * ระบบบันทึกเองอยู่แล้ว ไม่ใช่คอลัมน์ที่ต้องเพิ่มและไม่ใช่ค่าที่แต่งขึ้น
 */
export async function listUsers() {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.must_reset_password, u.created_at,
              (SELECT max(a.at) FROM audit_log a
                WHERE a.actor_id = u.id AND a.action = 'LOGIN' AND a.result = 'OK') AS last_login
         FROM users u
        ORDER BY u.id`,
    )
    return rows.map((r) => ({
      id: String(r.id),
      name: r.display_name,
      username: r.username,
      role: r.role,
      mustResetPassword: r.must_reset_password,
      createdAt: new Date(r.created_at).getTime(),
      lastLogin: r.last_login ? new Date(r.last_login).getTime() : null,
    }))
  }

  // dev fallback — รูปร่างเหมือนกันเป๊ะ อ่านจาก DEV_SEED + memAudit (ไม่ใช่ชุดข้อมูลคนละชุด)
  return DEV_SEED.map((u) => {
    const hit = memAudit.find(
      (e) => e.action === 'LOGIN' && e.result === 'OK' && String(e.actorId) === String(u.id),
    )
    return {
      id: String(u.id),
      name: u.displayName,
      username: u.username,
      role: u.role,
      mustResetPassword: Boolean(u.mustResetPassword),
      createdAt: null, // dev fallback ไม่มี created_at — null คือ "ไม่รู้" ไม่ใช่ 0
      lastLogin: hit ? new Date(hit.at).getTime() : null,
    }
  })
}

/**
 * เปลี่ยนรหัสผ่าน (ใช้โดย /password/reset) — bcrypt hash รหัสใหม่แล้วล้าง must_reset_password
 * ⚠️ ผู้เรียกต้องเป็นเจ้าของบัญชีเท่านั้น (userId มาจาก session, ไม่ใช่จาก body) และต้อง
 *    ยืนยัน currentPassword กับ hash เดิมมาก่อนแล้ว (ดู routes/api.js) — ฟังก์ชันนี้ไม่ตรวจซ้ำ
 */
export async function updatePasswordHash(userId, newPassword) {
  const newHash = bcrypt.hashSync(String(newPassword), 12)
  if (pool) {
    await pool.query(
      `UPDATE users SET password_hash = $1, must_reset_password = FALSE WHERE id = $2`,
      [newHash, userId],
    )
    return true
  }
  const u = DEV_SEED.find((x) => x.id === userId)
  if (!u) return false
  u.passwordHash = newHash
  u.mustResetPassword = false
  return true
}

/** sha256 hex ของข้อความ — ใช้ทำ target_hash ใน audit (ชื่อไฟล์ไม่เคยลง log ตรง ๆ) */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ── Audit — เขียนฝั่งเซิร์ฟเวอร์เท่านั้น ─────────────────────────────────
// dev fallback เก็บในหน่วยความจำ (วนทับที่ 500 แถว) เพื่อให้หน้า Audit เดโม่ได้
const memAudit = []

/**
 * บันทึกเหตุการณ์ลง audit log
 * ⚠️ Privacy-preserving: ผู้เรียกต้องส่ง targetHash (sha256) มา — ห้ามส่งชื่อไฟล์ดิบ
 * @param {{ actorId?: number|null, actorLabel?: string, role?: string,
 *           action: string, targetHash?: string|null, result: 'OK'|'DENIED'|'BLOCKED',
 *           sourceIp?: string }} e
 */
export async function recordAudit(e) {
  const row = {
    at: new Date(),
    actorId: e.actorId ?? null,
    actorLabel: e.actorLabel ?? null,
    role: e.role ?? null,
    action: e.action,
    targetHash: e.targetHash ?? null,
    result: e.result,
    sourceIp: e.sourceIp ?? null,
  }
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO audit_log (actor_id, actor_label, role, action, target_hash, result, source_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.actorId, row.actorLabel, row.role, row.action, row.targetHash, row.result, row.sourceIp],
      )
    } catch (err) {
      // audit ล้มเหลวต้องไม่ทำให้ request หลักล่ม — log ฝั่งเซิร์ฟเวอร์พอ
      console.error('[aegis-drive] audit write failed', err.message)
    }
    return
  }
  memAudit.unshift(row)
  if (memAudit.length > 500) memAudit.pop()
}

/** อ่าน audit ล่าสุด (ใช้โดย endpoint ที่มี requireRole('Admin') ครอบเสมอ) */
export async function readAudit(limit = 100) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT at, actor_label, role, action, target_hash, result, source_ip
         FROM audit_log ORDER BY at DESC LIMIT $1`,
      [Math.min(500, limit)],
    )
    return rows
  }
  return memAudit.slice(0, limit)
}

/** ตรวจว่า DB ติดต่อได้ — ใช้โดย /healthz (docker healthcheck + deploy.sh) */
export async function checkDb() {
  if (!pool) return { ok: true, mode: 'memory' }
  try {
    await pool.query('SELECT 1')
    return { ok: true, mode: 'postgres' }
  } catch {
    return { ok: false, mode: 'postgres' }
  }
}

export async function closePool() {
  if (pool) await pool.end()
}
