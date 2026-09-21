// tests/vaultTreeMigrationApi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 3.1 · migration lease / frozen inventory / genesis
//
// ⚠️ พิสูจน์รั้วของการย้าย: FLAT → MIGRATING_TREE_V1 ด้วย CAS + lease + inventory ที่แช่แข็ง; takeover หลัง
//    หมดอายุเท่านั้น; genesis อะตอมมิก (ซองกุญแจ + head + revision + โปรโมต blob + TREE_V1 + ล้างฟิลด์ migration
//    + ลบแถว frozen inventory); abandon เฉพาะเมื่อพิสูจน์ได้ว่าไม่เคยมี head; TREE_V1 ไม่ย้อนกลับ
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'
import { randomId, revisionDescriptor, fakeCiphertext, wrappedB64, ivB64 } from './helpers/vaultTreeFixtures.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-tree-migration-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
delete process.env.DATABASE_URL
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { createApp } = await import('../server/app.js')
const { vaultTreeConfigFromEnv } = await import('../server/config/vaultTreeLimits.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultManifestStorage } = await import('../server/storage/vaultManifestStore.js')
const tree = await import('../server/db/vaultTreeStore.js')
const store = await import('../server/db/store.js')
const v2store = await import('../server/db/vaultV2Store.js')
const { getUserByUsername } = await import('../server/db/connection.js')
const { createVaultSetup, encryptFileEnvelope } = await import('../src/lib/vaultCrypto.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const GEN = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_MIGRATION_LEASE_MS: '1500' })
const NOGEN = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true' })

let serverGen, baseGen, serverNoGen, baseNoGen, ownerId
before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultManifestStorage()
  serverGen = createApp({ vaultTreeConfig: GEN }).listen(0, '127.0.0.1')
  serverNoGen = createApp({ vaultTreeConfig: NOGEN }).listen(0, '127.0.0.1')
  await Promise.all([serverGen, serverNoGen].map((s) => new Promise((r) => s.once('listening', r))))
  baseGen = `http://127.0.0.1:${serverGen.address().port}`; baseNoGen = `http://127.0.0.1:${serverNoGen.address().port}`
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
})
after(async () => {
  await Promise.all([serverGen, serverNoGen].map((s) => new Promise((r) => s.close(r))))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => { await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests(); await store.__resetVaultForTests() })

const login = (base = baseGen, who = DEMO_USER) => loginClient(base, who.username, who.password)
async function vaultWithBlobs(client, n = 2) {
  const setup = await createVaultSetup('migration-passphrase-x2', FAST)
  assert.equal((await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  const ids = []
  for (let i = 0; i < n; i++) {
    const env = await encryptFileEnvelope(setup.kek, { name: `file-${i}.pdf`, type: 'application/pdf', size: 3, bytes: new Uint8Array([1, 2, i]) })
    const form = new FormData()
    form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
    for (const k of ['ivB64', 'wrappedDekB64', 'wrapIvB64', 'metaIvB64', 'metaB64']) form.append(k, env[k])
    const up = await client.req('/api/vault/blobs', { method: 'POST', body: form })
    assert.equal(up.status, 201); ids.push(String(up.data.blob.id))
  }
  return ids
}
const begin = (c) => c.req('/api/vault/tree/migration/begin', { method: 'POST', body: {} })
const takeover = (c) => c.req('/api/vault/tree/migration/takeover', { method: 'POST', body: {} })
const abandon = (c, leaseId) => c.req('/api/vault/tree/migration/abandon', { method: 'POST', body: { leaseId } })
const keyEnvelope = () => ({ primary: { wrappedTrkB64: wrappedB64(), wrapIvB64: ivB64() }, recovery: { wrappedTrkB64: wrappedB64(), wrapIvB64: ivB64() } })
async function stageGenesis(c, treeId) {
  const desc = revisionDescriptor({ generation: 1, baseRevisionId: null, treeId })
  const created = await c.req('/api/vault/tree/revisions', { method: 'POST', body: desc })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal((await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: fakeCiphertext(), headers: { 'Content-Type': 'application/octet-stream' } })).status, 200)
  return desc
}
function genesisBody(lease, desc, treeId, extra = {}) {
  const { treeId: _t, ...revision } = desc
  return { leaseId: lease.leaseId, epoch: lease.epoch, frozenInventoryId: lease.frozenInventoryId, treeId, ownerScopeIdB64: randomId(), keyEnvelope: keyEnvelope(), revision: { revisionId: revision.revisionId, ivB64: revision.ivB64, wrappedManifestDekB64: revision.wrappedManifestDekB64, wrapIvB64: revision.wrapIvB64, manifestSchemaVersion: 1 }, idempotencyKey: desc.idempotencyKey, ...extra } // one key per genesis attempt: staging + genesis share it
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('MG-1 begin in FLAT → 201 lease + frozen inventory; state becomes MIGRATING_TREE_V1 with the invariant fields', async () => {
  const c = await login(); const ids = await vaultWithBlobs(c, 2)
  const r = await begin(c)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.match(r.data.leaseId, /^[0-9a-f]{48}$/); assert.equal(r.data.epoch, 1)
  assert.ok(r.data.expiresAt > Date.now() && r.data.expiresAt <= Date.now() + 1_600)
  assert.match(r.data.frozenInventoryId, /^[A-Za-z0-9_-]{22}$/)
  assert.deepEqual(r.data.blobs.map((b) => String(b.id)).sort(), ids.sort())
  assert.ok(r.data.blobs.every((b) => b.formatVersion === 1 && b.metaB64 && !('storageKey' in b)))
  const st = await tree.peekTreeState(ownerId)
  assert.equal(st.protocolState, 'MIGRATING_TREE_V1'); assert.equal(st.migrationLeaseId, r.data.leaseId); assert.equal(st.migrationLeaseEpoch, 1)
  assert.equal(st.frozenInventoryId, r.data.frozenInventoryId); assert.match(st.frozenInventoryDigest, /^[0-9a-f]{64}$/); assert.equal(st.headEverCommitted, false)
  assert.deepEqual((await tree.listFrozenInventory(ownerId, r.data.frozenInventoryId)).map((b) => b.id).sort(), ids.sort())
  const state = await c.req('/api/vault/tree/state')
  assert.equal(state.data.protocolState, 'MIGRATING_TREE_V1'); assert.equal(state.data.lease.held, true); assert.equal(state.data.lease.epoch, 1)
})

test('MG-2 begin when not FLAT → 409 TREE_STATE_CONFLICT; genesis flag off → 503', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  assert.equal((await begin(c)).status, 201)
  const again = await begin(c)
  assert.equal(again.status, 409); assert.equal(again.data.code, 'TREE_STATE_CONFLICT')
  const c2 = await login(baseNoGen)
  for (const p of ['begin', 'takeover', 'abandon']) {
    const r = await c2.req(`/api/vault/tree/migration/${p}`, { method: 'POST', body: {} })
    assert.equal(r.status, 503, p); assert.equal(r.data.code, 'TREE_PROTOCOL_DISABLED')
  }
  assert.equal((await c2.req('/api/vault/tree/genesis', { method: 'POST', body: {} })).status, 503)
})

test('MG-3 takeover before expiry → 409 TREE_LEASE_HELD; after expiry → new lease, epoch 2, same fenced inventory', async () => {
  const c = await login(); const ids = await vaultWithBlobs(c, 2)
  const first = await begin(c)
  const held = await takeover(c)
  assert.equal(held.status, 409); assert.equal(held.data.code, 'TREE_LEASE_HELD')
  await tree.__expireLeaseForTests(ownerId)
  const taken = await takeover(c)
  assert.equal(taken.status, 200, JSON.stringify(taken.data))
  assert.notEqual(taken.data.leaseId, first.data.leaseId); assert.equal(taken.data.epoch, 2)
  assert.equal(taken.data.frozenInventoryId, first.data.frozenInventoryId)
  assert.deepEqual(taken.data.blobs.map((b) => String(b.id)).sort(), ids.sort())
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, 'MIGRATING_TREE_V1')
})

