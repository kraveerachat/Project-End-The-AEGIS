// tests/accessReconciliation.test.js — AEGIS Drive (IDEA1) · จอ Access ตรงกับความจริงเสมอ
//
// ชุดนี้ต่างจาก accessUsers.test.js ตรงที่ **ไม่เชื่อชั้น store เลย** — หลังยิงผ่าน HTTP
// แล้วจะเปิด connection ของตัวเองไปอ่านตาราง users ด้วย SQL ดิบ แล้วเทียบทีละแถว
// (แบบแผนเดียวกับ tests/vaultPostgres.test.js) เพราะสิ่งที่ต้องพิสูจน์คือ
// "รายการที่จอแสดง = แถวที่มีอยู่จริงในตาราง ไม่ขาดไม่เกิน" ไม่ใช่ "สิ่งที่ชั้น
// abstraction เลือกจะคืนมาให้เราดู" — ถ้ายังมีแหล่งข้อมูลที่สองซ่อนอยู่ที่ไหน
// การเทียบผ่าน store จะมองไม่เห็น
//
// บั๊กจริงที่ชุดนี้กันไม่ให้กลับมา: GET /api/users เคยคืนอาเรย์เดโม่ในหน่วยความจำ ขณะที่
// POST /api/users เขียนแถวจริงลง Postgres แล้วซิงก์สำเนาเข้าอาเรย์นั้นให้ UI เห็น
// ผลคือหลังรีสตาร์ท บัญชีที่ Admin สร้างยัง "ล็อกอินได้จริง" แต่ **หายไปจากจอที่ Admin
// ใช้ตรวจว่าใครเข้าถึงระบบได้** — สถานะ access control ที่โกหกในทิศทางนี้แย่กว่าไม่มีจอเลย
//
// ⚠️ ข้ามทั้งไฟล์เมื่อไม่ได้ตั้ง TEST_DATABASE_URL: การเทียบกับตารางจริงต้องมีตารางจริง
//    (โหมด in-memory ไม่มี "แหล่งที่สอง" ให้เทียบ — accessUsers.test.js ครอบส่วนนั้นแล้ว)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { loginClient, DEMO_ADMIN } from './helpers/testClient.mjs'

const DB_URL = process.env.TEST_DATABASE_URL
const skip = DB_URL ? false : 'ต้องตั้ง TEST_DATABASE_URL เพื่อเทียบกับตาราง users จริง'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-access-recon-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (DB_URL) process.env.DATABASE_URL = DB_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { closePool } = await import('../server/db/connection.js')

const PROBE_PREFIX = `recon.${Math.random().toString(36).slice(2, 8)}`

let server, baseUrl, sql

