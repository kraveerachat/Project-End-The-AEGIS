// tests/helpers/previewIndexNeutralitySpec.mjs — D-1 PR-E Task H.2 · preview-index account neutrality, memory AND PostgreSQL
//
// ADMIN, EXISTING_USER and NEWLY_CREATED_USER (provisioned by the Admin through the normal API during the run) get the
// same preview-index create/read/write behaviour for their own index, the same "not found" for everyone else's (the
// Admin has no override), and no server-side de-duplication across owners.
// ⚠️ The tests share one ordered context (`ctx`): AN-PI-1 builds one index per class and later tests use it. On
//    PostgreSQL, generation rows are undeletable by design, so each fixed account may create its first index only once
//    per database; the harness gives every test FILE its own fresh database.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { seedV2Blob } from './previewIndexStoreSpec.mjs'

const PI = '/api/vault/tree/preview-index'
const opaque22 = () => randomBytes(16).toString('base64url')
const hex48 = () => randomBytes(24).toString('hex')
export const NEUTRALITY_CLASSES = Object.freeze(['ADMIN', 'EXISTING_USER', 'NEWLY_CREATED_USER'])

/**
 * @param {object} o
 * @param {typeof import('node:test').test} o.test
 * @param {object} o.H tests/helpers/previewIndexUploadHarness.mjs (servers: write, small)
 * @param {object|false} [o.skip]
 */
