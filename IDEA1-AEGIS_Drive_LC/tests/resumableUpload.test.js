// tests/resumableUpload.test.js — AEGIS Drive (IDEA1) · Resumable chunked upload (LFT-V2-A)
//
// ยิงผ่าน Express app "ตัวเดียวกับที่รันใน production" (server/app.js) — securityHeaders /
// session / CSRF / requireAuth ทำงานจริงทุกชั้น ไม่มีการ mock
// แบบแผนเดียวกับ tests/filesOwnership.test.js และ tests/vaultApi.test.js
//
// สิ่งที่ชุดนี้พิสูจน์ (ตรงกับข้อกำหนดของ LFT-V2-A ข้อ 1–14 และ 17):
//    1. เจ้าของอ่าน session ของตัวเองได้
//    2. session ของผู้ใช้อื่น = 404 ทุกกริยา (ไม่ใช่ 403 ที่ยืนยันว่ามีอยู่)
//    3. chunk ที่ถูกต้องถูกรับไว้
//    4. ส่ง chunk ซ้ำแล้วผลเหมือนเดิม (idempotent) ไม่ใช่ไบต์ซ้อนกัน
//    5. ดัชนี chunk ที่ไม่มีอยู่ถูกปฏิเสธ
//    6. ขนาด chunk ที่ผิดถูกปฏิเสธ (ทั้งสั้นและยาวเกิน)
//    7. ขาด chunk = commit ไม่ผ่าน และบอกว่าขาดก้อนไหน
//    8. ขนาดรวมไม่ตรง = commit ไม่ผ่าน
//    9. SHA-256 ที่เซิร์ฟเวอร์คำนวณเองไม่ตรงกับที่ client อ้าง = commit ไม่ผ่าน
//   10. commit สำเร็จได้ไฟล์ปลายทางหนึ่งไฟล์ ไบต์ตรงกันทั้งก้อน
//   11. ไม่มีไฟล์ครึ่ง ๆ โผล่ใน GET /api/files ก่อน commit
//   12. สถานะ resume บอก chunk ที่ขาดได้ถูกต้องหลังการหลุดกลางคัน
//   13. งานเก็บกวาด session ที่ถูกทิ้ง ไม่แตะไฟล์ที่ commit ไปแล้ว
//   14. ไฟล์จากเส้นทางเดิม (V1) ยังดาวน์โหลดได้ไบต์ต่อไบต์
//   17. CSRF ยังบังคับกับทุกเส้นทางที่เปลี่ยนสถานะ
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performLogin } from './helpers/testClient.mjs'

// STORAGE_ROOT + เพดาน chunk ต้องถูกตั้ง "ก่อน" import โมดูลที่อ่านค่าเหล่านี้ตอน module-load
const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-resumable-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
// 8 MiB = ขอบล่างจริงของช่วงที่ deployment ตั้งได้ (ดู config/transferLimits.js)
// ⚠️ ไม่ใช่ค่าทดสอบพิเศษที่ production ตั้งไม่ได้ — ชุดนี้จึงพิสูจน์เส้นทางจริง
process.env.UPLOAD_CHUNK_SIZE_BYTES = String(8 * 1024 * 1024)

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage, resolveKey } = await import('../server/storage/fileStore.js')
const { initUploadStaging, uploadStagingConfig } = await import('../server/storage/uploadStaging.js')
const { cleanupAbandonedUploads } = await import('../server/storage/uploadCleanup.js')
const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
const store = await import('../server/db/store.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[resumable upload tests] database mode: ${DB_MODE}`)

const CHUNK = TRANSFER_LIMITS.chunkSizeBytes
assert.equal(CHUNK, 8 * 1024 * 1024, 'ชุดทดสอบนี้ต้องรันด้วย chunk 8 MiB')

const OWNER = { username: 'user', password: 'aegis-drive-user' }   // DataLake-User (เจ้าของ)
const OTHER = { username: 'admin', password: 'aegis-drive-admin' } // Admin (ผู้บุกรุก — ไม่มีข้อยกเว้น)

let server, baseUrl

before(async () => {
  await initStorage()
  await initUploadStaging()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  if (usingPostgres) await closePool()
})

// ── client จำลอง: ถือ cookie + CSRF token เหมือนเบราว์เซอร์จริง ───────────
class Client {
  constructor() { this.cookie = null; this.csrf = null }

  async req(pathname, { method = 'GET', body, headers: extra, skipCsrf = false } = {}) {
    const headers = { ...extra }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET' && !skipCsrf) headers['X-CSRF-Token'] = this.csrf
    let payload
    if (Buffer.isBuffer(body)) {
      payload = body
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream'
    } else if (body instanceof FormData) payload = body
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = await res.json() } catch { /* ไม่มี body JSON */ }
    return { status: res.status, data }
  }

  async raw(pathname) {
    const headers = {}
    if (this.cookie) headers.cookie = this.cookie
    const res = await fetch(baseUrl + pathname, { headers })
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }
  }
}

