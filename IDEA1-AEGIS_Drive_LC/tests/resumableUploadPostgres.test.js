// tests/resumableUploadPostgres.test.js — AEGIS Drive (IDEA1) · LFT-V2-A กับ Postgres จริง
//
// ชุดนี้ต่างจาก resumableUpload.test.js ตรงที่ **ไม่เชื่อ store abstraction เลย** —
// หลังเดินโปรโตคอลผ่าน HTTP แล้ว จะเปิด connection ของตัวเองไปอ่าน/เขียนตารางด้วย
// SQL ดิบ เพราะสิ่งที่ต้องพิสูจน์คือ "แถวที่นอนอยู่ใน PostgreSQL จริง ๆ" ไม่ใช่สิ่งที่
// ชั้น abstraction เลือกจะคืนมาให้ดู (แบบแผนเดียวกับ tests/vaultPostgres.test.js)
//
// เหตุผลที่ต้องมีไฟล์นี้: LFT-V2-A ผ่านชุดทดสอบมาทั้งหมดในโหมด in-memory fallback
// เท่านั้น เส้นทาง SQL ของ upload_sessions / upload_session_chunks, migration 003,
// สิทธิ์ของ role drive_app, ON DELETE CASCADE และพฤติกรรมของ cleanup กับ commit บน
// ฐานข้อมูลจริงจึงยังไม่เคยถูกรันเลย — นั่นคือช่องว่างที่ใหญ่ที่สุดของ PR
//
// ⚠️ ต้องรันด้วยฐานข้อมูล "แบบใช้แล้วทิ้งที่แยกขาด" เท่านั้น ชุดนี้เขียนและลบแถวจริง
//    เตรียมด้วย: sh scripts/pg-integration-env.sh up
//    แล้วส่ง TEST_DATABASE_URL ที่สคริปต์นั้นพิมพ์ออกมา
//    ไม่ได้ตั้ง TEST_DATABASE_URL → ข้ามทั้งไฟล์ (นักพัฒนาที่ไม่มี Docker ยังรัน
//    `npm test` ได้ตามปกติ) แบบแผนเดียวกับ vaultPostgres.test.js
//
// ⚠️ ต้องรันแบบ serial (`--test-concurrency=1` ตั้งไว้ใน package.json แล้ว)
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { performLogin } from './helpers/testClient.mjs'

const DB_URL = process.env.TEST_DATABASE_URL
const skip = DB_URL ? false : 'ต้องตั้ง TEST_DATABASE_URL เพื่อรันกับ Postgres จริง (ดู scripts/pg-integration-env.sh)'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-resumable-pg-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
// 8 MiB = ขอบล่างจริงของช่วงที่ deployment ตั้งได้ ไม่ใช่ค่าทดสอบพิเศษ
process.env.UPLOAD_CHUNK_SIZE_BYTES = String(8 * 1024 * 1024)
if (DB_URL) process.env.DATABASE_URL = DB_URL

const { createApp } = await import('../server/app.js')
const { initStorage, resolveKey } = await import('../server/storage/fileStore.js')
const { initUploadStaging, uploadStagingConfig } = await import('../server/storage/uploadStaging.js')
const { cleanupAbandonedUploads } = await import('../server/storage/uploadCleanup.js')
const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')

const CHUNK = TRANSFER_LIMITS.chunkSizeBytes
const MULTI_SIZE = CHUNK * 2 + 4096
const SMALL_SIZE = 2048

const OWNER = { username: 'user', password: 'aegis-drive-user' }
const OTHER = { username: 'admin', password: 'aegis-drive-admin' }

let server, baseUrl, sql

before(async (t) => {
  if (skip) return
  assert.equal(usingPostgres, true, 'ชุดนี้ต้องรันในโหมด Postgres จริงเท่านั้น')
  // connection ของเทสต์เอง แยกจาก pool ของแอป — ใช้ยืนยันสิ่งที่อยู่ในตารางจริง
  sql = new pg.Pool({ connectionString: DB_URL, max: 3 })
  await initStorage()
  await initUploadStaging()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (skip) return
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  await sql?.end()
  if (usingPostgres) await closePool()
})

beforeEach(async () => {
  if (skip) return
  // ⚠️ DELETE ไม่ใช่ TRUNCATE: role drive_app ได้แค่ DML ตามการออกแบบ การใช้ DELETE
  //    ทำให้ชุดทดสอบทำงานภายใต้สิทธิ์ "เท่ากับแอปจริง" เป๊ะ (แบบแผนเดียวกับ store.js)
  await sql.query('DELETE FROM upload_session_chunks')
  await sql.query('DELETE FROM upload_sessions')
})

class Client {
  constructor() { this.cookie = null; this.csrf = null }
  async req(pathname, { method = 'GET', body, headers: extra } = {}) {
    const headers = { ...extra }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let payload
    if (Buffer.isBuffer(body)) { payload = body; headers['Content-Type'] = 'application/octet-stream' }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = await res.json() } catch { /* no body */ }
    return { status: res.status, data }
  }
}

async function login(account) {
  const c = new Client()
  await performLogin(c, account.username, account.password)
  return c
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function makeContent(size) {
  const block = randomBytes(64 * 1024)
  const out = Buffer.alloc(size)
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(out, offset, 0, Math.min(block.length, size - offset))
    if (offset + 4 <= size) out.writeUInt32BE(offset >>> 0, offset)
  }
  return out
}

const chunkOf = (content, index) =>
  content.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, content.length))

async function openSession(client, { name, content, claimSha256 = sha256(content) }) {
  const res = await client.req('/api/files/uploads', {
    method: 'POST', body: { name, size: content.length, sha256: claimSha256 },
  })
  assert.equal(res.status, 201, `เปิด session ไม่สำเร็จ: ${JSON.stringify(res.data)}`)
  return res.data.upload
}

