// tests/vaultV2Api.test.js — AEGIS Drive (IDEA1) · Private Vault V2 ผ่าน HTTP จริง (LFT-V2-B)
//
// ยิงผ่าน Express app ตัวเดียวกับ production (server/app.js) — securityHeaders / session /
// CSRF / requireAuth ทำงานจริงทุกชั้น ไม่มี mock แบบแผนเดียวกับ tests/vaultApi.test.js
// และ tests/resumableUpload.test.js
//
// สิ่งที่ชุดนี้พิสูจน์:
//    1. โปรโตคอลอัปโหลดทีละ chunk (เปิด → ส่ง → ถามสถานะ → commit → ยกเลิก)
//    2. ค่าที่ client ประกาศถูก "ตรวจแล้วแช่แข็ง" — ไม่มี endpoint ใดแก้ได้ภายหลัง
//    3. ของผู้ใช้อื่น = 404 ทุกกริยา (ไม่ใช่ 403 ที่ยืนยันว่ามีอยู่)
//    4. SERVER_CIPHERTEXT_INTEGRITY: เซิร์ฟเวอร์ตรวจไบต์ของตัวเองก่อนเผยแพร่
//    5. ไม่มี upload ที่ยังไม่ commit โผล่ใน GET /api/vault
//    6. ดาวน์โหลดรายก้อน + ไบต์ตรงเป๊ะ + ถอดได้จริงด้วย DEK ของเบราว์เซอร์
//    7. ไม่มีชื่อไฟล์ / MIME / กุญแจ / storage key ใน API, ในแถวข้อมูล, บนดิสก์ หรือใน log
//    8. V1 ยังทำงานครบทุกอย่างในบัญชีรายการเดียวกัน
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performLogin } from './helpers/testClient.mjs'

