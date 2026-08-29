// tests/vaultApi.test.js — AEGIS Drive (IDEA1) · Private Vault, ครบวงจรผ่าน HTTP จริง
//
// ยิงผ่าน Express app "ตัวเดียวกับที่รันใน production" (server/app.js) — middleware ทุกชั้น
// (securityHeaders / session / CSRF / requireAuth) ทำงานจริง ไม่มีการ mock
// การเข้ารหัสใช้ src/lib/vaultCrypto.js ตัวเดียวกับที่เบราว์เซอร์รัน
//
// สิ่งที่ชุดนี้พิสูจน์:
//   1. setup → unlock (ถูก/ผิด) → upload → download ได้ไบต์เดิมเป๊ะ
//   2. ไม่มี plaintext / ชื่อไฟล์ / passphrase / กุญแจ ปรากฏใน "ฐานข้อมูล" (แถวที่ store เก็บ)
//   3. ไม่มีสิ่งเหล่านั้นปรากฏใน server log (stdout/stderr ถูกดักไว้ตลอดการทดสอบ)
//   4. ไม่มีสิ่งเหล่านั้นปรากฏในไฟล์ .aegisenc บนดิสก์
//   5. audit บันทึกเฉพาะ actor/เวลา/ชนิดการกระทำ — ไม่มีเนื้อหาหรือกุญแจ
//   6. vault ของผู้ใช้คนหนึ่ง อีกคนเข้าไม่ถึง
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performLogin } from './helpers/testClient.mjs'

// STORAGE_ROOT ต้องถูกตั้ง "ก่อน" import โมดูลที่อ่านค่านี้ตอน module-load
const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

// ── โหมดของฐานข้อมูล ────────────────────────────────────────────────────
// ตั้ง TEST_DATABASE_URL → รันกับ Postgres จริง (production code path)
// ไม่ตั้ง → dev fallback ในหน่วยความจำ (รันได้โดยไม่ต้องมี Docker)
// ⚠️ เทสต์ชุดเดียวกันเป๊ะต้องผ่านทั้งสองโหมด — ถ้าผ่านแค่โหมดเดียวแปลว่าโค้ด
//    สองเส้นทางไม่เท่ากันจริง ซึ่งเป็นบั๊กในตัวมันเอง
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const store = await import('../server/db/store.js')
const v2store = await import('../server/db/vaultV2Store.js')
const { readAudit, usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(
  usingPostgres, DB_MODE === 'postgres',
  `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`,
)
console.log(`[vault tests] database mode: ${DB_MODE}`)
const {
  createVaultSetup, unlockVault, encryptFileEnvelope,
  decryptBlobMeta, decryptFileContent,
} = await import('../src/lib/vaultCrypto.js')

// พารามิเตอร์ที่เบาที่สุด "เท่าที่เซิร์ฟเวอร์ยอมรับ" (พื้นขั้นต่ำ OWASP) — ชุดทดสอบ
// จึงเดินผ่านด่าน validate จริง ไม่ใช่เลี่ยงมัน
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }

// ── ความลับที่ใช้ตลอดชุดทดสอบ — ทุกคำต้อง "ไม่โผล่" ที่ไหนฝั่งเซิร์ฟเวอร์เลย ───
const PASSPHRASE = 'zebra-glacier-nominal-77-vault'
const WRONG_PASSPHRASE = 'zebra-glacier-nominal-78-vault'
const SECRET_FILENAME = 'board-resolution-CONFIDENTIAL.pdf'
const SECRET_CONTENT = 'RESOLVED: the acquisition of Meridian Ltd proceeds at 4.2M THB. Signed, Veerachat J.'
const SECRETS = [
  PASSPHRASE, WRONG_PASSPHRASE, SECRET_FILENAME, SECRET_CONTENT,
  'board-resolution', 'CONFIDENTIAL', 'Meridian', 'acquisition', 'RESOLVED',
]

