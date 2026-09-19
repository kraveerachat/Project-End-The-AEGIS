// tests/vaultTreeApi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 2.4 · opaque tree API (server, memory mode)
//
// ⚠️ พิสูจน์สัญญาบนสาย: auth/CSRF/flag gates, ไวยากรณ์ของค่าทึบ, staging → publish → CAS, idempotency,
//    attach promotion, key-envelope CAS, inventory + lifecycle, owner isolation — และ NO-LEAK-1:
//    ทุกไบต์ที่ส่งไปเซิร์ฟเวอร์และทุกแถว audit ไม่มีชื่อไฟล์/node id/คำว่า parent เลย
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'
import { randomId, fixedId, revisionDescriptor, fakeCiphertext, capture, wrappedB64, ivB64 } from './helpers/vaultTreeFixtures.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-tree-api-'))
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
const { readAudit, getUserByUsername } = await import('../server/db/connection.js')
const { createVaultSetup, encryptFileEnvelope } = await import('../src/lib/vaultCrypto.js')
const { seedTree } = await import('./helpers/vaultTreeStoreSpec.mjs')

const ON = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_MAX_ATTACH_PER_CAS: '4', VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES: '65552' })
const OFF = vaultTreeConfigFromEnv({})
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 } // server minimum, as in vaultApi.test.js
const SECRET_NAMES = ['quarterly-board-minutes-CONFIDENTIAL.pdf', 'โฟลเดอร์ลับ', 'merger-plan']
const NODE_IDS = [fixedId(1, 'N'), fixedId(2, 'N')]

let serverOn, baseOn, serverOff, baseOff, ownerId, otherId
const logLines = []

before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultManifestStorage()
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream)
    stream.write = (chunk, ...rest) => { logLines.push(String(chunk)); return orig(chunk, ...rest) }
  }
  serverOn = createApp({ vaultTreeConfig: ON }).listen(0, '127.0.0.1')
  serverOff = createApp({ vaultTreeConfig: OFF }).listen(0, '127.0.0.1')
  await Promise.all([serverOn, serverOff].map((s) => new Promise((r) => s.once('listening', r))))
  baseOn = `http://127.0.0.1:${serverOn.address().port}`; baseOff = `http://127.0.0.1:${serverOff.address().port}`
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
  otherId = String((await getUserByUsername(DEMO_ADMIN.username)).id)
})
after(async () => {
  await Promise.all([serverOn, serverOff].map((s) => new Promise((r) => s.close(r))))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => { await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests(); await store.__resetVaultForTests() })

const login = (base = baseOn, who = DEMO_USER) => loginClient(base, who.username, who.password)
async function stage(client, { generation, baseRevisionId, treeId, revisionId = randomId(), idempotencyKey = randomId(), bytes = fakeCiphertext() }) {
  const desc = revisionDescriptor({ revisionId, baseRevisionId, generation, idempotencyKey, treeId })
  const created = await client.req('/api/vault/tree/revisions', { method: 'POST', body: desc })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const put = await client.req(`/api/vault/tree/revisions/${revisionId}/ciphertext`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })
  assert.equal(put.status, 200, JSON.stringify(put.data))
  return { desc, bytes }
}

test('TR-1 unauthenticated → 401 on every route; CSRF enforced on every non-GET', async () => {
  const anon = await import('./helpers/testClient.mjs').then((m) => new m.Client(baseOn))
  for (const [m, p] of [['GET', '/api/vault/tree/state'], ['GET', '/api/vault/tree/head'], ['POST', '/api/vault/tree/revisions'], ['PUT', `/api/vault/tree/revisions/${fixedId(1)}/ciphertext`], ['GET', `/api/vault/tree/revisions/${fixedId(1)}`], ['POST', '/api/vault/tree/head'], ['POST', '/api/vault/tree/key-envelope'], ['GET', '/api/vault/tree/blobs']]) {
    const r = await anon.req(p, { method: m, body: m === 'PUT' ? new Uint8Array(8) : m === 'POST' ? {} : undefined, headers: m === 'PUT' ? { 'Content-Type': 'application/octet-stream' } : {} })
    // GET → 401 from requireAuth; non-GET without a session hits the app-wide CSRF gate first (403) — either way no tree code runs
    assert.equal(r.status, m === 'GET' ? 401 : 403, `${m} ${p}`)
  }
  const c = await login()
  const saved = c.csrf; c.csrf = null
  const r = await c.req('/api/vault/tree/revisions', { method: 'POST', body: revisionDescriptor({ generation: 1 }) })
  assert.equal(r.status, 403, 'missing CSRF token')
  c.csrf = saved
})

