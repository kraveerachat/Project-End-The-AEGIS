// server/db/bootstrapAdmin.js — AEGIS Drive (IDEA1) · Day-0 admin bootstrap
// ⚠️ ทำงานเฉพาะตอนบูตครั้งแรกของฐานข้อมูลจริง (Postgres) และเฉพาะเมื่อยังไม่มี Admin
//    สักคนเลย — ไม่ใช่ mechanism สำหรับ reset/rotate รหัสผ่านหลังจากนั้น (ใช้ CLI/console
//    ของ Postgres โดยตรง หรือ /api/password/reset ของบัญชีนั้นเองแทน)
//
// ⚠️ Threat model: env var ที่ container เห็นได้ (ADMIN_BOOTSTRAP_PASSWORD_HASH) ต้องเป็น
//    "bcrypt hash" ที่คำนวณไว้แล้วในเครื่องของผู้ดูแลระบบ (ดู scripts/hash_password.py)
//    ไม่ใช่รหัสผ่านดิบ — เพราะ:
//      1) รหัสผ่านดิบที่อยู่ใน env var ของ container หลุดออกได้ง่ายกว่าที่คิด
//         (`docker inspect`, `/proc/<pid>/environ`, docker-compose config --resolve, ฯลฯ)
//      2) bcrypt hash แม้หลุดออกไปก็ถอดกลับเป็นรหัสผ่านไม่ได้ (โดยคณิตศาสตร์)
//      3) รหัสผ่านดิบจึง "มีชีวิตอยู่" แค่ในเทอร์มินัลของผู้ดูแลระบบตอนรัน hash_password.py
//         (ผ่าน getpass — ไม่มี echo, ไม่ลง shell history) แล้วหายไปตลอดกาล
//    ถ้า ADMIN_BOOTSTRAP_PASSWORD_HASH ที่ได้มาไม่ใช่รูปแบบ bcrypt ($2a$/$2b$/$2y$) ให้ปฏิเสธ
//    การบูต (fail loud) แทนที่จะเก็บมันลง password_hash เฉย ๆ — กันกรณีตั้งค่าผิดเป็นรหัสดิบ
import { usingPostgres, query } from './connection.js'
import { ROLES } from '../rbac/permissions.js'

const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$/

export async function bootstrapAdminIfNeeded() {
  if (!usingPostgres) return // dev fallback มี admin/user เดโม่อยู่แล้วใน connection.js

  const username = process.env.ADMIN_BOOTSTRAP_USERNAME
  const passwordHash = process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH
  if (!username && !passwordHash) return // ไม่ได้ตั้งค่าไว้ — ข้ามเงียบ ๆ (ไม่ใช่ error)

  const { rows } = await query(`SELECT count(*)::int AS n FROM users WHERE role = $1`, [ROLES.ADMIN])
  if (rows[0].n > 0) {
    // มี Admin อยู่แล้ว — Day-0 ผ่านไปแล้ว ไม่ทำอะไรอีก (ป้องกันสร้างซ้ำ/เขียนทับทุก restart)
    console.log('[aegis-drive] ADMIN_BOOTSTRAP_* is set but an Admin already exists — skipping')
    return
  }

  if (!username || !passwordHash) {
    throw new Error('ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD_HASH must both be set together')
  }
  if (!BCRYPT_HASH_RE.test(passwordHash)) {
    // ไม่ใช่รูปแบบ bcrypt hash — เดาว่าเป็นรหัสดิบที่ตั้งผิดช่อง ปฏิเสธการบูตทันที
    // (ดีกว่าเงียบแล้วเก็บรหัสดิบลง password_hash โดยไม่มีใครรู้)
    throw new Error(
      'ADMIN_BOOTSTRAP_PASSWORD_HASH does not look like a bcrypt hash — ' +
      'generate one with scripts/hash_password.py, never pass a raw password here',
    )
  }

  await query(
    `INSERT INTO users (username, password_hash, role, display_name, must_reset_password)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (username) DO NOTHING`,
    [String(username).trim().toLowerCase(), passwordHash, ROLES.ADMIN, 'System Administrator'],
  )
  console.log(`[aegis-drive] Day-0 admin bootstrapped: ${username} (must reset password on first login)`)
  console.warn('[aegis-drive] ⚠️ remove ADMIN_BOOTSTRAP_* from .env now that bootstrap is done')
}