let server, baseUrl
// ดัก stdout/stderr ตลอดการทดสอบ — ถ้ามีใครเผลอ console.log(req.body) จะโดนจับที่นี่
const logLines = []

before(async () => {
  await initStorage()
  await initVaultStorage()

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
  if (usingPostgres) await closePool() // ไม่งั้น process ค้างเพราะ pool ยังเปิดอยู่
})

// ล้างทั้งแถวข้อมูลและ ciphertext บนดิสก์ — ไม่งั้นเคสที่นับไฟล์ในโฟลเดอร์จะเห็นของเคสก่อน
beforeEach(async () => {
  await store.__resetVaultForTests()
  // ⚠️ GET /api/vault คืน "ห้องนิรภัยทั้งห้อง" คือทั้ง V1 และ V2 ในรายการเดียว (LFT-V2-B)
  //    การล้างเฉพาะตาราง V1 จึงไม่พออีกต่อไป: ในโหมด Postgres ทุกไฟล์เทสต์ใช้ฐานข้อมูล
  //    เดียวกัน แถว V2 ที่ค้างจากไฟล์อื่นจะโผล่มาในบัญชีรายการของชุดนี้แล้วนับเกิน
  await v2store.__resetVaultV2ForTests()
  const dir = path.join(STORAGE_ROOT, 'vault')
  for (const f of await fs.readdir(dir)) await fs.rm(path.join(dir, f), { force: true })
})

// ── client จำลอง: ถือ cookie + CSRF token เหมือนเบราว์เซอร์จริง ───────────
class Client {
  constructor() { this.cookie = null; this.csrf = null }

  async req(pathname, { method = 'GET', body, raw = false } = {}) {
    const headers = {}
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let payload
    if (body instanceof FormData) payload = body
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    if (raw) return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
    let data = null
    try { data = await res.json() } catch { /* 204 ไม่มี body */ }
    return { status: res.status, data }
  }

  // ผ่านด่าน force-reset ของบัญชี seed ให้เอง (seed.sql ตั้ง must_reset_password = TRUE)
  // — ดูเหตุผลและผลข้างเคียงใน tests/helpers/testClient.mjs
  async login(username, password) {
    return performLogin(this, username, password)
  }
}

const loginAs = async (u, p) => { const c = new Client(); await c.login(u, p); return c }

/** จำลอง "เบราว์เซอร์อัปโหลดไฟล์เข้า vault" — เข้ารหัสก่อน แล้วค่อยส่ง */
async function uploadEncrypted(client, kek, { name, content }) {
  const bytes = new TextEncoder().encode(content)
  const env = await encryptFileEnvelope(kek, { name, type: 'application/pdf', size: bytes.length, bytes })

  const form = new FormData()
  form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
  form.append('ivB64', env.ivB64)
  form.append('wrappedDekB64', env.wrappedDekB64)
  form.append('wrapIvB64', env.wrapIvB64)
  form.append('metaIvB64', env.metaIvB64)
  form.append('metaB64', env.metaB64)

  const res = await client.req('/api/vault/blobs', { method: 'POST', body: form })
  return { res, env, plainBytes: bytes }
}

// ── การตั้งค่า vault ────────────────────────────────────────────────────

test('vault ที่ยังไม่ตั้งค่า → configured:false (ไม่ใช่ error)', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const res = await c.req('/api/vault')
  assert.equal(res.status, 200)
  assert.equal(res.data.configured, false)
  assert.deepEqual(res.data.blobs, [])
  assert.equal(res.data.saltB64, undefined, 'ยังไม่ตั้งค่าต้องไม่มี salt ให้')
})

test('setup: เก็บ salt/params/verifier แล้วตั้งซ้ำไม่ได้ (409)', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)

  const first = await c.req('/api/vault/setup', {
    method: 'POST',
    body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })
  assert.equal(first.status, 201)

  const again = await c.req('/api/vault/setup', {
    method: 'POST',
    body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })
  assert.equal(again.status, 409, 'ตั้งค่าซ้ำต้องถูกปฏิเสธ — ไม่งั้น ciphertext เดิมกำพร้าถาวร')
})