// ต้องตั้งก่อน import โมดูลที่อ่านค่าเหล่านี้ตอน module-load
const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-v2-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
// 8 MiB = ขอบล่างจริงของช่วงที่ deployment ตั้งได้ (server/config/vaultTransferLimits.js)
// ⚠️ ไม่ใช่ค่าทดสอบพิเศษที่ production ตั้งไม่ได้ — ชุดนี้จึงเดินเส้นทางจริง
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultStaging } = await import('../server/storage/vaultStaging.js')
// พื้นที่พักอยู่นอกโฟลเดอร์ vault/ โดยเจตนา — ไฟล์ที่ยังไม่ commit จึงไม่มีทาง
// ถูกเข้าใจผิดว่าเป็นข้อมูลของผู้ใช้ (ดู server/storage/vaultStaging.js)
const stagingVaultDir = () => path.join(STORAGE_ROOT, '.staging', 'vault')
const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
const store = await import('../server/db/store.js')
const v2store = await import('../server/db/vaultV2Store.js')
const { readAudit, usingPostgres, closePool } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[vault v2 api tests] database mode: ${DB_MODE}`)

const {
  createVaultSetup, encryptFileEnvelope,
} = await import('../src/lib/vaultCrypto.js')
const {
  createVaultV2Envelope, encryptVaultChunk, decryptVaultChunk, unwrapVaultV2Dek,
  decryptVaultV2Meta, planVaultChunks, plaintextRangeFor, newContentId,
} = await import('../src/lib/vaultChunkCrypto.js')

const CIPHER_CHUNK = VAULT_TRANSFER_LIMITS.ciphertextChunkBytes
assert.equal(CIPHER_CHUNK, 8 * 1024 * 1024 + GCM_TAG_BYTES, 'ชุดนี้ต้องรันด้วย chunk plaintext 8 MiB')

// พารามิเตอร์ Argon2id ที่เบาที่สุด "เท่าที่เซิร์ฟเวอร์ยอมรับ" — ยังผ่าน validate จริง
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }

const PASSPHRASE = 'zebra-glacier-nominal-77-vault'
const SECRET_FILENAME = 'merger-term-sheet-CONFIDENTIAL.pdf'
const SECRETS = [PASSPHRASE, SECRET_FILENAME, 'merger-term-sheet', 'CONFIDENTIAL']

const OWNER = { username: 'user', password: 'aegis-drive-user' }
const OTHER = { username: 'admin', password: 'aegis-drive-admin' }

let server, baseUrl
const logLines = []

before(async () => {
  await initStorage()
  await initVaultStorage()
  await initVaultStaging()

  // ถ้ามีใครเผลอ console.log(req.headers) หรือ path ของไฟล์ จะโดนจับที่นี่
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream)
    stream.write = (chunk, ...rest) => {
      logLines.push(String(chunk))
      return orig(chunk, ...rest)
    }
  }

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

beforeEach(async () => {
  await v2store.__resetVaultV2ForTests()
  await store.__resetVaultForTests()
  const dir = path.join(STORAGE_ROOT, 'vault')
  for (const f of await fs.readdir(dir)) {
    if (f === '.staging') continue
    await fs.rm(path.join(dir, f), { recursive: true, force: true })
  }
  const staging = stagingVaultDir()
  for (const f of await fs.readdir(staging).catch(() => [])) {
    await fs.rm(path.join(staging, f), { recursive: true, force: true })
  }
})

// ── client จำลอง: ถือ cookie + CSRF token เหมือนเบราว์เซอร์จริง ───────────────
class Client {
  constructor() { this.cookie = null; this.csrf = null }

  async req(pathname, { method = 'GET', body, headers: extra, skipCsrf = false } = {}) {
    const headers = { ...extra }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET' && !skipCsrf) headers['X-CSRF-Token'] = this.csrf
    let payload
    if (body instanceof FormData || body instanceof Uint8Array) payload = body
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = await res.json() } catch { /* 204 / octet-stream */ }
    return { status: res.status, data, headers: res.headers }
  }

  async raw(pathname, { method = 'GET', headers: extra, body } = {}) {
    const headers = { ...extra }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    const res = await fetch(baseUrl + pathname, { method, headers, body })
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) }
  }

  login(username, password) { return performLogin(this, username, password) }
}

const loginAs = async (u) => { const c = new Client(); await c.login(u.username, u.password); return c }

/** ตั้งค่า vault แล้วคืน KEK ที่เบราว์เซอร์จะถืออยู่ */
async function setupVault(client) {
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  const res = await client.req('/api/vault/setup', {
    method: 'POST',
    body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })
  assert.equal(res.status, 201)
  return setup.kek
}

/** ซอง V2 ที่ถูกต้องหนึ่งชุด — เนื้อในเป็นความลับของเบราว์เซอร์ล้วน */
async function envelopeFor(kek, { name = SECRET_FILENAME, type = 'application/pdf', size, chunkCount }) {
  const env = await createVaultV2Envelope(kek, { name, type, size, chunkCount })
  return {
    env,
    body: {
      formatVersion: 2,
      contentIdB64: env.contentIdB64,
      chunkSize: CIPHER_CHUNK,
      wrappedDekB64: env.wrappedDekB64,
      wrapIvB64: env.wrapIvB64,
      metaIvB64: env.metaIvB64,
      metaB64: env.metaB64,
    },
  }
}

const ivB64 = () => randomBytes(12).toString('base64')

/** PUT ciphertext ของ chunk หนึ่งก้อน */
function putChunk(client, uploadId, index, bytes, iv = ivB64()) {
  return client.req(`/api/vault/uploads/${uploadId}/chunks/${index}`, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': iv },
  })
}

/**
 * เปิด session เล็ก ๆ ที่มี chunk เดียว — พอสำหรับพิสูจน์กติกาของโปรโตคอล
 * ⚠️ chunkSize ยังเป็น 8 MiB จริงตามที่ deployment ตั้ง แต่ไฟล์ที่เล็กกว่า chunk เดียว
 *    ทำให้ก้อนแรกเป็นก้อนสุดท้ายด้วย จึงส่งไบต์น้อย ๆ ได้โดยไม่เลี่ยงการตรวจใด ๆ
 */
async function openSmallSession(client, kek, { ciphertextSize = 1024 + GCM_TAG_BYTES } = {}) {
  const { env, body } = await envelopeFor(kek, { size: ciphertextSize - GCM_TAG_BYTES, chunkCount: 1 })
  const res = await client.req('/api/vault/uploads', {
    method: 'POST', body: { ...body, ciphertextSize, chunkCount: 1 },
  })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  return { uploadId: res.data.upload.uploadId, env, ciphertextSize, upload: res.data.upload }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16 · เพดานที่ deployment บังคับอยู่จริง
// ─────────────────────────────────────────────────────────────────────────────
test('GET /limits บอกค่าที่บังคับอยู่จริง และต้องล็อกอินก่อน', async () => {
  const anon = new Client()
  const denied = await anon.req('/api/vault/uploads/limits')
  assert.equal(denied.status, 401, 'ไม่มี session = ไม่มีสิทธิ์แม้แต่จะรู้เพดาน')

  const c = await loginAs(OWNER)
  const res = await c.req('/api/vault/uploads/limits')
  assert.equal(res.status, 200)
  assert.equal(res.data.formatVersion, 2)
  assert.equal(res.data.plaintextChunkBytes, 8 * 1024 * 1024)
  assert.equal(res.data.ciphertextChunkBytes, 8 * 1024 * 1024 + 16)
  assert.equal(res.data.gcmTagBytes, 16)
  assert.ok(res.data.maxLogicalFileBytes > 64 * 1024 * 1024, 'V2 ต้องไม่ติดเพดาน 64 MiB ของ V1')

  // ⚠️ LFT-V2-E · จอต้องแยก "เพดานที่บังคับอยู่ตอนนี้" ออกจาก "เพดานสูงสุดที่ตั้งได้"
  //    การเอาค่าที่สองไปบอกผู้ใช้คือการสัญญาขนาดที่เซิร์ฟเวอร์นี้จะปฏิเสธจริง ๆ
  assert.equal(res.data.maxSupportedLogicalFileBytes, 34_359_738_368, 'เพดานที่รองรับคือ 32 GiB')
  assert.ok(res.data.maxLogicalFileBytes <= res.data.maxSupportedLogicalFileBytes,
    'ค่าที่บังคับอยู่ต้องไม่เกินค่าที่ประกาศว่ารองรับ')
  assert.equal(res.data.maxLogicalFileBytes, 5 * 1024 * 1024 * 1024,
    'deployment ที่ไม่ได้ตั้งค่าเองต้องยังได้ 5 GiB เท่าเดิม — การรองรับ 32 GiB ต้องเป็นการเลือก')

  assert.ok(Object.hasOwn(res.data, 'capacity'))
  assert.ok(!JSON.stringify(res.data).includes('/'), 'ต้องไม่มี path ใด ๆ ในคำตอบ')
})

// ─────────────────────────────────────────────────────────────────────────────
// 17 · auth + CSRF
// ─────────────────────────────────────────────────────────────────────────────
test('ทุกเส้นทางของ V2 ปิดสำหรับผู้ที่ไม่มี session — และไม่มีทางบอกว่า id ไหนมีจริง', async () => {
  const anon = new Client()

  // อ่าน: requireAuth เป็นด่านแรก → 401 (ไม่ใช่ 404 ที่ทำให้เดา id ได้ทีละใบ)
  for (const url of [
    '/api/vault/uploads/limits',
    '/api/vault/uploads/' + 'a'.repeat(48),
    `/api/vault/blobs/${'a'.repeat(48)}/chunks/0`,
  ]) {
    const res = await anon.req(url)
    assert.equal(res.status, 401, `GET ${url}`)
  }

  // เขียน: CSRF อยู่ "นอก" requireAuth (app.use('/api', csrfProtection, apiRouter))
  // คำขอที่ไม่มี session จึงถูกปฏิเสธที่ด่าน CSRF ก่อนถึง requireAuth เสมอ — บันทึกไว้
  // ตามจริงว่าเป็น 403 ไม่ใช่ 401 สิ่งที่สำคัญคือ "ไม่มีทางผ่าน" ไม่ใช่ตัวเลขไหนมาก่อน
  for (const [method, url] of [
    ['POST', '/api/vault/uploads'],
    ['PUT', `/api/vault/uploads/${'a'.repeat(48)}/chunks/0`],
    ['POST', `/api/vault/uploads/${'a'.repeat(48)}/commit`],
    ['DELETE', '/api/vault/uploads/' + 'a'.repeat(48)],
  ]) {
    const res = await anon.req(url, { method, body: {} })
    assert.equal(res.status, 403, `${method} ${url}`)
  }
})

test('CSRF ถูกบังคับกับทุกกริยาที่เปลี่ยนสถานะของ V2', async () => {
  const c = await loginAs(OWNER)
  await setupVault(c)
  for (const [method, url] of [
    ['POST', '/api/vault/uploads'],
    ['PUT', `/api/vault/uploads/${'a'.repeat(48)}/chunks/0`],
    ['POST', `/api/vault/uploads/${'a'.repeat(48)}/commit`],
    ['DELETE', '/api/vault/uploads/' + 'a'.repeat(48)],
  ]) {
    const res = await c.req(url, { method, body: {}, skipCsrf: true })
    assert.equal(res.status, 403, `${method} ${url} ต้องถูกปฏิเสธเมื่อไม่มี CSRF token`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 18–19 · การตรวจ input ตอนเปิด session
// ─────────────────────────────────────────────────────────────────────────────
test('เปิด session ก่อนตั้งค่า vault ไม่ได้ — ไม่มี KEK ก็ไม่มีซองที่มีความหมาย', async () => {
  const c = await loginAs(OWNER)
  const kek = (await createVaultSetup(PASSPHRASE, FAST)).kek
  const { body } = await envelopeFor(kek, { size: 1024, chunkCount: 1 })
  const res = await c.req('/api/vault/uploads', {
    method: 'POST', body: { ...body, ciphertextSize: 1040, chunkCount: 1 },
  })
  assert.equal(res.status, 409)
})

test('ค่าที่ประกาศตอนเปิด session ถูกตรวจทุกตัว — ผิดข้อเดียวก็ 400', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { body } = await envelopeFor(kek, { size: 1024, chunkCount: 1 })
  const good = { ...body, ciphertextSize: 1024 + GCM_TAG_BYTES, chunkCount: 1 }

  const bad = [
    ['formatVersion ที่ไม่ใช่ 2', { formatVersion: 1 }],
    ['formatVersion เป็นข้อความ', { formatVersion: 'v2' }],
    ['contentId ผิดความยาว', { contentIdB64: 'AAAA' }],
    ['contentId ไม่ใช่ base64', { contentIdB64: '!'.repeat(24) }],
    ['ไม่มี wrappedDek', { wrappedDekB64: undefined }],
    ['wrapIv ผิดความยาว', { wrapIvB64: 'AAAA' }],
    ['metaIv ผิดความยาว', { metaIvB64: 'AAAA' }],
    ['chunkCount = 0', { chunkCount: 0 }],
    ['chunkCount ติดลบ', { chunkCount: -1 }],
    ['chunkSize เล็กกว่าขอบล่างที่ deployment ยอมรับ', { chunkSize: 1024 }],
    ['chunkSize ใหญ่กว่าขอบบน', { chunkSize: 64 * 1024 * 1024 + 17 }],
    ['ciphertextSize = 0', { ciphertextSize: 0 }],
    ['ก้อนสุดท้ายเล็กกว่า GCM tag', { ciphertextSize: 8, chunkCount: 1 }],
    ['ciphertextSize ไม่สอดคล้องกับ chunkCount', { ciphertextSize: 1040, chunkCount: 5 }],
    ['ciphertextSize มากกว่าที่ chunkCount รองรับได้', { ciphertextSize: CIPHER_CHUNK * 2 + 1, chunkCount: 2 }],
  ]

  for (const [label, patch] of bad) {
    const res = await c.req('/api/vault/uploads', { method: 'POST', body: { ...good, ...patch } })
    assert.equal(res.status, 400, `ควรปฏิเสธ: ${label} — ได้ ${res.status}`)
  }

  const ok = await c.req('/api/vault/uploads', { method: 'POST', body: good })
  assert.equal(ok.status, 201, 'ค่าชุดเดียวกันที่ถูกต้องต้องผ่าน')
})

test('ไฟล์ที่ใหญ่เกินเพดานเชิงตรรกะถูกปฏิเสธที่ 413 พร้อมบอกเพดาน', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const max = VAULT_TRANSFER_LIMITS.maxLogicalFileBytes
  const chunkCount = Math.ceil((max + CIPHER_CHUNK) / (CIPHER_CHUNK - GCM_TAG_BYTES)) + 1
  const { body } = await envelopeFor(kek, { size: max + 1, chunkCount })
  const res = await c.req('/api/vault/uploads', {
    method: 'POST',
    body: { ...body, chunkCount, ciphertextSize: chunkCount * CIPHER_CHUNK },
  })
  assert.equal(res.status, 413)
  assert.equal(res.data.code, 'LOGICAL_LIMIT_EXCEEDED')
  assert.equal(res.data.maxLogicalFileBytes, max)
})

// ─────────────────────────────────────────────────────────────────────────────
// 20 · การแยกเจ้าของ
// ─────────────────────────────────────────────────────────────────────────────
test('session ของผู้ใช้อื่น = 404 ทุกกริยา ไม่ใช่ 403 ที่ยืนยันว่ามีอยู่', async () => {
  const owner = await loginAs(OWNER)
  const kek = await setupVault(owner)
  const { uploadId } = await openSmallSession(owner, kek)

  const other = await loginAs(OTHER)
  const get = await other.req(`/api/vault/uploads/${uploadId}`)
  assert.equal(get.status, 404)
  const put = await putChunk(other, uploadId, 0, new Uint8Array(1040))
  assert.equal(put.status, 404)
  const commit = await other.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 404)
  const del = await other.req(`/api/vault/uploads/${uploadId}`, { method: 'DELETE' })
  assert.equal(del.status, 404)

  // เจ้าของยังเข้าถึงได้ตามปกติ — ที่ผ่านมาไม่ใช่การล็อกทั้ง session ทิ้ง
  const mine = await owner.req(`/api/vault/uploads/${uploadId}`)
  assert.equal(mine.status, 200)
  assert.equal(mine.data.upload.uploadId, uploadId)
})

test('uploadId ที่ผิดรูปแบบได้ 404 เหมือนของคนอื่น ไม่ใช่ 400 ที่บอกว่ารูปแบบคืออะไร', async () => {
  const c = await loginAs(OWNER)
  await setupVault(c)
  for (const id of ['0', 'zz', 'a'.repeat(47), 'a'.repeat(49), 'g'.repeat(48), '../../etc/passwd']) {
    const res = await c.req(`/api/vault/uploads/${encodeURIComponent(id)}`)
    assert.equal(res.status, 404, `uploadId=${id}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 21–24 · การส่ง chunk
