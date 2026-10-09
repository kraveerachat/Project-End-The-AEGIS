// tests/helpers/previewIndexStoreSpec.mjs — D-1 PR-A · one preview-index store spec, run in memory mode AND on PostgreSQL 15
//
// ⚠️ Rows and meanings must be identical in both modes — this file is that definition
//    (tests/previewIndexStore.test.js runs it in memory and, when TEST_DATABASE_URL is set, on PostgreSQL).
// ⚠️ Every test uses fresh owners from `newOwner()`: generation rows are undeletable by design
//    (migration 012 triggers), so PostgreSQL state is isolated by owner, not by DELETE.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const hex48 = () => randomBytes(24).toString('hex')
const b64 = (n) => randomBytes(n).toString('base64')
export const TREE_ID = 'T'.padStart(22, 'P')

/**
 * Commit one V2 blob for `userId` through the real V2 store and set its tree lifecycle in the same commit.
 * @returns {Promise<{ id: string, size: number, contentIdB64: string }>}
 */
export async function seedV2Blob({ v2, tree }, userId, { lifecycle, size = 4_112 + 16 }) {
  const id = hex48()
  const contentIdB64 = b64(16)
  await v2.finishVaultV2Commit({
    uploadId: `seed-${id}`, userId, blobId: id, storageKey: `vault/v2/seed-${id}.aegisenc`,
    ciphertextSize: size, chunkSize: 8 * 1024 * 1024 + 16, chunkCount: 1, contentIdB64,
    envelope: { wrappedDekB64: b64(48), wrapIvB64: b64(12), metaIvB64: b64(12), metaB64: b64(40) },
    chunks: [{ index: 0, size, sha256: 'c'.repeat(64), ivB64: b64(12) }],
    withinCommit: lifecycle ? (client) => tree.upsertBlobState(userId, { formatVersion: 2, id }, lifecycle, { client }) : null,
  })
  return { id, size, contentIdB64 }
}

/**
 * @param {object} o
 * @param {typeof import('node:test').test} o.test
 * @param {typeof import('../../server/db/vaultPreviewIndexStore.js')} o.store
 * @param {typeof import('../../server/db/vaultTreeStore.js')} o.tree
 * @param {typeof import('../../server/db/vaultV2Store.js')} o.v2
 * @param {() => Promise<string>} o.newOwner fresh owner id per call
 * @param {object} [o.skip]
 */
