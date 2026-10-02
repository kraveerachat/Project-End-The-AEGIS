// tests/previewIndexStorageBudget.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Task C.7 · server-enforced per-owner preview-index budget
//
// Counted: committed ciphertext of the owner's INDEX_STAGED + INDEX_MANAGED V2 blobs (root, shard, derivative — including
// lost-CAS and superseded ones). Never counted: user files (UNREFERENCED / TREE_MANAGED), V1 blobs, uncommitted sessions.
// Enforced twice, server-side only: an advisory check at create (declared size) and the authoritative check inside the
// commit transaction under the owner's vault_tree_state FOR UPDATE lock. Boundary: retained + new ≤ max → allowed;
// > max → 507 PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED. A full budget stops ONLY new preview persistence; nothing is deleted.
// ⚠️ Memory mode by default; `PI_UPLOAD_PG=1` + scripts/pg-integration-env.sh runs the same file on PostgreSQL 15.
// ⚠️ Budget values here are test values only (PROVISIONAL / TO_BE_MEASURED in production; approved at HG-G).
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as H from './helpers/previewIndexUploadHarness.mjs'
import { seedV2Blob } from './helpers/previewIndexStoreSpec.mjs'

const { PI_UP, TREE_UP, tree, v2, pindex, cfg, MiB, GCM_TAG_BYTES } = H
const S = 1024 + GCM_TAG_BYTES // ciphertext size of one test upload (1 KiB plaintext, one chunk)
const deps = { tree, v2 }

before(() => H.setup({ write: cfg.write(MiB), write2: cfg.write(2 * MiB), read: cfg.read() }))
after(() => H.teardown())
beforeEach(async () => { await H.reset(); H.setServerConfig('write2', cfg.write(2 * MiB)) })

/** owner in TREE_V1 whose retained preview-index bytes are exactly `bytes` (one seeded INDEX_MANAGED blob) */
async function ownerWithRetained(bytes, userId = H.ownerId) {
  await H.treeOwner(userId)
  if (bytes > 0) await seedV2Blob(deps, userId, { lifecycle: 'INDEX_MANAGED', size: bytes })
  assert.equal(await pindex.getRetainedIndexBytes(userId), bytes)
}
const budgetCode = (r) => [r.status, r.data?.code]
const EXCEEDED = [507, 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED']

test('PIB-1 below budget: commit succeeds as INDEX_STAGED and retained bytes grow by exactly the ciphertext size', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await ownerWithRetained(0)
  const r = await H.uploadOne(c, kek)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.blob.lifecycle, 'INDEX_STAGED')
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), S)
})

test('PIB-2 boundary: retained + new == max succeeds; the next byte over is 507 at create (declared size), with { error, code } only', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await ownerWithRetained(MiB - S)
  const atMax = await H.uploadOne(c, kek)
  assert.equal(atMax.status, 201, 'retained + new == max is allowed')
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), MiB)
  const over = await H.open(c, kek)
  assert.deepEqual(budgetCode(over), EXCEEDED)
  assert.deepEqual(Object.keys(over.data).sort(), ['code', 'error'], 'no byte counts echoed')
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), MiB)
})

