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
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k.startsWith('VAULT_PREVIEW_INDEX_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { vaultTreeConfigFromEnv, VAULT_TREE_PROTOCOL_VERSION, verifyTreeSchema, TREE_TABLES, PREVIEW_INDEX_TABLES, verifyPreviewIndexSchema, HG_G_RETAINED_BUDGET_APPROVAL } = await import('../server/config/vaultTreeLimits.js')
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
  // D-1 preview index (PROVISIONAL / TO_BE_MEASURED — approved values only after HG-G)
  maxPreviewIndexAttachPerCas: 64,
  maxPreviewIndexSupersededPerCas: 64,
  maxPreviewIndexEnvelopeBatch: 32,
  maxPreviewIndexRetainedBytesPerOwner: null,
})
const ALL_OFF = Object.freeze({ schemaAvailable: false, protocolEnabled: false, genesisMigrationEnabled: false, treeUiEnabled: false, mediaPreviewEnabled: false, destructivePurgeEnabled: false, previewIndexSchemaAvailable: false, previewIndexReadEnabled: false, previewIndexWriteEnabled: false })
const ALL_ON = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_DESTRUCTIVE_PURGE_ENABLED: 'true' }

test('CF-1 empty env → all flags false (six tree + three preview-index); limits equal the Limits Register server values; deep-frozen', () => {
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
  assert.deepEqual({ ...on.flags }, { schemaAvailable: true, protocolEnabled: true, genesisMigrationEnabled: true, treeUiEnabled: true, mediaPreviewEnabled: true, destructivePurgeEnabled: true, previewIndexSchemaAvailable: false, previewIndexReadEnabled: false, previewIndexWriteEnabled: false })
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

// ── D-1 preview index (PR-A, Task A.1) ───────────────────────────────────────
const TREE_ON = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true' }
const PI_SCHEMA = { ...TREE_ON, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true' }
const PI_READ = { ...PI_SCHEMA, VAULT_PREVIEW_INDEX_READ_ENABLED: 'true' }
const MIB = 1_048_576

test('PI-CF-1 preview-index flags parse only true/false and are all false by default', () => {
  const c = vaultTreeConfigFromEnv({})
  assert.equal(c.flags.previewIndexSchemaAvailable, false)
  assert.equal(c.flags.previewIndexReadEnabled, false)
  assert.equal(c.flags.previewIndexWriteEnabled, false)
  for (const name of ['VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE', 'VAULT_PREVIEW_INDEX_READ_ENABLED', 'VAULT_PREVIEW_INDEX_WRITE_ENABLED']) {
    for (const bad of ['yes', '1', '', 'TRUE']) assert.throws(() => vaultTreeConfigFromEnv({ ...PI_READ, [name]: bad }), new RegExp(name), `${name}=${JSON.stringify(bad)}`)
  }
  assert.deepEqual(PREVIEW_INDEX_TABLES, ['vault_preview_index_heads', 'vault_preview_index_generations', 'vault_preview_index_blob_refs'])
})

test('PI-CHAIN-1..4 preview-index flags are a fail-closed chain', () => {
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true' }), /VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE.*VAULT_TREE_SCHEMA_AVAILABLE/)
  assert.throws(() => vaultTreeConfigFromEnv({ ...TREE_ON, VAULT_PREVIEW_INDEX_READ_ENABLED: 'true' }), /VAULT_PREVIEW_INDEX_READ_ENABLED.*VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE/)
  const noMedia = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true' }
  assert.throws(() => vaultTreeConfigFromEnv(noMedia), /VAULT_PREVIEW_INDEX_READ_ENABLED.*VAULT_MEDIA_PREVIEW_ENABLED/)
  assert.throws(() => vaultTreeConfigFromEnv({ ...PI_SCHEMA, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(64 * MIB) }), /VAULT_PREVIEW_INDEX_WRITE_ENABLED.*VAULT_PREVIEW_INDEX_READ_ENABLED/)
  const read = vaultTreeConfigFromEnv(PI_READ)
  assert.equal(read.flags.previewIndexSchemaAvailable, true)
  assert.equal(read.flags.previewIndexReadEnabled, true)
  assert.equal(read.flags.previewIndexWriteEnabled, false)
})

test('PI-CF-2 provisional preview-index limits parse within range', () => {
  const c = vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS: '8', VAULT_PREVIEW_INDEX_MAX_SUPERSEDED_PER_CAS: '0', VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH: '128' })
  assert.equal(c.limits.maxPreviewIndexAttachPerCas, 8)
  assert.equal(c.limits.maxPreviewIndexSupersededPerCas, 0)
  assert.equal(c.limits.maxPreviewIndexEnvelopeBatch, 128)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS: '0' }), /VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS: '257' }), /VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_SUPERSEDED_PER_CAS: '257' }), /VAULT_PREVIEW_INDEX_MAX_SUPERSEDED_PER_CAS/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH: '0' }), /VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH/)
  assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH: '129' }), /VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH/)
})

