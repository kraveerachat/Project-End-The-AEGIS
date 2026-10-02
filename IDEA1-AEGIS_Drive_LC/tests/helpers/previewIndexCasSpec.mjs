// tests/helpers/previewIndexCasSpec.mjs — D-1 PR-C Task C.1 · one preview-index CAS spec, run in memory mode AND on PostgreSQL 15
//
// ⚠️ Rows and meanings must be identical in both modes. Concurrency evidence comes only from PostgreSQL
//    (tests/previewIndexCasPostgres.test.js); this spec pins the sequential contract.
// ⚠️ Every test uses fresh owners: generation rows are undeletable by design (migration 012 triggers).
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { seedV2Blob, TREE_ID } from './previewIndexStoreSpec.mjs'

const hex48 = () => randomBytes(24).toString('hex')
const b64 = (n) => randomBytes(n).toString('base64')
const opaque22 = () => randomBytes(16).toString('base64url')
export const digestOf = (s) => createHash('sha256').update(String(s)).digest('hex')

/** put `userId` in TREE_V1 with a committed main head (generation 1) — the precondition of every index CAS */
export async function seedTreeOwner({ tree }, userId, { treeId = TREE_ID } = {}) {
  const revisionId = opaque22()
  const created = await tree.createRevision(userId, {
    revisionId, treeId, baseRevisionId: null, generation: 1, manifestSchemaVersion: 1,
    ivB64: b64(12), wrappedManifestDekB64: b64(48), wrapIvB64: b64(12), idempotencyKey: opaque22(),
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal((await tree.markRevisionPublished(userId, revisionId, { storageKey: `vault-tree/${revisionId}.aegisenc`, ciphertextSize: 4112, sha256: 'a'.repeat(64) })).ok, true)
  const seeded = await tree.__seedTreeV1ForTests(userId, {
    treeId, ownerScopeIdB64: b64(16), revisionId,
    keyEnvelope: { primary: { wrappedTrkB64: b64(48), wrapIvB64: b64(12) }, recovery: { wrappedTrkB64: b64(48), wrapIvB64: b64(12) } },
  })
  assert.equal(seeded.ok, true, JSON.stringify(seeded))
  return { treeId, revisionId }
}

/** a well-formed store CAS request; `over` replaces any field. The digest is derived from the body unless `tag` is given. */
export function casRequest({ expectedGeneration = 0, expectedRootBlobId = null, root, attach = null, superseded = [], key = opaque22(), tag = null, ...over }) {
  const attachBlobIds = attach ?? [root.id]
  return {
    expectedGeneration, expectedRootBlobId, rootBlobId: root.id, rootContentIdB64: root.contentIdB64,
    attachBlobIds, supersededBlobIds: superseded, idempotencyKey: key,
    requestDigest: digestOf(tag ?? JSON.stringify([expectedGeneration, expectedRootBlobId, root.id, root.contentIdB64, attachBlobIds, superseded])),
    ...over,
  }
}

const refOrder = (x, y) => (x.blobId < y.blobId ? -1 : x.blobId > y.blobId ? 1 : x.role < y.role ? -1 : x.role > y.role ? 1 : 0)

/**
 * @param {object} o
 * @param {typeof import('node:test').test} o.test
 * @param {typeof import('../../server/db/vaultPreviewIndexStore.js')} o.store
 * @param {typeof import('../../server/db/vaultTreeStore.js')} o.tree
 * @param {typeof import('../../server/db/vaultV2Store.js')} o.v2
 * @param {() => Promise<string>} o.newOwner fresh owner id per call
 * @param {object|false} [o.skip]
 * @param {(userId: string) => Promise<number>} [o.countPurgeCandidates] PostgreSQL only: rows in vault_tree_purge_candidates
 */
export function definePreviewIndexCasSpec({ test, store, tree, v2, newOwner, skip = false, countPurgeCandidates = null }) {
  const deps = { v2, tree }
  const C = () => store.INDEX_STORE_CODE
  const lifecycleOf = async (u, id) => (await tree.listBlobStates(u)).find((s) => s.formatVersion === 2 && s.id === id)?.lifecycle ?? null
  const ready = async () => { const u = await newOwner(); await seedTreeOwner(deps, u); return u }
  const staged = (u) => seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })

  test('PI-CAS-1 first creation (0/null): head, generation row, ATTACHED refs, INDEX_STAGED → INDEX_MANAGED', { skip }, async () => {
    const a = await ready()
    const root = await staged(a), shard = await staged(a), deriv = await staged(a)
    const r = await store.casIndexHead(a, casRequest({ root, attach: [root.id, shard.id, deriv.id] }))
    assert.deepEqual(r, { ok: true, replay: false, indexGeneration: 1, rootBlobId: root.id })
    const head = await store.getIndexHead(a)
    assert.deepEqual({ ...head, updatedAt: typeof head.updatedAt }, { treeId: TREE_ID, indexGeneration: 1, rootBlobId: root.id, rootContentIdB64: root.contentIdB64, updatedAt: 'number' })
    for (const b of [root, shard, deriv]) assert.equal(await lifecycleOf(a, b.id), 'INDEX_MANAGED')
    const gens = await store.listIndexGenerations(a)
    assert.equal(gens.length, 1)
    assert.deepEqual({ ...gens[0], committedAt: typeof gens[0].committedAt }, { indexGeneration: 1, baseGeneration: 0, treeId: TREE_ID, rootBlobId: root.id, supersededAt: null, committedAt: 'number' })
    assert.deepEqual(await store.listIndexBlobRefs(a, 1), [root.id, shard.id, deriv.id].map((id) => ({ blobId: id, role: 'ATTACHED' })).sort(refOrder))
  })

  test('PI-CAS-2 TREE_V1 and an existing main head are required (else TREE_STATE_CONFLICT, nothing written)', { skip }, async () => {
    const flat = await newOwner()
    const root = await staged(flat)
    assert.deepEqual(await store.casIndexHead(flat, casRequest({ root })), { ok: false, code: C().TREE_STATE_CONFLICT })
    const noHead = await newOwner()
    await tree.__setProtocolStateForTests(noHead, 'TREE_V1')
    const root2 = await staged(noHead)
    assert.deepEqual(await store.casIndexHead(noHead, casRequest({ root: root2 })), { ok: false, code: C().TREE_STATE_CONFLICT })
    assert.equal(await store.getIndexHead(flat), null)
    assert.equal(await store.getIndexHead(noHead), null)
    assert.equal(await lifecycleOf(flat, root.id), 'INDEX_STAGED')
    assert.equal(await lifecycleOf(noHead, root2.id), 'INDEX_STAGED')
  })

  test('PI-CAS-3 stale expectation → PREVIEW_INDEX_CONFLICT carrying only the current generation/root; nothing changes', { skip }, async () => {
    const a = await ready()
    const r1 = await staged(a)
    assert.equal((await store.casIndexHead(a, casRequest({ root: r1 }))).ok, true)
    const r2 = await staged(a)
    assert.deepEqual(await store.casIndexHead(a, casRequest({ root: r2 })), { ok: false, code: C().PREVIEW_INDEX_CONFLICT, current: { indexGeneration: 1, rootBlobId: r1.id } })
    assert.equal((await store.casIndexHead(a, casRequest({ root: r2, expectedGeneration: 1, expectedRootBlobId: r2.id }))).code, C().PREVIEW_INDEX_CONFLICT)
    assert.equal((await store.casIndexHead(a, casRequest({ root: r2, expectedGeneration: 2, expectedRootBlobId: r1.id }))).code, C().PREVIEW_INDEX_CONFLICT)
    const fresh = await ready()
    const f1 = await staged(fresh)
    assert.deepEqual(await store.casIndexHead(fresh, casRequest({ root: f1, expectedGeneration: 1, expectedRootBlobId: f1.id })), { ok: false, code: C().PREVIEW_INDEX_CONFLICT, current: null }, 'no head yet: only 0/null matches')
    assert.equal(await lifecycleOf(a, r2.id), 'INDEX_STAGED')
    assert.equal(await lifecycleOf(fresh, f1.id), 'INDEX_STAGED')
    assert.equal((await store.getIndexHead(a)).indexGeneration, 1)
    assert.equal((await store.listIndexGenerations(a)).length, 1)
  })

  test('PI-CAS-4 superseded ids are ADVISORY ONLY: SUPERSEDED rows only — lifecycle stays INDEX_MANAGED, bytes still counted, no purge', { skip }, async () => {
    const a = await ready()
    const r1 = await staged(a), s1 = await staged(a)
    assert.equal((await store.casIndexHead(a, casRequest({ root: r1, attach: [r1.id, s1.id] }))).ok, true)
    const purgeBefore = countPurgeCandidates ? await countPurgeCandidates(a) : 0
    const r2 = await staged(a), s2 = await staged(a)
    const bytes = await store.getRetainedIndexBytes(a)
    assert.equal(bytes, r1.size + s1.size + r2.size + s2.size)
    const res = await store.casIndexHead(a, casRequest({ root: r2, attach: [r2.id, s2.id], superseded: [r1.id, s1.id], expectedGeneration: 1, expectedRootBlobId: r1.id }))
    assert.deepEqual(res, { ok: true, replay: false, indexGeneration: 2, rootBlobId: r2.id })
    for (const b of [r1, s1, r2, s2]) assert.equal(await lifecycleOf(a, b.id), 'INDEX_MANAGED')
    assert.equal(await store.getRetainedIndexBytes(a), bytes, 'a superseded blob still exists, so it is still counted')
    assert.deepEqual((await store.listIndexEnvelopes(a, [r1.id, s1.id])).map((e) => e.id).sort(), [r1.id, s1.id].sort(), 'V2 rows still present')
    if (countPurgeCandidates) assert.equal(await countPurgeCandidates(a), purgeBefore)
    assert.deepEqual(await store.listIndexBlobRefs(a, 2), [
      ...[r2.id, s2.id].map((id) => ({ blobId: id, role: 'ATTACHED' })), ...[r1.id, s1.id].map((id) => ({ blobId: id, role: 'SUPERSEDED' })),
    ].sort(refOrder))
    const gens = await store.listIndexGenerations(a)
    assert.deepEqual(gens.map((g) => [g.indexGeneration, g.baseGeneration, g.supersededAt === null]), [[1, 0, false], [2, 1, true]])
  })

  test('PI-CAS-5 idempotent replay returns the same result and changes nothing; same key + different body → mismatch', { skip }, async () => {
    const a = await ready()
    const root = await staged(a)
    const req = casRequest({ root })
    const first = await store.casIndexHead(a, req)
    assert.equal(first.ok, true)
    assert.deepEqual(await store.casIndexHead(a, req), { ...first, replay: true })
    assert.equal((await store.listIndexGenerations(a)).length, 1)
    const other = await staged(a)
    assert.deepEqual(await store.casIndexHead(a, casRequest({ root: other, key: req.idempotencyKey, expectedGeneration: 1, expectedRootBlobId: root.id })), { ok: false, code: C().PREVIEW_INDEX_IDEMPOTENCY_MISMATCH })
    assert.equal(await lifecycleOf(a, other.id), 'INDEX_STAGED')
    // replay is answered even after the head moved on (the lost-response client still learns its own result)
    assert.equal((await store.casIndexHead(a, casRequest({ root: other, expectedGeneration: 1, expectedRootBlobId: root.id }))).ok, true)
    assert.deepEqual(await store.casIndexHead(a, req), { ...first, replay: true })
    const b = await ready()
    const rootB = await staged(b)
    assert.equal((await store.casIndexHead(b, casRequest({ root: rootB, key: req.idempotencyKey }))).ok, true, 'idempotency keys are per owner')
  })

  test('PI-CAS-6 attach must be the caller\'s INDEX_STAGED V2 blobs; anything else → PREVIEW_INDEX_BLOB_STATE_CONFLICT with full rollback', { skip }, async () => {
    const a = await ready(), b = await ready()
    const managed = await staged(a)
    assert.equal((await store.casIndexHead(a, casRequest({ root: managed }))).ok, true)
    const root = await staged(a)
    const bad = {
      userUnreferenced: await seedV2Blob(deps, a, { lifecycle: 'UNREFERENCED' }),
      userTree: await seedV2Blob(deps, a, { lifecycle: 'TREE_MANAGED' }),
      noLifecycle: await seedV2Blob(deps, a, { lifecycle: null }),
      foreignStaged: await staged(b),
      unknown: { id: hex48() },
      alreadyManaged: managed,
    }
    for (const [label, x] of Object.entries(bad)) {
      const r = await store.casIndexHead(a, casRequest({ root, attach: [root.id, x.id], expectedGeneration: 1, expectedRootBlobId: managed.id }))
      assert.deepEqual(r, { ok: false, code: C().PREVIEW_INDEX_BLOB_STATE_CONFLICT }, label)
      assert.equal(await lifecycleOf(a, root.id), 'INDEX_STAGED', `${label}: valid attach not promoted`)
    }
    assert.equal(await lifecycleOf(b, bad.foreignStaged.id), 'INDEX_STAGED')
    assert.equal(await lifecycleOf(a, bad.userUnreferenced.id), 'UNREFERENCED')
    assert.equal(await lifecycleOf(a, bad.userTree.id), 'TREE_MANAGED')
    assert.equal((await store.getIndexHead(a)).indexGeneration, 1)
    assert.equal((await store.listIndexGenerations(a)).length, 1)
  })

  test('PI-CAS-7 root content id must match the committed root blob; root must be attached; attach ∩ superseded = ∅', { skip }, async () => {
    const a = await ready()
    const root = await staged(a), other = await staged(a)
    assert.deepEqual(await store.casIndexHead(a, casRequest({ root: { ...root, contentIdB64: other.contentIdB64 } })), { ok: false, code: C().PREVIEW_INDEX_ROOT_MISMATCH })
    assert.deepEqual(await store.casIndexHead(a, casRequest({ root, attach: [other.id] })), { ok: false, code: C().PREVIEW_INDEX_BLOB_STATE_CONFLICT })
    assert.equal(await store.getIndexHead(a), null)
    assert.equal(await lifecycleOf(a, root.id), 'INDEX_STAGED')
    assert.equal(await lifecycleOf(a, other.id), 'INDEX_STAGED')
    const g1 = await staged(a)
    assert.equal((await store.casIndexHead(a, casRequest({ root: g1 }))).ok, true)
    assert.deepEqual(await store.casIndexHead(a, casRequest({ root, superseded: [root.id], expectedGeneration: 1, expectedRootBlobId: g1.id })), { ok: false, code: C().PREVIEW_INDEX_BLOB_STATE_CONFLICT })
  })

  test('PI-CAS-8 superseded ids must be the caller\'s INDEX_MANAGED blobs (staged, user, foreign, unknown → conflict)', { skip }, async () => {
    const a = await ready(), b = await ready()
    const g1 = await staged(a)
    assert.equal((await store.casIndexHead(a, casRequest({ root: g1 }))).ok, true)
    const fb = await staged(b)
    assert.equal((await store.casIndexHead(b, casRequest({ root: fb }))).ok, true)
    const candidates = { stagedOwn: await staged(a), userFile: await seedV2Blob(deps, a, { lifecycle: 'TREE_MANAGED' }), foreignManaged: fb, unknown: { id: hex48() } }
    for (const [label, x] of Object.entries(candidates)) {
      const root = await staged(a)
      assert.deepEqual(await store.casIndexHead(a, casRequest({ root, superseded: [x.id], expectedGeneration: 1, expectedRootBlobId: g1.id })), { ok: false, code: C().PREVIEW_INDEX_BLOB_STATE_CONFLICT }, label)
      assert.equal(await lifecycleOf(a, root.id), 'INDEX_STAGED', label)
    }
    assert.equal((await store.getIndexHead(a)).indexGeneration, 1)
  })

  test('PI-CAS-9 an index head bound to another treeId → PREVIEW_INDEX_TREE_MISMATCH; nothing promoted', { skip }, async () => {
    const a = await ready()
    const old = await seedV2Blob(deps, a, { lifecycle: 'INDEX_MANAGED' })
    await store.__seedIndexHeadForTests(a, { treeId: 'Z'.repeat(22), indexGeneration: 1, rootBlobId: old.id, rootContentIdB64: old.contentIdB64 })
    const root = await staged(a)
    assert.deepEqual(await store.casIndexHead(a, casRequest({ root, expectedGeneration: 1, expectedRootBlobId: old.id })), { ok: false, code: C().PREVIEW_INDEX_TREE_MISMATCH })
    assert.equal(await lifecycleOf(a, root.id), 'INDEX_STAGED')
  })

  test('PI-CAS-10 malformed store input is refused before any write; userId required', { skip }, async () => {
    const a = await ready()
    const root = await staged(a)
    await assert.rejects(store.casIndexHead(null, casRequest({ root })), /userId/)
    const bads = [
      { requestDigest: 'x' }, { idempotencyKey: '' }, { expectedGeneration: -1 }, { expectedGeneration: 1.5, expectedRootBlobId: root.id },
      { expectedRootBlobId: root.id }, { expectedGeneration: 1, expectedRootBlobId: null }, { attachBlobIds: [] },
      { attachBlobIds: [root.id, root.id] }, { supersededBlobIds: 'nope' }, { supersededBlobIds: [hex48(), 'x'] }, { rootContentIdB64: 'short' },
    ]
    for (const over of bads) {
      const r = await store.casIndexHead(a, casRequest({ root, ...over }))
      assert.deepEqual(r, { ok: false, code: C().INVALID_INPUT }, JSON.stringify(over))
    }
    assert.equal(await store.getIndexHead(a), null)
    assert.equal(await lifecycleOf(a, root.id), 'INDEX_STAGED')
  })
}
