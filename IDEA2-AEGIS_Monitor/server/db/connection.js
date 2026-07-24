// server/db/connection.js — AEGIS Monitor (IDEA2)
// จุดเชื่อมต่อฐานข้อมูล aegis_monitor — "แหล่งความจริง" ของ user + role + camera_assignment
// ⚠️ Identity Decoupling: ฐานข้อมูลนี้เป็นของ IDEA2 เท่านั้น — IDEA1 มี DB ของตัวเอง
//    (aegis_drive) ห้ามใช้ connection string เดียวกัน ห้ามอ่านตารางข้ามโมดูล
// ⚠️ ไม่มี SSO: เซิร์ฟเวอร์นี้ไม่เคยเรียกไปถามเซสชันจาก HUB หรือแอปอื่นใด
//    (โค้ดเดิมที่ fetch http://localhost:3001/api/me ถูก "ทำลายทิ้ง" ตามคำสั่งสถาปัตยกรรม)
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { ROLES } from '../rbac/permissions.js'
import { camerasForUserId } from './store.js'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL

let pool = null
if (DATABASE_URL) {
  // pool เล็กโดยเจตนา — Beelink 8GB รันหลาย container ร่วมกัน
  pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 })
}

export const usingPostgres = Boolean(pool)

/** query ทั่วไปสำหรับ store.js — เรียกได้เฉพาะเมื่อ usingPostgres === true */
export async function query(text, params) {
  return pool.query(text, params)
}

/**
 * รัน fn ภายใน transaction เดียว (BEGIN/COMMIT, ROLLBACK เมื่อ throw) บน client
 * ตัวเดียวที่ checkout จาก pool — ใช้เมื่อหลายคำสั่งต้อง atomic (เช่น สร้าง user +
 * ผูก camera_assignment พร้อมกัน: ถ้าขั้นใดพัง ต้องไม่เหลือ user กำพร้าไว้)
 * ⚠️ pg เท่านั้น — ผู้เรียกต้อง guard ด้วย usingPostgres ก่อน
 */
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* client เสียแล้ว — ปล่อยให้ release ไป */ }
    throw err
  } finally {
    client.release()
  }
}

// ── dev fallback (ไม่มี DATABASE_URL) — security model เหมือนโหมดจริงทุกอย่าง ──
const DEV_USERS = DATABASE_URL
  ? []
  : [
      { id: 1, username: 'soc',       displayName: 'A. Okafor',   role: ROLES.SOC,      password: 'aegis-soc' },
      { id: 2, username: 'operator',  displayName: 'M. Reyes',    role: ROLES.OPERATOR, password: 'aegis-operator' },
      // operator คนที่สอง — มีไว้พิสูจน์ว่า operator A มองไม่เห็นกล้องของ operator B
      // (ตรงกับ seed.sql: operator→CAM-05, operator2→CAM-06)
      { id: 3, username: 'operator2', displayName: 'T. Nakamura', role: ROLES.OPERATOR, password: 'aegis-operator2' },
    ].map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      active: true,
      passwordHash: bcrypt.hashSync(u.password, 10),
      mustResetPassword: false, // บัญชีเดโม่ล็อกอินได้ทันที ไม่ผ่าน force-reset
    }))

const DEV_CAMERAS = [
  { id: 'CAM-01', name: 'Main entrance', zone: 'Perimeter',  res: '1920×1080', online: true },
  { id: 'CAM-02', name: 'Parking lot',   zone: 'Perimeter',  res: '1920×1080', online: true },
  { id: 'CAM-03', name: 'Server room',   zone: 'Restricted', res: '1280×720',  online: false },
  { id: 'CAM-04', name: 'Loading dock',  zone: 'Restricted', res: '1920×1080', online: true },
  { id: 'CAM-05', name: 'Reception',     zone: 'Public',     res: '1920×1080', online: true },
  { id: 'CAM-06', name: 'Corridor B',    zone: 'Internal',   res: '1280×720',  online: true },
]

// dev fallback: camera_assignment อยู่ใน store.js (มุมมองเดียวกับที่วิว Operators แก้)
// — การแก้ assignment ในวิวนั้นจึงมีผลกับ Scoped View ของ operator ทันที เหมือน DB จริง

export async function getUserByUsername(username) {
  const uname = String(username ?? '').trim().toLowerCase()
  if (!uname) return null

  if (pool) {
    // parameterized query เท่านั้น — กัน SQL injection
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role, password_hash, active, must_reset_password
         FROM users
        WHERE lower(username) = $1
        LIMIT 1`,
      [uname],
    )
    if (rows.length === 0) return null
    const r = rows[0]
    if (!r.active) return null // บัญชีถูกระงับ = ล็อกอินไม่ได้ (ข้อความ error เท่าเดิม — ไม่รั่วสถานะบัญชี)
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      passwordHash: r.password_hash,
      mustResetPassword: r.must_reset_password,
    }
  }

  return DEV_USERS.find((u) => u.username === uname) ?? null
}

/** ค้น user ด้วย id — ใช้โดย /password/reset (ต้อง re-fetch hash จริงจาก DB เสมอ เพราะ session ไม่เก็บ) */
export async function getUserById(id) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role, password_hash, active, must_reset_password
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
  return DEV_USERS.find((u) => u.id === id) ?? null
}

/** เปลี่ยนรหัสผ่าน (ใช้โดย /password/reset) — ผู้เรียกต้องยืนยัน currentPassword มาก่อนแล้ว */
export async function updatePasswordHash(userId, newPassword) {
  const newHash = bcrypt.hashSync(String(newPassword), 12)
  if (pool) {
    await pool.query(
      `UPDATE users SET password_hash = $1, must_reset_password = FALSE WHERE id = $2`,
      [newHash, userId],
    )
    return true
  }
  const u = DEV_USERS.find((x) => x.id === userId)
  if (!u) return false
  u.passwordHash = newHash
  u.mustResetPassword = false
  return true
}

/**
 * กล้องที่ user มองเห็นได้ — จุดบังคับ Scoped View "ฝั่งเซิร์ฟเวอร์"
 * ⚠️ กรอง camera ตาม camera_assignment ที่ฝั่ง server — ห้ามเชื่อ filter จาก client
 * SOC-Responder → ทุกกล้อง; CCTV-Operator → เฉพาะแถวใน camera_assignment ของตน
 */
export async function getVisibleCameras(user) {
  if (pool) {
    if (user.role === ROLES.SOC) {
      const { rows } = await pool.query(`SELECT id, name, zone, res, online FROM cameras ORDER BY id`)
      return rows
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.zone, c.res, c.online
         FROM cameras c
         JOIN camera_assignment a ON a.camera_id = c.id
        WHERE a.user_id = $1
        ORDER BY c.id`,
      [user.id],
    )
    return rows
  }

  if (user.role === ROLES.SOC) return DEV_CAMERAS
  const visible = camerasForUserId(user.id)
  return DEV_CAMERAS.filter((c) => visible.has(c.id))
}

/** id ของกล้องที่มองเห็น — ใช้ตรวจ 403 รายกล้อง (Operator ถามกล้องอื่น → ปฏิเสธ) */
export async function canSeeCamera(user, cameraId) {
  const cams = await getVisibleCameras(user)
  return cams.some((c) => c.id === cameraId)
}

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