// ─────────────────────────────────────────────────────────────────────────────
test('chunk ที่ถูกต้องถูกรับไว้ และสถานะบอกว่าขาดอะไรอยู่บ้าง', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { env, body } = await envelopeFor(kek, { size: 8 * 1024 * 1024 + 512, chunkCount: 2 })
  const ciphertextSize = CIPHER_CHUNK + 512 + GCM_TAG_BYTES
  const open = await c.req('/api/vault/uploads', {
    method: 'POST', body: { ...body, ciphertextSize, chunkCount: 2 },
  })
  assert.equal(open.status, 201)
  const { uploadId } = open.data.upload
  assert.deepEqual(open.data.upload.missing, [0, 1])
  assert.equal(open.data.upload.status, 'open')
  assert.ok(env.contentIdB64)

  const first = await putChunk(c, uploadId, 0, randomBytes(CIPHER_CHUNK))
  assert.equal(first.status, 200, JSON.stringify(first.data))
  assert.equal(first.data.size, CIPHER_CHUNK)
  assert.deepEqual(first.data.upload.missing, [1])
  assert.equal(first.data.upload.receivedBytes, CIPHER_CHUNK)

  const second = await putChunk(c, uploadId, 1, randomBytes(512 + GCM_TAG_BYTES))
  assert.equal(second.status, 200)
  assert.deepEqual(second.data.upload.missing, [])
  assert.equal(second.data.upload.receivedBytes, ciphertextSize)
})