async function login(account) {
  const c = new Client()
  await performLogin(c, account.username, account.password)
  return c
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** เนื้อไฟล์ทดสอบ — ไบต์สุ่มจริงชุดเล็กที่ต่อกันจนได้ขนาด (เร็วกว่าสุ่มทีเดียวหลายสิบ MiB) */
function makeContent(size) {
  const block = randomBytes(64 * 1024)
  const out = Buffer.alloc(size)
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(out, offset, 0, Math.min(block.length, size - offset))
    // ทำให้แต่ละบล็อกไม่ซ้ำกันเป๊ะ ๆ เพื่อให้ chunk ที่สลับตำแหน่งกันแล้วแฮชเปลี่ยนจริง
    if (offset + 4 <= size) out.writeUInt32BE(offset >>> 0, offset)
  }
  return out
}

const chunkOf = (content, index) => content.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, content.length))

/** เปิด session หนึ่งอัน แล้วคืนทั้ง view และเนื้อไฟล์ */
async function openSession(client, { name, content, claimSha256 = sha256(content) }) {
  const res = await client.req('/api/files/uploads', {
    method: 'POST',
    body: { name, size: content.length, sha256: claimSha256 },
  })
  assert.equal(res.status, 201, `เปิด session ไม่สำเร็จ: ${JSON.stringify(res.data)}`)
  return res.data.upload
}

const putChunk = (client, uploadId, index, bytes, options = {}) =>
  client.req(`/api/files/uploads/${uploadId}/chunks/${index}`, { method: 'PUT', body: bytes, ...options })

async function putAllChunks(client, upload, content) {
  for (let index = 0; index < upload.chunkCount; index += 1) {
    const res = await putChunk(client, upload.uploadId, index, Buffer.from(chunkOf(content, index)))
    assert.equal(res.status, 200, `chunk ${index} ถูกปฏิเสธ: ${JSON.stringify(res.data)}`)
  }
}