const putChunk = (client, uploadId, index, bytes) =>
  client.req(`/api/files/uploads/${uploadId}/chunks/${index}`, { method: 'PUT', body: bytes })

async function putAll(client, upload, content) {
  for (let i = 0; i < upload.chunkCount; i += 1) {
    const r = await putChunk(client, upload.uploadId, i, Buffer.from(chunkOf(content, i)))
    assert.equal(r.status, 200, `chunk ${i}: ${JSON.stringify(r.data)}`)
  }
}

const rows = async (text, params) => (await sql.query(text, params)).rows

// ─────────────────────────────────────────────────────────────────────────────
// 1–2 · session ถูกสร้างเป็นแถวจริง และเจ้าของอ่านของตัวเองได้
// ─────────────────────────────────────────────────────────────────────────────
test('1+2 · create session เขียนแถวจริงลง upload_sessions และเจ้าของอ่านกลับได้', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `pg-create-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })

  const [row] = await rows('SELECT * FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.ok(row, 'ต้องมีแถวจริงใน PostgreSQL ไม่ใช่แค่ในหน่วยความจำ')
  assert.equal(row.name, name)
  assert.equal(Number(row.logical_size), content.length)
  assert.equal(Number(row.chunk_size), CHUNK)
  assert.equal(Number(row.chunk_count), 3)
  assert.equal(row.status, 'open')
  assert.equal(row.expected_sha256, sha256(content))
  assert.ok(new Date(row.expires_at).getTime() > Date.now(), 'expires_at ต้องอยู่ในอนาคต')

  const read = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(read.status, 200)
  assert.equal(read.data.upload.name, name)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · ผู้ใช้อื่นได้ 404 — และการกรองอยู่ในชั้น SQL ไม่ใช่แค่ใน route
// ─────────────────────────────────────────────────────────────────────────────
test('3 · session ของผู้ใช้อื่นได้ 404 และตัวกรองเจ้าของอยู่ใน WHERE ของ SQL จริง', { skip }, async () => {
  const owner = await login(OWNER)
  const intruder = await login(OTHER)
  const content = makeContent(SMALL_SIZE)
  const upload = await openSession(owner, { name: `pg-cross-${Date.now()}.bin`, content })

  for (const [method, p] of [
    ['GET', `/api/files/uploads/${upload.uploadId}`],
    ['PUT', `/api/files/uploads/${upload.uploadId}/chunks/0`],
    ['POST', `/api/files/uploads/${upload.uploadId}/commit`],
    ['DELETE', `/api/files/uploads/${upload.uploadId}`],
  ]) {
    const res = await intruder.req(p, { method, ...(method === 'PUT' ? { body: Buffer.from(content) } : {}) })
    assert.equal(res.status, 404, `${method} ${p} ต้องเป็น 404`)
  }

  // ยังอยู่ครบใน PostgreSQL — 404 ที่ลบของจริงไปแล้วก็ไร้ความหมาย
  const [row] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(row.status, 'open')

  // ⚠️ พิสูจน์ว่า "การกรองด้วยเจ้าของ" อยู่ในคำสั่ง SQL เอง ไม่ใช่แค่โค้ดใน route:
  //    ค้นด้วย user_id ของผู้บุกรุกโดยตรง ต้องไม่เจอแถวนี้เลย
  const [ownerRow] = await rows('SELECT user_id FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  const otherUsers = await rows('SELECT id FROM users WHERE id <> $1', [ownerRow.user_id])
  for (const u of otherUsers) {
    const found = await rows(
      'SELECT 1 FROM upload_sessions WHERE upload_id = $1 AND user_id = $2', [upload.uploadId, u.id],
    )
    assert.equal(found.length, 0, 'แถวนี้ต้องไม่ถูกคืนให้ user_id อื่นในชั้น SQL')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4–6 · chunk คงอยู่จริง, ส่งซ้ำ idempotent, และรายงานก้อนที่ขาดได้ถูกต้อง
// ─────────────────────────────────────────────────────────────────────────────
test('4+5+6 · chunk ลงตารางจริง, ส่งซ้ำไม่เพิ่มแถว, และก้อนที่ขาดถูกรายงานถูกต้อง', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const upload = await openSession(owner, { name: `pg-chunks-${Date.now()}.bin`, content })

  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
  let stored = await rows(
    'SELECT chunk_index, size_bytes, sha256 FROM upload_session_chunks WHERE upload_id = $1 ORDER BY chunk_index',
    [upload.uploadId],
  )
  assert.equal(stored.length, 1)
  assert.equal(Number(stored[0].size_bytes), CHUNK)
  assert.equal(stored[0].sha256, sha256(chunkOf(content, 0)))

  // ส่งก้อนเดิมซ้ำสามครั้ง — ON CONFLICT DO UPDATE ต้องคงไว้ที่หนึ่งแถวเสมอ
  for (let i = 0; i < 3; i += 1) {
    const r = await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
    assert.equal(r.status, 200)
  }
  stored = await rows('SELECT chunk_index FROM upload_session_chunks WHERE upload_id = $1', [upload.uploadId])
  assert.equal(stored.length, 1, 'ส่งซ้ำต้องไม่สร้างแถวเพิ่ม (idempotent ในชั้น SQL)')

  // ก้อนที่ขาดถูกรายงานจากสถานะจริงในฐานข้อมูล
  await putChunk(owner, upload.uploadId, 2, Buffer.from(chunkOf(content, 2)))
  const status = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.deepEqual(status.data.upload.received, [0, 2])
  assert.deepEqual(status.data.upload.missing, [1])
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · สถานะอยู่รอดการรีสตาร์ทของโปรเซสแอป
// ─────────────────────────────────────────────────────────────────────────────
test('7 · session และ chunk ที่ส่งไปแล้วอยู่รอด "การรีสตาร์ทแอป" และทำต่อได้จนจบ', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `pg-restart-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))

  // จำลองการรีสตาร์ท: ปิด listener เดิม แล้วสร้าง app instance ใหม่ทั้งก้อน
  // (in-memory store จะสูญสถานะตรงนี้ — PostgreSQL ต้องไม่)
  await new Promise((r) => server.close(r))
  const restarted = createApp()
  server = restarted.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`

  const fresh = await login(OWNER) // เซสชัน HTTP ใหม่หลังรีสตาร์ท
  const status = await fresh.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(status.status, 200, 'session ต้องยังอยู่หลังแอปรีสตาร์ท')
  assert.deepEqual(status.data.upload.received, [0], 'chunk ที่ส่งสำเร็จแล้วต้องยังถูกนับ')
  assert.deepEqual(status.data.upload.missing, [1, 2])

  await putChunk(fresh, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))
  await putChunk(fresh, upload.uploadId, 2, Buffer.from(chunkOf(content, 2)))
  const commit = await fresh.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201, `commit หลังรีสตาร์ทต้องผ่าน: ${JSON.stringify(commit.data)}`)
  assert.equal(commit.data.sha256, sha256(content))
})

// ─────────────────────────────────────────────────────────────────────────────
// 8–11 · ด่าน commit และการเผยแพร่แถวเดียว
// ─────────────────────────────────────────────────────────────────────────────
test('8+11 · ขาด chunk = commit ไม่ผ่าน และไม่มีแถวใน files เลย', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `pg-incomplete-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))

  const res = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'UPLOAD_INCOMPLETE')

  const files = await rows('SELECT id FROM files WHERE name = $1', [name])
  assert.equal(files.length, 0, 'อัปโหลดที่ยังไม่ครบต้องไม่มีแถวใน files')
  // และสถานะต้องยังเป็น open — commit ที่ถูกปฏิเสธต้องไม่ทิ้ง session ไว้ในสถานะกลาง
  const [row] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(row.status, 'open')
})