export function definePreviewIndexStoreSpec({ test, store, tree, v2, newOwner, skip = false }) {
  const deps = { v2, tree }

  test('PI-ST-1 lifecycle constants: original four first and unchanged, plus INDEX_STAGED/INDEX_MANAGED', { skip }, async () => {
    assert.deepEqual(tree.BLOB_LIFECYCLES, ['UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED', 'INDEX_STAGED', 'INDEX_MANAGED'])
    assert.deepEqual(tree.RECOVERABLE_BLOB_LIFECYCLES, ['UNREFERENCED'])
    assert.deepEqual(tree.PREVIEW_INDEX_LIFECYCLES, ['INDEX_STAGED', 'INDEX_MANAGED'])
    const a = await newOwner()
    const row = await tree.upsertBlobState(a, { formatVersion: 2, id: hex48() }, 'INDEX_STAGED')
    assert.equal(row.lifecycle, 'INDEX_STAGED')
    await assert.rejects(tree.upsertBlobState(a, { formatVersion: 2, id: hex48() }, 'BOGUS'), /bad lifecycle/)
  })

  test('PI-ST-2 getIndexHead: null for a fresh owner; seeded head round-trips; never another owner\'s head', { skip }, async () => {
    const a = await newOwner(), b = await newOwner()
    assert.equal(await store.getIndexHead(a), null)
    const root = await seedV2Blob(deps, a, { lifecycle: 'INDEX_MANAGED' })
    await store.__seedIndexHeadForTests(a, { treeId: TREE_ID, indexGeneration: 1, rootBlobId: root.id, rootContentIdB64: 'AAECAwQFBgcICQoLDA0ODw==' })
    const h = await store.getIndexHead(a)
    assert.deepEqual({ ...h, updatedAt: typeof h.updatedAt }, { treeId: TREE_ID, indexGeneration: 1, rootBlobId: root.id, rootContentIdB64: 'AAECAwQFBgcICQoLDA0ODw==', updatedAt: 'number' })
    assert.equal(await store.getIndexHead(b), null, 'another owner never sees A\'s head')
    await assert.rejects(store.getIndexHead(null), /userId/)
  })

  test('PI-ST-3 listIndexEnvelopes returns only the caller\'s INDEX_* blobs; user blobs and other owners\' ids are silently absent', { skip }, async () => {
    const a = await newOwner(), b = await newOwner()
    const staged = await seedV2Blob(deps, a, { lifecycle: 'INDEX_STAGED' })
    const managed = await seedV2Blob(deps, a, { lifecycle: 'INDEX_MANAGED' })
    const userFile = await seedV2Blob(deps, a, { lifecycle: 'UNREFERENCED' })
    const treeFile = await seedV2Blob(deps, a, { lifecycle: 'TREE_MANAGED' })
    const noRow = await seedV2Blob(deps, a, { lifecycle: null })
    const foreign = await seedV2Blob(deps, b, { lifecycle: 'INDEX_MANAGED' })
    const got = await store.listIndexEnvelopes(a, [staged.id, managed.id, userFile.id, treeFile.id, noRow.id, foreign.id, hex48()])
    assert.deepEqual(got.map((x) => x.id).sort(), [staged.id, managed.id].sort())
    for (const e of got) {
      assert.deepEqual(Object.keys(e).sort(), ['chunkCount', 'chunkSize', 'contentIdB64', 'createdAt', 'formatVersion', 'id', 'metaB64', 'metaIvB64', 'size', 'wrapIvB64', 'wrappedDekB64'])
      assert.equal(e.formatVersion, 2)
      assert.equal('storageKey' in e, false)
    }
    assert.deepEqual(await store.listIndexEnvelopes(a, []), [])
    assert.deepEqual(await store.listIndexEnvelopes(b, [staged.id, managed.id]), [])
  })

  test('PI-ST-4 listIndexBlobs paginates the caller\'s INDEX_* blobs by id; excludeIndexBlobIds is exactly that set', { skip }, async () => {
    const a = await newOwner(), b = await newOwner()
    const mine = []
    for (let i = 0; i < 5; i++) mine.push((await seedV2Blob(deps, a, { lifecycle: i % 2 ? 'INDEX_STAGED' : 'INDEX_MANAGED' })).id)
    await seedV2Blob(deps, a, { lifecycle: 'UNREFERENCED' })
    await seedV2Blob(deps, b, { lifecycle: 'INDEX_MANAGED' })
    const seen = []
    let after = null, pages = 0
    do {
      const page = await store.listIndexBlobs(a, { after, limit: 2 })
      assert.ok(page.blobs.length <= 2)
      for (const x of page.blobs) {
        assert.deepEqual(Object.keys(x).sort(), ['createdAt', 'id', 'lifecycle'])
        assert.ok(['INDEX_STAGED', 'INDEX_MANAGED'].includes(x.lifecycle))
      }
      seen.push(...page.blobs.map((x) => x.id))
      after = page.next; pages++
    } while (after && pages < 10)
    assert.deepEqual(seen, [...mine].sort(), 'stable id order, no duplicates, nothing missing')
    assert.equal(pages, 3)
    await assert.rejects(store.listIndexBlobs(a, { after: null, limit: 501 }), /limit/)
    await assert.rejects(store.listIndexBlobs(a, { after: null, limit: 0 }), /limit/)
    assert.deepEqual([...(await store.excludeIndexBlobIds(a))].sort(), [...mine].sort())
    assert.equal((await store.excludeIndexBlobIds(await newOwner())).size, 0)
  })

  test('PI-ST-5 getRetainedIndexBytes sums INDEX_STAGED + INDEX_MANAGED ciphertext only, per owner', { skip }, async () => {
    const a = await newOwner(), b = await newOwner()
    assert.equal(await store.getRetainedIndexBytes(a), 0)
    const s1 = await seedV2Blob(deps, a, { lifecycle: 'INDEX_STAGED', size: 1_000 })
    const m1 = await seedV2Blob(deps, a, { lifecycle: 'INDEX_MANAGED', size: 20_000 })
    await seedV2Blob(deps, a, { lifecycle: 'UNREFERENCED', size: 300_000 })
    await seedV2Blob(deps, a, { lifecycle: 'TREE_MANAGED', size: 4_000_000 })
    await seedV2Blob(deps, a, { lifecycle: 'PURGE_PENDING', size: 50_000 })
    await seedV2Blob(deps, a, { lifecycle: null, size: 7_000 })
    await seedV2Blob(deps, b, { lifecycle: 'INDEX_MANAGED', size: 900_000 })
    const total = await store.getRetainedIndexBytes(a)
    assert.equal(total, s1.size + m1.size)
    assert.equal(typeof total, 'number')
    assert.equal(await store.getRetainedIndexBytes(b), 900_000)
    await assert.rejects(store.getRetainedIndexBytes(undefined), /userId/)
  })
}