test('TR-2 flags off → 503 TREE_PROTOCOL_DISABLED on every tree route', async () => {
  const c = await login(baseOff)
  for (const [m, p] of [['GET', '/api/vault/tree/state'], ['GET', '/api/vault/tree/head'], ['POST', '/api/vault/tree/revisions'], ['POST', '/api/vault/tree/head'], ['POST', '/api/vault/tree/key-envelope'], ['GET', '/api/vault/tree/blobs']]) {
    const r = await c.req(p, { method: m, body: m === 'POST' ? {} : undefined })
    assert.equal(r.status, 503, `${m} ${p}`); assert.equal(r.data.code, 'TREE_PROTOCOL_DISABLED')
  }
})

test('TR-3 fresh owner state: FLAT, no head, no lease, flags echoed, barrier 0, no-store', async () => {
  const c = await login()
  const r = await c.req('/api/vault/tree/state')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.deepEqual(r.data, { protocolState: 'FLAT', minProtocolVersion: 1, protocolVersion: 1, flags: { ...ON.flags }, lease: null, head: null, purgeBarrierGeneration: 0 })
  const h = await c.req('/api/vault/tree/head')
  assert.equal(h.status, 409); assert.equal(h.data.code, 'TREE_STATE_CONFLICT')
})

test('TR-4 POST revisions validates opaque syntax → 400 on each violation without echoing the value', async () => {
  const c = await login()
  await seedTree(tree, ownerId)
  const good = revisionDescriptor({ generation: 2, baseRevisionId: fixedId(901) })
  const bad = [
    { ...good, revisionId: 'short' }, { ...good, revisionId: good.revisionId + '=' }, { ...good, ivB64: 'tooshort' }, { ...good, wrapIvB64: 'x'.repeat(16) + '!' },
    { ...good, generation: 0 }, { ...good, generation: 1.5 }, { ...good, generation: '2' }, { ...good, manifestSchemaVersion: 2 },
    { ...good, baseRevisionId: undefined }, { ...good, generation: 1 }, { ...good, idempotencyKey: 'nope' }, { ...good, extra: 'field' },
    { ...good, wrappedManifestDekB64: 'a'.repeat(300) }, { ...good, name: SECRET_NAMES[0] }, { ...good, parentNodeId: NODE_IDS[0] },
  ]
  for (const b of bad) {
    const r = await c.req('/api/vault/tree/revisions', { method: 'POST', body: b })
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80)); assert.equal(r.data.code, 'INVALID_INPUT')
    assert.doesNotMatch(JSON.stringify(r.data), /short|tooshort|nope|CONFIDENTIAL/)
  }
})

test('TR-5 PUT ciphertext: CREATED → PUBLISHED; second PUT 409; over limit 413; wrong content type 415', async () => {
  const c = await login()
  const { treeId, rootRevision } = await seedTree(tree, ownerId)
  const desc = revisionDescriptor({ generation: 2, baseRevisionId: rootRevision })
  assert.equal((await c.req('/api/vault/tree/revisions', { method: 'POST', body: desc })).status, 201)
  const replay = await c.req('/api/vault/tree/revisions', { method: 'POST', body: desc })
  assert.equal(replay.status, 200); assert.equal(replay.data.state, 'CREATED')
  const wrongType = await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: { not: 'bytes' } })
  assert.equal(wrongType.status, 415)
  const big = await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: fakeCiphertext(65_553), headers: { 'Content-Type': 'application/octet-stream' } })
  assert.equal(big.status, 413); assert.equal(big.data.code, 'TREE_MANIFEST_TOO_LARGE')
  const put = await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: fakeCiphertext(4_112), headers: { 'Content-Type': 'application/octet-stream' } })
  assert.equal(put.status, 200); assert.deepEqual(put.data, { revisionId: desc.revisionId, state: 'PUBLISHED', ciphertextSize: 4_112 })
  const again = await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: fakeCiphertext(4_112), headers: { 'Content-Type': 'application/octet-stream' } })
  assert.equal(again.status, 409); assert.equal(again.data.code, 'TREE_REVISION_NOT_PUBLISHED')
  assert.equal((await c.req(`/api/vault/tree/revisions/${randomId()}/ciphertext`, { method: 'PUT', body: fakeCiphertext(8), headers: { 'Content-Type': 'application/octet-stream' } })).status, 404)
  assert.equal(treeId, fixedId(900))
})

