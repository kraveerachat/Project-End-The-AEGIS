// server/db/seedTestFixtures.js — AEGIS Drive (IDEA1) · LOCAL TEST ENVIRONMENT ONLY
// ⚠️ ไม่ใช่ Day-0 bootstrap ของจริง (ดู bootstrapAdmin.js สำหรับ production) — ไฟล์นี้
//    ใส่บัญชีทดสอบ 3 บัญชีที่ "รู้รหัสผ่านล่วงหน้า" (admin_drive, staff_01, staff_02) เพื่อให้
//    ทดสอบ UI/RBAC ได้ทันทีโดยไม่ต้องผ่าน force-reset flow ก่อน — ต่างจาก production ตรงที่:
//      1) เขียนได้หลายบัญชีในครั้งเดียว (bootstrapAdmin.js สร้างได้แค่ Admin คนแรกเท่านั้น)
//      2) must_reset_password = FALSE เสมอ (ผู้ทดสอบต้อง login ได้ทันทีด้วยรหัสที่กำหนดไว้)
//      3) รันแยกต่างหาก ไม่ถูกเรียกจาก index.js ตอนบูต — ต้องสั่งรันเองทุกครั้ง (ไม่ใช่ทุก restart)
//
// ⚠️ รหัสผ่านที่นี่มาจาก .env.test เท่านั้น ในรูป bcrypt hash ที่คำนวณไว้ล่วงหน้าแล้ว — ไฟล์นี้
//    ไม่มี plaintext แม้แต่ตัวเดียว และไม่ hash อะไรเองตอนรัน (ต่างจาก bootstrapAdmin.js ที่ยัง
//    รับ hash ผ่าน env เหมือนกัน — รูปแบบเดียวกัน แค่คนละ env var namespace)
//
// ใช้:
//   export $(grep -v '^#' .env.test | xargs)   # โหลดตัวแปรจาก .env.test เข้า shell
//   node server/db/seedTestFixtures.js
import { usingPostgres, query, closePool } from './connection.js'

const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$/

// username/display name ไม่ใช่ความลับ — hardcode ได้ตรงนี้ (เฉพาะ hash เท่านั้นที่มาจาก env)
const FIXTURES = [
  { username: 'admin_drive', displayName: 'Test Admin (Drive)', role: 'Admin', envVar: 'TEST_SEED_ADMIN_DRIVE_HASH' },
  { username: 'staff_01', displayName: 'Test Staff 01', role: 'DataLake-User', envVar: 'TEST_SEED_STAFF_01_HASH' },
  { username: 'staff_02', displayName: 'Test Staff 02', role: 'DataLake-User', envVar: 'TEST_SEED_STAFF_02_HASH' },
]

async function main() {
  // สองชั้นกันรัน production โดยไม่ตั้งใจ: NODE_ENV guard + ต้องมี Postgres จริงเท่านั้น
  // (ไม่มี in-memory fallback สำหรับสคริปต์นี้ — ผิดจุดประสงค์ถ้าจะ seed DB ที่ restart แล้วหาย)
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run: NODE_ENV=production — this script seeds known test passwords, never for prod')
  }
  if (!usingPostgres) {
    throw new Error('DATABASE_URL is not set — this script writes to Postgres only, no in-memory fallback')
  }

  for (const f of FIXTURES) {
    const hash = process.env[f.envVar]
    if (!hash) {
      throw new Error(`${f.envVar} is not set — generate it locally and put it in .env.test first`)
    }
    if (!BCRYPT_HASH_RE.test(hash)) {
      throw new Error(`${f.envVar} does not look like a bcrypt hash — never put a raw password here`)
    }

    const { rows } = await query(
      `INSERT INTO users (username, password_hash, role, display_name, must_reset_password)
       VALUES ($1, $2, $3, $4, FALSE)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [f.username, hash, f.role, f.displayName],
    )
    if (rows.length > 0) {
      console.log(`[seed-test] created ${f.username} (${f.role})`)
    } else {
      console.log(`[seed-test] ${f.username} already exists — skipped (idempotent, no changes made)`)
    }
  }
  console.log('[seed-test] done — all 3 fixtures are usable immediately with the passwords behind their hashes')
}

main()
  .catch((err) => {
    console.error('[seed-test] failed:', err.message)
    process.exitCode = 1
  })
  .finally(closePool) // ปิด pg Pool เสมอ ไม่งั้น process ค้างไม่ยอมจบ