test('setup: พารามิเตอร์ KDF ที่อ่อนเกินไปถูก "ปฏิเสธ" ไม่ใช่ถูกแก้เงียบ ๆ', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)

  // client ที่ถูกแก้ส่ง m=1KiB, t=1 มา — ต้องได้ 400
  // ⚠️ ถ้าเซิร์ฟเวอร์ "ยกค่าขึ้นให้" แทนที่จะปฏิเสธ verifier ที่ถูกสร้างด้วยค่าเดิม
  //    จะถอดไม่ได้อีกเลย = vault พังตั้งแต่วินาทีแรกโดยไม่มีใครรู้ตัว
  for (const bad of [
    { memorySizeKiB: 1, iterations: 1, parallelism: 1 },
    { memorySizeKiB: 19_456, iterations: 1, parallelism: 1 },
    { memorySizeKiB: 19_455, iterations: 2, parallelism: 1 },
    { memorySizeKiB: 19_456, iterations: 2, parallelism: 99 },
    { memorySizeKiB: 19_456, iterations: 2, parallelism: 1, kdf: 'pbkdf2' },
  ]) {
    const res = await c.req('/api/vault/setup', {
      method: 'POST', body: { saltB64: setup.saltB64, params: bad, verifier: setup.verifier },
    })
    assert.equal(res.status, 400, `ควรปฏิเสธ ${JSON.stringify(bad)}`)
  }

  // พารามิเตอร์ที่ถูกต้องต้องถูกเก็บ "ตรงตามที่ส่งมา" ทุกค่า
  const ok = await c.req('/api/vault/setup', {
    method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })
  assert.equal(ok.status, 201)
  assert.equal(ok.data.params.memorySizeKiB, setup.params.memorySizeKiB)
  assert.equal(ok.data.params.iterations, setup.params.iterations)
  assert.equal(ok.data.params.parallelism, setup.params.parallelism)
})

test('setup: input ผิดรูป → 400 (ไม่ใช่ 500)', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const bad = [
    { saltB64: 'not base64!!', params: FAST, verifier: { ivB64: 'AAAA', dataB64: 'AAAA' } },
    { saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==', params: FAST },
    {},
  ]
  for (const body of bad) {
    const res = await c.req('/api/vault/setup', { method: 'POST', body })
    assert.equal(res.status, 400, `ควรเป็น 400 สำหรับ ${JSON.stringify(body)}`)
  }
})

// ── unlock: ถูก / ผิด ───────────────────────────────────────────────────

test('passphrase ผิด → ปลดล็อกไม่ได้ และ audit บันทึกเป็น DENIED', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })

  const meta = await c.req('/api/vault')
  assert.equal(meta.data.configured, true)

  // ปลดล็อกเกิดฝั่ง client ล้วน — server ไม่มีส่วนร่วมในการตัดสิน
  await assert.rejects(
    () => unlockVault(WRONG_PASSPHRASE, {
      saltB64: meta.data.saltB64, params: meta.data.params, verifier: meta.data.verifier,
    }),
    /wrong-key/,
  )

  const rep = await c.req('/api/vault/unlock-attempt', { method: 'POST', body: { ok: false } })
  assert.equal(rep.status, 204)

  const audit = await readAudit(20)
  const entry = audit.find((e) => e.action === 'VAULT_UNLOCK')
  assert.ok(entry, 'ต้องมี audit entry ของการพยายามปลดล็อก')
  assert.equal(entry.result, 'DENIED')
})

