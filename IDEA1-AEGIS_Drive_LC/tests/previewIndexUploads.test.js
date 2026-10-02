// tests/previewIndexUploads.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Task C.4 · preview-index upload family (INDEX_STAGED at commit)
//
// ⚠️ /api/vault/tree/preview-index/uploads/* is the unchanged V2 upload family in mode 'previewIndex': write-gated
//    (VAULT_PREVIEW_INDEX_WRITE_ENABLED) mutations, TREE_V1 only, strict bodies, and a commit that writes lifecycle
//    INDEX_STAGED in the SAME transaction as the blob row — so the blob is never an UNREFERENCED recoverable user file.
// ⚠️ Memory mode by default; `PI_UPLOAD_PG=1` + scripts/pg-integration-env.sh runs the same file on PostgreSQL 15.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as H from './helpers/previewIndexUploadHarness.mjs'

const { PI_UP, TREE_UP, tree, v2, cfg } = H

before(() => H.setup({ write: cfg.write(), read: cfg.read(), treeOnly: cfg.treeOnly(), off: cfg.off() }))
after(() => H.teardown())
beforeEach(() => H.reset())

test('PIU-1 WRITE off → every mutating preview-index upload call 503 (nothing staged or committed); limits/status/cancel stay safe reads', async () => {
  const w = await H.login('write'); const kek = await H.setupVault(w)
  await H.treeOwner()
  const sessionId = await H.staged(w, kek)
  for (const [k, code] of [['read', 'PREVIEW_INDEX_WRITE_DISABLED'], ['treeOnly', 'PREVIEW_INDEX_WRITE_DISABLED']]) {
    const c = await H.login(k)
    for (const r of [await H.open(c, kek), await H.putChunk(c, sessionId), await H.commit(c, sessionId)]) {
      assert.equal(r.status, 503, `${k}: ${JSON.stringify(r.data)}`); assert.equal(r.data.code, code)
    }
    assert.equal((await c.req(`${PI_UP}/limits`)).status, 200, `${k}: limits is a safe read`)
    assert.equal((await H.status(c, sessionId)).status, 200, `${k}: status is a safe read`)
  }
  assert.equal((await v2.listVaultV2Blobs(H.ownerId)).length, 0, 'nothing committed while WRITE is off')
  const off = await H.login('off')
  for (const [m, p] of [['GET', `${PI_UP}/limits`], ['POST', PI_UP], ['POST', `${PI_UP}/${sessionId}/commit`], ['DELETE', `${PI_UP}/${sessionId}`]]) {
    const r = await off.req(p, { method: m, body: m === 'POST' ? {} : undefined })
    assert.equal(r.status, 503, `${m} ${p}`); assert.equal(r.data.code, 'TREE_PROTOCOL_DISABLED')
  }
  assert.equal((await H.cancel(await H.login('read'), sessionId)).status, 200, 'cancelling an uncommitted session stays possible with WRITE off')
})

test('PIU-2 outside TREE_V1 every mutation → 409 TREE_STATE_CONFLICT (after the WRITE gate)', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await tree.getTreeState(H.ownerId)
  for (const state of ['FLAT', 'MIGRATING_TREE_V1']) {
    await tree.__setProtocolStateForTests(H.ownerId, state)
    const r = await H.open(c, kek)
    assert.equal(r.status, 409, state); assert.equal(r.data.code, 'TREE_STATE_CONFLICT')
  }
  assert.equal((await v2.listVaultV2Blobs(H.ownerId)).length, 0)
})

test('PIU-3 strict bodies: unknown create/commit keys → 400 UNKNOWN_FIELD without echo', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await H.treeOwner()
  const secret = 'preview-of-CONFIDENTIAL-merger.jpg'
  for (const extra of [{ name: secret }, { nodeId: 'N'.repeat(22) }, { kind: 'thumb' }, { prefix: '010101' }, { mime: 'image/webp' }]) {
    const r = await H.open(c, kek, PI_UP, { extra })
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.data.code, 'UNKNOWN_FIELD')
    assert.equal(JSON.stringify(r.data).includes(secret), false)
  }
  const id = await H.staged(c, kek)
  const r = await H.commit(c, id, PI_UP, { lifecycle: 'UNREFERENCED' })
  assert.equal(r.status, 400); assert.equal(r.data.code, 'UNKNOWN_FIELD')
})