test('ดัชนีที่ไม่มีอยู่ ขนาดที่ผิด และ IV ที่ผิดรูปแบบ ถูกปฏิเสธคนละรหัส', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)

  const outOfRange = await putChunk(c, uploadId, 1, new Uint8Array(ciphertextSize))
  assert.equal(outOfRange.status, 400)
  assert.equal(outOfRange.data.code, 'CHUNK_INDEX_INVALID')

  const notANumber = await putChunk(c, uploadId, 'x', new Uint8Array(ciphertextSize))
  assert.equal(notANumber.status, 400)
  assert.equal(notANumber.data.code, 'CHUNK_INDEX_INVALID')

  for (const iv of ['', 'AAAA', 'A'.repeat(24), '!'.repeat(16)]) {
    const res = await c.req(`/api/vault/uploads/${uploadId}/chunks/0`, {
      method: 'PUT',
      body: new Uint8Array(ciphertextSize),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': iv },
    })
    assert.equal(res.status, 400, `IV=${JSON.stringify(iv)}`)
    assert.equal(res.data.code, 'CHUNK_IV_INVALID')
  }

  const noIv = await c.req(`/api/vault/uploads/${uploadId}/chunks/0`, {
    method: 'PUT', body: new Uint8Array(ciphertextSize), headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(noIv.status, 400)
  assert.equal(noIv.data.code, 'CHUNK_IV_INVALID')

  for (const size of [ciphertextSize - 1, ciphertextSize + 1]) {
    const res = await putChunk(c, uploadId, 0, new Uint8Array(size))
    assert.equal(res.status, 400, `size=${size}`)
    assert.equal(res.data.code, 'CHUNK_SIZE_INVALID')
    assert.equal(res.data.expectedBytes, ciphertextSize)
  }

  // ทุกความล้มเหลวด้านบนต้องไม่ทำให้ช่องนั้น "นับว่ารับแล้ว"
  const status = await c.req(`/api/vault/uploads/${uploadId}`)
  assert.deepEqual(status.data.upload.missing, [0])
  assert.equal(status.data.upload.receivedBytes, 0)
})

test('ส่ง chunk เดิมซ้ำด้วยไบต์ชุดใหม่ = ไบต์ใหม่ทับทั้งช่วง ไม่ใช่ต่อท้าย', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)

  const first = randomBytes(ciphertextSize)
  const second = randomBytes(ciphertextSize)
  assert.equal((await putChunk(c, uploadId, 0, first)).status, 200)
  const retry = await putChunk(c, uploadId, 0, second)
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.data.upload.missing, [])
  assert.equal(retry.data.upload.receivedBytes, ciphertextSize, 'ขนาดต้องไม่ถูกนับสองครั้ง')

  // commit แล้วดาวน์โหลดกลับ — ต้องได้ไบต์ชุดที่สอง ไม่ใช่ชุดแรกหรือของผสม
  const commit = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201)
  const got = await c.raw(`/api/vault/blobs/${commit.data.blob.id}/chunks/0`)
  assert.equal(got.status, 200)
  assert.deepEqual(Buffer.from(got.bytes), second)
})

