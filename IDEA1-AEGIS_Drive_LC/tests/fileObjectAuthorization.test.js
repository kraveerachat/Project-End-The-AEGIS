// tests/fileObjectAuthorization.test.js — AEGIS Drive (IDEA1) · Broken Object Level
// Authorization (IDOR) บนไฟล์ปกติ — ยืนยันบั๊กที่พบใน production และพิสูจน์ว่าถูกปิดแล้ว
//
// ยิงผ่าน Express app ตัวเดียวกับ production (server/app.js) — ไม่มีการ mock
// แบบแผนเดียวกับ tests/filesOwnership.test.js (ซึ่งพิสูจน์เฉพาะ DELETE อยู่แล้ว)
//
// สิ่งที่ชุดนี้พิสูจน์ (บั๊กที่ยืนยันแล้วใน production — FT-1):
//   A. GET /api/files คืนเฉพาะไฟล์ "ของผู้ใช้ที่เรียก" เท่านั้น — เดิมคืนของทุกคน
//   B. POST /files/:id/verify ข้ามเจ้าของไม่ได้ — เดิมตรวจ checksum ไฟล์คนอื่นได้ถ้ารู้ id
//   C. GET /files/:id/download ข้ามเจ้าของไม่ได้ — เดิมดาวน์โหลดไฟล์คนอื่นได้ถ้ารู้ id
//   D. ทั้งสอง role (Admin/DataLake-User) โดนด่านเดียวกัน — ไม่มีข้อยกเว้นให้ Admin
//   E. DELETE และ file-version routes (owner-only เดิม) ต้องไม่ถูกทำให้อ่อนลง
//   F. POST /api/shares ข้ามเจ้าของไม่ได้ — เดิมสร้างลิงก์สาธารณะของไฟล์คนอื่นได้ถ้ารู้ id
//   G. RBAC เดิมที่ถูกต้องอยู่แล้วต้องไม่เปลี่ยน: DataLake-User อ่าน /api/users ไม่ได้
//      (403) แต่อ่าน /api/files ได้ (200 — แต่ข้อมูลต้องเป็นของตัวเองเท่านั้น)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-objauth-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[file object authorization tests] database mode: ${DB_MODE}`)