before(async () => {
  if (!DB_URL) return
  await initStorage()
  // connection แยกของเราเอง — ไม่ใช้ pool ของแอป เพื่อให้แน่ใจว่าอ่าน "ของจริงในตาราง"
  sql = new pg.Client({ connectionString: DB_URL })
  await sql.connect()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (!DB_URL) return
  await sql.query(`DELETE FROM users WHERE username LIKE $1`, [`${PROBE_PREFIX}%`])
  await sql.end()
  await new Promise((r) => server.close(r))
  await closePool()
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

/** ตาราง users ตามที่ "อยู่ในฐานข้อมูลจริง" — อ่านด้วย SQL ดิบ ไม่ผ่านโค้ดแอปเลย */
async function usersInTable() {
  const { rows } = await sql.query(
    `SELECT id, username, display_name, profile_name, role, must_reset_password
       FROM users ORDER BY id`,
  )
  return rows
}

test('รายการที่ GET /api/users คืน = แถวในตาราง users เป๊ะ ๆ ไม่ขาดไม่เกิน', { skip }, async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const table = await usersInTable()
  const api = (await admin.req('/api/users')).data.users

  assert.equal(
    api.length, table.length,
    `จำนวนแถวต้องเท่ากัน — API คืน ${api.length} แต่ตารางมี ${table.length} ` +
    `(API: ${api.map((u) => u.username).join(',')} | ตาราง: ${table.map((r) => r.username).join(',')})`,
  )

  // เทียบทีละแถวด้วย id — ไม่ใช่แค่จำนวน (จำนวนเท่ากันแต่คนละชุดก็ยังผิด)
  const byId = new Map(api.map((u) => [String(u.id), u]))
  for (const row of table) {
    const got = byId.get(String(row.id))
    assert.ok(got, `บัญชี '${row.username}' มีอยู่ในตารางแต่ไม่ปรากฏใน API`)
    assert.equal(got.username, row.username, 'username ต้องตรงกับแถวในตาราง')
    assert.equal(got.role, row.role, 'role ต้องมาจากตาราง ไม่ใช่ค่าที่ UI เดา')
    assert.equal(got.mustResetPassword, row.must_reset_password, 'สถานะ force-reset ต้องตรงกับตาราง')
    assert.equal(got.accountName, row.display_name, 'accountName ต้องเป็น display_name จากตาราง')
    // name = ชื่อที่ผู้ใช้ตั้งเอง ถ้ามี ไม่งั้นชื่อที่ Admin ตั้ง
    const expectedName = row.profile_name?.trim() ? row.profile_name : row.display_name
    assert.equal(got.name, expectedName, 'ชื่อที่แสดงต้องเป็น COALESCE(profile_name, display_name)')
  }
})

test('บัญชีที่ provision ผ่าน POST ปรากฏในตารางจริง และ "แอปอินสแตนซ์ใหม่" ก็เห็นมัน', { skip }, async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const username = `${PROBE_PREFIX}.a`

  const created = await admin.req('/api/users', {
    method: 'POST',
    body: { name: 'Recon Probe A', username, role: 'DataLake-User' },
  })
  assert.equal(created.status, 201, `provision ต้องสำเร็จ — ได้ ${JSON.stringify(created.data)}`)

  // 1) มีอยู่ในตารางจริง (อ่านด้วย SQL ดิบ ไม่ผ่านแอป)
  const { rows } = await sql.query(
    `SELECT username, role, must_reset_password, display_name FROM users WHERE username = $1`,
    [username],
  )
  assert.equal(rows.length, 1, 'ต้องมีแถวจริงหนึ่งแถวในตาราง users')
  assert.equal(rows[0].role, 'DataLake-User', 'role ต้องเป็นค่าที่เซิร์ฟเวอร์บังคับ')
  assert.equal(rows[0].must_reset_password, true, 'บัญชีใหม่ต้องติดด่าน force-reset ในตาราง')

  // 2) ⚠️ หัวใจของเฟสนี้: "แอปอินสแตนซ์ใหม่" (จำลองการรีสตาร์ทฝั่ง routing/state)
  //    ต้องเห็นบัญชีนี้ด้วย ของเดิมจะไม่เห็น เพราะแถวที่ UI เห็นถูกซิงก์เข้าอาเรย์
  //    ในหน่วยความจำของอินสแตนซ์ที่สร้างมันเท่านั้น
  const app2 = createApp()
  const server2 = app2.listen(0)
  await new Promise((r) => server2.once('listening', r))
  const base2 = `http://127.0.0.1:${server2.address().port}`
  try {
    const admin2 = await loginClient(base2, DEMO_ADMIN.username, DEMO_ADMIN.password)
    const seen = (await admin2.req('/api/users')).data.users.find((u) => u.username === username)
    assert.ok(seen, 'บัญชีที่สร้างจากอินสแตนซ์หนึ่งต้องปรากฏในอีกอินสแตนซ์ (แหล่งข้อมูลเดียว)')
    assert.equal(seen.mustResetPassword, true)
    assert.equal(seen.role, 'DataLake-User')
  } finally {
    await new Promise((r) => server2.close(r))
  }
})

