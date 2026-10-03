// tests/helpers/previewIndexOldClientSpec.mjs — D-1 PR-E Task I.1 · baseline (pre-D-1) client against the current server
//
// The old client is the REAL client code of the A.0 baseline `2dc596d1` (server/src/package byte-identical to the
// accepted P1 runtime `8634360f`), imported from D1_BASELINE_ROOT (= that revision's IDEA1-AEGIS_Drive_LC directory, a
// detached worktree). It runs every existing Vault flow against the CURRENT server after the CURRENT writer has created a
// preview index for one of its files. Memory AND PostgreSQL (same spec). Every test shares one ordered context.
// ⚠️ The baseline client has no "replace content" intent; the stale-entry check therefore uses trash/restore of the
//    indexed node (a replaced blobRef is covered by SG-SRC-1 / PIRD-10).
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fakeJpeg } from './previewIndexFixture.mjs'

export const D1_BASELINE_ROOT = process.env.D1_BASELINE_ROOT ? path.resolve(process.env.D1_BASELINE_ROOT) : null
export const BASELINE_SKIP = D1_BASELINE_ROOT ? false : 'needs D1_BASELINE_ROOT (IDEA1 dir of a 2dc596d1 worktree with node_modules) to run the baseline client'
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const PI = '/api/vault/tree/preview-index'

/** the request adapter the browser build uses, over a test client (fetchJson / sendUpload / fetchBytes) */
export function transportOf(client, treeApi) {
  const fetchJson = async (pathname, { method = 'GET', body, signal } = {}) => {
    let b = body
    if (b instanceof Blob) b = new Uint8Array(await b.arrayBuffer())
    const raw = b instanceof Uint8Array
    const r = await client.req(pathname, { method, body: b, headers: raw ? { 'Content-Type': 'application/octet-stream' } : undefined, signal })
    const ok = r.status >= 200 && r.status < 400
    return { ok, status: r.status, data: r.data, errorKind: ok ? null : 'server' }
  }
  const sendUpload = async (pathname, { method = 'PUT', body, headers } = {}) => {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer())
    const r = await client.req(pathname, { method, body: bytes, headers })
    const ok = r.status >= 200 && r.status < 400
    return { ok, status: r.status, data: r.data, errorKind: ok ? null : 'server' }
  }
  const fetchBytes = async (pathname) => {
    const r = await client.raw(pathname)
    const ok = r.status >= 200 && r.status < 400
    return { ok, status: r.status, bytes: ok ? new Uint8Array(r.buffer) : null, headers: r.headers, errorKind: ok ? null : 'server' }
  }
  const o = (x = {}) => ({ fetchJson, fetchBytes, signal: x.signal })
  const api = {
    getTreeState: (x) => treeApi.getTreeState(o(x)), getTreeHead: (x) => treeApi.getTreeHead(o(x)),
    getRevisionCiphertext: (id, x) => treeApi.getRevisionCiphertext(id, o(x)),
    publishRevision: (m, x) => treeApi.publishRevision(m, o(x)), putRevisionCiphertext: (id, b, x) => treeApi.putRevisionCiphertext(id, b, o(x)),
    casHead: (b, x) => treeApi.casHead(b, o(x)), casKeyEnvelope: (b, x) => treeApi.casKeyEnvelope(b, o(x)),
    listTreeBlobs: (x = {}) => treeApi.listTreeBlobs({ ...o(x), lifecycle: x.lifecycle }),
    beginMigration: (x) => treeApi.beginMigration(o(x)), takeoverMigration: (x) => treeApi.takeoverMigration(o(x)),
    commitGenesis: (b, x) => treeApi.commitGenesis(b, o(x)),
  }
  return { api, fetchJson, sendUpload, fetchBytes }
}