// ─────────────────────────────────────────────────────────────────────────────
// 25–27 · commit
// ─────────────────────────────────────────────────────────────────────────────
test('commit ที่ยังขาด chunk ถูกปฏิเสธและบอกว่าขาดก้อนไหน', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { body } = await envelopeFor(kek, { size: 8 * 1024 * 1024 + 100, chunkCount: 2 })
  const ciphertextSize = CIPHER_CHUNK + 100 + GCM_TAG_BYTES
  const open = await c.req('/api/vault/uploads', {
    method: 'POST', body: { ...body, ciphertextSize, chunkCount: 2 },
  })
  const { uploadId } = open.data.upload
  await putChunk(c, uploadId, 1, randomBytes(100 + GCM_TAG_BYTES))

  const res = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'UPLOAD_INCOMPLETE')
  assert.deepEqual(res.data.upload.missing, [0])

  const inventory = await c.req('/api/vault')
  assert.deepEqual(inventory.data.blobs, [], 'upload ที่ยังไม่ commit ต้องมองไม่เห็นในบัญชีรายการ')
})

test('ไบต์ที่ถูกแก้บนดิสก์หลังรับไว้แล้ว ถูกจับได้ตอน commit — SERVER_CIPHERTEXT_INTEGRITY', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  assert.equal((await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))).status, 200)

  // จำลอง "ไบต์บนดิสก์เพี้ยนหลังจากเซิร์ฟเวอร์รับไว้แล้ว" — พลิกหนึ่งไบต์
  // ⚠️ ต้อง "พลิก" ไม่ใช่ "เขียนค่าคงที่ทับ": ไบต์ต้นทางมาจาก randomBytes() ดังนั้นการ
  //    เขียน 0xff ทับจะไม่เปลี่ยนอะไรเลยเมื่อไบต์นั้นเป็น 0xff อยู่แล้ว (1 ใน 256 ครั้ง)
  //    แล้ว commit ก็ผ่านอย่างถูกต้อง — เทสต์จะแดงแบบสุ่มโดยที่โค้ดโปรดักชันไม่ผิดอะไร
  const part = path.join(stagingVaultDir(), uploadId, 'part')
  const fh = await fs.open(part, 'r+')
  const original = Buffer.alloc(1)
  await fh.read(original, 0, 1, 5)
  await fh.write(Buffer.from([original[0] ^ 0xff]), 0, 1, 5)
  await fh.close()

  const res = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(res.status, 422)
  assert.equal(res.data.code, 'CIPHERTEXT_INTEGRITY_FAILED')
  assert.equal(res.data.chunkIndex, 0)

  // session ที่รู้แล้วว่าไบต์เพี้ยน ต้องไม่เหลือให้ commit ซ้ำได้
  const after = await c.req(`/api/vault/uploads/${uploadId}`)
  assert.equal(after.data.upload.status, 'aborted')
  const retry = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(retry.status, 409)
  const inventory = await c.req('/api/vault')
  assert.deepEqual(inventory.data.blobs, [])
})

test('commit สำเร็จสร้าง blob เดียว ไฟล์เดียว และปิด session นั้นถาวร', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  const bytes = randomBytes(ciphertextSize)
  await putChunk(c, uploadId, 0, bytes)

  const commit = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201)
  const blob = commit.data.blob
  assert.equal(blob.formatVersion, 2)
  assert.equal(blob.size, ciphertextSize)
  assert.equal(blob.chunkCount, 1)
  assert.equal(blob.chunkSize, CIPHER_CHUNK)

  // ไฟล์ปลายทางหนึ่งไฟล์ พื้นที่พักว่างเปล่า
  const vaultFiles = (await fs.readdir(path.join(STORAGE_ROOT, 'vault'))).filter((f) => f !== '.staging')
  assert.equal(vaultFiles.length, 1)
  assert.ok(vaultFiles[0].endsWith('.aegisenc'))
  assert.deepEqual(await fs.readdir(stagingVaultDir()), [], 'พื้นที่พักต้องถูกเก็บกวาดหลัง commit')

  // commit ซ้ำไม่สร้างของซ้ำ (NO_DUPLICATE_VAULT_BLOB)
  const again = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(again.status, 409)
  assert.equal(again.data.code, 'SESSION_NOT_OPEN')
  const inventory = await c.req('/api/vault')
  assert.equal(inventory.data.blobs.length, 1)

  // ยกเลิก session ที่ commit แล้วไม่ได้ — ไบต์เป็นข้อมูลของผู้ใช้ไปแล้ว
  const del = await c.req(`/api/vault/uploads/${uploadId}`, { method: 'DELETE' })
  assert.equal(del.status, 409)
  assert.equal(del.data.code, 'SESSION_COMMITTED')
  assert.equal((await fs.readdir(path.join(STORAGE_ROOT, 'vault'))).filter((f) => f !== '.staging').length, 1)
})