test('TR-6 head CAS success; GET head reflects it; GET revision streams the exact bytes with no-store', async () => {
  const c = await login()
  const { rootRevision } = await seedTree(tree, ownerId)
  const { desc, bytes } = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  const cas = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, attachBlobIds: [], purgeBlobIds: [], idempotencyKey: desc.idempotencyKey } })
  assert.equal(cas.status, 200, JSON.stringify(cas.data)); assert.deepEqual(cas.data, { generation: 2, revisionId: desc.revisionId, purgeBarrierGeneration: 0, purgeId: null })
  const head = await c.req('/api/vault/tree/head')
  assert.equal(head.status, 200)
  assert.equal(head.data.generation, 2); assert.equal(head.data.revisionId, desc.revisionId); assert.equal(head.data.baseRevisionId, rootRevision)
  assert.equal(head.data.ivB64, desc.ivB64); assert.equal(head.data.wrappedManifestDekB64, desc.wrappedManifestDekB64); assert.equal(head.data.ciphertextSize, bytes.length)
  assert.equal(head.data.keyEnvelope.envelopeCasVersion, 1); assert.ok(head.data.keyEnvelope.primary.wrappedTrkB64)
  const raw = await fetch(`${baseOn}/api/vault/tree/revisions/${desc.revisionId}`, { headers: { cookie: c.cookie } })
  assert.equal(raw.status, 200); assert.equal(raw.headers.get('content-type'), 'application/octet-stream'); assert.equal(raw.headers.get('cache-control'), 'no-store')
  assert.equal(Buffer.from(await raw.arrayBuffer()).equals(Buffer.from(bytes)), true)
  const state = await c.req('/api/vault/tree/state')
  assert.deepEqual(state.data.head, { treeId: fixedId(900), revisionId: desc.revisionId, generation: 2 })
})

test('TR-7 stale CAS → 409 TREE_HEAD_CONFLICT with the current pointer; the orphaned candidate is 404', async () => {
  const c = await login()
  const { rootRevision } = await seedTree(tree, ownerId)
  const a = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  assert.equal((await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: a.desc.revisionId, idempotencyKey: a.desc.idempotencyKey } })).status, 200)
  const b = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  const r = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: b.desc.revisionId, idempotencyKey: b.desc.idempotencyKey } })
  assert.equal(r.status, 409); assert.equal(r.data.code, 'TREE_HEAD_CONFLICT'); assert.equal(r.data.currentGeneration, 2); assert.equal(r.data.currentRevisionId, a.desc.revisionId)
  assert.equal((await fetch(`${baseOn}/api/vault/tree/revisions/${b.desc.revisionId}`, { headers: { cookie: c.cookie } })).status, 404)
})

test('TR-8 idempotent replay returns the original 200; replay with a mismatched key → 409 TREE_IDEMPOTENCY_MISMATCH', async () => {
  const c = await login()
  const { rootRevision } = await seedTree(tree, ownerId)
  const { desc } = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  const body = { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey }
  const first = await c.req('/api/vault/tree/head', { method: 'POST', body })
  const second = await c.req('/api/vault/tree/head', { method: 'POST', body })
  assert.equal(second.status, 200); assert.deepEqual(second.data, first.data)
  const mismatch = await c.req('/api/vault/tree/head', { method: 'POST', body: { ...body, idempotencyKey: randomId() } })
  assert.equal(mismatch.status, 409); assert.equal(mismatch.data.code, 'TREE_IDEMPOTENCY_MISMATCH')
  assert.equal((await tree.getTreeState(ownerId)).treeMutationCount, 1)
})

