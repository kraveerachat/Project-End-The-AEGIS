// tests/previewIndexStorageBudgetPostgres.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Task C.7 · budget under real concurrency
//
// ⚠️ PostgreSQL only: the authoritative budget check runs inside the commit transaction under the owner's
//    vault_tree_state FOR UPDATE lock, and only a real database can prove that parallel commits serialize there.
//    Without TEST_DATABASE_URL every test is skipped with an explicit reason — an evidence run must show 0 skips.
// ⚠️ statement_timeout / lock_timeout = 5 s (set by the harness): a deadlock fails instead of hanging.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const skip = process.env.TEST_DATABASE_URL ? false : 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'
if (!skip) process.env.PI_UPLOAD_PG = '1'
const H = await import('./helpers/previewIndexUploadHarness.mjs')
const { seedV2Blob } = await import('./helpers/previewIndexStoreSpec.mjs')
const { casRequest } = await import('./helpers/previewIndexCasSpec.mjs')
const { tree, v2, pindex, cfg, MiB, GCM_TAG_BYTES } = H
const S = 1024 + GCM_TAG_BYTES
const deps = { tree, v2 }

before(async () => {
  if (skip) return
  assert.equal(H.connection.usingPostgres, true)
  await H.setup({ write: cfg.write(MiB) })
})
after(async () => { if (!skip) await H.teardown() })
beforeEach(async () => { if (!skip) await H.reset() })

async function ownerAt(bytes, userId) {
  await H.treeOwner(userId)
  await seedV2Blob(deps, userId, { lifecycle: 'INDEX_MANAGED', size: bytes })
  assert.equal(await pindex.getRetainedIndexBytes(userId), bytes)
}
/** n sessions opened (create passes: the advisory check sees the same retained bytes for all), each with its chunk */
async function openSessions(c, kek, n) {
  const ids = []
  for (let i = 0; i < n; i++) ids.push(await H.staged(c, kek))
  return ids
}

test('PIB-PG-1 owner at max − S, 10 parallel commits of size S → exactly 1 success, 9 × 507, retained ≤ max', { skip }, async () => {
  for (let round = 0; round < 3; round++) {
    await H.reset()
    const c = await H.login('write'); const kek = await H.setupVault(c)
    await ownerAt(MiB - S, H.ownerId)
    const ids = await openSessions(c, kek, 10)
    const results = await Promise.all(ids.map((id) => H.commit(c, id)))
    const statuses = results.map((r) => r.status).sort()
    assert.deepEqual(statuses, [201, ...Array(9).fill(507)], JSON.stringify(results.map((r) => [r.status, r.data?.code])))
    for (const r of results.filter((x) => x.status === 507)) assert.equal(r.data.code, 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED')
    const retained = await pindex.getRetainedIndexBytes(H.ownerId)
    assert.equal(retained, MiB)
    assert.ok(retained <= MiB)
    const staged = (await tree.listBlobStates(H.ownerId)).filter((s) => s.lifecycle === 'INDEX_STAGED')
    assert.equal(staged.length, 1, 'exactly one blob committed')
    assert.equal((await v2.listVaultV2Blobs(H.ownerId)).length, 2, 'seed + the single winner; losers left no row')
  }
})

test('PIB-PG-2 two owners committing in parallel each respect only their own budget', { skip }, async () => {
  const a = await H.login('write'); const kekA = await H.setupVault(a)
  const b = await H.login('write', H.DEMO_ADMIN); const kekB = await H.setupVault(b)
  await ownerAt(MiB - S, H.ownerId)
  await ownerAt(MiB - 2 * S, H.otherId)
  const [idsA, idsB] = [await openSessions(a, kekA, 5), await openSessions(b, kekB, 5)]
  const results = await Promise.all([...idsA.map((id) => H.commit(a, id).then((r) => ['A', r.status])), ...idsB.map((id) => H.commit(b, id).then((r) => ['B', r.status]))])
  const okA = results.filter(([o, s]) => o === 'A' && s === 201).length
  const okB = results.filter(([o, s]) => o === 'B' && s === 201).length
  assert.equal(okA, 1, JSON.stringify(results))
  assert.equal(okB, 2, JSON.stringify(results))
  assert.ok(results.every(([, s]) => s === 201 || s === 507))
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), MiB)
  assert.equal(await pindex.getRetainedIndexBytes(H.otherId), MiB)
})

test('PIB-PG-3 parallel index CAS and preview-index commits for one owner do not deadlock (5 s timeouts)', { skip }, async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await ownerAt(4096, H.ownerId)
  const roots = []
  for (let i = 0; i < 4; i++) roots.push(await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' }))
  const ids = await openSessions(c, kek, 6)
  const casChain = (async () => {
    let gen = 0, prev = null
    for (const root of roots) {
      const r = await pindex.casIndexHead(H.ownerId, casRequest({ root, expectedGeneration: gen, expectedRootBlobId: prev }))
      assert.equal(r.ok, true, JSON.stringify(r)); gen = r.indexGeneration; prev = root.id
    }
    return gen
  })()
  const [gen, ...commits] = await Promise.all([casChain, ...ids.map((id) => H.commit(c, id))])
  assert.equal(gen, 4)
  assert.ok(commits.every((r) => r.status === 201), JSON.stringify(commits.map((r) => [r.status, r.data?.code])))
  assert.equal((await pindex.getIndexHead(H.ownerId)).indexGeneration, 4)
})