test('บัญชีที่ถูกลบออกจากตารางหายจากจอทันที (ไม่มีสำเนาค้างในหน่วยความจำ)', { skip }, async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const username = `${PROBE_PREFIX}.b`

  await admin.req('/api/users', {
    method: 'POST',
    body: { name: 'Recon Probe B', username, role: 'DataLake-User' },
  })
  const present = (await admin.req('/api/users')).data.users.some((u) => u.username === username)
  assert.equal(present, true, 'บัญชีต้องปรากฏก่อนถูกลบ')

  // ลบตรงจากตาราง (จำลองการถอนสิทธิ์ด้วย psql ตอน incident response)
  await sql.query(`DELETE FROM users WHERE username = $1`, [username])

  // ⚠️ ถ้ายังมีสำเนาในหน่วยความจำ แถวนี้จะยังโผล่อยู่ = จอบอกว่าคนที่ถูกถอนสิทธิ์แล้ว
  //    ยังเข้าถึงระบบได้ ซึ่งอ่านกลับกันได้อีกทางว่า "ถอนสิทธิ์ไปแล้วแต่จอยังไม่ยอมรับ"
  const stillThere = (await admin.req('/api/users')).data.users.some((u) => u.username === username)
  assert.equal(stillThere, false, 'บัญชีที่ถูกลบจากตารางต้องหายจากจอทันที')
})

test('ชื่อโปรไฟล์ที่ผู้ใช้ตั้งทับ ไม่ลบชื่อที่ Admin ตั้งออกจากจอ governance', { skip }, async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const username = `${PROBE_PREFIX}.c`
  const ASSIGNED = 'Recon Probe C'

  const created = await admin.req('/api/users', {
    method: 'POST', body: { name: ASSIGNED, username, role: 'DataLake-User' },
  })
  assert.equal(created.status, 201)

  // ผู้ใช้ตั้งชื่อตัวเองเป็นชื่อของ "คนอื่น" (กรณีปลอมตัวที่จอนี้ต้องยังอ่านออก)
  await sql.query(`UPDATE users SET profile_name = $1 WHERE username = $2`, ['Veerachat J.', username])

  const row = (await admin.req('/api/users')).data.users.find((u) => u.username === username)
  assert.equal(row.name, 'Veerachat J.', 'ชื่อที่แสดงคือชื่อที่ผู้ใช้ตั้งเอง')
  // ⚠️ ทั้ง accountName และ username ต้องยังอยู่ให้ Admin แยกออกว่าแถวนี้คือบัญชีไหนจริง ๆ
  assert.equal(row.accountName, ASSIGNED, 'ชื่อที่ Admin ตั้งต้องยังถูกส่งมาให้จอแสดงคู่กัน')
  assert.equal(row.username, username, 'username ต้องไม่เปลี่ยนตามชื่อโปรไฟล์')
})

test('ผู้ใช้ทั่วไปอ่าน /api/users ไม่ได้เลย (จอ governance = Admin เท่านั้น)', { skip }, async () => {
  const user = await loginClient(baseUrl, 'user', 'aegis-drive-user')
  const res = await user.req('/api/users')
  assert.equal(res.status, 403, 'DataLake-User ต้องได้ 403 ไม่ใช่รายชื่อบัญชีทั้งระบบ')
  assert.equal(res.data?.error, 'Forbidden')
  // และสร้างบัญชีก็ไม่ได้
  const created = await user.req('/api/users', {
    method: 'POST', body: { name: 'nope', username: `${PROBE_PREFIX}.d`, role: 'DataLake-User' },
  })
  assert.equal(created.status, 403)
  const { rows } = await sql.query(`SELECT 1 FROM users WHERE username = $1`, [`${PROBE_PREFIX}.d`])
  assert.equal(rows.length, 0, 'คำขอที่ถูกปฏิเสธต้องไม่สร้างแถวใด ๆ')
})