test('passphrase ถูก → ปลดล็อกได้ และ audit บันทึกเป็น OK', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })

  const meta = await c.req('/api/vault')
  const kek = await unlockVault(PASSPHRASE, {
    saltB64: meta.data.saltB64, params: meta.data.params, verifier: meta.data.verifier,
  })
  assert.ok(kek)

  await c.req('/api/vault/unlock-attempt', { method: 'POST', body: { ok: true } })
  const audit = await readAudit(20)
  assert.equal(audit.find((e) => e.action === 'VAULT_UNLOCK').result, 'OK')
})

test('endpoint unlock-attempt รับแค่ boolean — ยัด passphrase มาก็ไม่ถูกเก็บ', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  // จำลอง client ที่ถูกแก้ให้พยายามส่ง passphrase ขึ้นมา
  await c.req('/api/vault/unlock-attempt', {
    method: 'POST',
    body: { ok: true, passphrase: PASSPHRASE, kek: 'AAAA', debug: SECRET_CONTENT },
  })
  const audit = await readAudit(20)
  const dump = JSON.stringify(audit)
  for (const s of SECRETS) {
    assert.equal(dump.includes(s), false, `audit ดูดซับ "${s}" ที่ client ยัดมา`)
  }
})

// ── upload → download ครบรอบ ────────────────────────────────────────────

test('upload → download: ได้ไบต์เดิมเป๊ะ และชื่อไฟล์ถอดกลับมาถูก', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })

  const meta0 = await c.req('/api/vault')
  const kek = await unlockVault(PASSPHRASE, {
    saltB64: meta0.data.saltB64, params: meta0.data.params, verifier: meta0.data.verifier,
  })

  const { res: up, plainBytes } = await uploadEncrypted(c, kek, {
    name: SECRET_FILENAME, content: SECRET_CONTENT,
  })
  assert.equal(up.status, 201)
  const blobId = up.data.blob.id

  // ขนาดที่ server บันทึก = ขนาด ciphertext (plaintext + 16 ไบต์ GCM tag)
  assert.equal(up.data.blob.size, plainBytes.length + 16)

  // ── จำลองการ "เปิดเซสชันใหม่แล้วปลดล็อกอีกครั้ง" — ไม่ใช้ตัวแปรเดิมช่วย
  const meta = await c.req('/api/vault')
  assert.equal(meta.data.blobs.length, 1)
  const blob = meta.data.blobs[0]

  const kek2 = await unlockVault(PASSPHRASE, {
    saltB64: meta.data.saltB64, params: meta.data.params, verifier: meta.data.verifier,
  })

  // ชื่อไฟล์อ่านได้เฉพาะหลังถอด metadata ด้วย DEK ที่แกะจาก KEK
  const fileMeta = await decryptBlobMeta(kek2, blob)
  assert.equal(fileMeta.name, SECRET_FILENAME)
  assert.equal(fileMeta.size, plainBytes.length)

  // ดาวน์โหลด ciphertext ดิบแล้วถอดในฝั่ง "เบราว์เซอร์"
  const dl = await c.req(`/api/vault/blobs/${blobId}`, { raw: true })
  assert.equal(dl.status, 200)
  const decrypted = await decryptFileContent(kek2, blob, dl.bytes)
  assert.deepEqual(decrypted, plainBytes, 'round trip ต้องได้ไบต์เดิมทุกไบต์')
  assert.equal(new TextDecoder().decode(decrypted), SECRET_CONTENT)
})

test('upload: envelope ไม่ครบ → 400 และไม่มี ciphertext กำพร้าบนดิสก์', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'blob.aegisenc')
  form.append('ivB64', 'AAAAAAAAAAAAAAAA') // ขาดอีก 4 field
  const res = await c.req('/api/vault/blobs', { method: 'POST', body: form })
  assert.equal(res.status, 400)

  const files = await fs.readdir(path.join(STORAGE_ROOT, 'vault'))
  assert.equal(files.length, 0, 'request ที่ถูกปฏิเสธต้องไม่ทิ้ง ciphertext ไว้บนดิสก์')
})