test('PIB-3 authoritative commit check: growth after create, or a lowered budget, → 507 at commit; no blob row, no lifecycle row, staged bytes discarded', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await ownerWithRetained(MiB - S)
  const id = await H.staged(c, kek) // create passed: MiB - S + S == MiB
  await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED', size: 1 }) // another preview object landed meanwhile → MiB - S + 1
  const blobsBefore = (await v2.listVaultV2Blobs(H.ownerId)).map((b) => b.id).sort()
  const statesBefore = (await tree.listBlobStates(H.ownerId)).map((s) => `${s.id}:${s.lifecycle}`).sort()
  const r = await H.commit(c, id)
  assert.deepEqual(budgetCode(r), EXCEEDED)
  assert.deepEqual((await v2.listVaultV2Blobs(H.ownerId)).map((b) => b.id).sort(), blobsBefore, 'no blob row')
  assert.deepEqual((await tree.listBlobStates(H.ownerId)).map((s) => `${s.id}:${s.lifecycle}`).sort(), statesBefore, 'no lifecycle row; nothing else changed')
  const st = await H.status(c, id)
  assert.equal(st.data.upload.status, 'aborted', 'the uncommitted session is discarded')
  assert.equal((await H.commit(c, id)).status, 409, 'and cannot be committed later')

  // lowered budget between create and commit (config swap on a running server)
  const c2 = await H.login('write2')
  const id2 = await H.staged(c2, kek) // create under 2 MiB
  H.setServerConfig('write2', cfg.write(MiB))
  assert.deepEqual(budgetCode(await H.commit(c2, id2)), EXCEEDED)
})

test('PIB-4 per-owner scope: an owner at budget does not affect another owner, and vice versa', async () => {
  const a = await H.login('write'); const kekA = await H.setupVault(a)
  const b = await H.login('write', H.DEMO_ADMIN); const kekB = await H.setupVault(b)
  await ownerWithRetained(MiB, H.ownerId)
  await ownerWithRetained(0, H.otherId)
  assert.deepEqual(budgetCode(await H.open(a, kekA)), EXCEEDED)
  assert.equal((await H.uploadOne(b, kekB)).status, 201)
  assert.equal(await pindex.getRetainedIndexBytes(H.otherId), S)
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), MiB)
})

test('PIB-5 a full budget never blocks user files: tree upload, main head attach and V2 download still work; budget ignores user bytes', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  const { treeId, revisionId } = await H.treeOwner()
  await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_MANAGED', size: MiB })
  assert.deepEqual(budgetCode(await H.open(c, kek)), EXCEEDED)
  const user = await H.uploadOne(c, kek, TREE_UP, { plainSize: 64 * 1024 })
  assert.equal(user.status, 201, 'original upload unaffected')
  assert.equal(user.data.blob.lifecycle, 'UNREFERENCED')
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), MiB, 'user bytes are never counted')
  const dl = await c.req(`/api/vault/blobs/${user.data.blob.id}/chunks/0`)
  assert.equal(dl.status, 200, 'original download unaffected')
  const { randomBytes } = await import('node:crypto')
  const rev2 = randomBytes(16).toString('base64url'), key2 = randomBytes(16).toString('base64url')
  assert.equal((await tree.createRevision(H.ownerId, { revisionId: rev2, treeId, baseRevisionId: revisionId, generation: 2, manifestSchemaVersion: 1, ivB64: randomBytes(12).toString('base64'), wrappedManifestDekB64: randomBytes(48).toString('base64'), wrapIvB64: randomBytes(12).toString('base64'), idempotencyKey: key2 })).ok, true)
  assert.equal((await tree.markRevisionPublished(H.ownerId, rev2, { storageKey: `vault-tree/${rev2}.aegisenc`, ciphertextSize: 4112, sha256: 'b'.repeat(64) })).ok, true)
  const main = await tree.casHead(H.ownerId, { expectedGeneration: 1, expectedRevisionId: revisionId, revisionId: rev2, attachBlobRefs: [{ formatVersion: 2, id: user.data.blob.id }], idempotencyKey: key2 })
  assert.equal(main.ok, true, 'main manifest head CAS unaffected')
})

