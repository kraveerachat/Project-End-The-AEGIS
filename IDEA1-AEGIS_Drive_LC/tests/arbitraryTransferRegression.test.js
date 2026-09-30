// tests/arbitraryTransferRegression.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · T-UP-1 / T-DL-2
//
// Characterisation pins for spec §3: upload accepts ANY binary regardless of extension, MIME, or
// preview support, and download returns the exact original bytes (Normal Files: octet-stream +
// attachment + nosniff for every type; Vault: exact ciphertext back, client decrypt = exact plaintext).
// These behaviours already hold; the tests make any future extension/MIME gate a visible regression.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-arbitrary-transfer-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultStaging } = await import('../server/storage/vaultStaging.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')
const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
const { createVaultV2Envelope, encryptVaultChunk, decryptVaultChunk } = await import('../src/lib/vaultChunkCrypto.js')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const CHUNK = TRANSFER_LIMITS.chunkSizeBytes
let seq = 0
const prefix = `arbxfer-${Date.now()}`
const uniq = (name) => `${prefix}-${seq++}-${name}`

/** The corpus: unknown extension, no extension, misleading extension, empty, and active-content names. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), randomBytes(2048)])
const CORPUS = [
  { label: 'unknown extension', name: 'blob.xyz', bytes: randomBytes(256 * 1024) },
  { label: 'no extension', name: 'README', bytes: randomBytes(4096) },
  { label: 'misleading extension (PDF bytes named .jpg)', name: 'photo.jpg', bytes: PDF },
  { label: 'empty file', name: 'empty.dat', bytes: Buffer.alloc(0) },
  { label: 'active-content name', name: 'page.html', bytes: Buffer.from('<script>alert(1)</script>') },
]

let server, base
before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultStaging()
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((r) => server.close(r))
  if (usingPostgres) { await query(`DELETE FROM files WHERE name LIKE '${prefix}-%'`); await closePool() }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

async function uploadV1(client, name, bytes) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/x-definitely-unknown' }), name)
  return client.req('/api/files/upload', { method: 'POST', body: form })
}

async function uploadV2(client, name, content) {
  const open = await client.req('/api/files/uploads', { method: 'POST', body: { name, size: content.length, sha256: sha256(content) } })
  assert.equal(open.status, 201, `V2 open refused for ${name}: ${JSON.stringify(open.data)}`)
  const upload = open.data.upload
  for (let i = 0; i < upload.chunkCount; i += 1) {
    const part = content.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, content.length))
    const put = await client.raw(`/api/files/uploads/${upload.uploadId}/chunks/${i}`, { method: 'PUT', body: part, headers: { 'Content-Type': 'application/octet-stream' } })
    assert.equal(put.status, 200, put.buffer.toString())
  }
  return client.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
}

async function assertDownloadExact(client, fileId, expected, label) {
  const res = await client.raw(`/api/files/${encodeURIComponent(fileId)}/download`)
  assert.equal(res.status, 200, `${label}: download status`)
  assert.equal(sha256(res.buffer), sha256(expected), `${label}: byte-exact download`)
  assert.equal(res.headers.get('content-type'), 'application/octet-stream', `${label}: octet-stream for every type`)
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/, `${label}: attachment`)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: nosniff`)
}

test('AT-1 Normal Files V1 upload accepts every corpus item and downloads the exact bytes', async () => {
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  for (const item of CORPUS) {
    const res = await uploadV1(user, uniq(item.name), item.bytes)
    assert.equal(res.status, 201, `${item.label}: V1 upload must not be refused (${JSON.stringify(res.data)})`)
    await assertDownloadExact(user, res.data.file.id, item.bytes, `V1 ${item.label}`)
  }
})

test('AT-2 Normal Files V2 resumable upload accepts every non-empty corpus item and downloads the exact bytes', async () => {
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  for (const item of CORPUS.filter((c) => c.bytes.length > 0)) {
    const commit = await uploadV2(user, uniq(item.name), item.bytes)
    assert.equal(commit.status, 201, `${item.label}: V2 commit (${JSON.stringify(commit.data)})`)
    assert.equal(commit.data.sha256, sha256(item.bytes))
    await assertDownloadExact(user, commit.data.file.id, item.bytes, `V2 ${item.label}`)
  }
})

test('AT-3 Vault V2 stores any client ciphertext and returns it exactly; client decrypt yields the exact plaintext', async () => {
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
  const setup = await createVaultSetup('zebra-glacier-nominal-77-vault', FAST)
  const setupRes = await user.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  assert.equal(setupRes.status, 201, `vault setup: ${JSON.stringify(setupRes.data)}`)
  for (const item of CORPUS) {
    const env = await createVaultV2Envelope(setup.kek, { name: item.name, type: '', size: item.bytes.length, chunkCount: 1 })
    const enc = await encryptVaultChunk(env.dek, { contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: new Uint8Array(item.bytes) })
    const ciphertext = Buffer.from(enc.ciphertext)
    assert.equal(ciphertext.length, item.bytes.length + GCM_TAG_BYTES)
    const open = await user.req('/api/vault/uploads', { method: 'POST', body: {
      formatVersion: 2, contentIdB64: env.contentIdB64, chunkSize: VAULT_TRANSFER_LIMITS.ciphertextChunkBytes,
      wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64,
      ciphertextSize: ciphertext.length, chunkCount: 1,
    } })
    assert.equal(open.status, 201, `${item.label}: vault open (${JSON.stringify(open.data)})`)
    const put = await user.raw(`/api/vault/uploads/${open.data.upload.uploadId}/chunks/0`, {
      method: 'PUT', body: ciphertext, headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': enc.ivB64 },
    })
    assert.equal(put.status, 200, `${item.label}: ${put.buffer.toString()}`)
    const commit = await user.req(`/api/vault/uploads/${open.data.upload.uploadId}/commit`, { method: 'POST', body: {} })
    assert.equal(commit.status, 201, `${item.label}: vault commit (${JSON.stringify(commit.data)})`)
    const blobId = commit.data.blob?.id ?? commit.data.id
    assert.ok(blobId, 'commit names the blob')
    const back = await user.raw(`/api/vault/blobs/${encodeURIComponent(blobId)}/chunks/0`)
    assert.equal(back.status, 200)
    assert.equal(sha256(back.buffer), sha256(ciphertext), `${item.label}: exact ciphertext returned`)
    assert.equal(back.headers.get('content-type'), 'application/octet-stream')
    const plain = await decryptVaultChunk(env.dek, { contentId: env.contentId, chunkIndex: 0, chunkCount: 1, ivB64: back.headers.get('x-vault-chunk-iv'), ciphertext: new Uint8Array(back.buffer) })
    assert.equal(sha256(Buffer.from(plain)), sha256(item.bytes), `${item.label}: exact plaintext after client decrypt`)
  }
})
