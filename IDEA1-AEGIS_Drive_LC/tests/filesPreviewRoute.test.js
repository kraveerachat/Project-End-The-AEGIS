// tests/filesPreviewRoute.test.js — FILES-MANAGEMENT-UX-1 · Round 8 · GET /api/files/:id/preview
//
// ⚠️ ทำไมต้องมีเส้นทางใหม่แทนการยืม Download: Download ส่ง application/octet-stream +
//    attachment + nosniff เสมอ (โดยเจตนา — ไฟล์ HTML/SVG ที่ผู้ใช้อัปโหลดต้องไม่ถูก render
//    ใน origin ของแอป) และไม่รองรับ Range เบราว์เซอร์จึงแสดงภาพจากมันไม่ได้ และวิดีโอ
//    จะต้องดึงทั้งไฟล์ เส้นทาง Preview จึงต้อง "เปิดเฉพาะชนิดที่แสดงผลได้อย่างปลอดภัย"
//    ตาม allowlist ที่เซิร์ฟเวอร์ตัดสินเอง และต้องเสิร์ฟเป็นช่วง (206) เพื่อให้หน่วยความจำ
//    ทั้งฝั่งเซิร์ฟเวอร์และเบราว์เซอร์ถูกจำกัดต่อคำขอ ไม่ใช่ต่อขนาดไฟล์
//
// ⚠️ ด่านความเป็นเจ้าของต้องมาก่อน "ทุกอย่าง" — ก่อน Range, ก่อน MIME, ก่อนอ่านขนาด
//    ไฟล์บนดิสก์ — และตอบ 404 เหมือน Download เพื่อไม่ยืนยันว่าไฟล์ของคนอื่นมีอยู่
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-preview-route-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL
const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')
assert.equal(usingPostgres, DB_MODE === 'postgres')

let server, baseUrl
let nameSeq = 0
const uniqueName = (label, ext) => `preview-${label}-${Date.now()}-${nameSeq++}.${ext}`

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
    await query(`DELETE FROM files WHERE name LIKE 'preview-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function upload(client, name, bytes, parentId = null) {
  const form = new FormData()
  form.append('file', new Blob([bytes]), name)
  if (parentId !== null) form.append('parentId', String(parentId))
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `upload ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

async function makeFolder(client, name) {
  const res = await client.req('/api/files/folder', { method: 'POST', body: { name } })
  assert.equal(res.status, 201)
  return res.data.file
}

/** raw preview fetch — คืน status, headers และ bytes จริง */
async function preview(client, id, headers = {}) {
  const res = await client.raw(`/api/files/${encodeURIComponent(id)}/preview`, { headers })
  return { status: res.status, headers: res.headers, body: res.buffer }
}

/* ══ ownership before anything else ═══════════════════════════════════════ */

test('R8-PREVIEW-9 · owner isolation is enforced before any bytes, size or range are touched', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const bytes = randomBytes(4096)
  const file = await upload(owner, uniqueName('iso', 'jpg'), bytes)

  // เจ้าของเห็นเนื้อในจริง
  const mine = await preview(owner, file.id)
  assert.equal(mine.status, 200, 'เจ้าของต้องได้ preview')
  assert.equal(mine.headers.get('content-type'), 'image/jpeg')
  assert.ok(mine.body.equals(bytes))

  // คนอื่น (แม้เป็น Admin) ได้ 404 ไม่ใช่ 403 — ไม่ยืนยันว่ามีไฟล์อยู่
  const theirs = await preview(other, file.id)
  assert.equal(theirs.status, 404)
  assert.equal(theirs.body.length > 0 && theirs.headers.get('content-type')?.startsWith('image/'), false)

  // ⚠️ พิสูจน์ลำดับ: Range ที่ "ไม่ถูกต้อง" จากคนอื่นต้องได้ 404 ไม่ใช่ 416 — 416 จะต้องรู้ขนาดไฟล์
  //    ซึ่งแปลว่าเซิร์ฟเวอร์แตะ metadata/ดิสก์ของไฟล์คนอื่นไปแล้ว
  const probe = await preview(other, file.id, { Range: 'bytes=999999-' })
  assert.equal(probe.status, 404)
  assert.equal(probe.headers.get('content-range'), null)
  assert.equal(probe.headers.get('accept-ranges'), null)

  // ไม่ล็อกอิน → 401 (requireAuth เดิม)
  const anon = await fetch(`${baseUrl}/api/files/${file.id}/preview`)
  assert.equal(anon.status, 401)

  // id ที่ไม่มีอยู่ → 404 เหมือน Download
  assert.equal((await preview(owner, '999999999')).status, 404)
})

