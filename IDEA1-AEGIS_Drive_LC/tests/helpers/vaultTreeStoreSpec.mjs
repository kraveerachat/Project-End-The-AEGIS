// tests/helpers/vaultTreeStoreSpec.mjs — PR #157 · one store spec, run in memory mode AND against PostgreSQL 15
//
// ⚠️ รูปร่างของแถวและความหมายของทุกสถานะต้องเหมือนกันทั้งสองโหมด — ไฟล์นี้คือนิยามนั้น
//    (tests/vaultTreeStore.test.js รันในหน่วยความจำ, tests/vaultTreePostgres.test.js รันกับ PG จริง)
import assert from 'node:assert/strict'

export const ID = (n, tag = 'A') => String(n).padStart(22, tag)
const IV = (n) => 'iv' + String(n).padStart(14, '0') // 16 chars, base64-ish
const B64 = (n) => 'wrapped' + String(n).padStart(9, '0')

export const envelopeFixture = (n = 1) => ({
  primary: { wrappedTrkB64: B64(n * 10 + 1), wrapIvB64: IV(n * 10 + 1) },
  recovery: { wrappedTrkB64: B64(n * 10 + 2), wrapIvB64: IV(n * 10 + 2) },
})

/** สร้าง tree ที่ TREE_V1 ให้ผู้ใช้: revision genesis PUBLISHED แล้ว seed (ข้าม lease) */
export async function seedTree(store, userId, { treeId = ID(900), rootRevision = ID(901), blobRefs = [] } = {}) {
  const created = await store.createRevision(userId, {
    revisionId: rootRevision, treeId, baseRevisionId: null, generation: 1, manifestSchemaVersion: 1,
    ivB64: IV(1), wrappedManifestDekB64: B64(1), wrapIvB64: IV(2), idempotencyKey: ID(1, 'K'),
  })
  assert.equal(created.ok, true)
  assert.equal((await store.markRevisionPublished(userId, rootRevision, { storageKey: `vault-tree/${rootRevision}.aegisenc`, ciphertextSize: 4112, sha256: 'a'.repeat(64) })).ok, true)
  const seeded = await store.__seedTreeV1ForTests(userId, { treeId, ownerScopeIdB64: ID(77), keyEnvelope: envelopeFixture(1), revisionId: rootRevision, blobRefs })
  assert.equal(seeded.ok, true, JSON.stringify(seeded))
  return { treeId, rootRevision }
}