test('MG-4 genesis with a stale leaseId or epoch → 409 TREE_LEASE_STALE and nothing is written', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  const lease = (await begin(c)).data
  const treeId = randomId()
  const desc = await stageGenesis(c, treeId)
  const staleId = await c.req('/api/vault/tree/genesis', { method: 'POST', body: genesisBody({ ...lease, leaseId: 'f'.repeat(48) }, desc, treeId) })
  assert.equal(staleId.status, 409); assert.equal(staleId.data.code, 'TREE_LEASE_STALE')
  const staleEpoch = await c.req('/api/vault/tree/genesis', { method: 'POST', body: genesisBody({ ...lease, epoch: 2 }, desc, treeId) })
  assert.equal(staleEpoch.status, 409); assert.equal(staleEpoch.data.code, 'TREE_LEASE_STALE')
  await tree.__expireLeaseForTests(ownerId)
  const expired = await c.req('/api/vault/tree/genesis', { method: 'POST', body: genesisBody(lease, desc, treeId) })
  assert.equal(expired.status, 409); assert.equal(expired.data.code, 'TREE_LEASE_STALE')
  assert.equal(await tree.getHead(ownerId), null); assert.equal(await tree.getKeyEnvelope(ownerId), null)
  assert.equal((await tree.getRevision(ownerId, desc.revisionId)).state, 'PUBLISHED')
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, 'MIGRATING_TREE_V1')
})