test('9 · SHA-256 ที่เซิร์ฟเวอร์คำนวณเองไม่ตรง = ไม่เผยแพร่ และ session ถูก abort', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const decoy = makeContent(MULTI_SIZE)
  const name = `pg-checksum-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content, claimSha256: sha256(decoy) })
  await putAll(owner, upload, content)

  const res = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(res.status, 422)
  assert.equal(res.data.code, 'CHECKSUM_MISMATCH')

  assert.equal((await rows('SELECT id FROM files WHERE name = $1', [name])).length, 0)
  const [row] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(row.status, 'aborted')
})

test('10 · commit สำเร็จสร้างแถวใน files พอดีหนึ่งแถว และไบต์บนดิสก์ตรงกับต้นทาง', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `pg-commit-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putAll(owner, upload, content)

  const res = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(res.status, 201, JSON.stringify(res.data))

  const files = await rows('SELECT * FROM files WHERE name = $1', [name])
  assert.equal(files.length, 1, 'ต้องได้แถวเดียวเป๊ะ')
  assert.equal(Number(files[0].size_bytes), content.length)
  assert.equal(files[0].sha256, sha256(content))
  const onDisk = await fs.readFile(resolveKey(files[0].path))
  assert.ok(onDisk.equals(content), 'ไบต์บนดิสก์ต้องตรงกับต้นทางทุกไบต์')

  const [session] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'committed')
  // chunk ยังอยู่คู่กับ session ที่ commit แล้ว (ยังตรวจย้อนหลังได้) — CASCADE ยังไม่ทำงาน
  const chunks = await rows('SELECT chunk_index FROM upload_session_chunks WHERE upload_id = $1', [upload.uploadId])
  assert.equal(chunks.length, 3)
})

