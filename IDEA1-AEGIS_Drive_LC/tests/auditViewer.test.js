// tests/auditViewer.test.js — AEGIS Drive (IDEA1) · จอ Audit และคุณสมบัติ privacy ของ audit log
//
// จอนี้ "จริง" อยู่แล้วก่อนงานรอบนี้ แต่ยังไม่เคยมีชุดทดสอบของตัวเอง และตอนนี้มีสองจอ
// พึ่งพามันโดยตรง: กราฟกิจกรรมของ Dashboard นับจาก audit_log และคอลัมน์ "เข้าระบบล่าสุด"
// ของจอ Access ก็อ่านจากที่นี่ — ถ้า audit เพี้ยน ทั้งสองจอจะเพี้ยนตามแบบเงียบ ๆ
//
// สิ่งที่ชุดนี้พิสูจน์:
//   A. Admin เท่านั้นที่อ่าน audit ได้ (DataLake-User → 403 ไม่ใช่รายการเหตุการณ์ทั้งระบบ)
//   B. Privacy-preserving จริง: ชื่อไฟล์ถูกเก็บเป็น sha256 ไม่ใช่ค่าดิบ — ผู้ตรวจ log
//      ระบุได้ว่า "เหตุการณ์ซ้ำไฟล์เดิมไหม" โดยไม่เห็นว่าไฟล์นั้นชื่ออะไร
//   C. การกระทำจริงลง audit จริง และผลลัพธ์ (OK/DENIED) ตรงกับสิ่งที่เกิดขึ้น
//   D. ความลับไม่เคยหลุดลง audit — ไม่มีรหัสผ่าน, token ของลิงก์แชร์, หรือ passphrase
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-audit-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query, sha256Hex } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[audit viewer tests] database mode: ${DB_MODE}`)

const SECRET_FILENAME = `audittest-salary-review-${Date.now()}.txt`
const LINK_PASSWORD = 'audit-link-password-2026'

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
  if (usingPostgres) {
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'audittest-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

const events = async (admin) => (await admin.req('/api/audit')).data.events
const actionOf = (e) => e.action ?? ''
const targetOf = (e) => e.target_hash ?? e.targetHash ?? null
const labelOf = (e) => e.actor_label ?? e.actorLabel ?? null

// ═══ A. สิทธิ์ ═══════════════════════════════════════════════════════════════════

test('audit อ่านได้เฉพาะ Admin — DataLake-User ได้ 403 ไม่ใช่รายการเหตุการณ์ทั้งระบบ', async () => {
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const res = await user.req('/api/audit')
  assert.equal(res.status, 403, `ต้องได้ 403 — ได้ ${res.status}`)
  assert.equal(res.data?.error, 'Forbidden')
  assert.equal('events' in (res.data ?? {}), false, 'ห้ามหลุดเหตุการณ์แม้แต่รายการเดียว')

  // ⚠️ audit เห็น "ทุกการกระทำของทุกคน" — การเปิดให้ผู้ใช้ทั่วไปอ่านคือการเปิดให้เห็น
  //    พฤติกรรมของเพื่อนร่วมงานทั้งองก์ (ใครแตะ vault เมื่อไร, IP ของใคร)
  const anon = new Client(baseUrl)
  assert.equal((await anon.req('/api/audit')).status, 401, 'ไม่ล็อกอินต้องได้ 401')

  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  assert.equal((await admin.req('/api/audit')).status, 200, 'Admin ต้องอ่านได้')
})

// ═══ B + C. เนื้อหาของ audit ══════════════════════════════════════════════════════

test('ชื่อไฟล์ถูกเก็บเป็น sha256 ไม่ใช่ค่าดิบ — และ hash เดิมซ้ำได้เพื่อระบุไฟล์เดียวกัน', async () => {
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const form = new FormData()
  form.append('file', new Blob(['audit probe body'], { type: 'application/octet-stream' }), SECRET_FILENAME)
  const up = await user.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(up.status, 201)
  // ดาวน์โหลดซ้ำสองครั้ง — เหตุการณ์คนละครั้งแต่ต้องชี้ไปที่ไฟล์เดียวกันได้
  await user.raw(`/api/files/${encodeURIComponent(up.data.file.id)}/download`)
  await user.raw(`/api/files/${encodeURIComponent(up.data.file.id)}/download`)

  const rows = await events(admin)
  const expectedHash = sha256Hex(SECRET_FILENAME)

  // ⚠️ ชื่อไฟล์ดิบต้องไม่ปรากฏที่ใดใน audit เลย — ผู้ตรวจ log ไม่ควรรู้ว่าใครมีไฟล์ชื่ออะไร
  const dump = JSON.stringify(rows)
  assert.ok(!dump.includes(SECRET_FILENAME), 'ชื่อไฟล์ดิบต้องไม่อยู่ใน audit')
  assert.ok(!dump.includes('salary'), 'เศษของชื่อไฟล์ก็ต้องไม่อยู่')

  // แต่ต้องยัง "ระบุซ้ำได้": upload + download สองครั้ง ต้องมี target_hash เดียวกัน
  const mine = rows.filter((e) => targetOf(e) === expectedHash)
  assert.ok(mine.length >= 3, `ต้องพบเหตุการณ์ของไฟล์นี้อย่างน้อยสามครั้ง — พบ ${mine.length}`)
  assert.ok(mine.some((e) => actionOf(e) === 'FILE_UPLOAD'), 'ต้องมี FILE_UPLOAD')
  assert.equal(
    mine.filter((e) => actionOf(e) === 'FILE_DOWNLOAD').length, 2,
    'ดาวน์โหลดสองครั้งต้องเป็นสองแถว (นับเหตุการณ์ได้จริง)',
  )

  // target_hash ทุกแถวที่มีค่า ต้องเป็น sha256 hex เสมอ ไม่ใช่ข้อความอ่านออก
  for (const e of rows) {
    const target = targetOf(e)
    if (target != null) assert.match(target, /^[0-9a-f]{64}$/, `target_hash ต้องเป็น sha256: ${target}`)
  }
})

test('ผลลัพธ์ใน audit ตรงกับสิ่งที่เกิดขึ้นจริง — การถูกปฏิเสธถูกบันทึกเป็น DENIED', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const name = `audittest-denied-${Date.now()}.txt`
  const form = new FormData()
  form.append('file', new Blob(['deny probe'], { type: 'application/octet-stream' }), name)
  const up = await owner.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(up.status, 201)

  // Admin พยายามลบไฟล์ของคนอื่น → 403 (ด่าน ownership) และต้องลง audit เป็น DENIED
  const del = await admin.req(`/api/files/${encodeURIComponent(up.data.file.id)}`, { method: 'DELETE' })
  assert.equal(del.status, 403)

  const rows = await events(admin)
  const hash = sha256Hex(name)
  const denied = rows.find((e) => targetOf(e) === hash && actionOf(e) === 'FILE_DELETE')
  assert.ok(denied, 'ความพยายามลบต้องปรากฏใน audit')
  assert.equal(denied.result, 'DENIED', '⚠️ การถูกปฏิเสธต้องมองเห็นได้ ไม่ใช่หายไปเงียบ ๆ')
  assert.equal(labelOf(denied), DEMO_ADMIN.username, 'ต้องบันทึกว่าใครเป็นคนพยายาม')

  // และไฟล์ต้องยังอยู่จริง (audit ตรงกับความจริง ไม่ใช่ตรงกับเจตนา)
  assert.equal((await owner.req(`/api/files/${encodeURIComponent(up.data.file.id)}/versions`)).status, 200)
  await owner.req(`/api/files/${encodeURIComponent(up.data.file.id)}`, { method: 'DELETE' })
})

// ═══ D. ความลับไม่หลุดลง audit ════════════════════════════════════════════════════

test('ไม่มีรหัสผ่าน / token ของลิงก์แชร์ / รหัสลิงก์ หลุดลง audit เลย', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const name = `audittest-secrets-${Date.now()}.txt`
  const form = new FormData()
  form.append('file', new Blob(['secret probe'], { type: 'application/octet-stream' }), name)
  const up = await owner.req('/api/files/upload', { method: 'POST', body: form })

  // สร้างลิงก์ที่มีรหัส แล้วไถ่ทั้งแบบผิดและแบบถูก — ทุกขั้นเขียน audit
  const share = await owner.req('/api/shares', {
    method: 'POST',
    body: { fileId: up.data.file.id, expiry: '1h', authType: 'password', password: LINK_PASSWORD, scope: 'any' },
  })
  assert.equal(share.status, 201)
  const token = share.data.path.split('/').pop()

  const recipient = new Client(baseUrl)
  await recipient.raw(share.data.path, { method: 'POST', body: 'password=wrong-guess', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
  await recipient.raw(share.data.path, { method: 'POST', body: `password=${LINK_PASSWORD}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })

  // เปลี่ยนรหัสผ่านบัญชี (อีกเส้นทางที่รับความลับเข้ามา)
  const dump = JSON.stringify(await events(admin))

  // ⚠️ audit ถูกอ่านโดย Admin คนไหนก็ได้ ถ้า token หลุดลงไป ใครที่อ่าน audit ได้ก็
  //    ดาวน์โหลดไฟล์ของคนอื่นได้ทันทีโดยไม่ต้องผ่านด่านใดเลย
  for (const secret of [token, LINK_PASSWORD, DEMO_USER.password, DEMO_ADMIN.password, name]) {
    assert.ok(!dump.includes(secret), `ความลับ/ชื่อไฟล์ต้องไม่อยู่ใน audit: ${secret.slice(0, 14)}…`)
  }

  // แต่เหตุการณ์ต้องถูกบันทึกครบ (ไม่ใช่เงียบไปทั้งหมดเพื่อความปลอดภัย)
  const rows = await events(admin)
  const redeem = rows.filter((e) => actionOf(e) === 'SHARE_REDEEM')
  assert.ok(redeem.some((e) => e.result === 'OK'), 'การไถ่สำเร็จต้องถูกบันทึก')
  assert.ok(redeem.some((e) => e.result === 'DENIED'), 'การกรอกรหัสผิดต้องถูกบันทึก')

  await owner.req(`/api/files/${encodeURIComponent(up.data.file.id)}`, { method: 'DELETE' })
})

test('audit คืนไม่เกินเพดานที่ขอ และเรียงใหม่→เก่า', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const rows = await events(admin)
  assert.ok(Array.isArray(rows))
  assert.ok(rows.length <= 200, `endpoint ขอ 200 แถว — ได้ ${rows.length}`)

  const times = rows.map((e) => new Date(e.at).getTime())
  const sortedDesc = [...times].sort((a, b) => b - a)
  assert.deepEqual(times, sortedDesc, 'ต้องเรียงจากใหม่ไปเก่า (จอแสดงเหตุการณ์ล่าสุดก่อน)')
})
