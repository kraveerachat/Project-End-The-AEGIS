// tests/helpers/previewIndexUploadHarness.mjs — D-1 PR-C · shared harness for the preview-index upload family tests
//
// Runs in memory mode by default. With PI_UPLOAD_PG=1 and TEST_DATABASE_URL (scripts/pg-integration-env.sh) it runs
// the SAME tests against a fresh PostgreSQL 15 database created from TEMPLATE aegis_drive_test (drive_app,
// non-superuser), dropped afterwards. Must be imported before any server module (it sets the environment).
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

export const PG = process.env.PI_UPLOAD_PG === '1'
if (PG && !process.env.TEST_DATABASE_URL) throw new Error('PI_UPLOAD_PG=1 needs TEST_DATABASE_URL (scripts/pg-integration-env.sh)')

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-preview-index-uploads-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)
delete process.env.MAX_VAULT_LOGICAL_FILE_BYTES
delete process.env.VAULT_UPLOAD_SESSION_TTL_MS; delete process.env.VAULT_COMMIT_LEASE_MS; delete process.env.VAULT_UPLOAD_CONCURRENCY
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k.startsWith('VAULT_PREVIEW_INDEX_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

let superPool = null, dbName = null
if (PG) {
  process.env.PGOPTIONS = '-c statement_timeout=5000 -c lock_timeout=5000'
  const TEST_URL = process.env.TEST_DATABASE_URL
  superPool = new pg.Pool({ connectionString: process.env.AEGIS_PGTEST_SUPER_URL, max: 2 })
  dbName = `aegis_drive_piup_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  await superPool.query(`CREATE DATABASE ${dbName} TEMPLATE ${new URL(TEST_URL).pathname.slice(1)}`)
  await superPool.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
  await superPool.query(`GRANT CONNECT ON DATABASE ${dbName} TO drive_app`)
  const u = new URL(TEST_URL); u.pathname = '/' + dbName
  process.env.DATABASE_URL = u.toString()
} else {
  delete process.env.DATABASE_URL
}

export const { createApp } = await import('../../server/app.js')
export const { vaultTreeConfigFromEnv } = await import('../../server/config/vaultTreeLimits.js')
const { initStorage } = await import('../../server/storage/fileStore.js')
const { initVaultStorage } = await import('../../server/storage/vaultStore.js')
const { initVaultStaging } = await import('../../server/storage/vaultStaging.js')
const { initVaultManifestStorage } = await import('../../server/storage/vaultManifestStore.js')
export const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../../server/config/vaultTransferLimits.js')
export const tree = await import('../../server/db/vaultTreeStore.js')
export const store = await import('../../server/db/store.js')
export const v2 = await import('../../server/db/vaultV2Store.js')
export const pindex = await import('../../server/db/vaultPreviewIndexStore.js')
export const connection = await import('../../server/db/connection.js')
const { createVaultSetup } = await import('../../src/lib/vaultCrypto.js')
const { createVaultV2Envelope } = await import('../../src/lib/vaultChunkCrypto.js')
const { loginClient, DEMO_USER, DEMO_ADMIN } = await import('./testClient.mjs')
export { DEMO_USER, DEMO_ADMIN }

export const PI_UP = '/api/vault/tree/preview-index/uploads'
export const TREE_UP = '/api/vault/tree/uploads'
export const MiB = 1024 * 1024
const TREE_FLAGS = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true' }
export const cfg = {
  write: (budget = MiB) => vaultTreeConfigFromEnv({ ...TREE_FLAGS, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(budget) }),
  read: () => vaultTreeConfigFromEnv({ ...TREE_FLAGS, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true' }),
  treeOnly: () => vaultTreeConfigFromEnv(TREE_FLAGS),
  off: () => vaultTreeConfigFromEnv({}),
}

const servers = new Map()
export let ownerId, otherId

export async function setup(names) {
  await initStorage(); await initVaultStorage(); await initVaultStaging(); await initVaultManifestStorage()
  for (const [name, config] of Object.entries(names)) {
    const app = createApp({ vaultTreeConfig: config })
    const s = app.listen(0, '127.0.0.1')
    await new Promise((r) => s.once('listening', r))
    servers.set(name, { s, app, base: `http://127.0.0.1:${s.address().port}` })
  }
  ownerId = String((await connection.getUserByUsername(DEMO_USER.username)).id)
  otherId = String((await connection.getUserByUsername(DEMO_ADMIN.username)).id)
}
export async function teardown() {
  await Promise.all([...servers.values()].map(({ s }) => new Promise((r) => s.close(r))))
  if (PG) {
    await connection.closePool()
    await superPool.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await superPool.end()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
}
export async function reset() {
  await tree.__resetVaultTreeForTests(); await v2.__resetVaultV2ForTests(); await store.__resetVaultForTests(); await pindex.__resetPreviewIndexForTests()
}
/** swap the vault-tree config of a running server (e.g. lower the budget between create and commit) */
export const setServerConfig = (name, config) => servers.get(name).app.set('vaultTreeConfig', config)
export const base = (name) => servers.get(name).base

export const login = (name, who = DEMO_USER) => loginClient(base(name), who.username, who.password)
export async function setupVault(client) {
  const s = await createVaultSetup('preview-index-upload-passphrase-77', { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 })
  const r = await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: s.saltB64, params: s.params, verifier: s.verifier } })
  assert.ok(r.status === 201 || r.status === 409, JSON.stringify(r.data))
  return s.kek
}
/** an index-object-shaped create body (name '' and a reserved marker type live only inside the encrypted meta) */
export async function createBody(kek, { plainSize = 1024 } = {}) {
  const env = await createVaultV2Envelope(kek, { name: '', type: 'application/vnd.aegis.vault-preview-index-shard.v1', size: plainSize, chunkCount: 1 })
  return { formatVersion: 2, contentIdB64: env.contentIdB64, chunkSize: VAULT_TRANSFER_LIMITS.ciphertextChunkBytes, wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64, ciphertextSize: plainSize + GCM_TAG_BYTES, chunkCount: 1 }
}
export const open = async (c, kek, routeBase = PI_UP, o = {}) => c.req(routeBase, { method: 'POST', body: { ...(await createBody(kek, o)), ...(o.extra ?? {}) } })
export const putChunk = (c, uploadId, routeBase = PI_UP, size = 1024) => c.req(`${routeBase}/${uploadId}/chunks/0`, { method: 'PUT', body: randomBytes(size + GCM_TAG_BYTES), headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') } })
export const commit = (c, uploadId, routeBase = PI_UP, body = undefined) => c.req(`${routeBase}/${uploadId}/commit`, { method: 'POST', body })
export const status = (c, uploadId, routeBase = PI_UP) => c.req(`${routeBase}/${uploadId}`)
export const cancel = (c, uploadId, routeBase = PI_UP) => c.req(`${routeBase}/${uploadId}`, { method: 'DELETE' })
/** open → chunk → (no commit); returns the upload id */
export async function staged(c, kek, routeBase = PI_UP, o = {}) {
  const r = await open(c, kek, routeBase, o); assert.equal(r.status, 201, JSON.stringify(r.data))
  const id = r.data.upload.uploadId
  assert.equal((await putChunk(c, id, routeBase, o.plainSize ?? 1024)).status, 200)
  return id
}
/** a full upload in one family; returns the commit response */
export async function uploadOne(c, kek, routeBase = PI_UP, o = {}) {
  const id = await staged(c, kek, routeBase, o)
  return commit(c, id, routeBase)
}
export const blobStateOf = async (id, userId = ownerId) => (await tree.listBlobStates(userId)).find((s) => s.formatVersion === 2 && s.id === id) ?? null

/** owner in TREE_V1 with a committed main head */
export async function treeOwner(userId = ownerId) {
  const { seedTreeOwner } = await import('./previewIndexCasSpec.mjs')
  return seedTreeOwner({ tree, v2 }, userId)
}
