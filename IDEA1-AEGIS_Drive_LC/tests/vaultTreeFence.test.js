// tests/vaultTreeFence.test.js — AEGIS Drive (IDEA1) · PR #157 Task 2.5 · legacy mutation fence by protocol state
//
// ⚠️ ด่านนี้คือหัวใจของ "ไม่มีวันกลับไปแก้ไขแบบ flat": FLAT = ทุกอย่างเหมือนเดิมเป๊ะ; MIGRATING = การแก้ไขแบบ
//    เก่าถูกกั้น (409 TREE_MIGRATION_IN_PROGRESS); TREE_V1 = กั้นถาวร (426 UPGRADE_REQUIRED) — และการปิด flag
//    ของ tree "ไม่" เปิดการแก้ไขกลับ (FENCE-4) การอ่าน/ดาวน์โหลด/ยกเลิก staging ยังทำได้ทุกสถานะ
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-tree-fence-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)
delete process.env.DATABASE_URL
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { createApp } = await import('../server/app.js')
const { vaultTreeConfigFromEnv } = await import('../server/config/vaultTreeLimits.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultStaging } = await import('../server/storage/vaultStaging.js')
const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
const tree = await import('../server/db/vaultTreeStore.js')
const store = await import('../server/db/store.js')
const v2store = await import('../server/db/vaultV2Store.js')
const { getUserByUsername } = await import('../server/db/connection.js')
const { createVaultSetup, encryptFileEnvelope } = await import('../src/lib/vaultCrypto.js')
const { createVaultV2Envelope } = await import('../src/lib/vaultChunkCrypto.js')

const CIPHER_CHUNK = VAULT_TRANSFER_LIMITS.ciphertextChunkBytes
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const ON = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true' })
const OFF = vaultTreeConfigFromEnv({})

let serverOn, serverOff, baseOn, baseOff, ownerId
before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultStaging()
  serverOn = createApp({ vaultTreeConfig: ON }).listen(0, '127.0.0.1')
  serverOff = createApp({ vaultTreeConfig: OFF }).listen(0, '127.0.0.1')
  await Promise.all([serverOn, serverOff].map((s) => new Promise((r) => s.once('listening', r))))
  baseOn = `http://127.0.0.1:${serverOn.address().port}`; baseOff = `http://127.0.0.1:${serverOff.address().port}`
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
})
after(async () => {
  await Promise.all([serverOn, serverOff].map((s) => new Promise((r) => s.close(r))))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => { await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests(); await store.__resetVaultForTests() })

const login = (base = baseOn) => loginClient(base, DEMO_USER.username, DEMO_USER.password)
async function setupVault(client) {
  const setup = await createVaultSetup('fence-passphrase-xyz-99', FAST)
  assert.equal((await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  return setup.kek
}
async function v1Upload(client, kek) {
  const env = await encryptFileEnvelope(kek, { name: 'fence.pdf', type: 'application/pdf', size: 3, bytes: new Uint8Array([1, 2, 3]) })
  const form = new FormData()
  form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
  for (const k of ['ivB64', 'wrappedDekB64', 'wrapIvB64', 'metaIvB64', 'metaB64']) form.append(k, env[k])
  return client.req('/api/vault/blobs', { method: 'POST', body: form })
}
async function openSession(client, kek) {
  const ciphertextSize = 1024 + GCM_TAG_BYTES
  const env = await createVaultV2Envelope(kek, { name: 'fence-v2.bin', type: 'application/octet-stream', size: 1024, chunkCount: 1 })
  return client.req('/api/vault/uploads', { method: 'POST', body: { formatVersion: 2, contentIdB64: env.contentIdB64, chunkSize: CIPHER_CHUNK, wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64, ciphertextSize, chunkCount: 1 } })
}
const putChunk = (client, uploadId) => client.req(`/api/vault/uploads/${uploadId}/chunks/0`, { method: 'PUT', body: randomBytes(1024 + GCM_TAG_BYTES), headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') } })
const commit = (client, uploadId) => client.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })

/** ตั้งสถานะโปรโตคอลของเจ้าของโดยตรง (ผ่าน store) — lease/genesis จริงมาใน Task 3.1 */
async function setState(state) {
  await tree.getTreeState(ownerId)
  await tree.__setProtocolStateForTests(ownerId, state)
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, state)
}

const inventorySize = async () => (await store.listVaultBlobs(ownerId)).length + (await v2store.listVaultV2Blobs(ownerId)).length

test('FENCE-1 FLAT owner: every legacy mutation behaves exactly as before (no tree row is ever created for it)', async () => {
  const c = await login(); const kek = await setupVault(c)
  const up = await v1Upload(c, kek); assert.equal(up.status, 201)
  const s = await openSession(c, kek); assert.equal(s.status, 201)
  assert.equal((await putChunk(c, s.data.upload.uploadId)).status, 200)
  assert.equal((await commit(c, s.data.upload.uploadId)).status, 201)
  assert.equal((await c.req(`/api/vault/blobs/${up.data.blob.id}`, { method: 'DELETE' })).status, 204)
  assert.equal(await tree.peekTreeState(ownerId), null, 'legacy routes never create the state row')
})

for (const [state, status, code] of [['MIGRATING_TREE_V1', 409, 'TREE_MIGRATION_IN_PROGRESS'], ['TREE_V1', 426, 'UPGRADE_REQUIRED']]) {
  test(`FENCE-${state === 'TREE_V1' ? 3 : 2} ${state}: legacy mutations → ${status} ${code}; safe reads/downloads/cancel unchanged`, async () => {
    const c = await login(); const kek = await setupVault(c)
    const up = await v1Upload(c, kek); assert.equal(up.status, 201)
    const s = await openSession(c, kek); assert.equal(s.status, 201)
    const uploadId = s.data.upload.uploadId
    await setState(state)
    const before = await inventorySize()
    const denied = [
      await v1Upload(c, kek),
      await c.req(`/api/vault/blobs/${up.data.blob.id}`, { method: 'DELETE' }),
      await openSession(c, kek),
      await putChunk(c, uploadId),
      await commit(c, uploadId),
    ]
    for (const r of denied) { assert.equal(r.status, status, JSON.stringify(r.data)); assert.equal(r.data.code, code) }
    assert.equal(await inventorySize(), before, 'FENCE-6 no inventory row created or deleted by a fenced request')
    // safe reads stay open
    assert.equal((await c.req('/api/vault')).status, 200)
    const dl = await fetch(`${baseOn}/api/vault/blobs/${up.data.blob.id}`, { headers: { cookie: c.cookie } }); assert.equal(dl.status, 200)
    assert.equal((await c.req('/api/vault/uploads/limits')).status, 200)
    assert.equal((await c.req(`/api/vault/uploads/${uploadId}`)).status, 200)
    assert.equal((await c.req(`/api/vault/uploads/${uploadId}`, { method: 'DELETE' })).status, 200, 'cancelling a never-committed staging session mutates no inventory (existing 200 contract)')
  })
}

test('FENCE-4 flags off never reopens flat mutation for a non-FLAT owner; FLAT/absent rows stay unfenced', async () => {
  const c = await login(baseOff); const kek = await setupVault(c)
  assert.equal((await v1Upload(c, kek)).status, 201, 'absent row + flags off = FLAT behaviour')
  await setState('TREE_V1')
  const r = await v1Upload(c, kek)
  assert.equal(r.status, 426); assert.equal(r.data.code, 'UPGRADE_REQUIRED')
  const s = await openSession(c, kek); assert.equal(s.status, 426)
  assert.equal((await c.req('/api/vault/tree/state')).status, 503, 'tree protocol itself is off — and that still does not reopen flat mutation')
  await setState('MIGRATING_TREE_V1')
  assert.equal((await v1Upload(c, kek)).status, 409)
})

test('FENCE-5 an in-flight legacy upload session created in FLAT cannot commit after the fence; it stays cancellable', async () => {
  const c = await login(); const kek = await setupVault(c)
  const s = await openSession(c, kek); const uploadId = s.data.upload.uploadId
  assert.equal((await putChunk(c, uploadId)).status, 200)
  await setState('MIGRATING_TREE_V1')
  const r = await commit(c, uploadId)
  assert.equal(r.status, 409); assert.equal(r.data.code, 'TREE_MIGRATION_IN_PROGRESS')
  assert.equal((await v2store.listVaultV2Blobs(ownerId)).length, 0)
  assert.equal((await c.req(`/api/vault/uploads/${uploadId}`, { method: 'DELETE' })).status, 200)
})