test('upload ก่อนตั้งค่า vault → 409', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  const { res } = await uploadEncrypted(c, setup.kek, { name: 'x.pdf', content: 'x' })
  assert.equal(res.status, 409)
})

// ── การแยกขาดระหว่างผู้ใช้ ────────────────────────────────────────────

test('vault ของผู้ใช้คนหนึ่ง อีกคนมองไม่เห็นและดาวน์โหลดไม่ได้', async () => {
  const alice = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await alice.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  const { res: up } = await uploadEncrypted(alice, setup.kek, { name: SECRET_FILENAME, content: SECRET_CONTENT })
  assert.equal(up.status, 201)

  // admin เป็นคนละ identity — แม้เป็น Admin ก็ไม่มีสิทธิ์เหนือ vault ของคนอื่น
  const admin = await loginAs('admin', 'aegis-drive-admin')
  const adminView = await admin.req('/api/vault')
  assert.equal(adminView.data.configured, false, 'Admin ต้องไม่เห็น vault ของ user')
  assert.deepEqual(adminView.data.blobs, [])

  const steal = await admin.req(`/api/vault/blobs/${up.data.blob.id}`, { raw: true })
  assert.equal(steal.status, 404, 'Admin ดาวน์โหลด blob ของคนอื่นไม่ได้')
})

test('ไม่ล็อกอิน → ทุก endpoint ของ vault ตอบ 401/403', async () => {
  const anon = new Client()
  assert.equal((await anon.req('/api/vault')).status, 401)
  assert.equal((await anon.req('/api/vault/blobs/1', { raw: true })).status, 401)
  // POST โดยไม่มี CSRF token → ถูกตัดที่ชั้น CSRF ก่อนถึง requireAuth
  assert.equal((await anon.req('/api/vault/setup', { method: 'POST', body: {} })).status, 403)
})

// ══ ข้อพิสูจน์หลัก: ไม่มี plaintext หรือกุญแจ อยู่ฝั่งเซิร์ฟเวอร์ ══════════

test('ฐานข้อมูล: แถวของ vault ไม่มี plaintext / ชื่อไฟล์ / passphrase / กุญแจ', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  await uploadEncrypted(c, setup.kek, { name: SECRET_FILENAME, content: SECRET_CONTENT })

  // อ่าน "ทุกอย่างที่ชั้นข้อมูลเก็บไว้จริง" ออกมาเป็นข้อความเดียวแล้วค้นหาความลับ
  const meta = await store.getVaultMeta(1) // dev fallback: user 'user' คือ id 2, admin คือ 1
  const meta2 = await store.getVaultMeta(2)
  const blobs = [...(await store.listVaultBlobs(1)), ...(await store.listVaultBlobs(2))]
  const dump = JSON.stringify({ meta, meta2, blobs })

  for (const s of SECRETS) {
    assert.equal(dump.includes(s), false, `พบ "${s}" ในแถวข้อมูลฝั่งเซิร์ฟเวอร์`)
  }

  // เชิงโครงสร้าง: ไม่มี key ชื่อที่สื่อถึง plaintext/กุญแจดิบเลย
  const keys = new Set(blobs.flatMap((b) => Object.keys(b)))
  for (const forbidden of ['name', 'filename', 'mime', 'type', 'passphrase', 'kek', 'dek', 'key', 'plaintext', 'content']) {
    assert.equal(keys.has(forbidden), false, `แถว blob มีคอลัมน์ต้องห้าม "${forbidden}"`)
  }
  // สิ่งที่ต้องมี — envelope ครบชุด
  for (const required of ['storageKey', 'ivB64', 'wrappedDekB64', 'wrapIvB64', 'metaIvB64', 'metaB64', 'size']) {
    assert.ok(keys.has(required), `แถว blob ขาด "${required}"`)
  }
})