test('MG-5 genesis with a frozenInventoryId that does not match → 409 TREE_INVENTORY_MISMATCH', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  const lease = (await begin(c)).data
  const treeId = randomId(); const desc = await stageGenesis(c, treeId)
  const r = await c.req('/api/vault/tree/genesis', { method: 'POST', body: genesisBody({ ...lease, frozenInventoryId: randomId() }, desc, treeId) })
  assert.equal(r.status, 409); assert.equal(r.data.code, 'TREE_INVENTORY_MISMATCH')
  assert.equal(await tree.getHead(ownerId), null)
})

test('MG-6 genesis success is one transaction: envelope, head g1, HEAD_COMMITTED, blobs TREE_MANAGED, TREE_V1, migration fields cleared, frozen rows deleted', async () => {
  const c = await login(); const ids = await vaultWithBlobs(c, 3)
  const lease = (await begin(c)).data
  const treeId = randomId(); const desc = await stageGenesis(c, treeId)
  const body = genesisBody(lease, desc, treeId)
  const r = await c.req('/api/vault/tree/genesis', { method: 'POST', body })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.deepEqual(r.data, { treeId, generation: 1, revisionId: desc.revisionId, protocolState: 'TREE_V1' })
  const st = await tree.peekTreeState(ownerId)
  assert.equal(st.protocolState, 'TREE_V1'); assert.equal(st.headEverCommitted, true)
  assert.equal(st.migrationLeaseId, null); assert.equal(st.migrationLeaseExpiresAt, null); assert.equal(st.frozenInventoryId, null); assert.equal(st.frozenInventoryDigest, null)
  assert.equal(st.migrationLeaseEpoch, 1, 'epoch retained as the monotonic counter')
  assert.deepEqual(await tree.listFrozenInventory(ownerId, lease.frozenInventoryId), [], 'consumed frozen-inventory rows deleted')
  const head = await tree.getHead(ownerId)
  assert.equal(head.generation, 1); assert.equal(head.revisionId, desc.revisionId); assert.equal(head.treeId, treeId)
  assert.equal((await tree.getRevision(ownerId, desc.revisionId)).state, 'HEAD_COMMITTED')
  const env = await tree.getKeyEnvelope(ownerId)
  assert.equal(env.treeId, treeId); assert.equal(env.ownerScopeIdB64, body.ownerScopeIdB64); assert.deepEqual(env.primary, body.keyEnvelope.primary)
  const states = await tree.listBlobStates(ownerId)
  assert.deepEqual(states.map((s) => s.id).sort(), ids.sort())
  assert.ok(states.every((s) => s.lifecycle === 'TREE_MANAGED' && s.attachedGeneration === 1 && s.formatVersion === 1))
  const viaApi = await c.req('/api/vault/tree/head')
  assert.equal(viaApi.data.generation, 1); assert.equal(viaApi.data.keyEnvelope.envelopeCasVersion, 1)
  // legacy mutation is now permanently fenced
  const del = await c.req(`/api/vault/blobs/${ids[0]}`, { method: 'DELETE' })
  assert.equal(del.status, 426)
})

test('MG-7 genesis idempotent replay (same key) → 201 same body; a different key after TREE_V1 → 409 TREE_STATE_CONFLICT', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  const lease = (await begin(c)).data
  const treeId = randomId(); const desc = await stageGenesis(c, treeId)
  const body = genesisBody(lease, desc, treeId)
  const first = await c.req('/api/vault/tree/genesis', { method: 'POST', body })
  const replay = await c.req('/api/vault/tree/genesis', { method: 'POST', body })
  assert.equal(replay.status, 201); assert.deepEqual(replay.data, first.data)
  const other = await c.req('/api/vault/tree/genesis', { method: 'POST', body: { ...body, idempotencyKey: randomId() } })
  assert.equal(other.status, 409); assert.equal(other.data.code, 'TREE_STATE_CONFLICT')
  assert.equal((await tree.getTreeState(ownerId)).treeMutationCount, 0, 'genesis is not a mutation of an existing tree')
})