test('การยกเลิก session คืนพื้นที่พักและทำให้ id นั้นหายไปเลย', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))
  assert.equal((await fs.readdir(stagingVaultDir())).length, 1)

  const del = await c.req(`/api/vault/uploads/${uploadId}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.deepEqual(await fs.readdir(stagingVaultDir()), [])
  assert.equal((await c.req(`/api/vault/uploads/${uploadId}`)).status, 404)
  assert.equal(
    (await fs.readdir(path.join(STORAGE_ROOT, 'vault'))).filter((f) => f !== '.staging').length, 0,
    'การยกเลิกต้องไม่สร้างไฟล์ปลายทาง',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 28–30 · การอ่านกลับ
// ─────────────────────────────────────────────────────────────────────────────
test('วงจรเต็ม: เข้ารหัสหลายก้อนในเบราว์เซอร์ → commit → ดาวน์โหลดรายก้อน → ถอดได้ตรงไบต์', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)

  const plain = randomBytes(8 * 1024 * 1024 + 4321)
  const plan = planVaultChunks(plain.length, 8 * 1024 * 1024)
  assert.equal(plan.chunkCount, 2)

  const env = await createVaultV2Envelope(kek, {
    name: SECRET_FILENAME, type: 'application/pdf', size: plain.length, chunkCount: plan.chunkCount,
  })
  const open = await c.req('/api/vault/uploads', {
    method: 'POST',
    body: {
      formatVersion: 2,
      contentIdB64: env.contentIdB64,
      ciphertextSize: plan.ciphertextSize,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      wrappedDekB64: env.wrappedDekB64,
      wrapIvB64: env.wrapIvB64,
      metaIvB64: env.metaIvB64,
      metaB64: env.metaB64,
    },
  })
  assert.equal(open.status, 201, JSON.stringify(open.data))
  const { uploadId } = open.data.upload

  for (let i = 0; i < plan.chunkCount; i += 1) {
    const range = plaintextRangeFor(i, plain.length, plan.plaintextChunkBytes)
    const piece = await encryptVaultChunk(env.dek, {
      contentId: env.contentId, chunkIndex: i, chunkCount: plan.chunkCount,
      plaintext: plain.subarray(range.start, range.end),
    })
    const put = await putChunk(c, uploadId, i, piece.ciphertext, piece.ivB64)
    assert.equal(put.status, 200, JSON.stringify(put.data))
  }

  const commit = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201)
  const blob = commit.data.blob

  // ดาวน์โหลดทีละก้อน แล้วถอดด้วย DEK ที่แกะจากซอง (เหมือนที่เบราว์เซอร์ทำ)
  const dek = await unwrapVaultV2Dek(kek, blob)
  const meta = await decryptVaultV2Meta(kek, blob)
  assert.equal(meta.name, SECRET_FILENAME)
  assert.equal(meta.plainSize, plain.length)

  const rebuilt = Buffer.alloc(0)
  const parts = []
  for (let i = 0; i < blob.chunkCount; i += 1) {
    const res = await c.raw(`/api/vault/blobs/${blob.id}/chunks/${i}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-vault-chunk-index'), String(i))
    const iv = res.headers.get('x-vault-chunk-iv')
    assert.ok(iv, 'IV ของก้อนนี้ต้องมากับ response')
    assert.equal(Buffer.from(iv, 'base64').length, 12)
    parts.push(await decryptVaultChunk(dek, {
      contentId: blob.contentIdB64, chunkIndex: i, chunkCount: blob.chunkCount,
      ivB64: iv, ciphertext: res.bytes,
    }))
  }
  assert.deepEqual(Buffer.concat(parts.map(Buffer.from)), plain)
  assert.equal(rebuilt.length, 0)

  // IV ของสองก้อนต้องไม่ซ้ำกัน (ตรึงที่ชั้น API ด้วย ไม่ใช่แค่ในโมดูล crypto)
  const ivs = []
  for (let i = 0; i < blob.chunkCount; i += 1) {
    const res = await c.raw(`/api/vault/blobs/${blob.id}/chunks/${i}`)
    ivs.push(res.headers.get('x-vault-chunk-iv'))
  }
  assert.equal(new Set(ivs).size, blob.chunkCount)
})

test('การขอ chunk: ของคนอื่น ดัชนีเกินขอบเขต และ id ผิดรูปแบบ ล้วนเป็น 404', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))
  const blob = (await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob

  const other = await loginAs(OTHER)
  assert.equal((await other.raw(`/api/vault/blobs/${blob.id}/chunks/0`)).status, 404)

  assert.equal((await c.raw(`/api/vault/blobs/${blob.id}/chunks/1`)).status, 404)
  assert.equal((await c.raw(`/api/vault/blobs/${blob.id}/chunks/999999`)).status, 404)
  assert.equal((await c.raw(`/api/vault/blobs/${blob.id}/chunks/-1`)).status, 404)
  assert.equal((await c.raw(`/api/vault/blobs/${'f'.repeat(48)}/chunks/0`)).status, 404)
  assert.equal((await c.raw('/api/vault/blobs/nope/chunks/0')).status, 404)
})

test('blob V2 ไม่มีทางดาวน์โหลด "ทั้งไฟล์" ผ่านเส้นทางเดิม — และของคนอื่นยังเป็น 404', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))
  const blob = (await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob

  const mine = await c.req(`/api/vault/blobs/${blob.id}`)
  assert.equal(mine.status, 409)
  assert.equal(mine.data.code, 'VAULT_V2_USE_CHUNK_ENDPOINT')
  assert.equal(mine.data.chunkCount, 1)

  const other = await loginAs(OTHER)
  const theirs = await other.req(`/api/vault/blobs/${blob.id}`)
  assert.equal(theirs.status, 404, 'คนที่ไม่ใช่เจ้าของต้องไม่ได้รับการยืนยันว่า id นี้มีอยู่')
})

// ─────────────────────────────────────────────────────────────────────────────
// 31 · บัญชีรายการเดียวสำหรับ V1 + V2
// ─────────────────────────────────────────────────────────────────────────────
test('GET /api/vault คืนทั้ง V1 และ V2 ในรายการเดียว โดยไม่มี plaintext หรือ storage key', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)

  // V1 (เส้นทางเดิมที่ต้องไม่ถูกถอดออก)
  const v1Bytes = new TextEncoder().encode('legacy vault content')
  const v1env = await encryptFileEnvelope(kek, {
    name: 'legacy-notes.txt', type: 'text/plain', size: v1Bytes.length, bytes: v1Bytes,
  })
  const form = new FormData()
  form.append('file', new Blob([v1env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
  form.append('ivB64', v1env.ivB64)
  form.append('wrappedDekB64', v1env.wrappedDekB64)
  form.append('wrapIvB64', v1env.wrapIvB64)
  form.append('metaIvB64', v1env.metaIvB64)
  form.append('metaB64', v1env.metaB64)
  const v1res = await c.req('/api/vault/blobs', { method: 'POST', body: form })
  assert.equal(v1res.status, 201)

  // V2
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))
  const v2res = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(v2res.status, 201)

  const inv = await c.req('/api/vault')
  assert.equal(inv.status, 200)
  assert.equal(inv.data.configured, true)
  assert.equal(inv.data.blobs.length, 2)

  const v1 = inv.data.blobs.find((b) => b.formatVersion === 1)
  const v2 = inv.data.blobs.find((b) => b.formatVersion === 2)
  assert.ok(v1 && v2, 'ทั้งสองรูปแบบต้องอยู่ในรายการเดียวกัน')

  // V1 ยังมี ivB64 ระดับไฟล์ / V2 ไม่มีโดยสาระของรูปแบบ แต่มี contentId + แผนของ chunk
  assert.ok(v1.ivB64)
  assert.equal(v2.ivB64, undefined)
  assert.equal(v2.contentIdB64.length, 24)
  assert.equal(v2.chunkCount, 1)
  assert.equal(v2.chunkSize, CIPHER_CHUNK)

  for (const b of inv.data.blobs) {
    for (const forbidden of ['storageKey', 'storage_key', 'name', 'filename', 'type', 'mimeType', 'plainSize']) {
      assert.equal(Object.hasOwn(b, forbidden), false, `รายการต้องไม่มีฟิลด์ ${forbidden}`)
    }
    assert.ok(b.wrappedDekB64 && b.wrapIvB64 && b.metaIvB64 && b.metaB64, 'ต้องมีซองครบให้เบราว์เซอร์ถอดเอง')
  }

  const serialized = JSON.stringify(inv.data)
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret), false, `บัญชีรายการต้องไม่มี "${secret}"`)
  }
  assert.equal(serialized.includes('.aegisenc'), false, 'ต้องไม่มี path ของ Storage Layer หลุดออกมา')
})