/** เตรียม revision ผู้สมัคร (CREATED → PUBLISHED) สำหรับ CAS */
export async function stageRevision(store, userId, { treeId, baseRevisionId, generation, revisionId, key }) {
  const r = await store.createRevision(userId, {
    revisionId, treeId, baseRevisionId, generation, manifestSchemaVersion: 1,
    ivB64: IV(generation), wrappedManifestDekB64: B64(generation), wrapIvB64: IV(100 + generation), idempotencyKey: key,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const p = await store.markRevisionPublished(userId, revisionId, { storageKey: `vault-tree/${revisionId}.aegisenc`, ciphertextSize: 4112, sha256: 'b'.repeat(64) })
  assert.equal(p.ok, true, JSON.stringify(p))
  return r.revision
}

/**
 * @param {object} o
 * @param {typeof import('node:test').test} o.test
 * @param {typeof import('../../server/db/vaultTreeStore.js')} o.store
 * @param {string} o.userA owner id
 * @param {string} o.userB other owner id
 * @param {() => Promise<void>} o.reset called before every test
 */
export function defineStoreSpec({ test, store, userA, userB, reset }) {
  // ids may be resolved lazily (PG suites learn them in before())
  const A = () => (typeof userA === 'function' ? userA() : userA)
  const B = () => (typeof userB === 'function' ? userB() : userB)
  const before = async () => { await reset() }

  test('ST-1 getTreeState creates FLAT lazily; other user has an independent row', async () => {
    await before()
    const a = await store.getTreeState(A())
    assert.equal(a.protocolState, 'FLAT'); assert.equal(a.headEverCommitted, false); assert.equal(a.purgeBarrierGeneration, 0)
    assert.equal(a.migrationLeaseId, null); assert.equal(a.frozenInventoryId, null)
    const b = await store.getTreeState(B())
    assert.equal(b.protocolState, 'FLAT'); assert.notEqual(a.userId, b.userId)
    assert.equal(await store.peekTreeState('999999'), null, 'peek never creates')
  })

  test('ST-2 head CAS is refused while the owner is FLAT (genesis goes through commitGenesis)', async () => {
    await before()
    await store.getTreeState(A())
    const r = await store.casHead(A(), { expectedGeneration: 0, expectedRevisionId: ID(1), revisionId: ID(2), idempotencyKey: ID(3, 'K') })
    assert.equal(r.ok, false); assert.equal(r.code, 'TREE_STATE_CONFLICT')
    assert.equal(await store.getHead(A()), null)
  })

  test('ST-3 casHead succeeds when expected matches: generation +1, previous SUPERSEDED, new HEAD_COMMITTED', async () => {
    await before()
    const { treeId, rootRevision } = await seedTree(store, A())
    const head0 = await store.getHead(A())
    assert.equal(head0.generation, 1); assert.equal(head0.revisionId, rootRevision)
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(902), key: ID(2, 'K') })
    const r = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K') })
    assert.equal(r.ok, true); assert.equal(r.generation, 2); assert.equal(r.replay, false)
    const head = await store.getHead(A())
    assert.equal(head.generation, 2); assert.equal(head.revisionId, ID(902))
    assert.equal((await store.getRevision(A(), rootRevision)).state, 'SUPERSEDED')
    assert.equal((await store.getRevision(A(), ID(902))).state, 'HEAD_COMMITTED')
    assert.equal((await store.getTreeState(A())).treeMutationCount, 1)
  })

  test('ST-4 stale expectedGeneration → TREE_HEAD_CONFLICT with the current head; candidate ORPHANED; head unchanged', async () => {
    await before()
    const { treeId, rootRevision } = await seedTree(store, A())
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(902), key: ID(2, 'K') })
    assert.equal((await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K') })).ok, true)
    // a stale client still thinks the head is generation 1
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(903), key: ID(3, 'K') })
    const r = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(903), idempotencyKey: ID(3, 'K') })
    assert.equal(r.ok, false); assert.equal(r.code, 'TREE_HEAD_CONFLICT')
    assert.deepEqual(r.current, { generation: 2, revisionId: ID(902) })
    assert.equal((await store.getRevision(A(), ID(903))).state, 'ORPHANED')
    assert.equal((await store.getHead(A())).revisionId, ID(902))
  })

  test('ST-5 idempotency: same key replays the first outcome without a second head change; mismatched key → TREE_IDEMPOTENCY_MISMATCH', async () => {
    await before()
    const { treeId, rootRevision } = await seedTree(store, A())
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(902), key: ID(2, 'K') })
    const first = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K') })
    const again = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K') })
    assert.equal(again.ok, true); assert.equal(again.replay, true); assert.equal(again.generation, first.generation)
    assert.equal((await store.getTreeState(A())).treeMutationCount, 1)
    const wrongKey = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(9, 'K') })
    assert.equal(wrongKey.ok, false); assert.equal(wrongKey.code, 'TREE_IDEMPOTENCY_MISMATCH')
    // createRevision idempotency: same key + same id → replay; same key + other id → mismatch
    const rep = await store.createRevision(A(), { revisionId: ID(902), treeId, baseRevisionId: rootRevision, generation: 2, manifestSchemaVersion: 1, ivB64: 'iv00000000000002', wrappedManifestDekB64: 'x', wrapIvB64: 'iv00000000000102', idempotencyKey: ID(2, 'K') })
    assert.equal(rep.ok, true); assert.equal(rep.replay, true)
    const mis = await store.createRevision(A(), { revisionId: ID(950), treeId, baseRevisionId: rootRevision, generation: 2, manifestSchemaVersion: 1, ivB64: 'iv00000000000002', wrappedManifestDekB64: 'x', wrapIvB64: 'iv00000000000102', idempotencyKey: ID(2, 'K') })
    assert.equal(mis.ok, false); assert.equal(mis.code, 'TREE_IDEMPOTENCY_MISMATCH')
  })

  test('ST-6 attachBlobRefs: UNREFERENCED → TREE_MANAGED; any other state or other owner → TREE_BLOB_STATE_CONFLICT and full rollback', async () => {
    await before()
    const { treeId, rootRevision } = await seedTree(store, A())
    await store.upsertBlobState(A(), { formatVersion: 2, id: 'blobA1' }, 'UNREFERENCED')
    await store.upsertBlobState(A(), { formatVersion: 1, id: '42' }, 'UNREFERENCED')
    await store.upsertBlobState(A(), { formatVersion: 2, id: 'managed' }, 'TREE_MANAGED', { attachedGeneration: 1 })
    await store.upsertBlobState(B(), { formatVersion: 2, id: 'blobB1' }, 'UNREFERENCED')
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(902), key: ID(2, 'K') })
    const bad = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K'), attachBlobRefs: [{ formatVersion: 2, id: 'blobA1' }, { formatVersion: 2, id: 'managed' }] })
    assert.equal(bad.ok, false); assert.equal(bad.code, 'TREE_BLOB_STATE_CONFLICT')
    assert.equal((await store.getHead(A())).generation, 1, 'head unchanged')
    assert.equal((await store.listBlobStates(A())).find((b) => b.id === 'blobA1').lifecycle, 'UNREFERENCED', 'rolled back')
    assert.equal((await store.getRevision(A(), ID(902))).state, 'PUBLISHED', 'candidate still usable')
    const otherOwner = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K'), attachBlobRefs: [{ formatVersion: 2, id: 'blobB1' }] })
    assert.equal(otherOwner.ok, false); assert.equal(otherOwner.code, 'TREE_BLOB_STATE_CONFLICT')
    const ok = await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K'), attachBlobRefs: [{ formatVersion: 2, id: 'blobA1' }, { formatVersion: 1, id: '42' }] })
    assert.equal(ok.ok, true)
    const states = await store.listBlobStates(A())
    assert.equal(states.find((b) => b.id === 'blobA1').lifecycle, 'TREE_MANAGED'); assert.equal(states.find((b) => b.id === 'blobA1').attachedGeneration, 2)
    assert.equal(states.find((b) => b.id === '42' && b.formatVersion === 1).lifecycle, 'TREE_MANAGED')
    assert.equal((await store.listBlobStates(B())).find((b) => b.id === 'blobB1').lifecycle, 'UNREFERENCED')
    assert.equal((await store.listBlobStates(A(), { lifecycle: 'UNREFERENCED' })).length, 0)
  })

  test('ST-7 casKeyEnvelope with the expected cas version; stale → TREE_ENVELOPE_CONFLICT; equal IVs refused', async () => {
    await before()
    await seedTree(store, A())
    const env = await store.getKeyEnvelope(A())
    assert.equal(env.envelopeCasVersion, 1); assert.equal(env.keyEnvelopeVersion, 1); assert.equal(env.ownerScopeIdB64, ID(77))
    const next = envelopeFixture(2)
    const r = await store.casKeyEnvelope(A(), { expectedEnvelopeCasVersion: 1, ...next })
    assert.equal(r.ok, true); assert.equal(r.envelopeCasVersion, 2)
    assert.deepEqual((await store.getKeyEnvelope(A())).primary, next.primary)
    const stale = await store.casKeyEnvelope(A(), { expectedEnvelopeCasVersion: 1, ...envelopeFixture(3) })
    assert.equal(stale.ok, false); assert.equal(stale.code, 'TREE_ENVELOPE_CONFLICT'); assert.equal(stale.current, 2)
    const sameIv = envelopeFixture(4); sameIv.recovery.wrapIvB64 = sameIv.primary.wrapIvB64
    assert.equal((await store.casKeyEnvelope(A(), { expectedEnvelopeCasVersion: 2, ...sameIv })).ok, false)
    assert.equal(await store.getKeyEnvelope(B()), null)
  })

  test('ST-8 getRevision refuses other owners (null) and reports NON_RECOVERABLE', async () => {
    await before()
    const { rootRevision } = await seedTree(store, A())
    assert.equal(await store.getRevision(B(), rootRevision), null)
    const own = await store.getRevision(A(), rootRevision)
    assert.equal(own.state, 'HEAD_COMMITTED'); assert.equal(own.nonRecoverable, false)
    assert.equal(own.storageKey, `vault-tree/${rootRevision}.aegisenc`)
  })

  test('ST-9 owner isolation across the store surface', async () => {
    await before()
    const { treeId, rootRevision } = await seedTree(store, A())
    assert.equal(await store.getHead(B()), null)
    assert.equal(await store.getKeyEnvelope(B()), null)
    assert.equal((await store.getTreeState(B())).protocolState, 'FLAT')
    assert.equal((await store.markRevisionPublished(B(), rootRevision, { storageKey: 'x', ciphertextSize: 1, sha256: 'c'.repeat(64) })).ok, false)
    const r = await store.casHead(B(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: rootRevision, idempotencyKey: ID(1, 'K') })
    assert.equal(r.ok, false); assert.equal(r.code, 'TREE_STATE_CONFLICT')
    assert.deepEqual(await store.listBlobStates(B()), [])
    assert.equal((await store.casKeyEnvelope(B(), { expectedEnvelopeCasVersion: 1, ...envelopeFixture(5) })).ok, false)
    assert.equal((await store.getHead(A())).treeId, treeId)
  })

  test('ST-10 listBlobStates returns only this owner and enforces the lifecycle vocabulary', async () => {
    await before()
    await store.upsertBlobState(A(), { formatVersion: 2, id: 'a' }, 'UNREFERENCED')
    await store.upsertBlobState(B(), { formatVersion: 2, id: 'b' }, 'UNREFERENCED')
    assert.deepEqual((await store.listBlobStates(A())).map((b) => b.id), ['a'])
    await assert.rejects(store.upsertBlobState(A(), { formatVersion: 2, id: 'c' }, 'DELETED'))
    // orphan revision listing/retirement
    const { treeId, rootRevision } = await seedTree(store, A())
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(902), key: ID(2, 'K') })
    await stageRevision(store, A(), { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(903), key: ID(3, 'K') })
    assert.equal((await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K') })).ok, true)
    assert.equal((await store.casHead(A(), { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(903), idempotencyKey: ID(3, 'K') })).code, 'TREE_HEAD_CONFLICT')
    assert.deepEqual((await store.listOrphanRevisions({ olderThanMs: 60_000 })).map((r) => r.revisionId), [], 'too young')
    const old = await store.listOrphanRevisions({ olderThanMs: 0, now: Date.now() + 10 })
    assert.deepEqual(old.map((r) => r.revisionId), [ID(903)])
    const retired = await store.retireRevision(ID(903))
    assert.equal(retired.ok, true); assert.equal(retired.storageKey, `vault-tree/${ID(903)}.aegisenc`)
    assert.equal(await store.getRevision(A(), ID(903)), null)
    assert.equal((await store.retireRevision(ID(902))).ok, false, 'committed revisions are never retired here')
  })
}