export function definePreviewIndexNeutralitySpec({ test, H, skip = false }) {
  const ctx = { accounts: [] }
  let seq = 0
  async function provision(server = 'write') {
    const admin = await H.login(server, H.DEMO_ADMIN)
    const username = `pineutral${Date.now().toString(36)}${seq++}`
    const res = await admin.req('/api/users', { method: 'POST', body: { name: 'Preview Index Neutrality', username, role: 'DataLake-User' } })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    return { username, password: res.data.tempPassword }
  }
  const idOf = async (username) => String((await H.connection.getUserByUsername(username)).id)

  test('AN-PI-1 every class: Vault setup → TREE_V1 → head 404 → upload → CAS → head 200 with its own root; identical statuses and shapes', { skip }, async () => {
    const fresh = await provision()
    const who = { ADMIN: H.DEMO_ADMIN, EXISTING_USER: H.DEMO_USER, NEWLY_CREATED_USER: fresh }
    const shapes = []
    for (const className of NEUTRALITY_CLASSES) {
      const client = await H.login('write', who[className])
      const kek = await H.setupVault(client)
      const userId = await idOf(who[className].username)
      await H.treeOwner(userId)
      const absent = await client.req(`${PI}/head`)
      const up = await H.uploadOne(client, kek)
      const blob = up.data.blob
      const cas = await client.req(`${PI}/head`, { method: 'POST', body: { expectedGeneration: 0, expectedRootBlobId: null, rootBlobId: blob.id, rootContentIdB64: blob.contentIdB64, attachBlobIds: [blob.id], supersededBlobIds: [], idempotencyKey: opaque22() } })
      const head = await client.req(`${PI}/head`)
      const env = await client.req(`${PI}/envelopes?ids=${blob.id}`)
      assert.deepEqual(head.data.rootBlobRef, { formatVersion: 2, id: blob.id }, className)
      shapes.push({
        className, absent: [absent.status, absent.data?.code], upload: [up.status, blob.lifecycle], cas: [cas.status, Object.keys(cas.data).sort(), cas.data.indexGeneration],
        head: [head.status, Object.keys(head.data).sort()], envelopes: [env.status, JSON.stringify(env.data).includes(blob.id)],
      })
      ctx.accounts.push({ className, client, kek, userId, blob, who: who[className] })
    }
    const [first, ...rest] = shapes.map(({ className, ...s }) => s)
    assert.deepEqual(first, { absent: [404, 'PREVIEW_INDEX_NOT_FOUND'], upload: [201, 'INDEX_STAGED'], cas: [200, ['indexGeneration', 'rootBlobId'], 1], head: [200, first.head[1]], envelopes: [200, true] })
    for (const [i, s] of rest.entries()) assert.deepEqual(s, first, `${shapes[i + 1].className} behaves like ${shapes[0].className}`)
  })

  test('AN-PI-2 no Admin override and no cross-class access: another owner\'s head, envelopes, blobs and attach look exactly like a nonexistent id', { skip }, async () => {
    assert.equal(ctx.accounts.length, 3, 'AN-PI-1 ran first')
    for (const reader of ctx.accounts) {
      for (const target of ctx.accounts.filter((a) => a !== reader)) {
        const real = await reader.client.req(`${PI}/envelopes?ids=${target.blob.id}`), fake = await reader.client.req(`${PI}/envelopes?ids=${hex48()}`)
        assert.equal(real.status, fake.status); assert.deepEqual(real.data, fake.data, `${reader.className} → ${target.className} envelopes`)
        const head = await reader.client.req(`${PI}/head`)
        assert.deepEqual(head.data.rootBlobRef, { formatVersion: 2, id: reader.blob.id }, `${reader.className} only ever sees its own head`)
        const blobs = await reader.client.req(`${PI}/blobs`)
        assert.equal(JSON.stringify(blobs.data).includes(target.blob.id), false, `${reader.className} blob listing excludes ${target.className}`)
        const staged = await seedV2Blob({ tree: H.tree, v2: H.v2 }, target.userId, { lifecycle: 'INDEX_STAGED' })
        const steal = await reader.client.req(`${PI}/head`, { method: 'POST', body: { expectedGeneration: 1, expectedRootBlobId: reader.blob.id, rootBlobId: staged.id, rootContentIdB64: staged.contentIdB64, attachBlobIds: [staged.id], supersededBlobIds: [], idempotencyKey: opaque22() } })
        assert.equal(steal.status, 409, `${reader.className} attach of ${target.className}'s blob`)
        assert.equal(steal.data.code, 'PREVIEW_INDEX_BLOB_STATE_CONFLICT')
        assert.equal((await H.blobStateOf(staged.id, target.userId)).lifecycle, 'INDEX_STAGED', 'target blob untouched')
      }
    }
  })

  test('AN-PI-3 identical bytes from every class → distinct owner-scoped blob ids; the server never de-duplicates across owners', { skip }, async () => {
    const body = await H.createBody(ctx.accounts[0].kek)
    const chunk = randomBytes(1024 + H.GCM_TAG_BYTES), iv = randomBytes(12).toString('base64')
    const ids = []
    for (const a of ctx.accounts) {
      const open = await a.client.req(H.PI_UP, { method: 'POST', body })
      assert.equal(open.status, 201, `${a.className}: ${JSON.stringify(open.data)}`)
      const uploadId = open.data.upload.uploadId
      assert.equal((await a.client.req(`${H.PI_UP}/${uploadId}/chunks/0`, { method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': iv } })).status, 200)
      const done = await H.commit(a.client, uploadId)
      assert.equal(done.status, 201, a.className)
      ids.push([a, done.data.blob.id])
    }
    assert.equal(new Set(ids.map(([, id]) => id)).size, 3, 'three distinct blob ids')
    for (const [a, id] of ids) {
      for (const [b] of ids) {
        const state = await H.blobStateOf(id, b.userId)
        assert.equal(Boolean(state), a === b, `${id} belongs to ${a.className} only`)
      }
    }
    const { sealDerivative } = await import('../../src/lib/vaultPreviewIndexObject.js')
    const { createPreviewIndexFakeTransport } = await import('./previewIndexFakeTransport.mjs')
    const { fakeJpeg } = await import('./previewIndexFixture.mjs')
    const bytes = fakeJpeg(), t = createPreviewIndexFakeTransport()
    const sealed = []
    for (const a of ctx.accounts) sealed.push(await sealDerivative({ kek: a.kek, bytes, mime: 'image/jpeg', transport: t }))
    assert.equal(new Set(sealed.map((s) => s.contentId)).size, 3, 'client: identical derivative bytes get a distinct content id per seal')
  })

  test('AN-PI-4 the retained-storage budget is per owner: one class at its budget never blocks another class', { skip }, async () => {
    const at = ctx.accounts.find((a) => a.className === 'NEWLY_CREATED_USER')
    const retained = await H.pindex.getRetainedIndexBytes(at.userId)
    await seedV2Blob({ tree: H.tree, v2: H.v2 }, at.userId, { lifecycle: 'INDEX_MANAGED', size: Math.max(1, H.MiB - retained) })
    for (const a of ctx.accounts) {
      const c = await H.login('small', a.who)
      const r = await H.open(c, a.kek)
      if (a === at) assert.deepEqual([r.status, r.data?.code], [507, 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED'], a.className)
      else assert.equal(r.status, 201, `${a.className} unaffected by ${at.className}'s budget`)
    }
  })

  test('AN-PI-5 NEWLY_CREATED_USER before TREE_V1 → 409 TREE_STATE_CONFLICT (not 404/503); after setup → 404 like every class', { skip }, async () => {
    const fresh = await provision()
    const c = await H.login('write', fresh)
    const before = await c.req(`${PI}/head`)
    assert.deepEqual([before.status, before.data?.code], [409, 'TREE_STATE_CONFLICT'])
    await H.setupVault(c)
    await H.treeOwner(await idOf(fresh.username))
    const after = await c.req(`${PI}/head`)
    assert.deepEqual([after.status, after.data?.code], [404, 'PREVIEW_INDEX_NOT_FOUND'])
  })
}