test('MG-8 abandon: only MIGRATING with no head ever, no tree mutation, and (expired or matching lease) → FLAT with frozen rows deleted; otherwise 409', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  const lease = (await begin(c)).data
  const wrong = await abandon(c, 'e'.repeat(48))
  assert.equal(wrong.status, 409); assert.equal(wrong.data.code, 'TREE_ABANDON_FORBIDDEN')
  const okr = await abandon(c, lease.leaseId)
  assert.equal(okr.status, 200); assert.deepEqual(okr.data, { protocolState: 'FLAT' })
  const st = await tree.peekTreeState(ownerId)
  assert.equal(st.protocolState, 'FLAT'); assert.equal(st.migrationLeaseId, null); assert.equal(st.frozenInventoryId, null); assert.equal(st.migrationLeaseEpoch, 1)
  assert.deepEqual(await tree.listFrozenInventory(ownerId, lease.frozenInventoryId), [])
  // FLAT again → legacy mutation works
  assert.equal((await c.req('/api/vault')).status, 200)
  const notMigrating = await abandon(c, lease.leaseId)
  assert.equal(notMigrating.status, 409); assert.equal(notMigrating.data.code, 'TREE_ABANDON_FORBIDDEN')
  // expired lease held by "another device" can be abandoned without its id
  const lease2 = (await begin(c)).data
  assert.equal((await abandon(c, 'e'.repeat(48))).status, 409)
  await tree.__expireLeaseForTests(ownerId)
  assert.equal((await abandon(c, 'e'.repeat(48))).status, 200)
  assert.equal(lease2.epoch, 2)
})

test('MG-9 abandon after genesis → 409; the store refuses to leave TREE_V1', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  const lease = (await begin(c)).data
  const treeId = randomId(); const desc = await stageGenesis(c, treeId)
  assert.equal((await c.req('/api/vault/tree/genesis', { method: 'POST', body: genesisBody(lease, desc, treeId) })).status, 201)
  const r = await abandon(c, lease.leaseId)
  assert.equal(r.status, 409); assert.equal(r.data.code, 'TREE_ABANDON_FORBIDDEN')
  const direct = await tree.abandonMigration(ownerId, { leaseId: lease.leaseId })
  assert.equal(direct.ok, false)
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, 'TREE_V1')
})

test('MG-10 begin after a completed abandon works again with a fresh frozen inventory id and a higher epoch', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  const l1 = (await begin(c)).data
  assert.equal((await abandon(c, l1.leaseId)).status, 200)
  const l2 = (await begin(c)).data
  assert.notEqual(l2.frozenInventoryId, l1.frozenInventoryId); assert.notEqual(l2.leaseId, l1.leaseId); assert.equal(l2.epoch, 2)
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, 'MIGRATING_TREE_V1')
})

test('MG-11 during MIGRATING_TREE_V1 the tree-aware mutation routes are refused (409 TREE_STATE_CONFLICT) except genesis staging', async () => {
  const c = await login(); await vaultWithBlobs(c, 1)
  await begin(c)
  const treeId = randomId()
  const genesisStage = await c.req('/api/vault/tree/revisions', { method: 'POST', body: revisionDescriptor({ generation: 1, baseRevisionId: null, treeId }) })
  assert.equal(genesisStage.status, 201, 'the lease holder may stage the genesis revision')
  const later = await c.req('/api/vault/tree/revisions', { method: 'POST', body: revisionDescriptor({ generation: 2, baseRevisionId: randomId() }) })
  assert.equal(later.status, 409); assert.equal(later.data.code, 'TREE_STATE_CONFLICT')
  const cas = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: randomId(), revisionId: randomId(), idempotencyKey: randomId() } })
  assert.equal(cas.status, 409); assert.equal(cas.data.code, 'TREE_STATE_CONFLICT')
  const env = await c.req('/api/vault/tree/key-envelope', { method: 'POST', body: { expectedEnvelopeCasVersion: 1, ...keyEnvelope() } })
  assert.equal(env.status, 409); assert.equal(env.data.code, 'TREE_STATE_CONFLICT')
  assert.equal((await c.req('/api/vault/tree/head')).status, 409)
  const blobs = await c.req('/api/vault/tree/blobs')
  assert.equal(blobs.status, 200, 'the fenced inventory is readable during migration'); assert.equal(blobs.data.blobs[0].lifecycle, 'UNREFERENCED')
  // another owner is unaffected
  const other = await login(baseGen, DEMO_ADMIN)
  assert.equal((await other.req('/api/vault/tree/state')).data.protocolState, 'FLAT')
})