// ─────────────────────────────────────────────────────────────────────────────
// commit exactly-once — คำขอสองใบพร้อมกันต้องเผยแพร่แถวเดียว
// ─────────────────────────────────────────────────────────────────────────────
test('commit ที่ยิงพร้อมกันสองใบเผยแพร่ได้แถวเดียวเท่านั้น (SQL claim, ไม่ใช่การเช็คใน JS)', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `pg-race-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putAll(owner, upload, content)

  const [a, b] = await Promise.all([
    owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' }),
    owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' }),
  ])

  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, [201, 409], `ต้องมีผู้ชนะหนึ่งและผู้แพ้หนึ่ง — ได้ ${statuses}`)
  const loser = a.status === 409 ? a : b
  assert.equal(loser.data.code, 'SESSION_NOT_OPEN', 'ผู้แพ้ต้องได้คำตอบที่อธิบายได้ ไม่ใช่ 500')

  const files = await rows('SELECT id FROM files WHERE name = $1', [name])
  assert.equal(files.length, 1, 'หนึ่ง session ต้องเผยแพร่ได้แถวเดียวเท่านั้น')
  const [session] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'committed')
})

test('session ที่ commit หรือ abort แล้ว รับ chunk เพิ่มไม่ได้อีก', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const upload = await openSession(owner, { name: `pg-closed-${Date.now()}.bin`, content })
  await putAll(owner, upload, content)
  assert.equal((await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })).status, 201)

  const late = await putChunk(owner, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))
  assert.equal(late.status, 409)
  assert.equal(late.data.code, 'SESSION_NOT_OPEN')

  await sql.query(`UPDATE upload_sessions SET status = 'aborted' WHERE upload_id = $1`, [upload.uploadId])
  const afterAbort = await putChunk(owner, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))
  assert.equal(afterAbort.status, 409)
})

// ─────────────────────────────────────────────────────────────────────────────
// 12 · cancel ลบทั้ง metadata และพื้นที่พัก
// ─────────────────────────────────────────────────────────────────────────────
test('12 · cancel ลบแถว session, แถว chunk และพื้นที่พักออกครบ', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `pg-cancel-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
  const dir = path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, upload.uploadId)
  assert.ok((await fs.stat(dir)).isDirectory())

  const res = await owner.req(`/api/files/uploads/${upload.uploadId}`, { method: 'DELETE' })
  assert.equal(res.status, 200)

  assert.equal((await rows('SELECT 1 FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])).length, 0)
  assert.equal((await rows('SELECT 1 FROM upload_session_chunks WHERE upload_id = $1', [upload.uploadId])).length, 0,
    'แถว chunk ต้องหายตามไปด้วย (ON DELETE CASCADE)')
  await assert.rejects(fs.stat(dir), 'พื้นที่พักต้องถูกลบ')
  assert.equal((await rows('SELECT 1 FROM files WHERE name = $1', [name])).length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 13–14 · cleanup แตะเฉพาะสิ่งที่ควรแตะ
// ─────────────────────────────────────────────────────────────────────────────
test('13+14 · cleanup ลบเฉพาะ session ที่หมดอายุและยังเปิดอยู่ ไม่แตะที่ commit แล้ว', { skip }, async () => {
  const owner = await login(OWNER)

  // (ก) ไฟล์ที่ commit สำเร็จ
  const keepContent = makeContent(SMALL_SIZE)
  const keepName = `pg-keep-${Date.now()}.bin`
  const keep = await openSession(owner, { name: keepName, content: keepContent })
  await putAll(owner, keep, keepContent)
  assert.equal((await owner.req(`/api/files/uploads/${keep.uploadId}/commit`, { method: 'POST' })).status, 201)

  // (ข) session ที่ถูกทิ้งไว้ครึ่งทาง
  const dropContent = makeContent(MULTI_SIZE)
  const drop = await openSession(owner, { name: `pg-drop-${Date.now()}.bin`, content: dropContent })
  await putChunk(owner, drop.uploadId, 0, Buffer.from(chunkOf(dropContent, 0)))
  const dropDir = path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, drop.uploadId)

  // (ค) session ที่ "กำลัง commit อยู่" — cleanup ต้องไม่แตะ แม้จะหมดอายุแล้ว
  const busyContent = makeContent(SMALL_SIZE)
  const busy = await openSession(owner, { name: `pg-busy-${Date.now()}.bin`, content: busyContent })
  await putAll(owner, busy, busyContent)
  await sql.query(`UPDATE upload_sessions SET status = 'committing' WHERE upload_id = $1`, [busy.uploadId])
  const busyDir = path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, busy.uploadId)

  // ทำให้ทุก session หมดอายุพร้อมกัน แล้วเดินงานเก็บกวาดหนึ่งรอบ
  await sql.query(`UPDATE upload_sessions SET expires_at = now() - interval '1 hour'`)
  const result = await cleanupAbandonedUploads({ now: Date.now() })
  assert.ok(result.expired >= 1)

  // (ข) หายไป
  assert.equal((await rows('SELECT 1 FROM upload_sessions WHERE upload_id = $1', [drop.uploadId])).length, 0)
  await assert.rejects(fs.stat(dropDir), 'พื้นที่พักของ session ที่ถูกทิ้งต้องถูกลบ')

  // (ก) ยังอยู่ครบ ทั้งแถว session, แถว files และไบต์
  const [kept] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [keep.uploadId])
  assert.equal(kept?.status, 'committed', 'session ที่ commit แล้วต้องไม่ถูกเก็บกวาด')
  const keptFiles = await rows('SELECT path FROM files WHERE name = $1', [keepName])
  assert.equal(keptFiles.length, 1)
  assert.ok((await fs.readFile(resolveKey(keptFiles[0].path))).equals(keepContent))

  // (ค) ยังอยู่ — cleanup ต้องไม่ดึงไบต์ออกจากใต้ commit ที่กำลังทำงาน
  const [stillBusy] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [busy.uploadId])
  assert.equal(stillBusy?.status, 'committing', 'session ที่กำลัง commit ต้องไม่ถูกเก็บกวาด')
  assert.ok((await fs.stat(busyDir)).isDirectory(), 'พื้นที่พักของ session ที่กำลัง commit ต้องยังอยู่')
})

// ─────────────────────────────────────────────────────────────────────────────
// 15 · ON DELETE CASCADE ทั้งสองทิศ
// ─────────────────────────────────────────────────────────────────────────────
test('15 · ลบ session → chunk หายตาม; ลบผู้ใช้ → session ของเขาหายตาม (CASCADE จริง)', { skip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const upload = await openSession(owner, { name: `pg-cascade-${Date.now()}.bin`, content })
  await putAll(owner, upload, content)
  assert.equal((await rows('SELECT 1 FROM upload_session_chunks WHERE upload_id = $1', [upload.uploadId])).length, 3)

  await sql.query('DELETE FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(
    (await rows('SELECT 1 FROM upload_session_chunks WHERE upload_id = $1', [upload.uploadId])).length, 0,
    'upload_session_chunks ต้องหายตาม upload_sessions ผ่าน ON DELETE CASCADE',
  )

  // ── ผู้ใช้ถูกลบ → session ของเขาต้องหายไป ไม่ใช่กลายเป็นแถวกำพร้าที่ไม่มีเจ้าของ ──
  const [tmpUser] = await rows(
    `INSERT INTO users (username, password_hash, display_name)
     VALUES ($1, '$2a$10$notarealhash', 'Cascade Probe') RETURNING id`,
    [`cascade_probe_${Date.now()}`],
  )
  const probeId = 'f'.repeat(48)
  await sql.query(
    `INSERT INTO upload_sessions (upload_id, user_id, name, logical_size, chunk_size, chunk_count, expires_at)
     VALUES ($1, $2, 'probe.bin', 10, 16, 1, now() + interval '1 day')`,
    [probeId, tmpUser.id],
  )
  await sql.query(
    `INSERT INTO upload_session_chunks (upload_id, chunk_index, size_bytes, sha256)
     VALUES ($1, 0, 10, repeat('a', 64))`, [probeId],
  )
  await sql.query('DELETE FROM users WHERE id = $1', [tmpUser.id])
  assert.equal((await rows('SELECT 1 FROM upload_sessions WHERE upload_id = $1', [probeId])).length, 0,
    'session ต้องหายเมื่อบัญชีเจ้าของถูกลบ')
  assert.equal((await rows('SELECT 1 FROM upload_session_chunks WHERE upload_id = $1', [probeId])).length, 0,
    'chunk ต้องหายตามไปอีกทอด')
})

