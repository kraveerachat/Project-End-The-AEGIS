// tests/previewIndexLifecycleGuards.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Task D.3 · non-destructive preview-index lifecycle, pinned
//
// INITIAL_DESTRUCTIVE_GC=FORBIDDEN · SUPERSEDED_REF=ADVISORY_ONLY · SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO
//   - INDEX_STAGED / INDEX_MANAGED blobs can never become user attachments (main head CAS refuses them)
//   - there is no preview-index DELETE route and no store SQL that deletes or purges anything
//   - no module reads SUPERSEDED refs / supersededBlobIds to change a lifecycle, schedule a purge or remove a file
//   - a CAS declaring every prior root/shard superseded leaves them all present, INDEX_MANAGED and counted
// ⚠️ Memory mode by default; `PI_UPLOAD_PG=1` + scripts/pg-integration-env.sh runs the same file on PostgreSQL 15.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as H from './helpers/previewIndexUploadHarness.mjs'
import { seedV2Blob } from './helpers/previewIndexStoreSpec.mjs'
import { casRequest } from './helpers/previewIndexCasSpec.mjs'

const { tree, v2, pindex, cfg } = H
const deps = { tree, v2 }
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(rel))
    else if (/\.(m?js|jsx)$/.test(e.name)) out.push(rel)
  }
  return out
}

before(() => H.setup({ write: cfg.write(), read: cfg.read() }))
after(() => H.teardown())
beforeEach(() => H.reset())

test('LG-1 main head CAS refuses INDEX_STAGED and INDEX_MANAGED blobs (TREE_BLOB_STATE_CONFLICT); nothing is promoted', async () => {
  const { treeId, revisionId } = await H.treeOwner()
  for (const lifecycle of ['INDEX_STAGED', 'INDEX_MANAGED']) {
    const idx = await seedV2Blob(deps, H.ownerId, { lifecycle })
    const rev = randomBytes(16).toString('base64url'), key = randomBytes(16).toString('base64url')
    const head = await tree.getHead(H.ownerId)
    assert.equal((await tree.createRevision(H.ownerId, { revisionId: rev, treeId, baseRevisionId: head.revisionId, generation: head.generation + 1, manifestSchemaVersion: 1, ivB64: randomBytes(12).toString('base64'), wrappedManifestDekB64: randomBytes(48).toString('base64'), wrapIvB64: randomBytes(12).toString('base64'), idempotencyKey: key })).ok, true)
    assert.equal((await tree.markRevisionPublished(H.ownerId, rev, { storageKey: `vault-tree/${rev}.aegisenc`, ciphertextSize: 4112, sha256: 'b'.repeat(64) })).ok, true)
    const r = await tree.casHead(H.ownerId, { expectedGeneration: head.generation, expectedRevisionId: head.revisionId, revisionId: rev, attachBlobRefs: [{ formatVersion: 2, id: idx.id }], idempotencyKey: key })
    assert.equal(r.ok, false, lifecycle)
    assert.equal(r.code, 'TREE_BLOB_STATE_CONFLICT', lifecycle)
    assert.equal((await H.blobStateOf(idx.id)).lifecycle, lifecycle, `${lifecycle} unchanged`)
  }
  assert.ok(revisionId)
})

test('LG-2 legacy DELETE /api/vault/blobs/:id stays fenced (426) for TREE_V1 owners, also for preview-index blobs', async () => {
  const c = await H.login('write'); await H.setupVault(c)
  await H.treeOwner()
  const idx = await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_MANAGED' })
  const r = await c.req(`/api/vault/blobs/${idx.id}`, { method: 'DELETE' })
  assert.equal(r.status, 426)
  assert.equal(r.data.code, 'UPGRADE_REQUIRED')
  assert.equal((await H.blobStateOf(idx.id)).lifecycle, 'INDEX_MANAGED')
  assert.equal((await pindex.listIndexEnvelopes(H.ownerId, [idx.id])).length, 1)
})

test('LG-3 destructive purge stays off by default and the main CAS still refuses purge refs (TREE_PURGE_NOT_SUPPORTED)', async () => {
  assert.equal(cfg.write().flags.destructivePurgeEnabled, false)
  assert.equal(H.vaultTreeConfigFromEnv({}).flags.destructivePurgeEnabled, false)
  await H.treeOwner()
  const idx = await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_MANAGED' })
  const r = await tree.casHead(H.ownerId, { expectedGeneration: 1, expectedRevisionId: 'x', revisionId: 'y', attachBlobRefs: [], purgeBlobRefs: [{ formatVersion: 2, id: idx.id }], idempotencyKey: 'k' })
  assert.deepEqual(r, { ok: false, code: 'TREE_PURGE_NOT_SUPPORTED' })
})