test('PIB-6 rejection deletes nothing and touches no main manifest: every INDEX_* blob, V2 row and committed file survives', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await ownerWithRetained(MiB - 3 * S)
  const committed = []
  for (let i = 0; i < 3; i++) { const r = await H.uploadOne(c, kek); assert.equal(r.status, 201); committed.push(r.data.blob.id) }
  const headBefore = await tree.getHead(H.ownerId)
  const rowsBefore = (await v2.listVaultV2Blobs(H.ownerId)).map((b) => b.id).sort()
  assert.deepEqual(budgetCode(await H.open(c, kek)), EXCEEDED)
  const id = await (async () => { H.setServerConfig('write2', cfg.write(2 * MiB)); const c2 = await H.login('write2'); return { c2, id: await H.staged(c2, kek) } })()
  H.setServerConfig('write2', cfg.write(MiB))
  assert.deepEqual(budgetCode(await H.commit(id.c2, id.id)), EXCEEDED)
  assert.deepEqual((await v2.listVaultV2Blobs(H.ownerId)).map((b) => b.id).sort(), rowsBefore)
  for (const bid of committed) {
    assert.equal((await H.blobStateOf(bid)).lifecycle, 'INDEX_STAGED')
    assert.equal((await c.req(`/api/vault/blobs/${bid}/chunks/0`)).status, 200, 'ciphertext file still served')
  }
  assert.deepEqual(await tree.getHead(H.ownerId), headBefore, 'main head unchanged')
  assert.equal(await pindex.getIndexHead(H.ownerId), null, 'no index head appeared')
})

test('PIB-7 CAS-loss growth is bounded: repeated "upload then lose CAS" stops at the budget; every lost-CAS blob stays counted', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  const start = MiB - 5 * S - 7
  await ownerWithRetained(start)
  let ok = 0
  for (let i = 0; i < 12; i++) {
    const opened = await H.open(c, kek)
    if (opened.status === 507) { assert.deepEqual(budgetCode(opened), EXCEEDED); continue }
    assert.equal(opened.status, 201, JSON.stringify(opened.data))
    assert.equal((await H.putChunk(c, opened.data.upload.uploadId)).status, 200)
    const done = await H.commit(c, opened.data.upload.uploadId)
    assert.equal(done.status, 201, JSON.stringify(done.data)) // committed but never CAS-attached ("lost CAS")
    ok++
  }
  assert.equal(ok, 5)
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), start + 5 * S)
  assert.ok(start + 5 * S <= MiB)
})

test('PIB-8 WRITE off: create is 503 PREVIEW_INDEX_WRITE_DISABLED before any budget check', async () => {
  const c = await H.login('read'); const kek = await H.setupVault(c)
  await ownerWithRetained(MiB)
  const r = await H.open(c, kek)
  assert.equal(r.status, 503); assert.equal(r.data.code, 'PREVIEW_INDEX_WRITE_DISABLED')
})

test('PIB-9 audit: a budget rejection is recorded DENIED without byte counts or ids beyond the opaque hash', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await ownerWithRetained(MiB)
  assert.deepEqual(budgetCode(await H.open(c, kek)), EXCEEDED)
  const rows = (await H.connection.readAudit(50)).filter((e) => e.action === 'VAULT_V2_UPLOAD_START')
  assert.equal(rows[0].result, 'DENIED')
})

test('PIB-10 source: legacy and tree families never consult the budget; the budget path issues no DELETE', () => {
  const up = fs.readFileSync(new URL('../server/routes/vaultUploads.js', import.meta.url), 'utf8')
  assert.match(up, /if \(budget && /, 'budget hooks are guarded by the injected previewIndex budget only')
  assert.doesNotMatch(up, /DELETE\s+FROM/i)
  const route = fs.readFileSync(new URL('../server/routes/vaultPreviewIndex.js', import.meta.url), 'utf8')
  assert.match(route, /createVaultUploadHandlers\(\{ mode: 'previewIndex', writeGate: requirePreviewIndexWrite, budget: /)
  assert.match(fs.readFileSync(new URL('../server/routes/vaultTreeUploads.js', import.meta.url), 'utf8'), /createVaultUploadHandlers\(\{ mode: 'tree' \}\)/)
  assert.match(up, /createVaultUploadHandlers\(\{ mode: 'legacy' \}\)/)
})