let nameSeq = 0
const uniqueName = (label) => `objauth-${label}-${Date.now()}-${nameSeq++}.txt`

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
    await query(`DELETE FROM files WHERE name LIKE 'objauth-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

async function upload(client, { name, content }) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `อัปโหลดล้มเหลว: ${JSON.stringify(res.data)}`)
  return res.data.file
}

const findById = (list, id) => list.find((f) => String(f.id) === String(id)) ?? null

/** สอง user คนละ role พร้อมไฟล์คนละไฟล์ — ใช้ซ้ำในเกือบทุกเคสของชุดนี้ */
async function twoOwnersWithFiles() {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const adminFile = await upload(admin, { name: uniqueName('admin-file'), content: 'owned by Admin — must stay private to Admin' })
  const userFile = await upload(user, { name: uniqueName('user-file'), content: 'owned by DataLake-User — must stay private to DataLake-User' })
  return { admin, user, adminFile, userFile }
}

// ═══ A. LISTING — GET /api/files คืนเฉพาะไฟล์ของผู้เรียกเท่านั้น ═══════════════════
test('LISTING: แต่ละ role เห็นเฉพาะไฟล์ของตัวเอง ไม่เห็นไฟล์ของอีกฝ่าย', async () => {
  const { admin, user, adminFile, userFile } = await twoOwnersWithFiles()

  const adminList = (await admin.req('/api/files')).data.files
  assert.ok(findById(adminList, adminFile.id), 'Admin ต้องเห็นไฟล์ของตัวเอง')
  assert.equal(findById(adminList, userFile.id), null, 'Admin ต้องไม่เห็นไฟล์ของ DataLake-User')

  const userList = (await user.req('/api/files')).data.files
  assert.ok(findById(userList, userFile.id), 'DataLake-User ต้องเห็นไฟล์ของตัวเอง')
  assert.equal(findById(userList, adminFile.id), null, 'DataLake-User ต้องไม่เห็นไฟล์ของ Admin')

  await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })
  await user.req(`/api/files/${encodeURIComponent(userFile.id)}`, { method: 'DELETE' })
})

// ═══ C. DOWNLOAD — ทั้งสองทิศทาง ═══════════════════════════════════════════════
test('DOWNLOAD: เจ้าของดาวน์โหลดได้ปกติ ข้ามเจ้าของถูกปฏิเสธทั้งสองทิศทาง', async () => {
  const { admin, user, adminFile, userFile } = await twoOwnersWithFiles()

  const ownOk1 = await admin.raw(`/api/files/${encodeURIComponent(adminFile.id)}/download`)
  assert.equal(ownOk1.status, 200, 'Admin ต้องดาวน์โหลดไฟล์ตัวเองได้')
  const ownOk2 = await user.raw(`/api/files/${encodeURIComponent(userFile.id)}/download`)
  assert.equal(ownOk2.status, 200, 'DataLake-User ต้องดาวน์โหลดไฟล์ตัวเองได้')

  // Admin → ไฟล์ของ DataLake-User: ต้องถูกปฏิเสธ (พิสูจน์ว่า Admin ไม่มี override)
  const adminToUser = await admin.raw(`/api/files/${encodeURIComponent(userFile.id)}/download`)
  assert.equal(adminToUser.status, 404, 'Admin ต้องดาวน์โหลดไฟล์ของ DataLake-User ไม่ได้')

  // DataLake-User → ไฟล์ของ Admin: ต้องถูกปฏิเสธ
  const userToAdmin = await user.raw(`/api/files/${encodeURIComponent(adminFile.id)}/download`)
  assert.equal(userToAdmin.status, 404, 'DataLake-User ต้องดาวน์โหลดไฟล์ของ Admin ไม่ได้')

  await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })
  await user.req(`/api/files/${encodeURIComponent(userFile.id)}`, { method: 'DELETE' })
})

// ═══ B. VERIFY — ทั้งสองทิศทาง ══════════════════════════════════════════════════
test('VERIFY: เจ้าของตรวจ checksum ได้ปกติ ข้ามเจ้าของถูกปฏิเสธทั้งสองทิศทาง', async () => {
  const { admin, user, adminFile, userFile } = await twoOwnersWithFiles()

  const ownOk1 = await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}/verify`, { method: 'POST' })
  assert.equal(ownOk1.status, 200, 'Admin ต้องตรวจไฟล์ตัวเองได้')
  assert.equal(ownOk1.data?.match, true)

  const ownOk2 = await user.req(`/api/files/${encodeURIComponent(userFile.id)}/verify`, { method: 'POST' })
  assert.equal(ownOk2.status, 200, 'DataLake-User ต้องตรวจไฟล์ตัวเองได้')
  assert.equal(ownOk2.data?.match, true)

  const adminToUser = await admin.req(`/api/files/${encodeURIComponent(userFile.id)}/verify`, { method: 'POST' })
  assert.equal(adminToUser.status, 404, 'Admin ต้องตรวจไฟล์ของ DataLake-User ไม่ได้')

  const userToAdmin = await user.req(`/api/files/${encodeURIComponent(adminFile.id)}/verify`, { method: 'POST' })
  assert.equal(userToAdmin.status, 404, 'DataLake-User ต้องตรวจไฟล์ของ Admin ไม่ได้')

  await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })
  await user.req(`/api/files/${encodeURIComponent(userFile.id)}`, { method: 'DELETE' })
})