/* ══ MIME allowlist — เซิร์ฟเวอร์ตัดสินจากชื่อในฐานข้อมูล ไม่ใช่ client ══ */

test('R8-PREVIEW-MIME · only allowlisted image/video types are served inline with truthful headers', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const expected = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm',
  }
  for (const [ext, mime] of Object.entries(expected)) {
    const file = await upload(owner, uniqueName('mime', ext), randomBytes(64))
    const res = await preview(owner, file.id)
    assert.equal(res.status, 200, ext)
    assert.equal(res.headers.get('content-type'), mime, ext)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', ext)
    assert.match(res.headers.get('content-disposition') ?? '', /^inline;/, ext)
    assert.equal(res.headers.get('accept-ranges'), 'bytes', ext)
    assert.match(res.headers.get('cache-control') ?? '', /private/, ext)
    // ⚠️ กันสคริปต์: ต่อให้เบราว์เซอร์เปิด URL นี้ตรง ๆ ก็ต้องรันอะไรใน origin ไม่ได้
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/, ext)
    assert.equal(res.headers.get('content-disposition')?.includes('uploads/'), false)
  }
  // ชนิดที่รันโค้ดได้/ไม่รู้จัก → 415 และไม่มีไบต์ออกไป
  for (const ext of ['svg', 'html', 'txt', 'pdf', 'mkv', 'js']) {
    const file = await upload(owner, uniqueName('deny', ext), Buffer.from('<svg onload="alert(1)"></svg>'))
    const res = await preview(owner, file.id)
    assert.equal(res.status, 415, ext)
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /^(image|video|text\/html)/, ext)
  }
  // โฟลเดอร์ไม่มีไบต์ → 400 เหมือน Download
  const folder = await makeFolder(owner, uniqueName('dir', 'd').replace('.d', ''))
  assert.equal((await preview(owner, folder.id)).status, 400)
})