// ─────────────────────────────────────────────────────────────────────────────
// 32 · การลบ
// ─────────────────────────────────────────────────────────────────────────────
test('ลบ blob V2 เอาแถว chunk และไฟล์ ciphertext ไปด้วย โดยไม่แตะ blob อื่น', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)

  const made = []
  for (let n = 0; n < 2; n += 1) {
    const { uploadId, ciphertextSize } = await openSmallSession(c, kek, { ciphertextSize: 256 + GCM_TAG_BYTES })
    await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))
    const res = await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
    made.push(res.data.blob)
  }
  const vaultDir = path.join(STORAGE_ROOT, 'vault')
  const before = (await fs.readdir(vaultDir)).filter((f) => f !== '.staging')
  assert.equal(before.length, 2)

  const other = await loginAs(OTHER)
  assert.equal((await other.req(`/api/vault/blobs/${made[0].id}`, { method: 'DELETE' })).status, 404)
  assert.equal((await fs.readdir(vaultDir)).filter((f) => f !== '.staging').length, 2, 'คนอื่นลบไม่ได้')

  const del = await c.req(`/api/vault/blobs/${made[0].id}`, { method: 'DELETE' })
  assert.equal(del.status, 204)

  // DB ↔ ดิสก์ ต้องตรงกัน: หนึ่งแถว หนึ่งไฟล์
  const inv = await c.req('/api/vault')
  assert.equal(inv.data.blobs.length, 1)
  assert.equal(inv.data.blobs[0].id, made[1].id)
  const after = (await fs.readdir(vaultDir)).filter((f) => f !== '.staging')
  assert.equal(after.length, 1)

  // แถว chunk หายไปด้วย — ขอก้อนของ blob ที่ลบแล้วต้องเป็น 404 (ไม่มีการฟื้นคืน)
  assert.equal((await c.raw(`/api/vault/blobs/${made[0].id}/chunks/0`)).status, 404)
  assert.equal((await c.raw(`/api/vault/blobs/${made[1].id}/chunks/0`)).status, 200)
  assert.equal((await c.req(`/api/vault/blobs/${made[0].id}`, { method: 'DELETE' })).status, 404)
})

// ─────────────────────────────────────────────────────────────────────────────
// 33 · ความเป็นส่วนตัวของสิ่งที่เซิร์ฟเวอร์เก็บและบันทึก
// ─────────────────────────────────────────────────────────────────────────────
test('ไม่มีชื่อไฟล์ / passphrase / กุญแจ อยู่ในแถวข้อมูล บนดิสก์ หรือใน audit', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)

  const plain = randomBytes(2048)
  const plan = planVaultChunks(plain.length, 8 * 1024 * 1024)
  const env = await createVaultV2Envelope(kek, {
    name: SECRET_FILENAME, type: 'application/pdf', size: plain.length, chunkCount: plan.chunkCount,
  })
  const open = await c.req('/api/vault/uploads', {
    method: 'POST',
    body: {
      formatVersion: 2,
      contentIdB64: env.contentIdB64,
      ciphertextSize: plan.ciphertextSize,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      wrappedDekB64: env.wrappedDekB64,
      wrapIvB64: env.wrapIvB64,
      metaIvB64: env.metaIvB64,
      metaB64: env.metaB64,
    },
  })
  const { uploadId } = open.data.upload
  const piece = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: plain,
  })
  await putChunk(c, uploadId, 0, piece.ciphertext, piece.ivB64)
  const blob = (await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob
  await c.raw(`/api/vault/blobs/${blob.id}/chunks/0`)

  // 1) แถวที่ store เก็บจริง
  const rows = await v2store.listVaultV2Blobs(String((await c.req('/api/me')).data.user.id))
  assert.equal(rows.length, 1)
  const rowText = JSON.stringify(rows)
  for (const secret of SECRETS) {
    assert.equal(rowText.includes(secret), false, `แถวข้อมูลต้องไม่มี "${secret}"`)
  }
  for (const column of ['name', 'type', 'mimeType', 'plainSize', 'filename']) {
    assert.equal(Object.hasOwn(rows[0], column), false, `แถว blob V2 ต้องไม่มีคอลัมน์ ${column}`)
  }

  // 2) ไฟล์บนดิสก์: ชื่อไฟล์เป็น id ทึบ และเนื้อไฟล์ไม่มีความลับ
  const vaultDir = path.join(STORAGE_ROOT, 'vault')
  const files = (await fs.readdir(vaultDir)).filter((f) => f !== '.staging')
  assert.equal(files.length, 1)
  for (const secret of SECRETS) {
    assert.equal(files[0].includes(secret), false)
  }
  const onDisk = await fs.readFile(path.join(vaultDir, files[0]))
  for (const secret of SECRETS) {
    assert.equal(onDisk.includes(Buffer.from(secret, 'utf8')), false, `ciphertext ต้องไม่มี "${secret}"`)
  }
  assert.equal(onDisk.length, plan.ciphertextSize)

  // 3) audit: มีเหตุการณ์ครบ แต่ไม่มีเนื้อหา ชื่อไฟล์ กุญแจ หรือ path
  const audit = await readAudit(200)
  const actions = audit.map((a) => a.action)
  for (const expected of ['VAULT_V2_UPLOAD_START', 'VAULT_V2_COMMIT', 'VAULT_V2_READ']) {
    assert.ok(actions.includes(expected), `audit ต้องมี ${expected}`)
  }
  const auditText = JSON.stringify(audit)
  for (const secret of [...SECRETS, env.wrappedDekB64, env.metaB64, env.metaIvB64, blob.id, uploadId]) {
    assert.equal(auditText.includes(secret), false, `audit ต้องไม่มี "${String(secret).slice(0, 24)}…"`)
  }
  assert.equal(auditText.includes('.aegisenc'), false)

  // 4) log ของเซิร์ฟเวอร์
  const logs = logLines.join('\n')
  for (const secret of [...SECRETS, env.wrappedDekB64, env.metaB64]) {
    assert.equal(logs.includes(secret), false, `log ต้องไม่มี "${String(secret).slice(0, 24)}…"`)
  }
})