// ═══ ความพยายามข้ามเจ้าของถูกบันทึกลง audit เป็น DENIED (verify + download) ══════════
test('ความพยายามข้ามเจ้าของบน verify/download ถูกบันทึกลง audit เป็น DENIED', async () => {
  const { admin, user, adminFile } = await twoOwnersWithFiles()
  const { readAudit } = await import('../server/db/connection.js')

  await user.req(`/api/files/${encodeURIComponent(adminFile.id)}/verify`, { method: 'POST' })
  await user.raw(`/api/files/${encodeURIComponent(adminFile.id)}/download`)

  const events = await readAudit(50)
  const label = (e) => e.actor_label ?? e.actorLabel
  const deniedVerify = events.find(
    (e) => e.action === 'FILE_VERIFY' && e.result === 'DENIED' && label(e) === DEMO_USER.username,
  )
  const deniedDownload = events.find(
    (e) => e.action === 'FILE_DOWNLOAD' && e.result === 'DENIED' && label(e) === DEMO_USER.username,
  )
  assert.ok(deniedVerify, 'audit ต้องมีแถว FILE_VERIFY / DENIED ของผู้ที่พยายามข้ามเจ้าของ')
  assert.ok(deniedDownload, 'audit ต้องมีแถว FILE_DOWNLOAD / DENIED ของผู้ที่พยายามข้ามเจ้าของ')

  await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })
})

// ═══ E. DELETE (preserve) — ต้องไม่ถูกทำให้อ่อนลง ═══════════════════════════════
test('preserve — DELETE: เจ้าของลบได้ปกติ ข้ามเจ้าของ (รวม Admin) ถูกปฏิเสธด้วย 403', async () => {
  const { admin, user, adminFile, userFile } = await twoOwnersWithFiles()

  const adminDeniedOnUser = await admin.req(`/api/files/${encodeURIComponent(userFile.id)}`, { method: 'DELETE' })
  assert.equal(adminDeniedOnUser.status, 403, 'Admin ต้องลบไฟล์ของ DataLake-User ไม่ได้ (ไม่มี override)')

  const userDeniedOnAdmin = await user.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })
  assert.equal(userDeniedOnAdmin.status, 403, 'DataLake-User ต้องลบไฟล์ของ Admin ไม่ได้')

  assert.equal((await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })).status, 200)
  assert.equal((await user.req(`/api/files/${encodeURIComponent(userFile.id)}`, { method: 'DELETE' })).status, 200)
})

// ═══ E. VERSIONS (preserve) — regression: ยังเป็น owner-only เหมือนเดิม ═══════════
test('preserve — VERSIONS: ประวัติไฟล์ยังเป็นของเจ้าของเท่านั้น ไม่มีข้อยกเว้นให้ Admin', async () => {
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const name = uniqueName('versioned')
  await upload(user, { name, content: 'v1' })
  const file = await upload(user, { name, content: 'v2' }) // อัปโหลดชื่อเดิมทับ = สร้างเวอร์ชัน
  const versions = (await user.req(`/api/files/${encodeURIComponent(file.id)}/versions`)).data
  const versionId = versions.versions[0]?.id
  assert.ok(versionId, 'ต้องมีเวอร์ชันให้ทดสอบ')

  assert.equal(
    (await admin.req(`/api/files/${encodeURIComponent(file.id)}/versions`)).status, 404,
    'Admin อ่านประวัติของไฟล์คนอื่นไม่ได้',
  )
  assert.equal(
    (await admin.raw(`/api/files/${encodeURIComponent(file.id)}/versions/${versionId}/download`)).status, 404,
    'Admin ดาวน์โหลดเวอร์ชันเก่าของไฟล์คนอื่นไม่ได้',
  )
  assert.equal(
    (await admin.req(`/api/files/${encodeURIComponent(file.id)}/versions/${versionId}/restore`, { method: 'POST' })).status, 404,
    'Admin กู้คืนเวอร์ชันของไฟล์คนอื่นไม่ได้',
  )

  // เจ้าของยังใช้งานได้ปกติ — ด่านที่มีอยู่เดิมต้องไม่พังฟีเจอร์
  assert.equal((await user.req(`/api/files/${encodeURIComponent(file.id)}/versions`)).status, 200)

  await user.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
})

