// tests/previewIndexApi.test.js — AEGIS Drive (IDEA1) · D-1 PR-A Task A.4 · read-only preview-index routes (memory mode)
//
// ⚠️ Proves on the wire: auth and flag gates (tree protocol → preview-index read), TREE_V1 requirement,
//    owner isolation (another owner's data → absent / 404, never 403), no-store on every response,
//    strict input validation without echoing client values, no mutating preview-index route in PR-A, and
//    that INDEX_* blobs are excluded from the user inventories GET /api/vault and GET /api/vault/tree/blobs.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-preview-index-api-'))
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
const pindex = await import('../server/db/vaultPreviewIndexStore.js')
const { getUserByUsername } = await import('../server/db/connection.js')
const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
const { seedTree } = await import('./helpers/vaultTreeStoreSpec.mjs')
const { seedV2Blob } = await import('./helpers/previewIndexStoreSpec.mjs')

const TREE = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true' }
const READ = vaultTreeConfigFromEnv({ ...TREE, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH: '3' })
const SCHEMA_ONLY = vaultTreeConfigFromEnv({ ...TREE, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true' })
const TREE_ONLY = vaultTreeConfigFromEnv(TREE)
const ALL_OFF = vaultTreeConfigFromEnv({})
// PR-C: writer-capable server (budget is mandatory with WRITE; 1 MiB is the smallest accepted value — PROVISIONAL test value)
const WRITE = vaultTreeConfigFromEnv({
  ...TREE, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true',
  VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(1024 * 1024), VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS: '3', VAULT_PREVIEW_INDEX_MAX_SUPERSEDED_PER_CAS: '2',
})
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const CONTENT_ID = 'AAECAwQFBgcICQoLDA0ODw=='

const servers = {}
let ownerId, otherId
const deps = { v2, tree }

before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultManifestStorage(); await initVaultStaging()
  for (const [k, cfg] of Object.entries({ read: READ, write: WRITE, schemaOnly: SCHEMA_ONLY, treeOnly: TREE_ONLY, off: ALL_OFF })) {
    const s = createApp({ vaultTreeConfig: cfg }).listen(0, '127.0.0.1')
    await new Promise((r) => s.once('listening', r))
    servers[k] = { s, base: `http://127.0.0.1:${s.address().port}` }
  }
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
  otherId = String((await getUserByUsername(DEMO_ADMIN.username)).id)
})
after(async () => {
  await Promise.all(Object.values(servers).map(({ s }) => new Promise((r) => s.close(r))))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => {
  await tree.__resetVaultTreeForTests(); await v2.__resetVaultV2ForTests(); await store.__resetVaultForTests(); await pindex.__resetPreviewIndexForTests()
})

const login = (k = 'read', who = DEMO_USER) => loginClient(servers[k].base, who.username, who.password)
const noStore = (r) => assert.equal(r.headers?.get?.('cache-control') ?? r.headers?.['cache-control'], 'no-store')

async function indexedOwner(userId = ownerId, treeId = undefined) {
  const t = await seedTree(tree, userId, treeId ? { treeId } : {})
  const root = await seedV2Blob(deps, userId, { lifecycle: 'INDEX_MANAGED' })
  const shard = await seedV2Blob(deps, userId, { lifecycle: 'INDEX_MANAGED' })
  const staged = await seedV2Blob(deps, userId, { lifecycle: 'INDEX_STAGED' })
  await pindex.__seedIndexHeadForTests(userId, { treeId: t.treeId, indexGeneration: 3, rootBlobId: root.id, rootContentIdB64: CONTENT_ID })
  return { t, root, shard, staged }
}

test('PI-API-1 unauthenticated → 401 on every preview-index route; no route runs before auth', async () => {
  const anon = await import('./helpers/testClient.mjs').then((m) => new m.Client(servers.read.base))
  for (const p of ['/api/vault/tree/preview-index/head', '/api/vault/tree/preview-index/envelopes?ids=x', '/api/vault/tree/preview-index/blobs']) {
    assert.equal((await anon.req(p)).status, 401, p)
  }
})

test('PI-API-2 flag gates: tree protocol off → 503 TREE_PROTOCOL_DISABLED; schema without READ or tree-only → 503 PREVIEW_INDEX_DISABLED', async () => {
  for (const [k, code] of [['off', 'TREE_PROTOCOL_DISABLED'], ['treeOnly', 'PREVIEW_INDEX_DISABLED'], ['schemaOnly', 'PREVIEW_INDEX_DISABLED']]) {
    const c = await login(k)
    for (const p of ['/api/vault/tree/preview-index/head', `/api/vault/tree/preview-index/envelopes?ids=${'a'.repeat(48)}`, '/api/vault/tree/preview-index/blobs']) {
      const r = await c.req(p)
      assert.equal(r.status, 503, `${k} ${p}`)
      assert.equal(r.data.code, code, `${k} ${p}`)
      noStore(r)
    }
  }
})

test('PI-API-3 GET head: FLAT owner → 409; TREE_V1 without index → 404 PREVIEW_INDEX_NOT_FOUND; seeded head → exact shape', async () => {
  const c = await login()
  const flat = await c.req('/api/vault/tree/preview-index/head')
  assert.equal(flat.status, 409); assert.equal(flat.data.code, 'TREE_STATE_CONFLICT'); noStore(flat)
  const t = await seedTree(tree, ownerId)
  const none = await c.req('/api/vault/tree/preview-index/head')
  assert.equal(none.status, 404); assert.equal(none.data.code, 'PREVIEW_INDEX_NOT_FOUND'); noStore(none)
  const root = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_MANAGED' })
  await pindex.__seedIndexHeadForTests(ownerId, { treeId: t.treeId, indexGeneration: 3, rootBlobId: root.id, rootContentIdB64: CONTENT_ID })
  const r = await c.req('/api/vault/tree/preview-index/head')
  assert.equal(r.status, 200, JSON.stringify(r.data)); noStore(r)
  assert.deepEqual(r.data, { treeId: t.treeId, indexGeneration: 3, rootBlobRef: { formatVersion: 2, id: root.id }, rootContentIdB64: CONTENT_ID })
})

test('PI-API-4 a head whose treeId differs from the main head treeId is not served (404)', async () => {
  const c = await login()
  const t = await seedTree(tree, ownerId)
  const root = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_MANAGED' })
  await pindex.__seedIndexHeadForTests(ownerId, { treeId: 'Q'.padStart(22, 'W'), indexGeneration: 1, rootBlobId: root.id, rootContentIdB64: CONTENT_ID })
  assert.notEqual(t.treeId, 'Q'.padStart(22, 'W'))
  const r = await c.req('/api/vault/tree/preview-index/head')
  assert.equal(r.status, 404); assert.equal(r.data.code, 'PREVIEW_INDEX_NOT_FOUND')
})

test('PI-API-5 owner isolation: another owner never sees A\'s head, envelopes or blobs', async () => {
  const a = await indexedOwner(ownerId)
  await seedTree(tree, otherId, { treeId: 'B'.padStart(22, 'O') })
  const b = await login('read', DEMO_ADMIN)
  const head = await b.req('/api/vault/tree/preview-index/head')
  assert.equal(head.status, 404)
  const env = await b.req(`/api/vault/tree/preview-index/envelopes?ids=${a.root.id},${a.shard.id}`)
  assert.equal(env.status, 200); assert.deepEqual(env.data.blobs, [])
  const list = await b.req('/api/vault/tree/preview-index/blobs')
  assert.equal(list.status, 200); assert.deepEqual(list.data.blobs, [])
})

test('PI-API-6 envelopes: INDEX_* only, batch limit, strict ids; never echoes input', async () => {
  const c = await login()
  const a = await indexedOwner(ownerId)
  const user = await seedV2Blob(deps, ownerId, { lifecycle: 'UNREFERENCED' })
  const r = await c.req(`/api/vault/tree/preview-index/envelopes?ids=${a.root.id},${a.staged.id},${user.id}`)
  assert.equal(r.status, 200); noStore(r)
  assert.deepEqual(r.data.blobs.map((x) => x.id).sort(), [a.root.id, a.staged.id].sort())
  for (const e of r.data.blobs) assert.equal('storageKey' in e, false)
  const tooMany = await c.req(`/api/vault/tree/preview-index/envelopes?ids=${[a.root.id, a.shard.id, a.staged.id, user.id].join(',')}`)
  assert.equal(tooMany.status, 400); assert.equal(tooMany.data.code, 'INVALID_INPUT')
  const secret = 'quarterly-board-minutes.pdf'
  for (const q of ['', `ids=${secret}`, `ids=${a.root.id},${a.root.id.toUpperCase()}`, 'ids=,', `ids=${a.root.id}&ids=${a.shard.id}`]) {
    const bad = await c.req(`/api/vault/tree/preview-index/envelopes?${q}`)
    assert.equal(bad.status, 400, q); assert.equal(bad.data.code, 'INVALID_INPUT', q); noStore(bad)
    assert.equal(JSON.stringify(bad.data).includes(secret), false)
  }
})

test('PI-API-7 blobs: paginated opaque listing; bad limit/after → 400', async () => {
  const c = await login()
  const a = await indexedOwner(ownerId)
  const p1 = await c.req('/api/vault/tree/preview-index/blobs?limit=2')
  assert.equal(p1.status, 200); noStore(p1)
  assert.equal(p1.data.blobs.length, 2); assert.ok(p1.data.next)
  for (const x of p1.data.blobs) assert.deepEqual(Object.keys(x).sort(), ['createdAt', 'id', 'lifecycle'])
  const p2 = await c.req(`/api/vault/tree/preview-index/blobs?limit=2&after=${p1.data.next}`)
  assert.equal(p2.data.blobs.length, 1); assert.equal(p2.data.next, null)
  assert.deepEqual([...p1.data.blobs, ...p2.data.blobs].map((x) => x.id), [a.root.id, a.shard.id, a.staged.id].sort())
  for (const q of ['limit=0', 'limit=501', 'limit=abc', 'after=nothex']) {
    const bad = await c.req(`/api/vault/tree/preview-index/blobs?${q}`)
    assert.equal(bad.status, 400, q); assert.equal(bad.data.code, 'INVALID_INPUT', q)
  }
})

test('PI-API-8 no PUT/PATCH/DELETE preview-index route exists; POST /head exists only behind the WRITE gate (503 here)', async () => {
  const c = await login()
  const a = await indexedOwner(ownerId)
  const before = JSON.stringify(await pindex.getIndexHead(ownerId))
  for (const [m, p] of [['PUT', '/api/vault/tree/preview-index/head'], ['PATCH', '/api/vault/tree/preview-index/head'], ['DELETE', '/api/vault/tree/preview-index/head'], ['DELETE', `/api/vault/tree/preview-index/blobs/${a.root.id}`], ['DELETE', '/api/vault/tree/preview-index/blobs']]) {
    const r = await c.req(p, { method: m, body: m === 'DELETE' ? undefined : { expectedGeneration: 3 } })
    assert.equal(r.status, 404, `${m} ${p}`)
  }
  const post = await c.req('/api/vault/tree/preview-index/head', { method: 'POST', body: { expectedGeneration: 3 } })
  assert.equal(post.status, 503, 'WRITE is off on this server')
  assert.equal(post.data.code, 'PREVIEW_INDEX_WRITE_DISABLED')
  assert.equal(JSON.stringify(await pindex.getIndexHead(ownerId)), before)
  assert.equal((await pindex.listIndexEnvelopes(ownerId, [a.root.id, a.shard.id, a.staged.id])).length, 3)
})

test('PI-INV-1 INDEX_* blobs are excluded from GET /api/vault and GET /api/vault/tree/blobs (any lifecycle filter)', async () => {
  const c = await login()
  const setup = await createVaultSetup('preview-index-api-passphrase', FAST)
  assert.equal((await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  const a = await indexedOwner(ownerId)
  const user = await seedV2Blob(deps, ownerId, { lifecycle: 'UNREFERENCED' })
  const attached = await seedV2Blob(deps, ownerId, { lifecycle: 'TREE_MANAGED' })
  const indexIds = [a.root.id, a.shard.id, a.staged.id]
  for (const k of ['read', 'treeOnly']) {
    const ck = await login(k)
    const inv = await ck.req('/api/vault')
    assert.equal(inv.status, 200)
    const ids = inv.data.blobs.map((b) => String(b.id))
    assert.deepEqual(ids.filter((id) => indexIds.includes(id)), [], `${k}: GET /api/vault excludes INDEX_*`)
    assert.ok(ids.includes(user.id) && ids.includes(attached.id), `${k}: user blobs still listed`)
    for (const q of ['', '?lifecycle=UNREFERENCED', '?lifecycle=TREE_MANAGED', '?lifecycle=INDEX_MANAGED', '?lifecycle=INDEX_STAGED']) {
      const r = await ck.req(`/api/vault/tree/blobs${q}`)
      assert.equal(r.status, 200, `${k} ${q}`)
      assert.deepEqual(r.data.blobs.map((b) => b.id).filter((id) => indexIds.includes(id)), [], `${k} /tree/blobs${q}`)
    }
    const orphans = (await ck.req('/api/vault/tree/blobs?lifecycle=UNREFERENCED')).data.blobs.map((b) => b.id)
    assert.deepEqual(orphans, [user.id])
  }
})

test('PI-INV-2 with no INDEX_* rows, GET /api/vault and /tree/blobs list exactly what the store holds (unchanged behavior)', async () => {
  const c = await login()
  const setup = await createVaultSetup('preview-index-api-passphrase', FAST)
  assert.equal((await c.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  await seedTree(tree, ownerId)
  const u1 = await seedV2Blob(deps, ownerId, { lifecycle: 'UNREFERENCED' })
  const u2 = await seedV2Blob(deps, ownerId, { lifecycle: 'TREE_MANAGED' })
  const inv = await c.req('/api/vault')
  assert.deepEqual(inv.data.blobs.map((b) => String(b.id)).sort(), [u1.id, u2.id].sort())
  const all = await c.req('/api/vault/tree/blobs')
  assert.deepEqual(all.data.blobs.map((b) => [b.id, b.lifecycle]).sort(), [[u1.id, 'UNREFERENCED'], [u2.id, 'TREE_MANAGED']].sort())
})

// ── PR-C Task C.3 — write-gated CAS route ───────────────────────────────────

const { readAudit, sha256Hex } = await import('../server/db/connection.js')
const { seedTreeOwner } = await import('./helpers/previewIndexCasSpec.mjs')
const casBody = (o) => ({
  expectedGeneration: 0, expectedRootBlobId: null, rootBlobId: o.root.id, rootContentIdB64: o.root.contentIdB64,
  attachBlobIds: o.attach ?? [o.root.id], supersededBlobIds: o.superseded ?? [], idempotencyKey: o.key ?? 'K'.padStart(22, 'k'), ...o.over,
})
const casAudit = async () => (await readAudit(500)).filter((e) => e.action === 'VAULT_PREVIEW_INDEX_CAS')
const lifecycleOf = async (u, id) => (await tree.listBlobStates(u)).find((x) => x.formatVersion === 2 && x.id === id)?.lifecycle ?? null
const postCas = (c, body) => c.req('/api/vault/tree/preview-index/head', { method: 'POST', body })

test('PI-CAS-API-1 WRITE flag off → 503 for a valid body, with zero store mutation and no audit', async () => {
  await seedTreeOwner(deps, ownerId)
  const root = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const before = (await casAudit()).length
  for (const [k, code] of [['read', 'PREVIEW_INDEX_WRITE_DISABLED'], ['schemaOnly', 'PREVIEW_INDEX_DISABLED'], ['treeOnly', 'PREVIEW_INDEX_DISABLED'], ['off', 'TREE_PROTOCOL_DISABLED']]) {
    const c = await login(k)
    const r = await postCas(c, casBody({ root }))
    assert.equal(r.status, 503, k); noStore(r)
    assert.equal(r.data.code, code, k)
  }
  assert.equal(await pindex.getIndexHead(ownerId), null)
  assert.deepEqual(await pindex.listIndexGenerations(ownerId), [])
  assert.equal(await lifecycleOf(ownerId, root.id), 'INDEX_STAGED')
  assert.equal((await casAudit()).length, before)
})

test('PI-CAS-API-2 the existing /api chain (CSRF, then auth) runs before the route', async () => {
  const { Client } = await import('./helpers/testClient.mjs')
  const anon = new Client(servers.write.base)
  assert.equal((await postCas(anon, {})).status, 403, 'anonymous mutation has no CSRF token → rejected before auth')
  const c = await login('write')
  const saved = c.csrf; c.csrf = null
  const r = await postCas(c, {})
  c.csrf = saved
  assert.equal(r.status, 403, 'missing CSRF token is rejected by the /api chain')
})

test('PI-CAS-API-3 success, replay and server-computed digest (id order does not matter); exact shapes; no-store', async () => {
  await seedTreeOwner(deps, ownerId)
  const c = await login('write')
  const root = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' }), shard = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const body = casBody({ root, attach: [root.id, shard.id] })
  const r = await postCas(c, body)
  assert.equal(r.status, 200, JSON.stringify(r.data)); noStore(r)
  assert.deepEqual(r.data, { indexGeneration: 1, rootBlobId: root.id })
  const replay = await postCas(c, { ...body, attachBlobIds: [shard.id, root.id] })
  assert.equal(replay.status, 200); assert.deepEqual(replay.data, { indexGeneration: 1, rootBlobId: root.id })
  const head = await c.req('/api/vault/tree/preview-index/head')
  assert.equal(head.status, 200)
  assert.equal(head.data.indexGeneration, 1)
  assert.deepEqual(head.data.rootBlobRef, { formatVersion: 2, id: root.id })
})

test('PI-CAS-API-4 conflicts: 409 PREVIEW_INDEX_CONFLICT exposes only currentGeneration/currentRootBlobId; other 409s only {error, code}', async () => {
  await seedTreeOwner(deps, ownerId)
  const c = await login('write')
  const g1 = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  assert.equal((await postCas(c, casBody({ root: g1 }))).status, 200)
  const r2 = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const stale = await postCas(c, casBody({ root: r2, key: 'S'.padStart(22, 's') }))
  assert.equal(stale.status, 409); noStore(stale)
  assert.deepEqual(stale.data, { error: 'Preview index changed', code: 'PREVIEW_INDEX_CONFLICT', currentGeneration: 1, currentRootBlobId: g1.id })
  const mismatch = await postCas(c, casBody({ root: r2, over: { expectedGeneration: 1, expectedRootBlobId: g1.id } }))
  assert.equal(mismatch.status, 409); assert.deepEqual(Object.keys(mismatch.data).sort(), ['code', 'error']); assert.equal(mismatch.data.code, 'PREVIEW_INDEX_IDEMPOTENCY_MISMATCH')
  const user = await seedV2Blob(deps, ownerId, { lifecycle: 'UNREFERENCED' })
  const blob = await postCas(c, casBody({ root: r2, attach: [r2.id, user.id], key: 'B'.padStart(22, 'b'), over: { expectedGeneration: 1, expectedRootBlobId: g1.id } }))
  assert.equal(blob.status, 409); assert.deepEqual(Object.keys(blob.data).sort(), ['code', 'error']); assert.equal(blob.data.code, 'PREVIEW_INDEX_BLOB_STATE_CONFLICT')
  const rootMis = await postCas(c, casBody({ root: { ...r2, contentIdB64: g1.contentIdB64 }, key: 'R'.padStart(22, 'r'), over: { expectedGeneration: 1, expectedRootBlobId: g1.id } }))
  assert.equal(rootMis.status, 409); assert.equal(rootMis.data.code, 'PREVIEW_INDEX_ROOT_MISMATCH')
  assert.equal(await lifecycleOf(ownerId, r2.id), 'INDEX_STAGED')
})

test('PI-CAS-API-5 strict body: unknown keys, bad syntax, limits → 400 INVALID_INPUT without echoing client values', async () => {
  await seedTreeOwner(deps, ownerId)
  const c = await login('write')
  const root = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const secret = 'quarterly-board-minutes.pdf'
  let n = 0
  const hex = () => String(++n).padStart(48, 'a')
  const bads = [
    { over: { name: secret } }, { over: { [secret]: 1 } }, { over: { requestDigest: 'f'.repeat(64) } },
    { over: { rootBlobId: secret } }, { over: { rootContentIdB64: secret } }, { over: { idempotencyKey: secret } },
    { over: { expectedGeneration: -1 } }, { over: { expectedGeneration: '0' } }, { over: { expectedGeneration: 1 } },
    { over: { expectedRootBlobId: root.id } }, { over: { attachBlobIds: [] } }, { over: { attachBlobIds: [root.id, root.id] } },
    { over: { attachBlobIds: [hex()] } }, { over: { supersededBlobIds: null } }, { over: { supersededBlobIds: [root.id] } },
    { attach: [root.id, hex(), hex(), hex()] }, { superseded: [hex(), hex(), hex()] }, { over: { attachBlobIds: undefined } },
  ]
  for (const b of bads) {
    const r = await postCas(c, casBody({ root, ...b }))
    assert.equal(r.status, 400, JSON.stringify(b)); noStore(r)
    assert.equal(r.data.code, 'INVALID_INPUT')
    assert.equal(JSON.stringify(r.data).includes(secret), false)
  }
  for (const raw of [[], 'x']) {
    const r = await postCas(c, raw)
    assert.equal(r.status, 400, JSON.stringify(raw))
  }
  assert.equal(await pindex.getIndexHead(ownerId), null)
  assert.equal(await lifecycleOf(ownerId, root.id), 'INDEX_STAGED')
})

test('PI-CAS-API-6 owner isolation: FLAT → 409 TREE_STATE_CONFLICT; another owner\'s blob is indistinguishable from an unknown id', async () => {
  const c = await login('write')
  const rootFlat = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const flat = await postCas(c, casBody({ root: rootFlat }))
  assert.equal(flat.status, 409); assert.equal(flat.data.code, 'TREE_STATE_CONFLICT')
  await seedTreeOwner(deps, ownerId)
  await seedTreeOwner(deps, otherId, { treeId: 'B'.padStart(22, 'O') })
  const foreign = await seedV2Blob(deps, otherId, { lifecycle: 'INDEX_STAGED' })
  const mine = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const viaForeign = await postCas(c, casBody({ root: mine, attach: [mine.id, foreign.id] }))
  const viaUnknown = await postCas(c, casBody({ root: mine, attach: [mine.id, 'e'.repeat(48)], key: 'U'.padStart(22, 'u') }))
  assert.equal(viaForeign.status, 409); assert.deepEqual(viaForeign.data, viaUnknown.data)
  const foreignRoot = await postCas(c, casBody({ root: foreign, key: 'F'.padStart(22, 'f') }))
  assert.equal(foreignRoot.status, 409); assert.deepEqual(foreignRoot.data, viaUnknown.data)
  assert.equal(await lifecycleOf(otherId, foreign.id), 'INDEX_STAGED')
  assert.equal(await pindex.getIndexHead(otherId), null)
})

test('PI-CAS-API-7 audit: VAULT_PREVIEW_INDEX_CAS once per real commit (hash of root id only), DENIED on failure, none on replay', async () => {
  await seedTreeOwner(deps, ownerId)
  const c = await login('write')
  const before = (await casAudit()).length
  const root = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  const body = casBody({ root })
  assert.equal((await postCas(c, body)).status, 200)
  assert.equal((await postCas(c, body)).status, 200)
  const r2 = await seedV2Blob(deps, ownerId, { lifecycle: 'INDEX_STAGED' })
  assert.equal((await postCas(c, casBody({ root: r2, key: 'D'.padStart(22, 'd') }))).status, 409)
  const all = await casAudit()
  const rows = all.slice(0, all.length - before)
  assert.deepEqual(rows.map((e) => e.result).sort(), ['DENIED', 'OK'])
  assert.equal(rows.find((e) => e.result === 'OK').targetHash, sha256Hex(root.id))
  const text = JSON.stringify(rows)
  for (const leak of [root.contentIdB64, 'K'.padStart(22, 'k'), r2.id, root.id]) assert.equal(text.includes(leak), false)
})
