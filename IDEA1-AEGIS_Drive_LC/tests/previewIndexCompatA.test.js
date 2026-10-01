// tests/previewIndexCompatA.test.js — AEGIS Drive (IDEA1) · D-1 PR-A Task A.6 · compatibility boundary
//
// Pins the PR-A contract: new flags default OFF and leave every pre-existing flag/route as before; the main
// manifest still writes schema 1 and the server still rejects schema-2 revisions (even with preview-index flags ON);
// VAULT_MANIFEST_V2_UPGRADE / setNodePreviews stay unused; INDEX_* blobs can never be attached by the main head
// CAS; the original (tree) upload family still commits UNREFERENCED user blobs that appear in GET /api/vault.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STORAGE_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aegis-preview-index-compat-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
delete process.env.DATABASE_URL
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k.startsWith('VAULT_PREVIEW_INDEX_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { createApp } = await import('../server/app.js')
const { vaultTreeConfigFromEnv } = await import('../server/config/vaultTreeLimits.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultManifestStorage } = await import('../server/storage/vaultManifestStore.js')
const { initVaultStaging } = await import('../server/storage/vaultStaging.js')
const tree = await import('../server/db/vaultTreeStore.js')
const store = await import('../server/db/store.js')
const v2 = await import('../server/db/vaultV2Store.js')
const { getUserByUsername } = await import('../server/db/connection.js')
const { MANIFEST_SCHEMA_VERSION_WRITE } = await import('../src/lib/vaultTreeManifest.js')
const { seedTree } = await import('./helpers/vaultTreeStoreSpec.mjs')
const { seedV2Blob } = await import('./helpers/previewIndexStoreSpec.mjs')
const { revisionDescriptor, fakeCiphertext, randomId } = await import('./helpers/vaultTreeFixtures.mjs')

const TREE = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true' }
const STAGE1 = vaultTreeConfigFromEnv({ ...TREE, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'false' })
const TREE_ONLY = vaultTreeConfigFromEnv(TREE)
const PRE_D1_FLAG_KEYS = ['schemaAvailable', 'protocolEnabled', 'genesisMigrationEnabled', 'treeUiEnabled', 'mediaPreviewEnabled', 'destructivePurgeEnabled']

const servers = {}
let ownerId
before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultManifestStorage(); await initVaultStaging()
  for (const [k, cfg] of Object.entries({ stage1: STAGE1, treeOnly: TREE_ONLY, dflt: undefined })) {
    const s = createApp(cfg ? { vaultTreeConfig: cfg } : {}).listen(0, '127.0.0.1')
    await new Promise((r) => s.once('listening', r))
    servers[k] = { s, base: `http://127.0.0.1:${s.address().port}` }
  }
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
})
after(async () => {
  await Promise.all(Object.values(servers).map(({ s }) => new Promise((r) => s.close(r))))
  await fsp.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => { await tree.__resetVaultTreeForTests(); await v2.__resetVaultV2ForTests(); await store.__resetVaultForTests() })
const login = (k) => loginClient(servers[k].base, DEMO_USER.username, DEMO_USER.password)

test('PI-COMPAT-1 new flags default OFF; with them OFF, /state keeps every pre-D-1 flag value and adds only three false flags', async () => {
  const dflt = vaultTreeConfigFromEnv({})
  assert.equal(dflt.flags.previewIndexSchemaAvailable, false)
  assert.equal(dflt.flags.previewIndexReadEnabled, false)
  assert.equal(dflt.flags.previewIndexWriteEnabled, false)
  assert.equal(dflt.limits.maxPreviewIndexRetainedBytesPerOwner, null)
  await seedTree(tree, ownerId)
  const st = await (await login('treeOnly')).req('/api/vault/tree/state')
  assert.equal(st.status, 200)
  assert.deepEqual(Object.keys(st.data).sort(), ['flags', 'head', 'lease', 'minProtocolVersion', 'protocolState', 'protocolVersion', 'purgeBarrierGeneration'])
  for (const k of PRE_D1_FLAG_KEYS) assert.equal(st.data.flags[k], TREE_ONLY.flags[k], k)
  assert.deepEqual(Object.keys(st.data.flags).filter((k) => !PRE_D1_FLAG_KEYS.includes(k)).sort(), ['previewIndexReadEnabled', 'previewIndexSchemaAvailable', 'previewIndexWriteEnabled'])
  for (const k of ['previewIndexReadEnabled', 'previewIndexSchemaAvailable', 'previewIndexWriteEnabled']) assert.equal(st.data.flags[k], false, k)
  const def = await (await login('dflt')).req('/api/vault/tree/state')
  assert.equal(def.status, 503, 'default app: tree protocol (and everything after it) stays off')
})

test('PI-COMPAT-2 main manifest stays schema v1: client writer constant is 1 and the server rejects schema-2 revisions even with preview-index flags ON', async () => {
  assert.equal(MANIFEST_SCHEMA_VERSION_WRITE, 1)
  const { rootRevision, treeId } = await seedTree(tree, ownerId)
  const c = await login('stage1')
  const v2desc = { ...revisionDescriptor({ baseRevisionId: rootRevision, generation: 2, treeId }), manifestSchemaVersion: 2 }
  const r = await c.req('/api/vault/tree/revisions', { method: 'POST', body: v2desc })
  assert.equal(r.status, 400); assert.equal(r.data.code, 'INVALID_INPUT')
})

test('PI-COMPAT-3 VAULT_MANIFEST_V2_UPGRADE, manifestV2Upgrade and setNodePreviews are referenced by no runtime module', () => {
  const files = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (/\.(js|jsx|mjs)$/.test(e.name)) files.push(p) } }
  walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'server'))
  assert.ok(files.length > 50)
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /VAULT_MANIFEST_V2_UPGRADE|manifestV2Upgrade|setNodePreviews/, path.relative(ROOT, f))
})