// ขนาดที่ครอบทั้ง "chunk เต็ม" และ "chunk สุดท้ายที่เป็นเศษ" — จุดที่พังบ่อยที่สุด
const MULTI_SIZE = CHUNK * 2 + 4096
const SMALL_SIZE = 1024

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 10 + 11 · เส้นทางที่สำเร็จทั้งเส้น และไฟล์ครึ่ง ๆ ต้องมองไม่เห็น
// ─────────────────────────────────────────────────────────────────────────────
test('1+10+11 · session ของตัวเองอ่านได้, ไฟล์ครึ่ง ๆ ไม่โผล่ในรายการ, commit ได้ไฟล์เดียวที่ไบต์ตรงกัน', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `lft-v2-happy-${Date.now()}.bin`

  const upload = await openSession(owner, { name, content })
  assert.equal(upload.chunkSize, CHUNK)
  assert.equal(upload.chunkCount, 3)
  assert.deepEqual(upload.received, [])
  assert.deepEqual(upload.missing, [0, 1, 2])

  // (1) เจ้าของอ่านสถานะของตัวเองได้
  const status = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(status.status, 200)
  assert.equal(status.data.upload.name, name)
  assert.equal(status.data.upload.size, content.length)

  // (11) ส่งไปแค่บางส่วนแล้วยัง "ไม่" commit — ต้องไม่มีอะไรโผล่ในรายการไฟล์
  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
  const partialList = await owner.req('/api/files')
  assert.equal(partialList.status, 200)
  assert.equal(
    partialList.data.files.some((f) => f.name === name), false,
    'ไฟล์ที่ยังอัปโหลดไม่ครบต้องไม่ปรากฏใน GET /api/files',
  )
  // และ commit ตอนนี้ต้องไม่ผ่านด้วย (ข้อ 7 ซ้ำอีกมุมหนึ่ง)
  const early = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(early.status, 409)
  assert.deepEqual(early.data.upload.missing, [1, 2])

  // (10) ส่งที่เหลือแล้ว commit
  await putChunk(owner, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))
  await putChunk(owner, upload.uploadId, 2, Buffer.from(chunkOf(content, 2)))
  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201, `commit ล้มเหลว: ${JSON.stringify(commit.data)}`)
  assert.equal(commit.data.sha256, sha256(content))
  assert.equal(commit.data.file.size, content.length)

  const listed = (await owner.req('/api/files')).data.files.filter((f) => f.name === name)
  assert.equal(listed.length, 1, 'commit สำเร็จต้องได้ไฟล์ปลายทาง "หนึ่ง" ไฟล์')
  assert.equal(listed[0].sha256, sha256(content))

  // ไบต์บนดิสก์ตรงกับต้นทางทั้งก้อน — ไม่ใช่แค่ metadata ที่ดูถูกต้อง
  const onDisk = await fs.readFile(resolveKey(listed[0].path))
  assert.equal(onDisk.length, content.length)
  assert.ok(onDisk.equals(content), 'ไบต์ปลายทางต้องตรงกับต้นทางทุกไบต์')

  // ดาวน์โหลดกลับมาแล้วต้องได้ไบต์ชุดเดียวกัน (เส้นทางดาวน์โหลดยังเป็น stream เหมือนเดิม)
  const download = await owner.raw(`/api/files/${listed[0].id}/download`)
  assert.equal(download.status, 200)
  assert.ok(download.buffer.equals(content))

  // พื้นที่พักถูกเก็บกวาดหลัง commit — ไม่มีไบต์ค้างสองที่
  const stagingDir = path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, upload.uploadId)
  await assert.rejects(fs.stat(stagingDir), 'โฟลเดอร์พักต้องถูกลบหลัง commit สำเร็จ')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · session ของผู้ใช้อื่น = 404 ทุกกริยา