test('ดิสก์: ไฟล์ .aegisenc ไม่มีร่องรอยของ plaintext', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  const { plainBytes } = await uploadEncrypted(c, setup.kek, { name: SECRET_FILENAME, content: SECRET_CONTENT })

  const dir = path.join(STORAGE_ROOT, 'vault')
  const files = await fs.readdir(dir)
  assert.equal(files.length, 1)
  assert.ok(files[0].endsWith('.aegisenc'), 'ต้องถูกเก็บเป็น .aegisenc')
  // ชื่อไฟล์บนดิสก์ต้องทึบ ไม่มีเศษของชื่อจริง
  assert.equal(files[0].includes('board'), false)
  assert.equal(files[0].includes('.pdf'), false)

  const raw = await fs.readFile(path.join(dir, files[0]))
  const asText = raw.toString('latin1')
  for (const s of SECRETS) {
    assert.equal(asText.includes(s), false, `พบ "${s}" ในไฟล์ ciphertext บนดิสก์`)
  }
  assert.equal(raw.length, plainBytes.length + 16, 'ต้องเป็น ciphertext + GCM tag ล้วน ไม่มี header เปล่า')
})

test('audit log: มีเฉพาะ actor/เวลา/ชนิดการกระทำ — ไม่มีเนื้อหาหรือกุญแจ', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  const { res: up } = await uploadEncrypted(c, setup.kek, { name: SECRET_FILENAME, content: SECRET_CONTENT })
  await c.req(`/api/vault/blobs/${up.data.blob.id}`, { raw: true })
  await c.req('/api/vault/unlock-attempt', { method: 'POST', body: { ok: true } })

  const audit = await readAudit(50)
  const actions = audit.map((e) => e.action)
  for (const expected of ['VAULT_SETUP', 'VAULT_BLOB_ADD', 'VAULT_BLOB_READ', 'VAULT_UNLOCK']) {
    assert.ok(actions.includes(expected), `audit ขาด ${expected}`)
  }

  const dump = JSON.stringify(audit)
  for (const s of SECRETS) {
    assert.equal(dump.includes(s), false, `พบ "${s}" ใน audit log`)
  }
  // target ถูก hash เสมอ (64 hex) — ไม่ใช่ค่าดิบ
  for (const e of audit.filter((x) => x.action.startsWith('VAULT_'))) {
    if (e.targetHash ?? e.target_hash) {
      assert.match(String(e.targetHash ?? e.target_hash), /^[0-9a-f]{64}$/)
    }
  }
})

test('server log: ไม่มี plaintext / passphrase / กุญแจ ตลอดทุกการทดสอบ', async () => {
  // เคสนี้ตรวจ log ที่สะสมมาจากทุกเคสก่อนหน้า (node:test รันไฟล์เดียวตามลำดับ)
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  const { res: up } = await uploadEncrypted(c, setup.kek, { name: SECRET_FILENAME, content: SECRET_CONTENT })
  await c.req(`/api/vault/blobs/${up.data.blob.id}`, { raw: true })

  const allLogs = logLines.join('\n')
  for (const s of SECRETS) {
    assert.equal(allLogs.includes(s), false, `พบ "${s}" ใน server log`)
  }
  // wrapped DEK ก็ไม่ควรถูก log แม้จะแกะไม่ได้ (ลดพื้นผิวโจมตีแบบ log exfiltration)
  assert.equal(allLogs.includes(setup.verifier.dataB64), false, 'verifier ciphertext ถูก log')
})

test('response ของ /api/vault ไม่หลุด storageKey (รายละเอียดภายในของ Storage Layer)', async () => {
  const c = await loginAs('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  await uploadEncrypted(c, setup.kek, { name: SECRET_FILENAME, content: SECRET_CONTENT })

  const meta = await c.req('/api/vault')
  const dump = JSON.stringify(meta.data)
  assert.equal(dump.includes('.aegisenc'), false)
  assert.equal(dump.includes('storageKey'), false)
  for (const s of SECRETS) assert.equal(dump.includes(s), false)
})