test('TR-9 attachBlobIds promotes UNREFERENCED V1 and V2 blobs; a TREE_MANAGED id → 409 and nothing changes; TR-ATTACH-MAX → 400', async () => {
  const c = await login()
  const { rootRevision } = await seedTree(tree, ownerId)
  await tree.upsertBlobState(ownerId, { formatVersion: 1, id: '7' }, 'UNREFERENCED')
  await tree.upsertBlobState(ownerId, { formatVersion: 2, id: 'v2blob' }, 'UNREFERENCED')
  await tree.upsertBlobState(ownerId, { formatVersion: 2, id: 'managed' }, 'TREE_MANAGED', { attachedGeneration: 1 })
  const { desc } = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  const conflict = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey, attachBlobIds: [{ formatVersion: 2, id: 'v2blob' }, { formatVersion: 2, id: 'managed' }] } })
  assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'TREE_BLOB_STATE_CONFLICT')
  assert.equal((await c.req('/api/vault/tree/head')).data.generation, 1)
  const tooMany = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey, attachBlobIds: Array.from({ length: 5 }, (_, i) => ({ formatVersion: 2, id: 'x' + i })) } })
  assert.equal(tooMany.status, 400)
  const okr = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey, attachBlobIds: [{ formatVersion: 1, id: 7 }, { formatVersion: 2, id: 'v2blob' }] } })
  assert.equal(okr.status, 200)
  const states = await tree.listBlobStates(ownerId)
  assert.equal(states.find((s) => s.id === '7').lifecycle, 'TREE_MANAGED'); assert.equal(states.find((s) => s.id === 'v2blob').attachedGeneration, 2)
  // purgeBlobIds are not served before Phase 8
  const { desc: d2 } = await stage(c, { generation: 3, baseRevisionId: desc.revisionId })
  const purge = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 2, expectedRevisionId: desc.revisionId, revisionId: d2.revisionId, idempotencyKey: d2.idempotencyKey, purgeBlobIds: [{ formatVersion: 2, id: 'v2blob' }] } })
  assert.equal(purge.status, 501); assert.equal(purge.data.code, 'TREE_PURGE_NOT_SUPPORTED')
})

test('TR-10 key-envelope CAS success/stale; response carries only the new cas version', async () => {
  const c = await login()
  await seedTree(tree, ownerId)
  const slots = { primary: { wrappedTrkB64: wrappedB64(), wrapIvB64: ivB64() }, recovery: { wrappedTrkB64: wrappedB64(), wrapIvB64: ivB64() } }
  const r = await c.req('/api/vault/tree/key-envelope', { method: 'POST', body: { expectedEnvelopeCasVersion: 1, ...slots } })
  assert.equal(r.status, 200); assert.deepEqual(r.data, { envelopeCasVersion: 2 })
  const stale = await c.req('/api/vault/tree/key-envelope', { method: 'POST', body: { expectedEnvelopeCasVersion: 1, ...slots, primary: { ...slots.primary, wrapIvB64: ivB64() } } })
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'TREE_ENVELOPE_CONFLICT'); assert.equal(stale.data.currentEnvelopeCasVersion, 2)
  const sameIv = await c.req('/api/vault/tree/key-envelope', { method: 'POST', body: { expectedEnvelopeCasVersion: 2, primary: slots.primary, recovery: { ...slots.recovery, wrapIvB64: slots.primary.wrapIvB64 } } })
  assert.equal(sameIv.status, 400)
  assert.deepEqual((await c.req('/api/vault/tree/head')).data.keyEnvelope.primary, slots.primary)
})