test('PI-BUDGET-1 retained-storage budget: unset → null (no invented value); range 1 MiB..64 GiB; integers only', () => {
  assert.equal(vaultTreeConfigFromEnv({}).limits.maxPreviewIndexRetainedBytesPerOwner, null)
  assert.equal(vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(MIB) }).limits.maxPreviewIndexRetainedBytesPerOwner, MIB)
  assert.equal(vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(64 * 1024 * MIB) }).limits.maxPreviewIndexRetainedBytesPerOwner, 64 * 1024 * MIB)
  for (const bad of [String(MIB - 1), String(64 * 1024 * MIB + 1), '1.5', 'abc', '-1', '']) {
    assert.throws(() => vaultTreeConfigFromEnv({ VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: bad }), /VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER/, JSON.stringify(bad))
  }
})

test('PI-BUDGET-2 WRITE=false with the budget unset boots; WRITE=true without a budget fails closed at boot', () => {
  const readOnly = vaultTreeConfigFromEnv({ ...PI_READ, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'false' })
  assert.equal(readOnly.flags.previewIndexWriteEnabled, false)
  assert.equal(readOnly.limits.maxPreviewIndexRetainedBytesPerOwner, null)
  assert.throws(() => vaultTreeConfigFromEnv({ ...PI_READ, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true' }), /VAULT_PREVIEW_INDEX_WRITE_ENABLED=true requires VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER/)
  const budgeted = vaultTreeConfigFromEnv({ ...PI_READ, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(32 * MIB) })
  assert.equal(budgeted.flags.previewIndexWriteEnabled, true)
  assert.equal(budgeted.limits.maxPreviewIndexRetainedBytesPerOwner, 32 * MIB)
})

test('PI-BUDGET-3 HG-G records exact 8 GiB without changing null default or fail-closed boot', () => {
  assert.deepEqual(HG_G_RETAINED_BUDGET_APPROVAL, {
    date: '2026-10-03',
    source: 'HG_G_APPROVED / PR #310 / 89da7f84d7279871f6e10df5df3e6b78594e5ef8',
    bytes: 8_589_934_592,
  })
  assert.equal(vaultTreeConfigFromEnv({}).limits.maxPreviewIndexRetainedBytesPerOwner, null)
  assert.throws(() => vaultTreeConfigFromEnv({ ...PI_READ, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true' }), /requires VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER/)
  const prepared = vaultTreeConfigFromEnv({ ...PI_READ, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'false', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: '8589934592' })
  assert.equal(prepared.flags.previewIndexWriteEnabled, false)
  assert.equal(prepared.limits.maxPreviewIndexRetainedBytesPerOwner, 8_589_934_592)
})

test('PI-BOOT-1 preview-index schema probe: missing table or missing lifecycle values reject; flag off never probes', async () => {
  let probes = 0
  const cfg = vaultTreeConfigFromEnv(PI_SCHEMA)
  await assert.rejects(verifyPreviewIndexSchema(cfg, async () => { probes++; return { missing: ['vault_preview_index_heads'], lifecycleValuesOk: true } }), /vault_preview_index_heads/)
  await assert.rejects(verifyPreviewIndexSchema(cfg, async () => { probes++; return { missing: [], lifecycleValuesOk: false } }), /INDEX_STAGED/)
  assert.deepEqual(await verifyPreviewIndexSchema(cfg, async () => { probes++; return { missing: [], lifecycleValuesOk: true } }), { probed: true, missing: [] })
  assert.equal(probes, 3)
  assert.deepEqual(await verifyPreviewIndexSchema(vaultTreeConfigFromEnv(TREE_ON), async () => { probes++; return { missing: ['x'], lifecycleValuesOk: false } }), { probed: false, missing: [] })
  assert.equal(probes, 3, 'previewIndexSchemaAvailable=false must not call the probe')
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