// ═══ F. SHARE — สร้างลิงก์แชร์ของไฟล์คนอื่นไม่ได้แม้รู้ id ═══════════════════════════
test('SHARE: สร้างลิงก์แชร์ของไฟล์ตัวเองได้ปกติ แต่สร้างของไฟล์คนอื่นไม่ได้แม้รู้ id', async () => {
  const { admin, user, adminFile, userFile } = await twoOwnersWithFiles()

  // เจ้าของสร้างลิงก์ของไฟล์ตัวเองได้ตามปกติ — ด่านใหม่ต้องไม่พังฟีเจอร์
  const ownShare = await user.req('/api/shares', {
    method: 'POST', body: { fileId: userFile.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(ownShare.status, 201, 'เจ้าของต้องสร้างลิงก์แชร์ไฟล์ตัวเองได้')
  await user.req(`/api/shares/${ownShare.data.share.id}`, { method: 'DELETE' })

  // ── การโจมตี: user (ไม่ใช่เจ้าของ) ระบุ id ไฟล์ของ admin เพื่อสร้างลิงก์สาธารณะ ──
  const crossFromUser = await user.req('/api/shares', {
    method: 'POST', body: { fileId: adminFile.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(crossFromUser.status, 400, 'DataLake-User ต้องสร้างลิงก์แชร์ของไฟล์ Admin ไม่ได้')
  assert.equal(crossFromUser.data?.share, undefined, 'ต้องไม่มีลิงก์ถูกสร้างขึ้นจริง')

  // ── ทิศทางกลับกัน: Admin ก็ไม่มี override เหนือไฟล์ของ DataLake-User เช่นกัน ──
  const crossFromAdmin = await admin.req('/api/shares', {
    method: 'POST', body: { fileId: userFile.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(crossFromAdmin.status, 400, 'Admin ต้องสร้างลิงก์แชร์ของไฟล์ DataLake-User ไม่ได้ (ไม่มี override)')

  // ไม่มีลิงก์ที่ไถ่ได้ของไฟล์เหล่านี้หลงเหลืออยู่จากความพยายามที่ถูกปฏิเสธ
  const remaining = (await user.req('/api/shares')).data.shares
  assert.equal(
    remaining.some((s) => String(s.fileId) === String(adminFile.id) || String(s.fileId) === String(userFile.id)),
    false,
    'ความพยายามที่ถูกปฏิเสธต้องไม่ทิ้งลิงก์ที่ไถ่ได้ไว้',
  )

  await admin.req(`/api/files/${encodeURIComponent(adminFile.id)}`, { method: 'DELETE' })
  await user.req(`/api/files/${encodeURIComponent(userFile.id)}`, { method: 'DELETE' })
})

// ═══ G. RBAC ตรงที่พิสูจน์แล้วว่าถูกต้องอยู่แล้ว ต้องไม่เปลี่ยน ═══════════════════════
test('preserve — RBAC: DataLake-User อ่าน /api/users ไม่ได้ (403) แต่อ่าน /api/files ได้ (200, ข้อมูลของตัวเองเท่านั้น)', async () => {
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)

  const usersRes = await user.req('/api/users')
  assert.equal(usersRes.status, 403, 'DataLake-User ต้องอ่าน /api/users ไม่ได้')

  const filesRes = await user.req('/api/files')
  assert.equal(filesRes.status, 200, 'DataLake-User ต้องอ่าน /api/files ได้ (แค่ข้อมูลต้องถูกกรอง)')
  assert.ok(Array.isArray(filesRes.data?.files), 'ต้องได้อาเรย์ไฟล์กลับมา')
})