test('LG-4 no preview-index DELETE route except uncommitted-upload cancel (refuses committed sessions); no deleting SQL', async () => {
  const route = code(read('server/routes/vaultPreviewIndex.js'))
  assert.doesNotMatch(route, /\.(delete|put|patch)\s*\(/i)
  const store = code(read('server/db/vaultPreviewIndexStore.js'))
  assert.doesNotMatch(store, /\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i)
  assert.doesNotMatch(store, /\b(removeVaultCiphertext|unlink|rm\s*\(|purge_candidates|PURGE_PENDING|PURGED)\b/)
  const c = await H.login('write')
  for (const p of ['/api/vault/tree/preview-index/head', `/api/vault/tree/preview-index/blobs/${'a'.repeat(48)}`, `/api/vault/tree/preview-index/envelopes?ids=${'a'.repeat(48)}`]) {
    assert.equal((await c.req(p, { method: 'DELETE' })).status, 404, p)
  }
  // the only DELETE under /preview-index is the upload-family cancel: it discards uncommitted staging only
  const kek = await H.setupVault(c)
  await H.treeOwner()
  const id = await H.staged(c, kek)
  const done = await H.commit(c, id)
  assert.equal(done.status, 201)
  const r = await H.cancel(c, id)
  assert.equal(r.status, 409); assert.equal(r.data.code, 'SESSION_COMMITTED')
  assert.equal((await H.blobStateOf(done.data.blob.id)).lifecycle, 'INDEX_STAGED', 'a committed preview blob survives a cancel attempt')
})

test('LG-5 SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO: no module uses superseded refs to change lifecycle, purge or remove anything', () => {
  const files = [...walk('server'), ...walk('src')]
  // (a) the client-declared list only travels through the route into the store; the one client module that names it is
  //     the PR-D writer, which only PRODUCES it as a CAS body field (replaced shard + old root ids) and never reads it back
  const supersededUsers = files.filter((f) => /supersededBlobIds/.test(code(read(f))))
  assert.deepEqual(supersededUsers.sort(), ['server/db/vaultPreviewIndexStore.js', 'server/routes/vaultPreviewIndex.js', 'src/lib/vaultPreviewIndexWriter.js'])
  const writerUses = code(read('src/lib/vaultPreviewIndexWriter.js')).split(/\r?\n/).filter((l) => /supersededBlobIds/.test(l)).map((l) => l.trim())
  assert.equal(writerUses.length, 2, 'declared once, placed once into the CAS body')
  assert.match(writerUses[0], /^const supersededBlobIds = \[/)
  assert.match(writerUses[1], /attachBlobIds, supersededBlobIds, idempotencyKey/)
  // (b) only the store (writer + read-only listing) touches the ref table; the config only names it for the boot probe
  const refTable = files.filter((f) => /vault_preview_index_blob_refs/.test(code(read(f))))
  assert.deepEqual(refTable.sort(), ['server/config/vaultTreeLimits.js', 'server/db/vaultPreviewIndexStore.js'])
  assert.doesNotMatch(code(read('server/config/vaultTreeLimits.js')), /\b(SELECT|UPDATE|DELETE|INSERT)\b[^\n]*vault_preview_index_blob_refs/i)
  // (c) inside the CAS, no UPDATE/DELETE statement is ever parameterised with the superseded ids
  const store = read('server/db/vaultPreviewIndexStore.js')
  const cas = store.slice(store.indexOf('export async function casIndexHead'), store.indexOf('export async function listIndexGenerations'))
  const calls = [...cas.matchAll(/c\.query\(\s*`([\s\S]*?)`,\s*(\[[\s\S]*?\])\s*,?\s*\)/g)]
  assert.ok(calls.length >= 6, 'CAS statements were found')
  for (const [, sql, params] of calls) {
    if (/\b(UPDATE|DELETE)\b/i.test(sql)) assert.doesNotMatch(params, /superseded/, `mutating statement uses superseded ids: ${sql.trim().slice(0, 60)}`)
    if (/vault_tree_blob_state/.test(sql) && /\bUPDATE\b/i.test(sql)) assert.match(params, /\battach\b/)
  }
  const memSection = cas.slice(cas.indexOf('memory CAS critical section: begin'))
  assert.doesNotMatch(memSection.replace(/superseded\.map\(stateOf\)\.some\([^)]*\)/, ''), /for \(const \w+ of superseded\.map|superseded[^\n]*lifecycle\s*=/, 'memory CAS never mutates superseded rows')
  // (d) the read-only ref listing has no production caller (diagnostics/tests only)
  const callers = files.filter((f) => f !== 'server/db/vaultPreviewIndexStore.js' && /listIndexBlobRefs/.test(read(f)))
  assert.deepEqual(callers, [])
})

test('LG-6 a CAS declaring EVERY prior root and shard superseded leaves all of them present, INDEX_MANAGED and counted', async () => {
  await H.treeOwner()
  const g1 = [await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' }), await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' }), await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' })]
  assert.equal((await pindex.casIndexHead(H.ownerId, casRequest({ root: g1[0], attach: g1.map((b) => b.id) }))).ok, true)
  const g2 = [await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' }), await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' })]
  const before = await pindex.getRetainedIndexBytes(H.ownerId)
  const r = await pindex.casIndexHead(H.ownerId, casRequest({ root: g2[0], attach: g2.map((b) => b.id), superseded: g1.map((b) => b.id), expectedGeneration: 1, expectedRootBlobId: g1[0].id }))
  assert.equal(r.ok, true, JSON.stringify(r))
  for (const b of g1) {
    assert.equal((await H.blobStateOf(b.id)).lifecycle, 'INDEX_MANAGED')
    assert.equal((await pindex.listIndexEnvelopes(H.ownerId, [b.id])).length, 1, 'V2 row still present')
  }
  assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), before, 'nothing removed from the budget')
  assert.equal((await v2.listVaultV2Blobs(H.ownerId)).length, 5)
})