test('การอ่านหลายก้อนสร้าง audit เพียงแถวเดียวต่อการอ่านหนึ่งครั้ง', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)
  const { env, body } = await envelopeFor(kek, { size: 8 * 1024 * 1024 + 64, chunkCount: 2 })
  const ciphertextSize = CIPHER_CHUNK + 64 + GCM_TAG_BYTES
  const open = await c.req('/api/vault/uploads', {
    method: 'POST', body: { ...body, ciphertextSize, chunkCount: 2 },
  })
  const { uploadId } = open.data.upload
  assert.ok(env.contentIdB64)
  await putChunk(c, uploadId, 0, randomBytes(CIPHER_CHUNK))
  await putChunk(c, uploadId, 1, randomBytes(64 + GCM_TAG_BYTES))
  const blob = (await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob

  const before = (await readAudit(500)).filter((a) => a.action === 'VAULT_V2_READ').length
  for (let i = 0; i < blob.chunkCount; i += 1) await c.raw(`/api/vault/blobs/${blob.id}/chunks/${i}`)
  const after = (await readAudit(500)).filter((a) => a.action === 'VAULT_V2_READ').length
  assert.equal(after - before, 1, 'หนึ่งการอ่าน = หนึ่งแถว ไม่ใช่หนึ่งแถวต่อ chunk')
})

// ─────────────────────────────────────────────────────────────────────────────
// 34 · V1 ต้องไม่ถูกกระทบ
// ─────────────────────────────────────────────────────────────────────────────
test('V1 ยังอัปโหลด ดาวน์โหลดทั้งไฟล์ และลบได้เหมือนเดิม แม้ V2 จะอยู่ในรายการเดียวกัน', async () => {
  const c = await loginAs(OWNER)
  const kek = await setupVault(c)

  const content = new TextEncoder().encode('legacy vault content that must keep working')
  const v1env = await encryptFileEnvelope(kek, {
    name: 'legacy-notes.txt', type: 'text/plain', size: content.length, bytes: content,
  })
  const form = new FormData()
  form.append('file', new Blob([v1env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
  form.append('ivB64', v1env.ivB64)
  form.append('wrappedDekB64', v1env.wrappedDekB64)
  form.append('wrapIvB64', v1env.wrapIvB64)
  form.append('metaIvB64', v1env.metaIvB64)
  form.append('metaB64', v1env.metaB64)
  const created = await c.req('/api/vault/blobs', { method: 'POST', body: form })
  assert.equal(created.status, 201)
  const v1Id = created.data.blob.id

  // V2 อยู่ร่วมด้วย
  const { uploadId, ciphertextSize } = await openSmallSession(c, kek)
  await putChunk(c, uploadId, 0, randomBytes(ciphertextSize))
  const v2Id = (await c.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob.id

  // ดาวน์โหลด V1 ทั้งไฟล์ยังได้ไบต์เดิมเป๊ะ
  const got = await c.raw(`/api/vault/blobs/${v1Id}`)
  assert.equal(got.status, 200)
  assert.deepEqual(Buffer.from(got.bytes), Buffer.from(v1env.ciphertext))
  assert.equal(got.headers.get('cache-control'), 'no-store')

  // id ของสองรูปแบบชนกันไม่ได้ และเส้นทาง chunk ไม่รับ id ของ V1
  assert.notEqual(String(v1Id), String(v2Id))
  assert.equal((await c.raw(`/api/vault/blobs/${v1Id}/chunks/0`)).status, 404)

  // ลบ V1 ไม่กระทบ V2
  assert.equal((await c.req(`/api/vault/blobs/${v1Id}`, { method: 'DELETE' })).status, 204)
  const inv = await c.req('/api/vault')
  assert.equal(inv.data.blobs.length, 1)
  assert.equal(inv.data.blobs[0].id, v2Id)
  assert.equal((await c.raw(`/api/vault/blobs/${v2Id}/chunks/0`)).status, 200)
})

test('newContentId ของเบราว์เซอร์ผ่านการตรวจรูปแบบของเซิร์ฟเวอร์เสมอ', () => {
  for (let i = 0; i < 50; i += 1) {
    const b64 = Buffer.from(newContentId()).toString('base64')
    assert.equal(v2store.isValidContentIdB64(b64), true, b64)
  }
  assert.equal(v2store.isValidContentIdB64('AAAA'), false)
  assert.equal(v2store.isValidIvB64(randomBytes(12).toString('base64')), true)
  assert.equal(v2store.isValidIvB64(randomBytes(16).toString('base64')), false)
  assert.equal(createHash('sha256').update('').digest('hex').length, 64)
})
