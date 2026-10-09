// tests/helpers/previewIndexSecurityGateSpec.mjs — D-1 PR-E Task H.1 · server-side security gates, one spec for memory AND PostgreSQL
//
// Each `SG-*` test re-proves one plan §H.1 invariant end to end over HTTP (real app, real stores) and names the task that
// implements it. The per-task unit tests stay the primary proof; tests/previewIndexSecurityGates.test.js holds the
// client-side gates and the coverage map that pins every cited test id.
// ⚠️ Budgets here are test values; the approved Production value (8,589,934,592 B, HG-G 2026-10-03) is asserted in SG-BUD-1.
// ⚠️ Nothing here deletes, purges or garbage-collects; SG-SUP-2 proves no DELETE/TRUNCATE reaches the blob, lifecycle or
//    preview-index tables while the gates run (PostgreSQL: every SQL statement is captured; memory: row sets compared).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { seedV2Blob } from './previewIndexStoreSpec.mjs'

export const APPROVED_BUDGET_BYTES = 8_589_934_592
const PI = '/api/vault/tree/preview-index'
const opaque22 = () => randomBytes(16).toString('base64url')
const hex48 = () => randomBytes(24).toString('hex')
const casBody = (o) => ({
  expectedGeneration: 0, expectedRootBlobId: null, rootBlobId: o.root.id, rootContentIdB64: o.root.contentIdB64,
  attachBlobIds: o.attach ?? [o.root.id], supersededBlobIds: o.superseded ?? [], idempotencyKey: o.key ?? opaque22(), ...o.over,
})
const postCas = (c, body) => c.req(`${PI}/head`, { method: 'POST', body })
const PROTECTED_TABLES = /\b(vault_v2_blobs|vault_v2_blob_chunks|vault_tree_blob_state|vault_preview_index_heads|vault_preview_index_generations|vault_preview_index_blob_refs)\b/i

/**
 * @param {object} o
 * @param {typeof import('node:test').test} o.test
 * @param {object} o.H tests/helpers/previewIndexUploadHarness.mjs (already set up with servers off/read/write/small)
 * @param {object|false} [o.skip]
 */
