// tests/vaultTreeConfig.test.js — AEGIS Drive (IDEA1) · PR #157 Task 2.1 · fail-closed rollout flags + server limits
//
// ⚠️ ทุก flag ปิดโดยปริยาย และเป็นโซ่: flag ปลายเปิดโดยที่ต้นทางปิด = บูตไม่ขึ้น (โยน error) ไม่ใช่เงียบ
//    ค่าเพดานฝั่งเซิร์ฟเวอร์ = ตาราง Task 0.3 (provisional) — เทสต์นี้คือตัวตรึงเช่นเดียวกับ vaultTreeLimits.test.js
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-tree-config-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
delete process.env.DATABASE_URL
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { vaultTreeConfigFromEnv, VAULT_TREE_PROTOCOL_VERSION, verifyTreeSchema, TREE_TABLES } = await import('../server/config/vaultTreeLimits.js')
const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')

const REGISTER_LIMITS = Object.freeze({
  maxManifestCiphertextBytes: 16_777_232,
  migrationLeaseMs: 600_000,
  orphanRevisionRetentionMs: 86_400_000,
  orphanBlobRetentionMs: 2_592_000_000,
  forensicRevisionRetentionMs: 2_592_000_000,
  purgeRetentionMs: 604_800_000,
  maxAttachBlobIdsPerCas: 256,
  maxPurgeBlobIdsPerRequest: 256,
})
const ALL_OFF = Object.freeze({ schemaAvailable: false, protocolEnabled: false, genesisMigrationEnabled: false, treeUiEnabled: false, mediaPreviewEnabled: false, destructivePurgeEnabled: false })
const ALL_ON = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_DESTRUCTIVE_PURGE_ENABLED: 'true' }

test('CF-1 empty env → all six flags false; limits equal the Limits Register server values; deep-frozen', () => {
  const c = vaultTreeConfigFromEnv({})
  assert.deepEqual({ ...c.flags }, ALL_OFF)
  assert.deepEqual({ ...c.limits }, REGISTER_LIMITS)
  assert.equal(c.protocolVersion, 1); assert.equal(VAULT_TREE_PROTOCOL_VERSION, 1)
  assert.equal(Object.isFrozen(c), true); assert.equal(Object.isFrozen(c.flags), true); assert.equal(Object.isFrozen(c.limits), true)
  assert.throws(() => { c.flags.protocolEnabled = true }, TypeError)
  assert.deepEqual(TREE_TABLES, ['vault_tree_state', 'vault_tree_frozen_inventory', 'vault_tree_key_envelope', 'vault_tree_heads', 'vault_tree_revisions', 'vault_tree_blob_state', 'vault_tree_purge_candidates'])
})

test('CF-2 flags parse only true/false; yes, 1 and explicit empty throw naming the variable', () => {
  assert.equal(vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true' }).flags.schemaAvailable, true)
  assert.equal(vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'false' }).flags.schemaAvailable, false)
  for (const bad of ['yes', '1', '', ' TRUE ', 'on']) {
    assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: bad }), /VAULT_TREE_SCHEMA_AVAILABLE/, JSON.stringify(bad))
  }
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_DESTRUCTIVE_PURGE_ENABLED: 'yes' }), /VAULT_DESTRUCTIVE_PURGE_ENABLED/)
})

test('CF-3 limits parse positive integers within range; out-of-range or malformed throw', () => {
  assert.equal(vaultTreeConfigFromEnv({ VAULT_TREE_MIGRATION_LEASE_MS: '30000' }).limits.migrationLeaseMs, 30_000)
  assert.equal(vaultTreeConfigFromEnv({ VAULT_TREE_MAX_ATTACH_PER_CAS: '8' }).limits.maxAttachBlobIdsPerCas, 8)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_MIGRATION_LEASE_MS: '0' }), /VAULT_TREE_MIGRATION_LEASE_MS/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_MIGRATION_LEASE_MS: 'abc' }), /VAULT_TREE_MIGRATION_LEASE_MS/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES: '1' }), /VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES: String(2 ** 40) }), /VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_MAX_PURGE_PER_REQUEST: '100000' }), /VAULT_TREE_MAX_PURGE_PER_REQUEST/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_PURGE_RETENTION_MS: '-5' }), /VAULT_TREE_PURGE_RETENTION_MS/)
})

test('FLAG-CHAIN-1..5 a flag whose prerequisite is false throws at boot', () => {
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_PROTOCOL_ENABLED: 'true' }), /VAULT_TREE_PROTOCOL_ENABLED.*VAULT_TREE_SCHEMA_AVAILABLE/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true' }), /VAULT_TREE_GENESIS_MIGRATION_ENABLED.*VAULT_TREE_PROTOCOL_ENABLED/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_UI_ENABLED: 'true' }), /VAULT_TREE_UI_ENABLED.*VAULT_TREE_PROTOCOL_ENABLED/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true' }), /VAULT_MEDIA_PREVIEW_ENABLED.*VAULT_TREE_UI_ENABLED/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_DESTRUCTIVE_PURGE_ENABLED: 'true' }), /VAULT_DESTRUCTIVE_PURGE_ENABLED.*VAULT_TREE_PROTOCOL_ENABLED/)
  const on = vaultTreeConfigFromEnv(ALL_ON)
  assert.deepEqual({ ...on.flags }, { schemaAvailable: true, protocolEnabled: true, genesisMigrationEnabled: true, treeUiEnabled: true, mediaPreviewEnabled: true, destructivePurgeEnabled: true })
})

test('BOOT-1 schemaAvailable=true with a missing table rejects naming it; BOOT-2 schemaAvailable=false never probes', async () => {
  let probes = 0
  const missingProbe = async () => { probes++; return { missing: ['vault_tree_heads'] } }
  await assert.rejects(verifyTreeSchema(vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true' }), missingProbe), /vault_tree_heads/)
  assert.equal(probes, 1)
  const okProbe = async () => { probes++; return { missing: [] } }
  await verifyTreeSchema(vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true' }), okProbe)
  assert.equal(probes, 2)
  await verifyTreeSchema(vaultTreeConfigFromEnv({}), missingProbe)
  assert.equal(probes, 2, 'schemaAvailable=false must not call the probe')
})

let server, baseUrl
before(async () => {
  await initStorage()
  const app = createApp()
  server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise((r) => server?.close(r)); await fs.rm(STORAGE_ROOT, { recursive: true, force: true }) })

test('CF-4 createApp() default config is all-off: tree route → 503 TREE_PROTOCOL_DISABLED after auth; /healthz carries the additive vaultTree block', async () => {
  const health = await (await fetch(`${baseUrl}/healthz`)).json()
  assert.deepEqual(health.vaultTree, { schemaAvailable: false, protocolEnabled: false, destructivePurgeEnabled: false })
  assert.ok('media' in health, 'existing media block still present')
  const anon = await fetch(`${baseUrl}/api/vault/tree/state`)
  assert.equal(anon.status, 401)
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const r = await client.req('/api/vault/tree/state')
  assert.equal(r.status, 503)
  assert.equal(r.data.code, 'TREE_PROTOCOL_DISABLED')
  const r2 = await client.req('/api/vault/tree/head')
  assert.equal(r2.status, 503)
  // legacy vault route is untouched by the flags
  const legacy = await client.req('/api/vault')
  assert.equal(legacy.status, 200)
})