test('PI-COMPAT-4 the main head CAS can never attach an INDEX_STAGED or INDEX_MANAGED blob (409 TREE_BLOB_STATE_CONFLICT, head unchanged)', async () => {
  const { rootRevision, treeId } = await seedTree(tree, ownerId)
  const c = await login('stage1')
  const staged = await seedV2Blob({ v2, tree }, ownerId, { lifecycle: 'INDEX_STAGED' })
  const managed = await seedV2Blob({ v2, tree }, ownerId, { lifecycle: 'INDEX_MANAGED' })
  const userBlob = await seedV2Blob({ v2, tree }, ownerId, { lifecycle: 'UNREFERENCED' })
  const desc = revisionDescriptor({ baseRevisionId: rootRevision, generation: 2, treeId })
  assert.equal((await c.req('/api/vault/tree/revisions', { method: 'POST', body: desc })).status, 201)
  assert.equal((await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: fakeCiphertext(), headers: { 'Content-Type': 'application/octet-stream' } })).status, 200)
  for (const blob of [staged, managed]) {
    const r = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey, attachBlobIds: [{ formatVersion: 2, id: blob.id }, { formatVersion: 2, id: userBlob.id }] } })
    assert.equal(r.status, 409, blob.id); assert.equal(r.data.code, 'TREE_BLOB_STATE_CONFLICT')
    assert.equal((await c.req('/api/vault/tree/head')).data.generation, 1)
  }
  const states = new Map((await tree.listBlobStates(ownerId)).map((s) => [s.id, s.lifecycle]))
  assert.equal(states.get(staged.id), 'INDEX_STAGED'); assert.equal(states.get(managed.id), 'INDEX_MANAGED'); assert.equal(states.get(userBlob.id), 'UNREFERENCED')
})

test('PI-COMPAT-5 preview-index flags change nothing for user files: tree upload family still commits UNREFERENCED blobs listed by GET /api/vault and recoverable as orphans', async () => {
  await seedTree(tree, ownerId)
  const c = await login('stage1')
  const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
  const setup = await createVaultSetup('preview-index-compat-passphrase', { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 })
  assert.equal((await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  const { createVaultV2Envelope, encryptVaultChunk } = await import('../src/lib/vaultChunkCrypto.js')
  const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
  const kek = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const plaintext = new TextEncoder().encode('ordinary user file bytes')
  const env = await createVaultV2Envelope(kek, { name: 'report.txt', type: 'text/plain', size: plaintext.length, chunkCount: 1 })
  const chunk = await encryptVaultChunk(env.dek, { contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext })
  const created = await c.req('/api/vault/tree/uploads', { method: 'POST', body: { formatVersion: 2, contentIdB64: env.contentIdB64, ciphertextSize: chunk.ciphertext.length, chunkSize: VAULT_TRANSFER_LIMITS.plaintextChunkBytes + GCM_TAG_BYTES, chunkCount: 1, wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64 } })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const uploadId = created.data.upload.uploadId
  const put = await c.req(`/api/vault/tree/uploads/${uploadId}/chunks/0`, { method: 'PUT', body: chunk.ciphertext, headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': chunk.ivB64 } })
  assert.ok(put.status === 200 || put.status === 201, JSON.stringify(put.data))
  const commit = await c.req(`/api/vault/tree/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  assert.equal(commit.data.blob.lifecycle, 'UNREFERENCED')
  const id = commit.data.blob.id
  const inv = await c.req('/api/vault')
  assert.ok(inv.data.blobs.some((b) => String(b.id) === id), 'GET /api/vault lists the user file')
  const orphans = await c.req('/api/vault/tree/blobs?lifecycle=UNREFERENCED')
  assert.deepEqual(orphans.data.blobs.map((b) => b.id), [id])
  const raw = await c.raw(`/api/vault/blobs/${id}/chunks/0`)
  assert.equal(raw.status, 200)
  assert.deepEqual(new Uint8Array(raw.buffer), new Uint8Array(chunk.ciphertext), 'download bytes are exactly the uploaded ciphertext')
  assert.equal(randomId().length, 22)
})
