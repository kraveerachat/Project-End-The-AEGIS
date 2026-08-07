// tests/accessUsers.test.js — AEGIS Drive (IDEA1) · ด่าน force-reset + จอ Access อ่านของจริง
//
// ยิงผ่าน Express app "ตัวเดียวกับที่รันใน production" (server/app.js) — middleware ทุกชั้น
// ทำงานจริง ไม่มีการ mock แบบแผนเดียวกับ tests/filesOwnership.test.js
//
// สิ่งที่ชุดนี้พิสูจน์ (บั๊กจริงที่เคยมีสองข้อ):
//   A. บัญชีที่ยังใช้รหัสผ่านชั่วคราว "ล็อกอินได้ แต่ทำอะไรไม่ได้" จนกว่าจะเปลี่ยนรหัส
//      — ก่อนหน้านี้ seed.sql ตั้ง must_reset_password = FALSE ให้ admin/user ทั้งที่
//      รหัสของทั้งคู่อยู่ใน git สาธารณะ ใครก็ตามที่ clone repo ก็เข้าระบบได้ทันที
//   B. GET /api/users คืน "บัญชีที่มีอยู่จริงในตาราง" ไม่ใช่อาเรย์เดโม่ที่ hard-code ไว้
//      — ของเดิม listUsers() คืนสี่แถวคงที่ (Somchai P. / Nattaporn W. ที่ไม่มีบัญชีจริง)
//      โดยไม่เช็ค usingPostgres เลย ขณะที่ POST /api/users เขียนแถวจริงลง Postgres
//      ผลคือจอที่ Admin ใช้ตอบคำถาม "ใครเข้าถึงระบบนี้ได้" แสดงคำตอบที่เป็นเท็จ
//
// ⚠️ ชุดเดียวกันต้องผ่านทั้งสองโหมด DB: ไม่ตั้ง TEST_DATABASE_URL = in-memory fallback,
//    ตั้ง = Postgres จริง (production code path) — ถ้าผ่านแค่โหมดเดียวคือยังไม่ได้พิสูจน์
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, loginClient, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-access-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[access/users tests] database mode: ${DB_MODE}`)

// ชื่อสุ่มต่อรอบ — รันซ้ำกับฐานเดิมได้โดยไม่ชน unique constraint ของ username
const PROBE = `qa.probe.${Math.random().toString(36).slice(2, 10)}`

let server, baseUrl

before(async () => {
  await initStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  if (usingPostgres) {
    // เก็บกวาดบัญชีทดสอบออกจากฐานจริง — audit_log อ้าง actor_id แบบ ON DELETE SET NULL
    // จึงลบแถว users ได้โดยไม่ทำให้ audit หาย (หลักฐานยังอยู่ ตัวบัญชีหายไป)
    await query(`DELETE FROM users WHERE username LIKE 'qa.probe.%'`)
    await closePool()
  }
})

// ═══ B. จอ Access อ่านตาราง users จริง ═══════════════════════════════════════

// ชื่อที่เคยอยู่ในอาเรย์เดโม่ของ store.js — ถ้าโผล่มาอีกแปลว่ามี mock กลับเข้ามาแล้ว
const REMOVED_FAKES = ['somchai.p', 'nattaporn.w', 'Somchai P.', 'Nattaporn W.']

test('GET /api/users คืนบัญชีจริงจากตาราง ไม่ใช่อาเรย์เดโม่ และไม่มีฟิลด์ที่แต่งขึ้น', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const res = await admin.req('/api/users')
  assert.equal(res.status, 200, `Admin ต้องอ่าน /api/users ได้ — ได้ ${res.status}`)
  const users = res.data.users
  assert.ok(Array.isArray(users) && users.length > 0, 'ต้องมีบัญชีอย่างน้อยหนึ่งใบ')

  // บัญชีที่ "ล็อกอินได้จริง" ต้องอยู่ในรายการ (เราเพิ่งล็อกอินด้วย admin สำเร็จมา)
  const names = users.map((u) => u.username)
  assert.ok(names.includes('admin'), `รายการต้องมี admin ที่เพิ่งล็อกอินสำเร็จ — ได้ ${JSON.stringify(names)}`)
  assert.ok(names.includes('user'), 'รายการต้องมีบัญชี user ตาม seed/DEV_SEED')

  // แถวเดโม่ที่ถูกถอดออกต้องไม่กลับมา
  for (const fake of REMOVED_FAKES) {
    assert.ok(
      !users.some((u) => u.username === fake || u.name === fake),
      `'${fake}' คือแถวเดโม่ที่ถูกถอดออกแล้ว — การกลับมาแปลว่า mock ถูกใส่คืน`,
    )
  }

  // ⚠️ status ยังห้ามแต่งขึ้น; activeSessions อนุญาตเพราะ endpoint อ่าน MemoryStore
  //    ของ Express จริงใน request นี้ และต้องเป็น null หาก store นับไม่ได้
  for (const u of users) {
    assert.equal('status' in u, false, `ฟิลด์ status เป็นค่าที่แต่งขึ้น — พบใน ${u.username}`)
    assert.ok(u.activeSessions === null || Number.isInteger(u.activeSessions), 'activeSessions ต้องเป็นค่าที่นับได้จริงหรือ null')
    assert.ok(typeof u.role === 'string', 'role ต้องมาจาก DB')
    assert.equal(typeof u.mustResetPassword, 'boolean', 'mustResetPassword ต้องเป็น boolean จริงจาก DB')
  }

  // lastLogin เป็นของจริงจาก audit_log — admin เพิ่งล็อกอินไปเมื่อครู่นี้
  const adminRow = users.find((u) => u.username === 'admin')
  assert.ok(adminRow.lastLogin != null, 'lastLogin ของบัญชีที่เพิ่งล็อกอินต้องไม่เป็น null')
  assert.ok(
    Math.abs(Date.now() - adminRow.lastLogin) < 120_000,
    `lastLogin ต้องเป็นเวลาที่เพิ่งเกิดจริง ไม่ใช่ค่าคงที่ — ได้ ${new Date(adminRow.lastLogin).toISOString()}`,
  )
})

test('GET /api/users นับเซสชันจริงต่อบัญชีจาก session store ของอินสแตนซ์นี้', async () => {
  const first = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const before = await first.req('/api/users')
  const beforeCount = before.data.users.find((u) => u.username === DEMO_ADMIN.username)?.activeSessions
  assert.ok(Number.isInteger(beforeCount) && beforeCount >= 1, 'เซสชันปัจจุบันต้องถูกนับอย่างน้อยหนึ่ง')

  await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const after = await first.req('/api/users')
  const afterCount = after.data.users.find((u) => u.username === DEMO_ADMIN.username)?.activeSessions
  assert.equal(afterCount, beforeCount + 1, 'ล็อกอินอีก browser session ต้องเพิ่ม count จริงหนึ่ง')

  const userCount = after.data.users.find((u) => u.username === 'user')?.activeSessions
  assert.ok(Number.isInteger(userCount), 'บัญชีอื่นต้องได้ count ของตัวเอง ไม่ใช่ค่าของ Admin ที่คัดลอกมา')
})

test('บัญชีที่ Admin provision ปรากฏใน GET /api/users เพราะมันมีอยู่จริง (ไม่ใช่เพราะซิงก์เข้าอาเรย์)', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const created = await admin.req('/api/users', {
    method: 'POST',
    body: { name: 'QA Probe Account', username: PROBE, role: 'DataLake-User' },
  })
  assert.equal(created.status, 201, `provision ต้องสำเร็จ — ได้ ${created.status}: ${JSON.stringify(created.data)}`)
  assert.ok(created.data.tempPassword, 'ต้องคืนรหัสผ่านชั่วคราวครั้งเดียว')

  const after = await admin.req('/api/users')
  const row = after.data.users.find((u) => u.username === PROBE)
  assert.ok(row, 'บัญชีที่เพิ่งสร้างต้องอยู่ในรายการ')
  assert.equal(row.role, 'DataLake-User', 'role ต้องเป็นค่าที่เซิร์ฟเวอร์บังคับ ไม่ใช่ค่าที่ client ขอ')
  assert.equal(row.mustResetPassword, true, 'บัญชีที่ provision ใหม่ต้องติดด่าน force-reset')
  assert.equal(row.lastLogin, null, 'บัญชีที่ยังไม่เคยล็อกอินต้องเป็น null ไม่ใช่เวลาที่แต่งขึ้น')
})

// ═══ A. ด่าน force-reset ทำงานจริง ═══════════════════════════════════════════

test('บัญชีที่ยังใช้รหัสชั่วคราว: ล็อกอินได้ แต่ทุก endpoint อื่นตอบ 403 จนกว่าจะเปลี่ยนรหัส', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const username = `${PROBE}.gate`
  const created = await admin.req('/api/users', {
    method: 'POST',
    body: { name: 'QA Gate Probe', username, role: 'DataLake-User' },
  })
  assert.equal(created.status, 201)
  const tempPassword = created.data.tempPassword

  // ── ล็อกอินด้วยรหัสชั่วคราว: สำเร็จ และเซิร์ฟเวอร์ต้องบอก client ตรง ๆ ว่าต้องรีเซ็ต
  const probe = new Client(baseUrl)
  const login = await probe.req('/api/login', { method: 'POST', body: { username, password: tempPassword } })
  assert.equal(login.status, 200, 'รหัสชั่วคราวต้องล็อกอินได้ (ไม่ใช่ปฏิเสธ)')
  assert.equal(login.data.user.mustResetPassword, true, 'ต้องแจ้ง client ว่าติด force-reset')
  probe.csrf = login.data.csrfToken

  // ── แต่ยังทำอะไรไม่ได้เลย: endpoint ที่ไม่ได้ exempt ต้องตอบ 403 PASSWORD_RESET_REQUIRED
  for (const pathname of ['/api/files', '/api/dashboard', '/api/shares', '/api/vault']) {
    const blocked = await probe.req(pathname)
    assert.equal(blocked.status, 403, `${pathname} ต้องถูกปิดกั้น — ได้ ${blocked.status}`)
    assert.equal(blocked.data?.error, 'PASSWORD_RESET_REQUIRED', `${pathname} ต้องบอกเหตุผลที่ client แยกแยะได้`)
  }
  // /me ยังต้องเรียกได้ ไม่งั้น client พาผู้ใช้ไปหน้ารีเซ็ตไม่ได้เลย (deadlock)
  assert.equal((await probe.req('/api/me')).status, 200, '/me ต้องยังเรียกได้ระหว่างติดด่าน')

  // ── รหัสใหม่ที่อ่อนต้องถูกปฏิเสธ — ด่านนี้ไม่ใช่แค่ "เปลี่ยนอะไรก็ได้ให้ผ่าน"
  const weak = await probe.req('/api/password/reset', {
    method: 'POST', body: { currentPassword: tempPassword, newPassword: 'short' },
  })
  assert.equal(weak.status, 400, 'รหัสสั้นกว่านโยบายต้องถูกปฏิเสธ')

  // ── ต้องยืนยันรหัสเดิมให้ถูกก่อน แม้จะถือ session ที่ authenticated แล้ว
  const wrongCurrent = await probe.req('/api/password/reset', {
    method: 'POST', body: { currentPassword: 'not-the-temp-password', newPassword: 'aegis-gate-probe-pw-2026' },
  })
  assert.equal(wrongCurrent.status, 401, 'currentPassword ผิดต้องไม่ผ่าน')

  // ── เปลี่ยนสำเร็จ → ใช้งานได้ทันทีในเซสชันเดิม ไม่ต้อง re-login
  const ok = await probe.req('/api/password/reset', {
    method: 'POST', body: { currentPassword: tempPassword, newPassword: 'aegis-gate-probe-pw-2026' },
  })
  assert.equal(ok.status, 200, `การรีเซ็ตต้องสำเร็จ — ได้ ${ok.status}: ${JSON.stringify(ok.data)}`)
  assert.equal((await probe.req('/api/files')).status, 200, 'หลังรีเซ็ตต้องใช้งาน endpoint ปกติได้')

  // ── รหัสชั่วคราวเดิมต้องใช้ไม่ได้อีก (ไม่ใช่แค่ "ถูกขอให้เปลี่ยน" แต่ยังใช้ได้อยู่)
  const reuse = new Client(baseUrl)
  const reused = await reuse.req('/api/login', { method: 'POST', body: { username, password: tempPassword } })
  assert.equal(reused.status, 401, 'รหัสชั่วคราวต้องตายหลังถูกเปลี่ยน')

  // ── และจอ Access ต้องเห็นสถานะที่เปลี่ยนไปแล้ว (ไม่ใช่ค่าที่ค้างอยู่ในอาเรย์)
  const list = await admin.req('/api/users')
  const row = list.data.users.find((u) => u.username === username)
  assert.equal(row.mustResetPassword, false, 'สถานะ pending-reset ต้องหายไปหลังผู้ใช้เปลี่ยนรหัสจริง')
  assert.ok(row.lastLogin != null, 'lastLogin ต้องปรากฏหลังบัญชีนี้ล็อกอินสำเร็จ')
})

test('seed.sql ไม่ทิ้งบัญชีที่ยังใช้รหัสสาธารณะจาก git ได้แบบไม่มีด่าน', async (t) => {
  if (!usingPostgres) {
    t.skip('เงื่อนไขนี้เป็นเรื่องของ seed.sql — โหมด in-memory ใช้ DEV_SEED คนละเส้นทาง')
    return
  }
  // hash สองก้อนนี้อยู่ใน seed.sql ที่ commit ลง git — บัญชีใดที่ยังใช้มันอยู่
  // ต้องติด must_reset_password = TRUE เสมอ ไม่มีข้อยกเว้น
  const { rows } = await query(
    `SELECT username, must_reset_password FROM users
      WHERE password_hash IN (
        '$2a$10$x.s.qVZEnNDozB6hLZu9Wu3tAD/HebtRwTu/mkbtHM/4QeqisPmnO',
        '$2a$10$KvFvKFdx6OnPCjxIlwYXiOw0i0mmdmwcO1rNgHvqwtxuOgZfsVj1i'
      )`,
  )
  for (const r of rows) {
    assert.equal(
      r.must_reset_password, true,
      `'${r.username}' ยังใช้รหัสที่อยู่ใน git แต่ไม่ติดด่านรีเซ็ต — นั่นคือช่องโหว่เดิม`,
    )
  }
})