// ─────────────────────────────────────────────────────────────────────────────
test('2 · session ของผู้ใช้อื่นตอบ 404 ทุกกริยา และ Admin ก็ไม่มีข้อยกเว้น', async () => {
  const owner = await login(OWNER)
  const intruder = await login(OTHER)
  const content = makeContent(SMALL_SIZE)
  const upload = await openSession(owner, { name: `lft-v2-cross-${Date.now()}.bin`, content })

  const get = await intruder.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(get.status, 404)
  assert.equal(get.data.error, 'Not found')

  const put = await putChunk(intruder, upload.uploadId, 0, Buffer.from(content))
  assert.equal(put.status, 404)

  const commit = await intruder.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 404)

  const del = await intruder.req(`/api/files/uploads/${upload.uploadId}`, { method: 'DELETE' })
  assert.equal(del.status, 404)

  // ถูกปฏิเสธแล้ว session ต้อง "ยังอยู่ครบ" — 404 ที่ลบของจริงไปแล้วก็ไร้ความหมาย
  const stillThere = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(stillThere.status, 200)
  assert.equal(stillThere.data.upload.status, 'open')

  // id ที่ผิดรูปแบบก็ต้องเป็น 404 เหมือนกัน ไม่ใช่ 400 ที่บอกใบ้รูปแบบ id
  assert.equal((await owner.req('/api/files/uploads/not-a-real-id')).status, 404)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4 · chunk ที่ถูกต้องถูกรับ และการส่งซ้ำเป็น idempotent
// ─────────────────────────────────────────────────────────────────────────────
test('3+4 · chunk ที่ถูกต้องถูกรับไว้ และส่งซ้ำก้อนเดิมให้ผลเหมือนเดิม (ไม่ใช่ไบต์ซ้อนกัน)', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `lft-v2-idempotent-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })

  const first = await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
  assert.equal(first.status, 200)
  assert.equal(first.data.size, CHUNK)
  assert.deepEqual(first.data.upload.received, [0])

  // ส่งก้อนเดิมซ้ำสามครั้ง — สถานะและไบต์รวมต้องไม่ขยับ
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeat = await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
    assert.equal(repeat.status, 200)
    assert.deepEqual(repeat.data.upload.received, [0])
    assert.equal(repeat.data.upload.receivedBytes, CHUNK)
    assert.equal(repeat.data.sha256, first.data.sha256)
  }

  await putChunk(owner, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))
  await putChunk(owner, upload.uploadId, 2, Buffer.from(chunkOf(content, 2)))
  // ส่งซ้ำก้อนกลางอีกครั้งหลังส่งครบแล้ว — ต้องยัง commit ผ่านและได้ไบต์เดิม
  await putChunk(owner, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))

  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201, `commit หลังส่งซ้ำต้องผ่าน: ${JSON.stringify(commit.data)}`)
  assert.equal(commit.data.sha256, sha256(content))
  assert.equal(commit.data.file.size, content.length, 'ไบต์ต้องไม่ถูกต่อท้ายซ้ำจนไฟล์ยาวเกิน')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · ดัชนี chunk ที่ผิด
// ─────────────────────────────────────────────────────────────────────────────
test('5 · ดัชนี chunk ที่อยู่นอกช่วงหรือไม่ใช่ตัวเลขถูกปฏิเสธ และไม่ถูกนับว่ารับแล้ว', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const upload = await openSession(owner, { name: `lft-v2-index-${Date.now()}.bin`, content })

  const tooHigh = await putChunk(owner, upload.uploadId, upload.chunkCount, Buffer.from(chunkOf(content, 0)))
  assert.equal(tooHigh.status, 400)
  assert.equal(tooHigh.data.code, 'CHUNK_INDEX_INVALID')

  const wayHigh = await putChunk(owner, upload.uploadId, 999, Buffer.from(chunkOf(content, 0)))
  assert.equal(wayHigh.status, 400)

  const negative = await putChunk(owner, upload.uploadId, -1, Buffer.from(chunkOf(content, 0)))
  assert.equal(negative.status, 400)

  const notANumber = await putChunk(owner, upload.uploadId, 'first', Buffer.from(chunkOf(content, 0)))
  assert.equal(notANumber.status, 400)

  const status = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.deepEqual(status.data.upload.received, [], 'chunk ที่ถูกปฏิเสธต้องไม่ถูกบันทึกว่ารับแล้ว')
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · ขนาด chunk ที่ผิด
// ─────────────────────────────────────────────────────────────────────────────
test('6 · chunk ที่สั้นหรือยาวกว่าที่เซิร์ฟเวอร์กำหนดถูกปฏิเสธ และไม่ถูกนับว่ารับแล้ว', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const upload = await openSession(owner, { name: `lft-v2-size-${Date.now()}.bin`, content })

  const short = await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)).subarray(0, CHUNK - 10))
  assert.equal(short.status, 400)
  assert.equal(short.data.code, 'CHUNK_SIZE_INVALID')
  assert.equal(short.data.expectedBytes, CHUNK)

  const long = await putChunk(owner, upload.uploadId, 0, Buffer.concat([Buffer.from(chunkOf(content, 0)), Buffer.alloc(10)]))
  assert.equal(long.status, 400)

  // chunk สุดท้ายเป็นเศษ — ส่งเต็มขนาด chunk มาต้องถูกปฏิเสธเช่นกัน
  const lastIndex = upload.chunkCount - 1
  const fullSizedLast = await putChunk(owner, upload.uploadId, lastIndex, Buffer.alloc(CHUNK))
  assert.equal(fullSizedLast.status, 400)
  assert.equal(fullSizedLast.data.expectedBytes, content.length - lastIndex * CHUNK)

  const status = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.deepEqual(status.data.upload.received, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 + 12 · ขาด chunk = commit ไม่ผ่าน และสถานะบอกได้ว่าขาดก้อนไหน
// ─────────────────────────────────────────────────────────────────────────────
test('7+12 · commit ที่ยังขาด chunk ถูกปฏิเสธ และสถานะ resume รายงาน chunk ที่ขาดได้ถูกต้อง', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `lft-v2-resume-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })

  // จำลอง "เน็ตหลุดกลาง chunk ที่ 1": ก้อน 0 และ 2 ถึงแล้ว ก้อน 1 ยังไม่ถึง
  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))
  await putChunk(owner, upload.uploadId, 2, Buffer.from(chunkOf(content, 2)))

  const status = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(status.status, 200)
  assert.deepEqual(status.data.upload.received, [0, 2])
  assert.deepEqual(status.data.upload.missing, [1], 'สถานะต้องบอกได้เป๊ะว่าขาดก้อนไหน')
  assert.equal(status.data.upload.receivedBytes, CHUNK + (content.length - 2 * CHUNK))

  const blocked = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.data.code, 'UPLOAD_INCOMPLETE')
  assert.deepEqual(blocked.data.upload.missing, [1])
  assert.equal((await owner.req('/api/files')).data.files.some((f) => f.name === name), false)

  // ทำต่อ "เฉพาะก้อนที่ขาด" — ไม่ต้องส่งก้อนที่สำเร็จแล้วซ้ำ
  const resumed = await putChunk(owner, upload.uploadId, 1, Buffer.from(chunkOf(content, 1)))
  assert.equal(resumed.status, 200)
  assert.deepEqual(resumed.data.upload.missing, [])

  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201)
  assert.equal(commit.data.sha256, sha256(content), 'ไฟล์ที่ทำต่อจากที่ค้างต้องแฮชตรงกับต้นฉบับ')
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · ขนาดรวมไม่ตรงกับที่ประกาศไว้
// ─────────────────────────────────────────────────────────────────────────────
test('8 · ไบต์บนดิสก์ไม่เท่ากับขนาดที่ประกาศไว้ = commit ไม่ผ่าน และไม่มีแถวถูกเผยแพร่', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `lft-v2-sizemismatch-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putAllChunks(owner, upload, content)

  // ทำให้ไฟล์บนดิสก์ยาวเกินจริงหลังรับ chunk ครบ — เลียนแบบไบต์ที่ปนเข้ามานอกโปรโตคอล
  const partPath = path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, upload.uploadId, 'part')
  await fs.appendFile(partPath, Buffer.alloc(64))

  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 409)
  assert.equal(commit.data.code, 'SIZE_MISMATCH')
  assert.equal(commit.data.expectedBytes, content.length)
  assert.equal(commit.data.actualBytes, content.length + 64)
  assert.equal((await owner.req('/api/files')).data.files.some((f) => f.name === name), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 9 · SHA-256 ที่เซิร์ฟเวอร์คำนวณเองต้องเป็นด่านสุดท้าย
// ─────────────────────────────────────────────────────────────────────────────
test('9 · SHA-256 ที่เซิร์ฟเวอร์คำนวณจากไบต์จริงไม่ตรงกับที่ client อ้าง = commit ไม่ผ่าน', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `lft-v2-checksum-${Date.now()}.bin`

  // client อ้างแฮชของ "เนื้ออื่น" — ขนาดยังตรงทุกประการ จึงผ่านด่านขนาดไปได้
  const decoy = makeContent(MULTI_SIZE)
  const upload = await openSession(owner, { name, content, claimSha256: sha256(decoy) })
  await putAllChunks(owner, upload, content)

  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 422)
  assert.equal(commit.data.code, 'CHECKSUM_MISMATCH')
  assert.equal((await owner.req('/api/files')).data.files.some((f) => f.name === name), false)

  // session ถูกยกเลิกและพื้นที่พักถูกคืน — ไม่มีไบต์ที่รู้ว่าผิดค้างอยู่ให้ commit ซ้ำ
  const after = await owner.req(`/api/files/uploads/${upload.uploadId}`)
  assert.equal(after.status, 200)
  assert.equal(after.data.upload.status, 'aborted')
  const retry = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(retry.status, 409)
  assert.equal(retry.data.code, 'SESSION_NOT_OPEN')
})

// ─────────────────────────────────────────────────────────────────────────────
// 13 · งานเก็บกวาดต้องไม่แตะข้อมูลของผู้ใช้ที่ commit แล้ว
// ─────────────────────────────────────────────────────────────────────────────
test('13 · เก็บกวาด session ที่ถูกทิ้งแล้ว ไฟล์ที่ commit ไปแล้วยังอยู่ครบทั้งแถวและไบต์', async () => {
  const owner = await login(OWNER)

  // (ก) ไฟล์ที่ commit สำเร็จ — ต้องรอดทุกกรณี
  const keepContent = makeContent(SMALL_SIZE)
  const keepName = `lft-v2-cleanup-keep-${Date.now()}.bin`
  const keepUpload = await openSession(owner, { name: keepName, content: keepContent })
  await putAllChunks(owner, keepUpload, keepContent)
  const kept = await owner.req(`/api/files/uploads/${keepUpload.uploadId}/commit`, { method: 'POST' })
  assert.equal(kept.status, 201)
  const keptFile = kept.data.file

  // (ข) session ที่ถูกทิ้งไว้ครึ่งทาง แล้วหมดอายุ
  const dropContent = makeContent(MULTI_SIZE)
  const dropUpload = await openSession(owner, { name: `lft-v2-cleanup-drop-${Date.now()}.bin`, content: dropContent })
  await putChunk(owner, dropUpload.uploadId, 0, Buffer.from(chunkOf(dropContent, 0)))
  const dropDir = path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, dropUpload.uploadId)
  assert.ok((await fs.stat(dropDir)).isDirectory())

  // เดินเวลาไปข้างหน้าแทนการรอจริง — ใช้พารามิเตอร์ now ของงานเก็บกวาดเอง
  const result = await cleanupAbandonedUploads({ now: dropUpload.expiresAt + 1 })
  assert.ok(result.expired >= 1, 'session ที่หมดอายุต้องถูกเก็บกวาด')

  await assert.rejects(fs.stat(dropDir), 'พื้นที่พักของ session ที่ถูกทิ้งต้องถูกลบ')
  assert.equal((await owner.req(`/api/files/uploads/${dropUpload.uploadId}`)).status, 404)

  // ไฟล์ที่ commit แล้วต้องไม่ถูกแตะเลย — ทั้งแถว metadata และไบต์บนดิสก์
  const listed = (await owner.req('/api/files')).data.files.filter((f) => f.name === keepName)
  assert.equal(listed.length, 1, 'ไฟล์ที่ commit แล้วต้องยังอยู่หลังงานเก็บกวาด')
  const onDisk = await fs.readFile(resolveKey(listed[0].path))
  assert.ok(onDisk.equals(keepContent), 'ไบต์ของไฟล์ที่ commit แล้วต้องไม่ถูกแตะ')
  assert.equal((await owner.raw(`/api/files/${keptFile.id}/download`)).status, 200)

  // แถว session ที่ commit แล้วก็ต้องไม่ถูกลบด้วยงานเก็บกวาด (สถานะยังตรวจย้อนหลังได้)
  const committedSession = await store.findUploadSession(keepUpload.uploadId, listed[0].ownerId)
  assert.equal(committedSession?.status, 'committed')
})

// ─────────────────────────────────────────────────────────────────────────────
// 14 · ไฟล์จากเส้นทางเดิม (V1) ยังอ่านได้ตามเดิม
// ─────────────────────────────────────────────────────────────────────────────
test('14 · ไฟล์ที่อัปโหลดผ่าน endpoint เดิม (V1) ยังดาวน์โหลดกลับมาได้ไบต์ต่อไบต์', async () => {
  const owner = await login(OWNER)
  const legacyContent = makeContent(64 * 1024)
  const legacyName = `lft-v2-legacy-${Date.now()}.bin`

  const form = new FormData()
  form.append('sha256', sha256(legacyContent))
  form.append('file', new Blob([legacyContent]), legacyName)
  const uploaded = await owner.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(uploaded.status, 201, `เส้นทางเดิมต้องยังทำงานได้: ${JSON.stringify(uploaded.data)}`)

  const download = await owner.raw(`/api/files/${uploaded.data.file.id}/download`)
  assert.equal(download.status, 200)
  assert.ok(download.buffer.equals(legacyContent), 'ไฟล์เดิมต้องอ่านกลับมาได้เหมือนเดิมทุกไบต์')

  // และยังตรวจ checksum ผ่าน endpoint เดิมได้ตามปกติ
  const verify = await owner.req(`/api/files/${uploaded.data.file.id}/verify`, { method: 'POST' })
  assert.equal(verify.status, 200)
  assert.equal(verify.data.match, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 17 · CSRF ยังบังคับกับทุกเส้นทางที่เปลี่ยนสถานะ
// ─────────────────────────────────────────────────────────────────────────────
test('17 · ทุกเส้นทาง V2 ที่เปลี่ยนสถานะยังถูก CSRF บล็อกเมื่อไม่มี token', async () => {
  const owner = await login(OWNER)
  const content = makeContent(SMALL_SIZE)
  const upload = await openSession(owner, { name: `lft-v2-csrf-${Date.now()}.bin`, content })

  const create = await owner.req('/api/files/uploads', {
    method: 'POST', body: { name: 'no-token.bin', size: 10 }, skipCsrf: true,
  })
  assert.equal(create.status, 403)
  assert.equal(create.data.code, 'CSRF_TOKEN_INVALID')

  const put = await putChunk(owner, upload.uploadId, 0, Buffer.from(content), { skipCsrf: true })
  assert.equal(put.status, 403)
  assert.equal(put.data.code, 'CSRF_TOKEN_INVALID')

  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST', skipCsrf: true })
  assert.equal(commit.status, 403)

  const del = await owner.req(`/api/files/uploads/${upload.uploadId}`, { method: 'DELETE', skipCsrf: true })
  assert.equal(del.status, 403)

  // Origin ข้ามต้นทางก็ต้องถูกบล็อกที่ชั้นเดียวกัน (ชั้นที่ 2 ของ csrf.js)
  const crossOrigin = await putChunk(owner, upload.uploadId, 0, Buffer.from(content), {
    headers: { Origin: 'https://attacker.example' },
  })
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.data.code, 'CSRF_ORIGIN_MISMATCH')

  // ด่าน CSRF ต้องไม่ทำให้ session เสียหาย — ยังส่ง chunk ต่อได้ตามปกติ
  const allowed = await putChunk(owner, upload.uploadId, 0, Buffer.from(content))
  assert.equal(allowed.status, 200)
})

// ─────────────────────────────────────────────────────────────────────────────
// เพดานเชิงตรรกะ + การยกเลิก — ไม่อยู่ในรายการ 1–17 แต่เป็นสัญญาที่ UI พึ่งพา
// ─────────────────────────────────────────────────────────────────────────────
test('เพดานไฟล์เชิงตรรกะถูกบังคับฝั่งเซิร์ฟเวอร์และถูกประกาศให้ UI อ่านได้', async () => {
  const owner = await login(OWNER)

  const limits = await owner.req('/api/files/uploads/limits')
  assert.equal(limits.status, 200)
  assert.equal(limits.data.chunkSizeBytes, CHUNK)
  assert.equal(limits.data.maxLogicalFileBytes, TRANSFER_LIMITS.maxLogicalFileBytes)
  assert.equal(typeof limits.data.capacity.measured, 'boolean')

  const tooBig = await owner.req('/api/files/uploads', {
    method: 'POST',
    body: { name: 'too-big.bin', size: TRANSFER_LIMITS.maxLogicalFileBytes + 1 },
  })
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.data.code, 'LOGICAL_LIMIT_EXCEEDED')
  assert.equal(tooBig.data.maxLogicalFileBytes, TRANSFER_LIMITS.maxLogicalFileBytes)

  // เพดานใหม่ไม่ใช่ 1 GiB เดิมอีกต่อไป — ค่าคงที่เก่าต้องไม่กลับมาเป็นเพดานสถาปัตยกรรม
  assert.ok(
    TRANSFER_LIMITS.maxLogicalFileBytes > 1_073_741_824,
    'เพดานเชิงตรรกะเริ่มต้นต้องไม่ใช่ค่าคงที่ 1 GiB ของเส้นทางเดิม',
  )
})

test('ยกเลิก session แล้วไบต์ที่พักไว้ถูกคืน และไม่มีไฟล์ใดถูกเผยแพร่', async () => {
  const owner = await login(OWNER)
  const content = makeContent(MULTI_SIZE)
  const name = `lft-v2-cancel-${Date.now()}.bin`
  const upload = await openSession(owner, { name, content })
  await putChunk(owner, upload.uploadId, 0, Buffer.from(chunkOf(content, 0)))

  const cancelled = await owner.req(`/api/files/uploads/${upload.uploadId}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.data.ok, true)

  assert.equal((await owner.req(`/api/files/uploads/${upload.uploadId}`)).status, 404)
  await assert.rejects(
    fs.stat(path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, upload.uploadId)),
    'พื้นที่พักต้องถูกลบเมื่อผู้ใช้ยกเลิก',
  )
  assert.equal((await owner.req('/api/files')).data.files.some((f) => f.name === name), false)
})

test('การอัปโหลดทั้งหมดต้องล็อกอินก่อน — ไม่มีเส้นทาง V2 ใดเปิดให้ผู้ไม่ยืนยันตัวตน', async () => {
  const anonymous = new Client()
  assert.equal((await anonymous.req('/api/files/uploads/limits')).status, 401)
  assert.equal((await anonymous.req('/api/files/uploads/' + 'a'.repeat(48))).status, 401)
})
