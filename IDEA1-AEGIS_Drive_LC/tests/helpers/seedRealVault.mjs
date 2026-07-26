// tests/helpers/seedRealVault.mjs — เขียนไฟล์จริงเข้า Private Vault บน Postgres
// แล้ว "ทิ้งข้อมูลไว้" เพื่อให้ขั้นตอนตรวจสอบภายนอก (pg_dump / docker logs / grep)
// มีของจริงให้ค้นหา
//
// ⚠️ ถ้าฐานข้อมูลว่าง การ grep แล้วไม่พบความลับ "ไม่ได้พิสูจน์อะไรเลย" — สคริปต์นี้
//    จึงมีไว้เพื่อทำให้การ grep มีความหมาย: ความลับถูกอัปโหลดเข้าระบบจริง ๆ แล้ว
//    ถ้ายังหาไม่เจอในดิสก์/ตาราง/log แปลว่าระบบเก็บมันแบบอ่านไม่ออกจริง
//
// ใช้: SEED_STORAGE_ROOT=... TEST_DATABASE_URL=... node tests/helpers/seedRealVault.mjs
import assert from 'node:assert/strict'

const STORAGE_ROOT = process.env.SEED_STORAGE_ROOT
assert.ok(STORAGE_ROOT, 'ต้องตั้ง SEED_STORAGE_ROOT')
assert.ok(process.env.TEST_DATABASE_URL, 'ต้องตั้ง TEST_DATABASE_URL')

process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL

const { createApp } = await import('../../server/app.js')
const { initStorage } = await import('../../server/storage/fileStore.js')
const { initVaultStorage } = await import('../../server/storage/vaultStore.js')
const { closePool } = await import('../../server/db/connection.js')
const { createVaultSetup, encryptFileEnvelope } = await import('../../src/lib/vaultCrypto.js')

// ความลับชุดเดียวกับที่ชุดทดสอบใช้ — สคริปต์ grep ภายนอกจะค้นหาคำเหล่านี้
export const SEED_SECRETS = {
  passphrase: 'orchid-tungsten-ledger-41-vault',
  filename: 'merger-terms_SIGNED_2026.pdf',
  content: 'CONFIDENTIAL MERGER TERMS. Meridian Ltd acquired for 4,200,000 THB. Authorised: Veerachat Jinapariwataporn.',
}

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }

await initStorage()
await initVaultStorage()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

let cookie = null
const jar = (res) => {
  const sc = res.headers.getSetCookie?.() ?? []
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ')
}

// login
let res = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'user', password: 'aegis-drive-user' }),
})
jar(res)
const { csrfToken } = await res.json()

// setup vault
const setup = await createVaultSetup(SEED_SECRETS.passphrase, FAST)
res = await fetch(`${base}/api/vault/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie, 'X-CSRF-Token': csrfToken },
  body: JSON.stringify({ saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier }),
})
assert.equal(res.status, 201, `setup ล้มเหลว: ${res.status}`)

// upload ไฟล์ที่มีความลับ
const bytes = new TextEncoder().encode(SEED_SECRETS.content)
const env = await encryptFileEnvelope(setup.kek, {
  name: SEED_SECRETS.filename, type: 'application/pdf', size: bytes.length, bytes,
})
const form = new FormData()
form.append('file', new Blob([env.ciphertext]), 'blob.aegisenc')
form.append('ivB64', env.ivB64)
form.append('wrappedDekB64', env.wrappedDekB64)
form.append('wrapIvB64', env.wrapIvB64)
form.append('metaIvB64', env.metaIvB64)
form.append('metaB64', env.metaB64)
res = await fetch(`${base}/api/vault/blobs`, {
  method: 'POST', headers: { cookie, 'X-CSRF-Token': csrfToken }, body: form,
})
assert.equal(res.status, 201, `upload ล้มเหลว: ${res.status}`)
const { blob } = await res.json()

// ดาวน์โหลดกลับหนึ่งรอบ เพื่อให้มี VAULT_BLOB_READ ใน audit ด้วย
res = await fetch(`${base}/api/vault/blobs/${blob.id}`, { headers: { cookie } })
assert.equal(res.status, 200)

console.log(JSON.stringify({
  seeded: true, blobId: blob.id, ciphertextBytes: blob.size, storageRoot: STORAGE_ROOT,
}))

await new Promise((r) => server.close(r))
await closePool()