test('TR-11 GET blobs returns lifecycle per blob with the same envelope fields as GET /api/vault; storageKey never present', async () => {
  const c = await login()
  const setup = await createVaultSetup('tree-api-passphrase-x1', FAST)
  assert.equal((await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  const env = await encryptFileEnvelope(setup.kek, { name: SECRET_NAMES[0], type: 'application/pdf', size: 3, bytes: new Uint8Array([1, 2, 3]) })
  const form = new FormData()
  form.set('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
  for (const k of ['ivB64', 'wrappedDekB64', 'wrapIvB64', 'metaIvB64', 'metaB64']) form.set(k, env[k])
  const up = await c.req('/api/vault/blobs', { method: 'POST', body: form })
  assert.equal(up.status, 201, JSON.stringify(up.data) + ' keys=' + [...form.keys()].join(','))
  const v1Id = String(up.data.blob?.id ?? up.data.id)
  // FLAT → inventory refused (fence not yet applied); after seeding TREE_V1 the V1 blob shows as UNREFERENCED, a managed one as TREE_MANAGED
  assert.equal((await c.req('/api/vault/tree/blobs')).status, 409)
  await seedTree(tree, ownerId)
  await tree.upsertBlobState(ownerId, { formatVersion: 1, id: v1Id }, 'TREE_MANAGED', { attachedGeneration: 1 })
  const r = await c.req('/api/vault/tree/blobs')
  assert.equal(r.status, 200)
  const b = r.data.blobs.find((x) => String(x.id) === v1Id)
  assert.equal(b.lifecycle, 'TREE_MANAGED'); assert.equal(b.formatVersion, 1); assert.equal(b.metaB64, env.metaB64)
  assert.equal('storageKey' in b, false)
  const legacy = await c.req('/api/vault')
  const { lifecycle, attachedGeneration, orphanSince, ...envelopeOnly } = b
  assert.deepEqual(envelopeOnly, legacy.data.blobs.find((x) => String(x.id) === v1Id))
  assert.equal((await c.req('/api/vault/tree/blobs?lifecycle=UNREFERENCED')).data.blobs.length, 0)
  assert.equal((await c.req('/api/vault/tree/blobs?lifecycle=BOGUS')).status, 400)
})

test('TR-12 owner isolation: another user cannot read the head/revision/blobs (404/409) nor CAS the head', async () => {
  const c = await login(); const other = await login(baseOn, DEMO_ADMIN)
  const { rootRevision } = await seedTree(tree, ownerId)
  const { desc } = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  assert.equal((await other.req('/api/vault/tree/head')).status, 409)
  assert.equal((await fetch(`${baseOn}/api/vault/tree/revisions/${rootRevision}`, { headers: { cookie: other.cookie } })).status, 404)
  assert.equal((await other.req('/api/vault/tree/blobs')).status, 409)
  const cas = await other.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey } })
  assert.equal(cas.status, 409); assert.equal(cas.data.code, 'TREE_STATE_CONFLICT')
  assert.equal((await other.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: fakeCiphertext(8), headers: { 'Content-Type': 'application/octet-stream' } })).status, 404)
  assert.equal((await c.req('/api/vault/tree/head')).data.generation, 1)
  assert.equal(otherId !== ownerId, true)
})

test('NO-LEAK-1 + AUD-OPAQUE-1: no request, response, log line or audit row contains a plaintext name, node id or "parent"', async () => {
  const c = await login()
  const cap = capture(c)
  const { rootRevision } = await seedTree(tree, ownerId)
  await tree.upsertBlobState(ownerId, { formatVersion: 2, id: 'leakblob' }, 'UNREFERENCED')
  const { desc } = await stage(c, { generation: 2, baseRevisionId: rootRevision })
  const responses = []
  responses.push(await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: desc.revisionId, idempotencyKey: desc.idempotencyKey, attachBlobIds: [{ formatVersion: 2, id: 'leakblob' }] } }))
  responses.push(await c.req('/api/vault/tree/head'), await c.req('/api/vault/tree/state'), await c.req('/api/vault/tree/blobs'))
  const everything = cap.all() + '\n' + JSON.stringify(responses.map((r) => r.data)) + '\n' + logLines.join('\n')
  for (const needle of [...SECRET_NAMES, ...NODE_IDS, 'parentNodeId', 'breadcrumb']) {
    const at = everything.indexOf(needle)
    assert.equal(at, -1, `${needle} leaked near: ${everything.slice(Math.max(0, at - 120), at + 40).replace(/\s+/g, ' ')}`)
  }
  assert.doesNotMatch(cap.all(), /"parent"/)
  const audit = await readAudit(50)
  const treeRows = audit.filter((a) => String(a.action).startsWith('VAULT_TREE_'))
  assert.ok(treeRows.length >= 3)
  for (const row of treeRows) {
    assert.ok(row.targetHash === null || /^[0-9a-f]{64}$/.test(row.targetHash), 'targets are hashes of opaque ids')
    const text = JSON.stringify(row)
    for (const needle of [...SECRET_NAMES, ...NODE_IDS]) assert.equal(text.includes(needle), false)
  }
  for (const expected of ['VAULT_TREE_HEAD_CAS', 'VAULT_TREE_REVISION_PUBLISH', 'VAULT_TREE_REVISION_STAGE']) assert.ok(treeRows.some((r) => r.action === expected), expected)
})