test('R8-PREVIEW-VAULT · a files row flagged vault=true is refused by the preview route', { skip: usingPostgres ? false : 'legacy vault rows can only be created directly in PostgreSQL' }, async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const { rows: [me] } = await query('SELECT id FROM users WHERE username = $1', [DEMO_USER.username])
  const name = uniqueName('vault', 'jpg')
  const { rows: [row] } = await query(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by, kind)
     VALUES ($1, 'vault/00000000-0000-4000-8000-000000000000.bin', 10, NULL, TRUE, TRUE, $2, 'file') RETURNING id`,
    [name, me.id],
  )
  const res = await preview(owner, String(row.id))
  assert.equal(res.status, 404, 'Vault ต้องไม่มีทาง preview แบบ plaintext — ตอบเหมือนไม่มีเส้นทางนี้')
  assert.equal(res.headers.get('content-type')?.startsWith('image/'), false)
})

/* ══ Range semantics — จริง ไม่ปลอม ════════════════════════════════════════ */

test('R8-RANGE · valid, suffix, clamped, invalid and absent ranges behave exactly per RFC 9110', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const bytes = randomBytes(8 * 1024 * 1024)
  const N = bytes.length
  const file = await upload(owner, uniqueName('range', 'mp4'), bytes)

  const full = await preview(owner, file.id)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-length'), String(N))
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(full.body.length, N)

  const head = await preview(owner, file.id, { Range: 'bytes=0-1023' })
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('content-range'), `bytes 0-1023/${N}`)
  assert.equal(head.headers.get('content-length'), '1024')
  assert.ok(head.body.equals(bytes.subarray(0, 1024)))

  const mid = await preview(owner, file.id, { Range: 'bytes=4096-8191' })
  assert.equal(mid.status, 206)
  assert.equal(mid.headers.get('content-range'), `bytes 4096-8191/${N}`)
  assert.ok(mid.body.equals(bytes.subarray(4096, 8192)))

  const open = await preview(owner, file.id, { Range: `bytes=${N - 10}-` })
  assert.equal(open.status, 206)
  assert.equal(open.headers.get('content-range'), `bytes ${N - 10}-${N - 1}/${N}`)
  assert.ok(open.body.equals(bytes.subarray(N - 10)))

  const suffix = await preview(owner, file.id, { Range: 'bytes=-100' })
  assert.equal(suffix.status, 206)
  assert.equal(suffix.headers.get('content-range'), `bytes ${N - 100}-${N - 1}/${N}`)
  assert.ok(suffix.body.equals(bytes.subarray(N - 100)))

  // ปลายเกินขอบ → ตัดให้พอดี ไม่ใช่ 416 (RFC: last-pos เกินได้)
  const clamped = await preview(owner, file.id, { Range: `bytes=${N - 5}-${N + 5000}` })
  assert.equal(clamped.status, 206)
  assert.equal(clamped.headers.get('content-range'), `bytes ${N - 5}-${N - 1}/${N}`)
  assert.equal(clamped.body.length, 5)

  // เริ่มต้นเกินขนาด / กลับหัว / ขยะ → 416 พร้อม Content-Range: bytes */N และไม่มีไบต์
  for (const bad of [`bytes=${N}-`, 'bytes=5-2', 'bytes=-0']) {
    const res = await preview(owner, file.id, { Range: bad })
    assert.equal(res.status, 416, bad)
    assert.equal(res.headers.get('content-range'), `bytes */${N}`, bad)
    assert.equal(res.body.length, 0, bad)
  }
  // ไวยากรณ์ผิด / หน่วยที่ไม่ใช่ bytes / หลายช่วง → RFC 9110 §14.2: ไม่มี Range → ส่งทั้งก้อน 200 (ไม่ปลอม 206)
  for (const ignored of ['items=0-10', 'bytes=0-10,20-30', 'bytes=abc']) {
    const res = await preview(owner, file.id, { Range: ignored })
    assert.equal(res.status, 200, ignored)
    assert.equal(res.body.length, N, ignored)
  }
})

test('R8-PREVIEW-10 · a large media preview is streamed per request, never buffered whole', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const size = 32 * 1024 * 1024
  const chunk = randomBytes(1024 * 1024)
  const file = await upload(owner, uniqueName('big', 'mp4'), Buffer.concat(Array.from({ length: 32 }, () => chunk)))
  assert.equal(file.size, size)

  const before = process.memoryUsage().arrayBuffers
  let transferred = 0
  for (let i = 0; i < 24; i += 1) {
    const start = i * 1024 * 1024 + 7
    const res = await preview(owner, file.id, { Range: `bytes=${start}-${start + 4095}` })
    assert.equal(res.status, 206)
    assert.equal(res.body.length, 4096)
    assert.ok(res.body.equals(chunk.subarray(7, 7 + 4096)))
    transferred += res.body.length
  }
  assert.equal(transferred, 24 * 4096)
  const grown = process.memoryUsage().arrayBuffers - before
  assert.ok(grown < size / 2, `ไบต์ที่ค้างในหน่วยความจำต้องไม่ใกล้ขนาดไฟล์ (โต ${grown} bytes)`)
})