test('PIU-4 commit → INDEX_STAGED in the same transaction; hidden from user inventories; served by /preview-index/envelopes', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await H.treeOwner()
  const done = await H.uploadOne(c, kek)
  assert.equal(done.status, 201, JSON.stringify(done.data))
  assert.equal(done.data.blob.lifecycle, 'INDEX_STAGED')
  assert.equal(done.data.blob.formatVersion, 2)
  const id = done.data.blob.id
  assert.equal((await H.blobStateOf(id)).lifecycle, 'INDEX_STAGED')
  const inv = await c.req('/api/vault')
  assert.equal(inv.data.blobs.some((b) => String(b.id) === id), false, 'GET /api/vault never lists it')
  for (const q of ['?lifecycle=UNREFERENCED', '']) {
    const r = await c.req(`/api/vault/tree/blobs${q}`)
    assert.equal(r.data.blobs.some((b) => b.id === id), false, `/tree/blobs${q}`)
  }
  const env = await c.req(`/api/vault/tree/preview-index/envelopes?ids=${id}`)
  assert.equal(env.status, 200); assert.deepEqual(env.data.blobs.map((b) => b.id), [id])
})

test('PIU-5 fault injection: lifecycle write fails after the blob insert → no blob row, no state row, session recoverable', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await H.treeOwner()
  const id = await H.staged(c, kek)
  tree.__failNextBlobStateUpsertForTests(new Error('PIU-5 injected failure after blob insert'))
  const failed = await H.commit(c, id)
  assert.equal(failed.status, 500)
  assert.equal((await v2.listVaultV2Blobs(H.ownerId)).length, 0)
  assert.equal((await tree.listBlobStates(H.ownerId)).length, 0)
  assert.equal((await H.status(c, id)).data.upload.status, 'open')
  const retried = await H.commit(c, id)
  assert.equal(retried.status, 201, JSON.stringify(retried.data))
  assert.equal((await H.blobStateOf(retried.data.blob.id)).lifecycle, 'INDEX_STAGED')
})

test('PIU-6 TU-SAME: transfer limits identical to the tree family; response shapes identical except lifecycle value', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await H.treeOwner()
  const [lp, lt] = [await c.req(`${PI_UP}/limits`), await c.req(`${TREE_UP}/limits`)]
  assert.deepEqual({ ...lp.data, capacity: null }, { ...lt.data, capacity: null })
  const shape = (v, prefix = '') => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().flatMap((k) => shape(v[k], `${prefix}${k}.`)) : [prefix.slice(0, -1)]
  const pi = await H.uploadOne(c, kek), tr = await H.uploadOne(c, kek, TREE_UP)
  assert.deepEqual(shape(pi.data), shape(tr.data))
  assert.deepEqual([pi.data.blob.lifecycle, tr.data.blob.lifecycle], ['INDEX_STAGED', 'UNREFERENCED'])
  const sp = await H.status(c, await H.staged(c, kek)), st = await H.status(c, await H.staged(c, kek, TREE_UP), TREE_UP)
  assert.deepEqual(shape(sp.data), shape(st.data), 'status (incl. wrapped envelope for resume) has the tree-family shape')
})

test('PIU-7 owner isolation: another user cannot see, write, commit or cancel a preview-index session', async () => {
  const c = await H.login('write'); const kek = await H.setupVault(c)
  await H.treeOwner()
  const id = await H.staged(c, kek)
  const other = await H.login('write', H.DEMO_ADMIN)
  await H.treeOwner(H.otherId)
  for (const r of [await H.status(other, id), await H.putChunk(other, id), await H.commit(other, id), await H.cancel(other, id)]) assert.equal(r.status, 404)
  assert.equal((await H.commit(c, id)).status, 201)
})
