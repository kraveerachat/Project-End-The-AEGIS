// tests/filesCreatedTimestamp.test.js — FILES-MANAGEMENT-UX-1 · Round 9 · "Uploaded" = created_at
//
// ⚠️ การเรียงตาม "วันอัปโหลด" ต้องมาจากคอลัมน์ files.created_at ที่คงทนในฐานข้อมูล —
//    ไม่ใช่เวลาที่จอโหลด ไม่ใช่ชื่อไฟล์ ไม่ใช่ mtime บนดิสก์ และต้อง "ไม่ขยับ" เมื่อเปลี่ยนชื่อ
//    หรือย้าย (ซึ่งเปลี่ยน modified_at) — ไม่งั้นการเรียงจะเล่าเรื่องผิดว่าไฟล์เพิ่งถูกอัปโหลด
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-created-ts-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

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
    await query(`DELETE FROM files WHERE name LIKE 'created-ts-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listOf(client, id) {
  const res = await client.req('/api/files')
  assert.equal(res.status, 200)
  const row = res.data.files.find((f) => f.id === id)
  assert.ok(row, 'ต้องพบแถวใน GET /api/files')
  return row
}

test('R9-DTO-1 · GET /api/files exposes a numeric `created` for files and folders, from the durable row', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const before = Date.now()
  const form = new FormData()
  form.append('file', new Blob(['payload']), `created-ts-${stamp()}.txt`)
  const up = await c.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(up.status, 201)
  const folder = await c.req('/api/files/folder', { method: 'POST', body: { name: `created-ts-${stamp()}` } })
  assert.equal(folder.status, 201)
  const after = Date.now()

  for (const id of [up.data.file.id, folder.data.file.id]) {
    const row = await listOf(c, id)
    assert.equal(typeof row.created, 'number', 'created ต้องเป็น epoch ms')
    assert.ok(row.created >= before - 1000 && row.created <= after + 1000, `created ${row.created} ต้องอยู่ในช่วงเวลาที่สร้างจริง`)
    assert.ok(row.created <= row.modified, 'สร้างต้องไม่หลัง modified')
  }
})

test('R9-DTO-2 · rename and move advance `modified` but never touch `created`', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const form = new FormData()
  form.append('file', new Blob(['payload']), `created-ts-${stamp()}.txt`)
  const up = await c.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(up.status, 201)
  const id = up.data.file.id
  const first = await listOf(c, id)
  await sleep(15)

  const renamed = await c.req(`/api/files/${id}`, { method: 'PATCH', body: { name: `created-ts-${stamp()}-renamed.txt` } })
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data))
  const afterRename = await listOf(c, id)
  assert.equal(afterRename.created, first.created, 'เปลี่ยนชื่อต้องไม่เปลี่ยนวันอัปโหลด')
  assert.ok(afterRename.modified >= first.modified)

  const folder = await c.req('/api/files/folder', { method: 'POST', body: { name: `created-ts-${stamp()}` } })
  await sleep(15)
  const moved = await c.req('/api/files/move', { method: 'POST', body: { ids: [id], parentId: folder.data.file.id } })
  assert.equal(moved.status, 200, JSON.stringify(moved.data))
  const res = await c.req(`/api/files?parentId=${encodeURIComponent(folder.data.file.id)}`)
  const inFolder = res.data.files.find((f) => f.id === id)
  assert.ok(inFolder)
  assert.equal(inFolder.created, first.created, 'ย้ายต้องไม่เปลี่ยนวันอัปโหลด')
  assert.ok(inFolder.modified >= afterRename.modified)
})

test('R9-DTO-3 · in PostgreSQL `created` is exactly files.created_at', { skip: usingPostgres ? false : 'requires TEST_DATABASE_URL (PostgreSQL)' }, async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const form = new FormData()
  form.append('file', new Blob(['payload']), `created-ts-${stamp()}.txt`)
  const up = await c.req('/api/files/upload', { method: 'POST', body: form })
  const id = up.data.file.id
  // ย้อนเวลา created_at ในฐานข้อมูลโดยตรง แล้ว DTO ต้องสะท้อนค่านั้น ไม่ใช่ค่าที่คำนวณเอง
  await query(`UPDATE files SET created_at = now() - interval '3 days' WHERE id = $1`, [id])
  const { rows: [db] } = await query('SELECT created_at, modified_at FROM files WHERE id = $1', [id])
  const row = await listOf(c, id)
  assert.equal(row.created, new Date(db.created_at).getTime())
  assert.equal(row.modified, new Date(db.modified_at).getTime())
  assert.ok(row.created < row.modified - 2 * 24 * 3600 * 1000)
})