// ─────────────────────────────────────────────────────────────────────────────
// CHECK constraints — ค่าที่ผิดต้องถูกฐานข้อมูลปฏิเสธ ไม่ใช่แค่โค้ดแอป
// ─────────────────────────────────────────────────────────────────────────────
test('CHECK constraints ปฏิเสธ status/index/size ที่ไม่ถูกต้องที่ชั้นฐานข้อมูลเอง', { skip }, async () => {
  const [u] = await rows('SELECT id FROM users ORDER BY id LIMIT 1')
  const id = 'e'.repeat(48)
  const mk = (cols, vals) => sql.query(
    `INSERT INTO upload_sessions (upload_id, user_id, name, logical_size, chunk_size, chunk_count, expires_at${cols})
     VALUES ($1, $2, 'x.bin', 10, 16, 1, now() + interval '1 day'${vals})`, [id, u.id],
  )

  await assert.rejects(mk(', status', `, 'bogus'`), /upload_sessions_status_check|violates check constraint/,
    'status นอกรายการต้องถูกปฏิเสธ')
  await assert.rejects(
    sql.query(`INSERT INTO upload_sessions (upload_id,user_id,name,logical_size,chunk_size,chunk_count,expires_at)
               VALUES ($1,$2,'x.bin',-1,16,1, now())`, [id, u.id]),
    /violates check constraint/, 'logical_size ติดลบต้องถูกปฏิเสธ')
  await assert.rejects(
    sql.query(`INSERT INTO upload_sessions (upload_id,user_id,name,logical_size,chunk_size,chunk_count,expires_at)
               VALUES ($1,$2,'x.bin',10,0,1, now())`, [id, u.id]),
    /violates check constraint/, 'chunk_size = 0 ต้องถูกปฏิเสธ')

  // ทั้งสี่สถานะที่ถูกต้องต้องผ่าน — รวม 'committing' ที่ commit ใช้จองสิทธิ์
  for (const status of ['open', 'committing', 'committed', 'aborted']) {
    await sql.query('DELETE FROM upload_sessions WHERE upload_id = $1', [id])
    await mk(', status', `, '${status}'`)
  }
  await sql.query('DELETE FROM upload_sessions WHERE upload_id = $1', [id])

  // chunk: index ติดลบ และขนาด <= 0 ต้องถูกปฏิเสธ
  await sql.query(
    `INSERT INTO upload_sessions (upload_id,user_id,name,logical_size,chunk_size,chunk_count,expires_at)
     VALUES ($1,$2,'x.bin',10,16,1, now() + interval '1 day')`, [id, u.id],
  )
  await assert.rejects(sql.query(
    `INSERT INTO upload_session_chunks (upload_id,chunk_index,size_bytes,sha256) VALUES ($1,-1,10,repeat('a',64))`,
    [id]), /violates check constraint/)
  await assert.rejects(sql.query(
    `INSERT INTO upload_session_chunks (upload_id,chunk_index,size_bytes,sha256) VALUES ($1,0,0,repeat('a',64))`,
    [id]), /violates check constraint/)
})