export function definePreviewIndexSecurityGateSpec({ test, H, skip = false }) {
  const { tree, v2, pindex, connection, cfg, MiB, GCM_TAG_BYTES } = H
  const deps = { tree, v2 }
  const lifecycleOf = async (u, id) => (await tree.listBlobStates(u)).find((x) => x.formatVersion === 2 && x.id === id)?.lifecycle ?? null
  const casAudit = async () => (await connection.readAudit(500)).filter((e) => e.action === 'VAULT_PREVIEW_INDEX_CAS')
  const indexRowCount = async (u) => (await tree.listBlobStates(u)).filter((s) => s.lifecycle === 'INDEX_STAGED' || s.lifecycle === 'INDEX_MANAGED').length
  // Generation rows are undeletable by design (migration 012 triggers), so on PostgreSQL every CAS test needs an owner
  // that never had an index: provisioned by the Admin through the normal API, first login completes the forced reset.
  let seq = 0
  async function freshOwner(server = 'write') {
    const admin = await H.login(server, H.DEMO_ADMIN)
    const username = `sgate${Date.now().toString(36)}${seq++}`
    const res = await admin.req('/api/users', { method: 'POST', body: { name: 'Security Gate', username, role: 'DataLake-User' } })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    const client = await H.login(server, { username, password: res.data.tempPassword })
    const userId = String((await connection.getUserByUsername(username)).id)
    const seeded = await H.treeOwner(userId)
    return { client, userId, ...seeded }
  }

  test('SG-OFF-1 default-off (A.1/E.1/E.3): every preview-index write route answers 503 before any lookup; nothing written, nothing audited', { skip }, async () => {
    await H.treeOwner()
    const root = await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_STAGED' })
    const auditBefore = (await casAudit()).length
    const rowsBefore = await indexRowCount(H.ownerId)
    assert.deepEqual(Object.fromEntries(Object.entries(cfg.off().flags).filter(([k]) => k.startsWith('previewIndex'))),
      { previewIndexSchemaAvailable: false, previewIndexReadEnabled: false, previewIndexWriteEnabled: false }, 'empty env: all preview-index flags off')
    const c = await H.login('read'); await H.setupVault(c)
    const id = hex48()
    for (const [label, r] of [
      ['POST head', await postCas(c, casBody({ root }))],
      ['POST uploads', await c.req(`${PI}/uploads`, { method: 'POST', body: {} })],
      ['PUT chunk', await c.req(`${PI}/uploads/${id}/chunks/0`, { method: 'PUT', body: randomBytes(32), headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') } })],
      ['POST commit', await c.req(`${PI}/uploads/${id}/commit`, { method: 'POST' })],
    ]) {
      assert.equal(r.status, 503, label)
      assert.equal(r.data?.code, 'PREVIEW_INDEX_WRITE_DISABLED', label)
    }
    const state = await c.req('/api/vault/tree/state')
    assert.equal(state.data?.flags?.previewIndexWriteEnabled, false)
    const off = await H.login('off')
    assert.equal((await postCas(off, casBody({ root }))).status, 503, 'tree protocol off → still 503')
    assert.equal(await pindex.getIndexHead(H.ownerId), null)
    assert.equal(await lifecycleOf(H.ownerId, root.id), 'INDEX_STAGED')
    assert.equal(await indexRowCount(H.ownerId), rowsBefore)
    assert.equal((await casAudit()).length, auditBefore)
  })

  test('SG-XO-1 cross-owner / wrong owner (A.4/C.3/C.4): ADMIN on another owner\'s index and uploads sees exactly what a nonexistent id gives; no override', { skip }, async () => {
    await H.treeOwner(H.ownerId); await H.treeOwner(H.otherId)
    const a = await H.login('write'); const kek = await H.setupVault(a)
    const committed = await H.uploadOne(a, kek)
    assert.equal(committed.status, 201, JSON.stringify(committed.data))
    const aBlob = committed.data.blob
    const aStaged = await H.staged(a, kek)
    const admin = await H.login('write', H.DEMO_ADMIN)
    const same = async (label, mk) => {
      const real = await mk(true), fake = await mk(false)
      assert.equal(real.status, fake.status, `${label}: status`)
      assert.deepEqual(real.data, fake.data, `${label}: body must not reveal existence`)
      assert.notEqual(real.status, 200, `${label}: never served`)
      return real
    }
    await same('status', (r) => H.status(admin, r ? aStaged : hex48()))
    await same('chunk', (r) => admin.req(`${PI}/uploads/${r ? aStaged : hex48()}/chunks/0`, { method: 'PUT', body: randomBytes(1024 + GCM_TAG_BYTES), headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') } }))
    await same('commit', (r) => H.commit(admin, r ? aStaged : hex48()))
    await same('cancel', (r) => H.cancel(admin, r ? aStaged : hex48()))
    const envReal = await admin.req(`${PI}/envelopes?ids=${aBlob.id}`), envFake = await admin.req(`${PI}/envelopes?ids=${hex48()}`)
    assert.equal(envReal.status, envFake.status); assert.deepEqual(envReal.data, envFake.data, 'envelopes: foreign ids are silently absent')
    const head = await admin.req(`${PI}/head`)
    assert.equal(head.status, 404, 'ADMIN has no index of its own and cannot reach the owner\'s')
    const steal = await postCas(admin, casBody({ root: { id: aBlob.id, contentIdB64: aBlob.contentIdB64 } }))
    assert.equal(steal.status, 409)
    assert.equal(steal.data.code, 'PREVIEW_INDEX_BLOB_STATE_CONFLICT')
    assert.equal(await lifecycleOf(H.ownerId, aBlob.id), 'INDEX_STAGED', 'owner\'s blob untouched')
    assert.equal(await pindex.getIndexHead(H.otherId), null)
    assert.equal((await H.status(a, aStaged)).status, 200, 'owner still sees its own session')
  })

  test('SG-WO-2 wrong owner of a main head (LG/A.3): the main head CAS refuses own INDEX_* blobs and another owner\'s blobs', { skip }, async () => {
    const { treeId } = await H.treeOwner(H.ownerId)
    await H.treeOwner(H.otherId)
    const own = await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_MANAGED' })
    const foreign = await seedV2Blob(deps, H.otherId, { lifecycle: 'UNREFERENCED' })
    for (const [label, ref] of [['own INDEX_MANAGED', own.id], ['foreign user blob', foreign.id]]) {
      const head = await tree.getHead(H.ownerId)
      const rev = opaque22(), key = opaque22()
      assert.equal((await tree.createRevision(H.ownerId, { revisionId: rev, treeId, baseRevisionId: head.revisionId, generation: head.generation + 1, manifestSchemaVersion: 1, ivB64: randomBytes(12).toString('base64'), wrappedManifestDekB64: randomBytes(48).toString('base64'), wrapIvB64: randomBytes(12).toString('base64'), idempotencyKey: key })).ok, true)
      assert.equal((await tree.markRevisionPublished(H.ownerId, rev, { storageKey: `vault-tree/${rev}.aegisenc`, ciphertextSize: 4112, sha256: 'b'.repeat(64) })).ok, true)
      const r = await tree.casHead(H.ownerId, { expectedGeneration: head.generation, expectedRevisionId: head.revisionId, revisionId: rev, attachBlobRefs: [{ formatVersion: 2, id: ref }], idempotencyKey: key })
      assert.equal(r.ok, false, label)
      assert.equal(r.code, 'TREE_BLOB_STATE_CONFLICT', label)
      assert.deepEqual(await tree.getHead(H.ownerId), head, `${label}: main head unchanged`)
    }
    assert.equal(await lifecycleOf(H.ownerId, own.id), 'INDEX_MANAGED')
    assert.equal(await lifecycleOf(H.otherId, foreign.id), 'UNREFERENCED')
  })

  test('SG-CID-2 content-id binding (C.1/C.3): a CAS whose root content id differs from the committed root is refused; nothing promoted', { skip }, async () => {
    const { client: c, userId: u } = await freshOwner()
    const root = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    const r = await postCas(c, casBody({ root: { id: root.id, contentIdB64: Buffer.alloc(16, 7).toString('base64') } }))
    assert.equal(r.status, 409)
    assert.equal(r.data.code, 'PREVIEW_INDEX_ROOT_MISMATCH')
    assert.equal(await pindex.getIndexHead(u), null)
    assert.equal(await lifecycleOf(u, root.id), 'INDEX_STAGED')
  })

  test('SG-STALE-2 / SG-CAS-1 CAS conflict (C.1/C.2): two writers on one expectation → exactly one wins; the loser learns only generation + root', { skip }, async () => {
    const { client: c, userId: u } = await freshOwner()
    const r1 = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    const r2 = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    const results = await Promise.all([postCas(c, casBody({ root: r1 })), postCas(c, casBody({ root: r2 }))])
    const wins = results.filter((r) => r.status === 200), losses = results.filter((r) => r.status === 409)
    assert.equal(wins.length, 1, JSON.stringify(results.map((r) => [r.status, r.data])))
    assert.equal(losses.length, 1)
    const winner = wins[0].data.rootBlobId
    assert.deepEqual(losses[0].data, { error: 'Preview index changed', code: 'PREVIEW_INDEX_CONFLICT', currentGeneration: 1, currentRootBlobId: winner })
    const loser = winner === r1.id ? r2 : r1
    assert.equal(await lifecycleOf(u, loser.id), 'INDEX_STAGED', 'loser stays staged (counted, never deleted)')
    assert.equal((await pindex.getIndexHead(u)).indexGeneration, 1)
  })

  test('SG-LOST-1 lost response (C.1/E.2): resending the identical body + key replays; the same key with another body is refused', { skip }, async () => {
    const { client: c, userId: u } = await freshOwner()
    const root = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    const other = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    const body = casBody({ root })
    const first = await postCas(c, body)
    assert.equal(first.status, 200)
    const replay = await postCas(c, body)
    assert.equal(replay.status, 200); assert.deepEqual(replay.data, first.data)
    assert.equal((await pindex.listIndexGenerations(u)).length, 1, 'replay adds no generation')
    const misuse = await postCas(c, casBody({ root: other, key: body.idempotencyKey }))
    assert.equal(misuse.status, 409)
    assert.equal(misuse.data.code, 'PREVIEW_INDEX_IDEMPOTENCY_MISMATCH')
  })

  test('SG-BUD-1 approved budget (G.3/A.1): exactly 8,589,934,592 B boots with WRITE=true; WRITE=true without a budget still fails closed', { skip }, async () => {
    const { HG_G_RETAINED_BUDGET_APPROVAL } = await import('../../server/config/vaultTreeLimits.js')
    assert.equal(HG_G_RETAINED_BUDGET_APPROVAL.bytes, APPROVED_BUDGET_BYTES)
    assert.equal(cfg.write(APPROVED_BUDGET_BYTES).limits.maxPreviewIndexRetainedBytesPerOwner, APPROVED_BUDGET_BYTES)
    assert.equal(cfg.off().limits.maxPreviewIndexRetainedBytesPerOwner, null, 'no runtime default')
    assert.throws(() => H.vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true' }), /requires VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER/)
  })

  test('SG-BUD-2 507 budget (C.7/E.4): at the budget, preview persistence is refused while original upload, main state and existing index objects stay untouched', { skip }, async () => {
    await H.treeOwner()
    const c = await H.login('small'); const kek = await H.setupVault(c)
    await seedV2Blob(deps, H.ownerId, { lifecycle: 'INDEX_MANAGED', size: MiB })
    const blobsBefore = (await v2.listVaultV2Blobs(H.ownerId)).map((b) => b.id).sort()
    const headBefore = await tree.getHead(H.ownerId)
    const over = await H.open(c, kek)
    assert.deepEqual([over.status, over.data?.code], [507, 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED'])
    assert.deepEqual(Object.keys(over.data).sort(), ['code', 'error'])
    const blobsAfterReject = (await v2.listVaultV2Blobs(H.ownerId)).map((b) => b.id).sort()
    assert.deepEqual(blobsAfterReject, blobsBefore, 'rejection deletes and adds nothing')
    const original = await H.uploadOne(c, kek, H.TREE_UP)
    assert.equal(original.status, 201, 'original (tree family) upload unaffected by a full preview budget')
    assert.deepEqual(await tree.getHead(H.ownerId), headBefore, 'main head untouched')
    assert.equal(await pindex.getRetainedIndexBytes(H.ownerId), MiB)
  })

  test('SG-MAN-1 / SG-SUP-1 manifest v1 and superseded no-delete (binding/C.1/D.3): a two-generation index run never touches the main head; superseded objects stay present and counted', { skip }, async () => {
    const { client: c, userId: u, revisionId } = await freshOwner()
    const headBefore = await tree.getHead(u)
    const r1 = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' }), s1 = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    assert.equal((await postCas(c, casBody({ root: r1, attach: [r1.id, s1.id] }))).status, 200)
    const r2 = await seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
    const g2 = await postCas(c, casBody({ root: r2, superseded: [r1.id, s1.id], over: { expectedGeneration: 1, expectedRootBlobId: r1.id } }))
    assert.equal(g2.status, 200, JSON.stringify(g2.data))
    for (const id of [r1.id, s1.id, r2.id]) assert.equal(await lifecycleOf(u, id), 'INDEX_MANAGED', `${id} present and managed`)
    assert.equal(await pindex.getRetainedIndexBytes(u), r1.size + s1.size + r2.size, 'superseded bytes still counted')
    assert.deepEqual(await tree.getHead(u), headBefore, 'main head untouched by index CAS')
    const rev = await tree.getRevision(u, revisionId)
    assert.equal(rev.manifestSchemaVersion, 1)
    if (connection.usingPostgres) {
      const { rows } = await connection.query('SELECT count(*)::int AS n FROM vault_tree_revisions WHERE manifest_schema_version <> 1', [])
      assert.equal(rows[0].n, 0, 'no non-v1 main revision anywhere')
    }
  })

  test('SG-SUP-2 no DELETE / TRUNCATE / purge authority (D.3): a full upload + CAS + supersede run issues none against blob, lifecycle or preview-index tables', { skip }, async () => {
    const statements = []
    let restore = () => {}
    if (connection.usingPostgres) {
      const pg = (await import('pg')).default
      const real = pg.Client.prototype.query
      pg.Client.prototype.query = function (q, ...rest) { statements.push(typeof q === 'string' ? q : q?.text ?? ''); return real.call(this, q, ...rest) }
      restore = () => { pg.Client.prototype.query = real }
    }
    try {
      const { client: c, userId: u } = await freshOwner(); const kek = await H.setupVault(c)
      const a = (await H.uploadOne(c, kek)).data.blob, b = (await H.uploadOne(c, kek)).data.blob
      assert.equal((await postCas(c, casBody({ root: a }))).status, 200)
      assert.equal((await postCas(c, casBody({ root: b, superseded: [a.id], over: { expectedGeneration: 1, expectedRootBlobId: a.id } }))).status, 200)
      const lost = await H.staged(c, kek)
      assert.equal((await H.cancel(c, lost)).status, 200, 'cancel of an uncommitted session is the only discard path')
      const blobs = (await v2.listVaultV2Blobs(u)).map((x) => x.id)
      assert.ok(blobs.includes(a.id) && blobs.includes(b.id), 'superseded and current roots both remain')
      assert.equal(await lifecycleOf(u, a.id), 'INDEX_MANAGED')
    } finally { restore() }
    if (connection.usingPostgres) {
      const destructive = statements.filter((s) => /\b(DELETE|TRUNCATE|DROP)\b/i.test(s) && PROTECTED_TABLES.test(s))
      assert.deepEqual(destructive, [], 'no destructive SQL against protected tables')
      assert.equal(statements.filter((s) => /INSERT\s+INTO\s+vault_tree_purge_candidates/i.test(s)).length, 0, 'no purge candidate')
      assert.ok(statements.length > 10, 'statement capture is live')
    }
  })
}