async function loadClientModules(root) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
  const [crypt, treeApi, migration, sync, ops, upload, manifest, download, unlocked] = await Promise.all([
    imp('src/lib/vaultCrypto.js'), imp('src/lib/vaultTreeApi.js'), imp('src/lib/vaultTreeMigration.js'), imp('src/lib/vaultTreeSync.js'),
    imp('src/lib/vaultTreeOps.js'), imp('src/lib/vaultTreeUpload.js'), imp('src/lib/vaultTreeManifest.js'), imp('src/lib/vaultChunkedDownload.js'),
    imp('src/lib/vaultUnlockedState.js'),
  ])
  return { ...crypt, treeApi, ...migration, ...sync, ...ops, ...upload, ...manifest, ...download, ...unlocked }
}

/**
 * @param {object} o
 * @param {typeof import('node:test').test} o.test
 * @param {object} o.H tests/helpers/previewIndexUploadHarness.mjs (server: write)
 * @param {object|false} [o.skip]
 */
export function definePreviewIndexOldClientSpec({ test, H, skip = false }) {
  const s = skip || BASELINE_SKIP
  const ctx = {}
  const OLD = () => ctx.old
  const findChild = (session, parentId, name) => OLD().childrenOf(session.head.index, parentId).find((n) => n.name === name)
  const rootId = (session) => session.head.manifest.rootNodeId

  async function unlockOld() {
    const old = OLD()
    const v = await ctx.client.req('/api/vault')
    assert.equal(v.status, 200)
    const u = await old.unlockVault(ctx.passphrase, { saltB64: v.data.saltB64, params: v.data.params, verifier: v.data.verifier })
    const kek = u?.kek ?? u
    assert.ok(kek)
    const unlocked = old.createUnlockedVaultState()
    const t = transportOf(ctx.client, old.treeApi)
    const session = old.createTreeSession({ kek, api: t.api, unlockedState: unlocked })
    await session.loadHead()
    return { kek, unlocked, t, session, inventory: v.data.blobs }
  }
  async function oldUpload(o, parentId, name, bytes) {
    const r = await OLD().uploadTreeFile({ kek: o.kek, file: new File([bytes], name, { type: 'text/plain' }), parentNodeId: parentId, session: o.session, unlockedState: o.unlocked, fetchJson: o.t.fetchJson, sendUpload: o.t.sendUpload, concurrency: 1 })
    assert.equal(r.ok, true, `old upload ${r.stage} ${r.reason}`)
  }
  async function oldDownload(o, parentId, name) {
    const node = findChild(o.session, parentId, name)
    assert.ok(node?.blobRef, `${name} missing`)
    const blob = (await ctx.client.req('/api/vault')).data.blobs.find((b) => b.formatVersion === node.blobRef.formatVersion && String(b.id) === String(node.blobRef.id))
    assert.ok(blob, 'envelope missing from GET /api/vault')
    const sink = OLD().createBufferedSink()
    const r = await OLD().downloadVaultV2({ kek: o.kek, blob, sink, fetchBytes: o.t.fetchBytes })
    assert.equal(r.ok, true, `old download ${r.reason}`)
    return Buffer.concat(sink.result().map((p) => Buffer.from(p)))
  }
  /** the CURRENT client view: current session + current reader */
  async function currentLookup(nodeName, parentName = null) {
    const treeApi = await import('../../src/lib/vaultTreeApi.js')
    const { createTreeSession } = await import('../../src/lib/vaultTreeSync.js')
    const { childrenOf } = await import('../../src/lib/vaultTreeManifest.js')
    const { createPreviewIndexReader } = await import('../../src/lib/vaultPreviewIndexReader.js')
    const t = transportOf(ctx.client, treeApi)
    const session = createTreeSession({ kek: ctx.kek, api: t.api })
    await session.loadHead()
    const root = session.head.manifest.rootNodeId
    const parent = parentName ? childrenOf(session.head.index, root).find((n) => n.name === parentName).nodeId : root
    const node = childrenOf(session.head.index, parent, { view: 'all' }).find((n) => n.name === nodeName)
      ?? childrenOf(session.head.index, null, { view: 'trash' }).find((n) => n.name === nodeName)
    assert.ok(node, `${nodeName} not in the current head`)
    const api = {
      async getPreviewIndexHead() { const r = await t.fetchJson(`${PI}/head`); if (r.status === 404) return null; if (!r.ok) throw new Error(`head ${r.status}`); return r.data },
      async getPreviewIndexEnvelopes(ids) { const r = await t.fetchJson(`${PI}/envelopes?ids=${ids.join(',')}`); if (!r.ok) throw new Error(`envelopes ${r.status}`); return r.data.blobs },
    }
    const reader = createPreviewIndexReader({ kek: ctx.kek, api, fetchBytes: t.fetchBytes })
    const loaded = await reader.load({ treeId: session.head.treeId, generation: session.head.generation, index: session.head.index })
    return { loaded, entry: loaded.status === 'READY' ? await reader.lookup(session.head.index.nodes.get(node.nodeId), 'thumb') : null, head: session.head }
  }
  const indexIds = () => [ctx.index.derivative, ctx.index.shard, ctx.index.root]

  test('OC-1 baseline client on the current server: Vault setup, genesis to TREE_V1, unlock, folder and two uploads', { skip: s }, async () => {
    ctx.old = await loadClientModules(D1_BASELINE_ROOT)
    const admin = await H.login('write', H.DEMO_ADMIN)
    const username = `oldclient${Date.now().toString(36)}`
    const res = await admin.req('/api/users', { method: 'POST', body: { name: 'Old Client', username, role: 'DataLake-User' } })
    assert.equal(res.status, 201)
    ctx.client = await H.login('write', { username, password: res.data.tempPassword })
    ctx.userId = String((await H.connection.getUserByUsername(username)).id)
    ctx.passphrase = `old-client-${crypto.randomBytes(6).toString('hex')}`
    const setup = await OLD().createVaultSetup(ctx.passphrase, FAST)
    assert.equal((await ctx.client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
    const g = await OLD().runGenesis({ kek: setup.kek, api: transportOf(ctx.client, OLD().treeApi).api })
    assert.equal(g.protocolState, 'TREE_V1')
    const o = await unlockOld()
    ctx.kek = o.kek
    await o.session.commit(OLD().intents.createFolder({ parentNodeId: rootId(o.session), name: 'Docs' }))
    ctx.files = {}
    for (const name of ['photo-a.txt', 'note-b.txt']) {
      const bytes = Buffer.from(`old client ${name} ${crypto.randomBytes(32).toString('hex')}\n`.repeat(30))
      await oldUpload(o, rootId(o.session), name, bytes)
      ctx.files[name] = sha(bytes)
    }
    assert.equal(o.session.head.manifestSchemaVersion, 1)
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-2 the current writer path creates a preview index for one of those files (derivative + shard + root + CAS)', { skip: s }, async () => {
    const { sealDerivative, sealIndexObject } = await import('../../src/lib/vaultPreviewIndexObject.js')
    const { encodeShard, encodeRoot } = await import('../../src/lib/vaultPreviewIndexCodec.js')
    const { routingBits, prefixOf } = await import('../../src/lib/vaultPreviewIndexRouting.js')
    const { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, PREVIEW_INDEX_LIMITS: L } = await import('../../src/lib/vaultPreviewIndexConstants.js')
    const treeApi = await import('../../src/lib/vaultTreeApi.js')
    const o = await unlockOld()
    const node = findChild(o.session, rootId(o.session), 'photo-a.txt')
    const t = transportOf(ctx.client, treeApi)
    const bytes = fakeJpeg()
    const d = await sealDerivative({ kek: ctx.kek, bytes, mime: 'image/jpeg', transport: t })
    const entry = { kind: 'thumb', profile: 'vp1', blobRef: d.blobRef, contentId: d.contentId, sourceBlobRef: node.blobRef, mime: 'image/jpeg', width: 320, height: 240, plainSize: bytes.length, createdAtClient: 1_759_300_000_000 }
    const prefix = prefixOf(await routingBits(node.nodeId), L.initialPrefixBits)
    const shard = await sealIndexObject({ kek: ctx.kek, marker: INDEX_SHARD_MARKER, plaintext: await encodeShard({ schemaVersion: 1, treeId: o.session.head.treeId, prefix, entries: new Map([[node.nodeId, [entry]]]) }), buckets: L.shardPaddingBuckets, transport: t })
    const root = await sealIndexObject({ kek: ctx.kek, marker: INDEX_ROOT_MARKER, plaintext: encodeRoot({ schemaVersion: 1, treeId: o.session.head.treeId, indexGeneration: 1, createdAtClient: 1_759_300_000_000, shards: [{ prefix, blobRef: shard.blobRef, contentId: shard.contentId }] }), buckets: L.rootPaddingBuckets, transport: t })
    const cas = await ctx.client.req(`${PI}/head`, { method: 'POST', body: { expectedGeneration: 0, expectedRootBlobId: null, rootBlobId: root.blobRef.id, rootContentIdB64: root.contentId, attachBlobIds: [d.blobRef.id, shard.blobRef.id, root.blobRef.id], supersededBlobIds: [], idempotencyKey: crypto.randomBytes(16).toString('base64url') } })
    assert.equal(cas.status, 200, JSON.stringify(cas.data))
    ctx.index = { derivative: d.blobRef.id, shard: shard.blobRef.id, root: root.blobRef.id }
    const now = await currentLookup('photo-a.txt')
    assert.equal(now.loaded.status, 'READY')
    assert.deepEqual(now.entry?.blobRef, d.blobRef, 'current reader serves the new derivative')
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-3 after index creation the baseline client unlocks and browses; its inventory never sees an index object', { skip: s }, async () => {
    const o = await unlockOld()
    const names = OLD().childrenOf(o.session.head.index, rootId(o.session)).map((n) => n.name).sort()
    assert.deepEqual(names, ['Docs', 'note-b.txt', 'photo-a.txt'])
    const ids = new Set(o.inventory.map((b) => String(b.id)))
    for (const id of indexIds()) assert.equal(ids.has(id), false, `GET /api/vault leaks index object ${id}`)
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-4 rename + move by the baseline client keep the indexed preview (same source blob)', { skip: s }, async () => {
    const o = await unlockOld()
    const root = rootId(o.session)
    await o.session.commit(OLD().intents.rename({ nodeId: findChild(o.session, root, 'photo-a.txt').nodeId, name: 'photo-a-renamed.txt' }))
    const docs = findChild(o.session, root, 'Docs').nodeId
    await o.session.commit(OLD().intents.move({ nodeIds: [findChild(o.session, root, 'photo-a-renamed.txt').nodeId], destinationNodeId: docs }))
    assert.ok(findChild(o.session, docs, 'photo-a-renamed.txt'))
    ctx.files['photo-a-renamed.txt'] = ctx.files['photo-a.txt']
    const now = await currentLookup('photo-a-renamed.txt', 'Docs')
    assert.deepEqual(now.entry?.blobRef, { formatVersion: 2, id: ctx.index.derivative }, 'preview kept across rename/move')
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-5 baseline upload (tree family) and byte-exact downloads of old and new files', { skip: s }, async () => {
    const o = await unlockOld()
    const root = rootId(o.session)
    const bytes = Buffer.from(`after-index upload ${crypto.randomBytes(32).toString('hex')}\n`.repeat(30))
    await oldUpload(o, root, 'after-index.txt', bytes)
    ctx.files['after-index.txt'] = sha(bytes)
    assert.equal(sha(await oldDownload(o, root, 'after-index.txt')), ctx.files['after-index.txt'])
    assert.equal(sha(await oldDownload(o, root, 'note-b.txt')), ctx.files['note-b.txt'])
    assert.equal(sha(await oldDownload(o, findChild(o.session, root, 'Docs').nodeId, 'photo-a-renamed.txt')), ctx.files['photo-a-renamed.txt'])
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-6 trash + restore by the baseline client; the current reader rejects the trashed node and serves it again after restore', { skip: s }, async () => {
    const o = await unlockOld()
    const root = rootId(o.session)
    const docs = findChild(o.session, root, 'Docs').nodeId
    const b = findChild(o.session, root, 'note-b.txt')
    await o.session.commit(OLD().intents.trash({ nodeIds: [b.nodeId] }))
    await o.session.commit(OLD().intents.restore({ nodeId: b.nodeId }))
    assert.ok(findChild(o.session, root, 'note-b.txt'), 'restored')
    const a = findChild(o.session, docs, 'photo-a-renamed.txt')
    await o.session.commit(OLD().intents.trash({ nodeIds: [a.nodeId] }))
    const trashed = await currentLookup('photo-a-renamed.txt')
    assert.equal(trashed.entry, null, 'stale: a trashed node never shows its indexed preview')
    await o.session.commit(OLD().intents.restore({ nodeId: a.nodeId }))
    const back = await currentLookup('photo-a-renamed.txt', 'Docs')
    assert.deepEqual(back.entry?.blobRef, { formatVersion: 2, id: ctx.index.derivative }, 'restored node is source-bound again')
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-7 recovery: the baseline orphan listing and UNREFERENCED inventory never offer an index object', { skip: s }, async () => {
    const o = await unlockOld()
    const orphans = await OLD().listOrphanBlobs({ kek: o.kek, api: o.t.api, index: o.session.head.index })
    assert.deepEqual(orphans.map((x) => String(x.blobRef?.id)).filter((id) => indexIds().includes(id)), [])
    assert.equal(orphans.length, 0, 'no orphan at all')
    const unref = await o.t.api.listTreeBlobs({ lifecycle: 'UNREFERENCED' })
    const listed = JSON.stringify(unref)
    for (const id of indexIds()) assert.equal(listed.includes(id), false, `UNREFERENCED listing leaks ${id}`)
    for (const id of indexIds()) assert.equal((await H.blobStateOf(id, ctx.userId)).lifecycle, 'INDEX_MANAGED', 'index objects untouched')
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
  })

  test('OC-8 the main manifest stays schema v1 through every baseline write; lock purges the baseline session', { skip: s }, async () => {
    const o = await unlockOld()
    assert.equal(o.session.head.manifestSchemaVersion, 1)
    const rev = await H.tree.getRevision(ctx.userId, o.session.head.revisionId)
    assert.equal(rev.manifestSchemaVersion, 1)
    if (H.connection.usingPostgres) {
      const { rows } = await H.connection.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE manifest_schema_version <> 1)::int AS bad FROM vault_tree_revisions WHERE user_id = $1', [ctx.userId])
      assert.ok(rows[0].n >= 8, `revisions ${rows[0].n}`)
      assert.equal(rows[0].bad, 0, 'every main revision of the owner is schema v1')
    }
    o.unlocked.purge(OLD().PURGE_REASONS.MANUAL_LOCK)
    await assert.rejects(() => o.session.loadHead(), (e) => /ABORTED/.test(String(e?.code ?? e?.message)))
  })
}

/** the PR187 Production tree flags (schema/protocol/genesis/UI/media on, purge off) + preview index R/W with the approved budget */
export const oldClientServerConfig = (H, budgetBytes) => H.vaultTreeConfigFromEnv({
  VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true',
  VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_DESTRUCTIVE_PURGE_ENABLED: 'false',
  VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true',
  VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(budgetBytes),
})