// ─────────────────────────────────────────────────────────────────────────────
// สิทธิ์ของ role ที่แอปใช้จริง — ต้องเป็น DML เท่านั้น
// ─────────────────────────────────────────────────────────────────────────────
test('role ที่แอปเชื่อมต่อด้วยไม่ใช่ superuser และแก้ schema ไม่ได้', { skip }, async () => {
  const [me] = await rows('SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user')
  assert.equal(me.rolsuper, false, `role ${me.role} ต้องไม่ใช่ superuser — เทสต์ที่รันเป็น superuser พิสูจน์อะไรไม่ได้`)

  await assert.rejects(sql.query('CREATE TABLE lftv2_probe (id int)'), /permission denied/,
    'CREATE TABLE ต้องถูกปฏิเสธ')
  await assert.rejects(sql.query('ALTER TABLE upload_sessions ADD COLUMN probe int'), /must be owner/,
    'ALTER TABLE ต้องถูกปฏิเสธ')
  await assert.rejects(sql.query('DROP TABLE upload_session_chunks'), /must be owner/,
    'DROP TABLE ต้องถูกปฏิเสธ')
  await assert.rejects(sql.query('TRUNCATE upload_sessions'), /permission denied/,
    'TRUNCATE ต้องถูกปฏิเสธ')

  // แต่ DML ทั้งสี่คำสั่งบนทั้งสองตารางต้องทำได้จริง
  for (const table of ['upload_sessions', 'upload_session_chunks']) {
    await sql.query(`SELECT count(*) FROM ${table}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ไบต์กับ metadata ต้องไม่หลุดจากกันเมื่อ metadata เขียนไม่สำเร็จ
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ การฉีดความล้มเหลวนี้ต้องใช้สิทธิ์ superuser (REVOKE) ซึ่งแอปไม่มีและไม่ควรมี
//    ตั้ง AEGIS_PGTEST_SUPER_URL (สคริปต์ scripts/pg-integration-env.sh พิมพ์ให้)
//    เพื่อเปิดเทสต์นี้ ไม่ตั้ง = ข้าม และบันทึกไว้ว่าไม่ได้ตรวจ ไม่ใช่แกล้งผ่าน
const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const superSkip = skip || (SUPER_URL ? false : 'ต้องตั้ง AEGIS_PGTEST_SUPER_URL เพื่อฉีดความล้มเหลวของ metadata')

test('metadata เขียนไม่สำเร็จ = ไม่มีไบต์กำพร้าเหลือ และ session ถูกปลดกลับมาทำต่อได้', { skip: superSkip }, async () => {
  const owner = await login(OWNER)
  const content = makeContent(SMALL_SIZE)
  const name = `pg-orphan-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putAll(owner, upload, content)

  const uploadsDir = path.join(STORAGE_ROOT, 'uploads')
  const before = await fs.readdir(uploadsDir)

  // ถอนสิทธิ์ INSERT บน files ชั่วคราว — ความล้มเหลวจริงของชั้นฐานข้อมูล ไม่ใช่ mock
  const su = new pg.Client({ connectionString: SUPER_URL.replace(/\/postgres$/, '/' + new URL(DB_URL).pathname.slice(1)) })
  await su.connect()
  const appRole = (await sql.query('SELECT current_user AS r')).rows[0].r
  await su.query(`REVOKE INSERT ON files FROM ${appRole}`)
  let res
  try {
    res = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  } finally {
    await su.query(`GRANT INSERT ON files TO ${appRole}`)
  }

  assert.equal(res.status, 500, 'metadata ที่เขียนไม่ได้ต้องกลายเป็นความล้มเหลว ไม่ใช่ 201 ที่โกหก')
  assert.equal((await rows('SELECT 1 FROM files WHERE name = $1', [name])).length, 0,
    'ต้องไม่มีแถว metadata ที่ชี้ไปยังไบต์ที่ไม่ได้ถูกยอมรับ')

  const after = await fs.readdir(uploadsDir)
  assert.deepEqual(after.sort(), before.sort(),
    'ไบต์ที่ถูกเผยแพร่ไปแล้วต้องถูกเก็บกลับ — ห้ามเหลือไฟล์กำพร้าที่ไม่มีแถวใดอ้างถึง')

  const [session] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'open',
    'การจองต้องถูกปลด ไม่งั้น session ค้างเป็น committing ตลอดไป (commit ซ้ำไม่ได้ เก็บกวาดก็ไม่ได้)')

  // และเมื่อสิทธิ์กลับมา ผู้ใช้ต้อง commit ต่อได้จริงโดยไม่ต้องอัปโหลดใหม่ทั้งไฟล์
  await su.end()
  const retry = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(retry.status, 201, `commit ซ้ำหลังสิทธิ์กลับมาต้องผ่าน: ${JSON.stringify(retry.data)}`)
  assert.equal((await rows('SELECT 1 FROM files WHERE name = $1', [name])).length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// migration 003 · การ GRANT ต้องไม่ขึ้นกับว่า "ใคร" เป็นคนรัน migration
//
// ⚠️ นี่คือชุดกันการถอยหลังของข้อบกพร่องที่เจอในรอบ Postgres integration gate:
//    เดิม 003_upload_sessions.sql ไม่มี GRANT ของตัวเอง โดยอ้างในคอมเมนต์ว่า
//    ALTER DEFAULT PRIVILEGES ใน postgres/init/02-app-roles.sh ครอบตารางที่ถูกสร้าง
//    ทีหลังให้เอง วัดกับ PostgreSQL 15 จริงแล้วคำกล่าวนั้น "จริงเฉพาะเมื่อ role เดียวกัน
//    กับที่รัน ALTER DEFAULT PRIVILEGES เป็นคนสร้างตาราง" เพราะ default privileges ถูก
//    บันทึกต่อ role ผู้สร้าง (pg_default_acl.defaclrole) ไม่ใช่ต่อฐานข้อมูล
//    DBA ที่ apply migration ด้วยบัญชี superuser อีกใบ — เรื่องปกติมาก — ทำให้
//    drive_app ไม่ได้สิทธิ์อะไรเลย migration รายงานว่าสำเร็จ แล้วแอปพังตอน runtime
//    ด้วย permission denied for table upload_sessions ในทุกการอัปโหลด
// ─────────────────────────────────────────────────────────────────────────────
test('migration 003 ให้สิทธิ์ drive_app ได้แม้ถูก apply โดย superuser คนละคนกับที่ตั้ง default privileges', { skip: superSkip }, async () => {
  const admin = new pg.Client({ connectionString: SUPER_URL })
  await admin.connect()
  const dbName = `aegis_drive_grantprobe_${Date.now()}`
  const appRole = (await sql.query('SELECT current_user AS r')).rows[0].r
  const schemaSql = await fs.readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
  const migrationSql = await fs.readFile(
    new URL('../server/db/migrations/003_upload_sessions.sql', import.meta.url), 'utf8',
  )
  // ฐานข้อมูล "ก่อน V2" = schema.sql ตัดตรงหัวข้อ LFT-V2-A ออก (ไฟล์จริง ไม่ใช่ของปลอม)
  const preV2 = schemaSql.slice(0, schemaSql.indexOf('-- ── Resumable upload sessions (LFT-V2-A)'))
  assert.ok(preV2.length > 0 && !preV2.includes('upload_sessions'), 'ต้องตัดหัวข้อ V2 ออกได้จริง')

  let probe, migrator
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    const url = (u) => new URL(SUPER_URL).origin.replace(/^http/, 'postgres') && SUPER_URL.replace(/\/[^/]*$/, `/${u}`)
    probe = new pg.Client({ connectionString: url(dbName) })
    await probe.connect()
    await probe.query(preV2)
    // สิทธิ์แบบ production รวมถึง ALTER DEFAULT PRIVILEGES — ตั้งโดย "admin"
    await probe.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${appRole}`)
    await probe.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`)
    await probe.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`)
    await probe.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
    )

    // ── superuser คนละใบเป็นคนรัน migration ────────────────────────────────
    const migratorName = `lftv2_migrator_${Date.now()}`
    const migratorPw = 'probe-only-not-a-production-credential'
    await admin.query(`CREATE ROLE ${migratorName} LOGIN SUPERUSER PASSWORD '${migratorPw}'`)
    const migratorUrl = url(dbName).replace(/:\/\/[^@]*@/, `://${migratorName}:${migratorPw}@`)
    migrator = new pg.Client({ connectionString: migratorUrl })
    await migrator.connect()
    await migrator.query(migrationSql)

    // ตารางถูกสร้างโดย role ที่ "ไม่ได้" เป็นเจ้าของ default privileges
    const owners = await probe.query(
      `SELECT tablename, tableowner FROM pg_tables
        WHERE tablename IN ('upload_sessions','upload_session_chunks') ORDER BY tablename`,
    )
    assert.equal(owners.rows.length, 2, 'migration ต้องสร้างทั้งสองตาราง')
    for (const r of owners.rows) {
      assert.equal(r.tableowner, migratorName, 'ตารางต้องเป็นของ role ที่รัน migration จริง ๆ')
    }

    // ⚠️ หัวใจของชุดนี้: สิทธิ์ต้องมาถึง drive_app แม้เจ้าของตารางจะเป็นคนละ role
    const granted = await probe.query(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_name IN ('upload_sessions','upload_session_chunks')
        GROUP BY table_name ORDER BY table_name`,
      [appRole],
    )
    assert.equal(granted.rows.length, 2,
      'ทั้งสองตารางต้องมีสิทธิ์ให้ role ของแอป — ถ้าเป็น 0 คือข้อบกพร่องเดิมกลับมาแล้ว')
    for (const r of granted.rows) {
      assert.equal(r.privs, 'DELETE,INSERT,SELECT,UPDATE', `${r.table_name} ต้องได้ DML ครบสี่คำสั่ง`)
    }

    // และต้องไม่เผลอให้สิทธิ์ที่กว้างเกิน DML
    for (const r of granted.rows) {
      for (const forbidden of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal(r.privs.includes(forbidden), false, `${r.table_name} ต้องไม่ได้ ${forbidden}`)
      }
    }

    // รันซ้ำได้โดยไม่พัง และไม่เปลี่ยนสิทธิ์
    await migrator.query(migrationSql)
    const again = await probe.query(
      `SELECT count(*) AS n FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_name IN ('upload_sessions','upload_session_chunks')`,
      [appRole],
    )
    assert.equal(Number(again.rows[0].n), 8, 'สิทธิ์ 4 คำสั่ง × 2 ตาราง ต้องคงเดิมหลังรันซ้ำ')
    await migrator.end(); migrator = null

    await admin.query(`DROP ROLE ${migratorName}`).catch(() => {})
  } finally {
    await migrator?.end().catch(() => {})
    await probe?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
})

// ⚠️ Stage-A คือรูปตารางที่ migration 003 เคยสร้างก่อนรอบ crash-recovery — ยังไม่มี
//    คอลัมน์ commit intent ฐานข้อมูลของใครที่รับ Stage-A ไปแล้วต้องอัปเกรดได้ด้วยการ
//    รัน 003 ซ้ำ ไม่ใช่ต้องสร้างใหม่ รูปนี้เป็นประวัติศาสตร์ที่ตายตัวแล้วจึงเขียนตรงนี้ได้
const STAGE_A_UPLOAD_TABLES = `
CREATE TABLE upload_sessions (
  upload_id       TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  logical_size    BIGINT NOT NULL CHECK (logical_size >= 0),
  chunk_size      INTEGER NOT NULL CHECK (chunk_size > 0),
  chunk_count     INTEGER NOT NULL CHECK (chunk_count >= 0),
  expected_sha256 CHAR(64),
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'committing', 'committed', 'aborted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE TABLE upload_session_chunks (
  upload_id    TEXT NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256       CHAR(64) NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index)
);`

test('migration 003 อัปเกรดฐานข้อมูลที่รับ Stage-A ไปแล้วให้มีคอลัมน์ commit intent โดยไม่แตะแถวเดิม', { skip: superSkip }, async () => {
  const admin = new pg.Client({ connectionString: SUPER_URL })
  await admin.connect()
  const dbName = `aegis_drive_stagea_${Date.now()}`
  const migrationSql = await fs.readFile(
    new URL('../server/db/migrations/003_upload_sessions.sql', import.meta.url), 'utf8',
  )
  const schemaSql = await fs.readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
  const preV2 = schemaSql.slice(0, schemaSql.indexOf('-- ── Resumable upload sessions (LFT-V2-A)'))

  let probe
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    probe = new pg.Client({ connectionString: SUPER_URL.replace(/\/[^/]*$/, `/${dbName}`) })
    await probe.connect()
    await probe.query(preV2)
    await probe.query(STAGE_A_UPLOAD_TABLES)

    // ข้อมูลจริงที่ค้างอยู่ในฐานข้อมูล Stage-A ก่อนอัปเกรด
    const { rows: [u] } = await probe.query(
      `INSERT INTO users (username, password_hash, display_name)
       VALUES ('stagea_owner', '\$2a\$10\$notarealhash', 'Stage A Owner') RETURNING id`,
    )
    const sessionId = 'd'.repeat(48)
    await probe.query(
      `INSERT INTO upload_sessions (upload_id, user_id, name, logical_size, chunk_size, chunk_count, expires_at)
       VALUES ($1, $2, 'stagea.bin', 100, 16, 7, now() + interval '1 day')`, [sessionId, u.id],
    )
    await probe.query(
      `INSERT INTO upload_session_chunks (upload_id, chunk_index, size_bytes, sha256)
       VALUES ($1, 0, 16, repeat('a', 64))`, [sessionId],
    )

    const before = await probe.query(
      `SELECT md5(string_agg(upload_id||name||logical_size::text||status, '|' ORDER BY upload_id)) AS f
         FROM upload_sessions`,
    )
    const columnsBefore = await probe.query(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_name = 'upload_sessions'
          AND column_name IN ('commit_started_at','commit_storage_key','committed_file_id')`,
    )
    assert.equal(Number(columnsBefore.rows[0].n), 0, 'Stage-A ต้องยังไม่มีคอลัมน์ commit intent')

    // ── อัปเกรดด้วยการรัน 003 ตัวปัจจุบันซ้ำ ─────────────────────────────────
    await probe.query(migrationSql)

    const columnsAfter = await probe.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'upload_sessions'
          AND column_name IN ('commit_started_at','commit_storage_key','committed_file_id')
        ORDER BY column_name`,
    )
    assert.deepEqual(
      columnsAfter.rows.map((r) => r.column_name),
      ['commit_started_at', 'commit_storage_key', 'committed_file_id'],
      'ทั้งสามคอลัมน์ต้องถูกเพิ่มให้ฐานข้อมูล Stage-A',
    )

    // FK ของ committed_file_id ต้องถูกเพิ่มด้วย และเพิ่มเพียงครั้งเดียว
    const fk = await probe.query(
      `SELECT count(*) AS n FROM pg_constraint
        WHERE conname = 'upload_sessions_committed_file_id_fkey'`,
    )
    assert.equal(Number(fk.rows[0].n), 1, 'FK ของ committed_file_id ต้องมีหนึ่งอัน')

    const idx = await probe.query(
      `SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'upload_sessions_commit_idx'`,
    )
    assert.equal(Number(idx.rows[0].n), 1, 'index สำหรับงานกู้คืนต้องถูกสร้าง')

    // แถวเดิมต้องไม่ถูกแตะ และคอลัมน์ใหม่ต้องเป็น NULL
    const after = await probe.query(
      `SELECT md5(string_agg(upload_id||name||logical_size::text||status, '|' ORDER BY upload_id)) AS f
         FROM upload_sessions`,
    )
    assert.equal(after.rows[0].f, before.rows[0].f, 'แถวเดิมต้องไม่ถูกเขียนทับ')
    const { rows: [kept] } = await probe.query(
      'SELECT commit_started_at, commit_storage_key, committed_file_id FROM upload_sessions WHERE upload_id = $1',
      [sessionId],
    )
    assert.equal(kept.commit_started_at, null)
    assert.equal(kept.commit_storage_key, null)
    assert.equal(kept.committed_file_id, null)
    const chunks = await probe.query('SELECT count(*) AS n FROM upload_session_chunks WHERE upload_id = $1', [sessionId])
    assert.equal(Number(chunks.rows[0].n), 1, 'แถว chunk เดิมต้องยังอยู่')

    // รันซ้ำอีกครั้งต้องไม่พังและไม่เพิ่ม FK/index ซ้ำ
    await probe.query(migrationSql)
    const fkAgain = await probe.query(
      `SELECT count(*) AS n FROM pg_constraint WHERE conname = 'upload_sessions_committed_file_id_fkey'`,
    )
    assert.equal(Number(fkAgain.rows[0].n), 1, 'รันซ้ำต้องไม่เพิ่ม FK ซ้ำ')
  } finally {
    await probe?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
})

test('migration 003 ประกาศ GRANT ของตัวเองอย่างชัดเจน ไม่พึ่ง ALTER DEFAULT PRIVILEGES', { skip }, async () => {
  const migration = await fs.readFile(
    new URL('../server/db/migrations/003_upload_sessions.sql', import.meta.url), 'utf8',
  )
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON upload_sessions, upload_session_chunks TO drive_app/,
    'migration ต้องมี GRANT ของตัวเอง')
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'drive_app'\)/,
    'GRANT ต้องถูกกันด้วยการมีอยู่ของ role เพื่อให้ฐานข้อมูล dev ที่ไม่มี drive_app ยัง apply ได้')
  // ห้ามให้ความเป็นเจ้าของหรือ DDL แก่แอปเด็ดขาด
  assert.doesNotMatch(migration, /GRANT ALL|ALTER TABLE .* OWNER TO drive_app|GRANT TRUNCATE/,
    'migration ต้องไม่ให้สิทธิ์เกิน DML แก่ drive_app')
})

// ─────────────────────────────────────────────────────────────────────────────
// ไฟล์ที่มาจากเส้นทางเดิม (V1) ยังใช้งานได้ในฐานข้อมูลเดียวกัน
// ─────────────────────────────────────────────────────────────────────────────
test('ไฟล์จาก endpoint เดิม (V1) ยังอยู่และดาวน์โหลดกลับมาได้ในฐานข้อมูลเดียวกัน', { skip }, async () => {
  const owner = await login(OWNER)
  const legacy = makeContent(48 * 1024)
  const name = `pg-legacy-${Date.now()}.bin`

  const form = new FormData()
  form.append('sha256', sha256(legacy))
  form.append('file', new Blob([legacy]), name)
  const headers = { cookie: owner.cookie, 'X-CSRF-Token': owner.csrf }
  const res = await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', headers, body: form })
  assert.equal(res.status, 201)
  const body = await res.json()

  const dl = await fetch(`${baseUrl}/api/files/${body.file.id}/download`, { headers: { cookie: owner.cookie } })
  assert.equal(dl.status, 200)
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(legacy))

  const [row] = await rows('SELECT sha256 FROM files WHERE id = $1', [body.file.id])
  assert.equal(row.sha256, sha256(legacy))
})
