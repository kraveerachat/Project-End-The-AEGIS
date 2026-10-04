// D-1 Phase J rollback B/D/E replica driver — LOCAL / DISPOSABLE ONLY. Never points at Production.
// Drives the running replica Drive container over HTTP with the REAL client modules of the build under test
// (--root = that revision's IDEA1-AEGIS_Drive_LC directory); the preview-index writer path comes from --writer-root
// (the Stage 2/3 build). Database/disk assertions are made by rehearse-bde.sh, not here.
//   node bde-driver.mjs --root <IDEA1 dir> [--writer-root <IDEA1 dir>] --base http://127.0.0.1:<port> --phase <p> --state <file>
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null }
const ROOT = path.resolve(arg('root')); const WRITER_ROOT = arg('writer-root') ? path.resolve(arg('writer-root')) : null
const BASE = arg('base'); const PHASE = arg('phase'); const STATE = arg('state')
assert.ok(ROOT && BASE && PHASE && STATE)
assert.match(BASE, /^http:\/\/127\.0\.0\.1:\d+$/, 'local only')
const imp = (root, p) => import(pathToFileURL(path.join(root, p)).href)

const { loginClient, currentPasswordOf, DEMO_ADMIN, DEMO_USER } = await imp(ROOT, 'tests/helpers/testClient.mjs')
const { createVaultSetup, unlockVault } = await imp(ROOT, 'src/lib/vaultCrypto.js')
const treeApi = await imp(ROOT, 'src/lib/vaultTreeApi.js')
const { runGenesis } = await imp(ROOT, 'src/lib/vaultTreeMigration.js')
const { createTreeSession } = await imp(ROOT, 'src/lib/vaultTreeSync.js')
const { intents } = await imp(ROOT, 'src/lib/vaultTreeOps.js')
const { uploadTreeFile, listOrphanBlobs } = await imp(ROOT, 'src/lib/vaultTreeUpload.js')
const { childrenOf } = await imp(ROOT, 'src/lib/vaultTreeManifest.js')
const { downloadVaultV2, createBufferedSink } = await imp(ROOT, 'src/lib/vaultChunkedDownload.js')
const { createUnlockedVaultState, PURGE_REASONS } = await imp(ROOT, 'src/lib/vaultUnlockedState.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const PI = '/api/vault/tree/preview-index'
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { accounts: {}, files: [], index: {} }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
const results = []
const rec = (account, check, ok, detail = '') => { results.push({ account, check, result: ok ? 'PASS' : 'FAIL', detail }); if (!ok) process.exitCode = 1 }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const check = async (account, name, fn) => { try { const d = await fn(); rec(account, name, true, d ?? '') } catch (e) { rec(account, name, false, e?.message ?? String(e)) } }

function transport(client) {
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

// The current password is carried between driver processes so no login attempt fails (no rate-limit noise).
async function login(cls) {
  const [username, seed] = cls === 'ADMIN' ? [DEMO_ADMIN.username, DEMO_ADMIN.password]
    : cls === 'EXISTING_USER' ? [DEMO_USER.username, DEMO_USER.password]
      : [state.accounts.NEWLY_CREATED_USER.username, state.accounts.NEWLY_CREATED_USER.tempPassword]
  state.pw ??= {}
  const client = await loginClient(BASE, username, state.pw[username] ?? seed)
  state.pw[username] = currentPasswordOf(username) ?? state.pw[username] ?? seed; save()
  return client
}

async function setupTreeVault(client, cls) {
  const passphrase = `replica-${cls.toLowerCase()}-passphrase-d1j`
  const setup = await createVaultSetup(passphrase, FAST)
  const r = await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  assert.equal(r.status, 201, `vault setup ${r.status}`)
  const g = await runGenesis({ kek: setup.kek, api: transport(client).api })
  assert.equal(g.protocolState, 'TREE_V1')
  state.accounts[cls] = { ...(state.accounts[cls] ?? {}), passphrase }; save()
}

async function unlock(client, cls) {
  const v = await client.req('/api/vault')
  assert.equal(v.status, 200); assert.equal(v.data.configured, true)
  const u = await unlockVault(state.accounts[cls].passphrase, { saltB64: v.data.saltB64, params: v.data.params, verifier: v.data.verifier })
  const kek = u?.kek ?? u
  assert.ok(kek, 'unlock produced no KEK')
  const unlocked = createUnlockedVaultState()
  const t = transport(client)
  const session = createTreeSession({ kek, api: t.api, unlockedState: unlocked })
  await session.loadHead()
  return { client, kek, session, unlocked, t, inventory: v.data.blobs, inventoryBytes: Buffer.byteLength(JSON.stringify(v.data)) }
}

const findChild = (session, parentId, name) => childrenOf(session.head.index, parentId).find((n) => n.name === name)
const rootId = (session) => session.head.manifest.rootNodeId
const folderId = (ctx, folder) => (folder ? findChild(ctx.session, rootId(ctx.session), folder).nodeId : rootId(ctx.session))

async function download(ctx, nodeName, parentId) {
  const node = findChild(ctx.session, parentId, nodeName)
  assert.ok(node?.blobRef, `node ${nodeName} not found`)
  const blobs = (await ctx.client.req('/api/vault')).data.blobs
  const blob = blobs.find((b) => b.formatVersion === node.blobRef.formatVersion && String(b.id) === String(node.blobRef.id))
  assert.ok(blob, 'blob envelope missing from GET /api/vault')
  const sink = createBufferedSink()
  const r = await downloadVaultV2({ kek: ctx.kek, blob, sink, fetchBytes: ctx.t.fetchBytes })
  assert.equal(r.ok, true, `download failed: ${r.reason}`)
  return Buffer.concat(sink.result().map((p) => Buffer.from(p)))
}

async function upload(ctx, parentId, name, bytes, type = 'application/octet-stream') {
  const r = await uploadTreeFile({ kek: ctx.kek, file: new File([bytes], name, { type }), parentNodeId: parentId, session: ctx.session, unlockedState: ctx.unlocked, fetchJson: ctx.t.fetchJson, sendUpload: ctx.t.sendUpload, concurrency: 1 })
  assert.equal(r.ok, true, `upload failed: ${r.stage} ${r.reason}`)
  return r
}
const fileBytes = (label, n = 40) => Buffer.from(`AEGIS D-1 Phase J replica ${label} ${crypto.randomBytes(48).toString('hex')}\n`.repeat(n))

async function verifyKnownFiles(account, ctx) {
  for (const f of state.files.filter((x) => x.account === account)) {
    await check(account, `download byte-exact ${f.folder ?? ''}/${f.name}`, async () => {
      assert.equal(sha(await download(ctx, f.name, folderId(ctx, f.folder))), f.sha256); return `sha256 ${f.sha256.slice(0, 12)}…`
    })
  }
}

async function flags(client) { const s = await client.req('/api/vault/tree/state'); assert.equal(s.status, 200); return s.data.flags }
async function headOf(client) { const r = await client.req(`${PI}/head`); return { status: r.status, code: r.data?.code ?? null } }
async function postStatus(client, p) { const r = await client.req(p, { method: 'POST', body: {} }); return { status: r.status, code: r.data?.code ?? null } }

/** reader of the build under test (or --writer-root for Stage 2/3): load the index and look up the indexed node's thumb */
async function readIndexed(ctx, readerRoot, cls) {
  const { createPreviewIndexReader } = await imp(readerRoot, 'src/lib/vaultPreviewIndexReader.js')
  const api = {
    async getPreviewIndexHead() { const r = await ctx.t.fetchJson(`${PI}/head`); if (r.status === 404) return null; if (!r.ok) throw Object.assign(new Error(`head ${r.status}`), { status: r.status, code: r.data?.code }); return r.data },
    async getPreviewIndexEnvelopes(ids) { const r = await ctx.t.fetchJson(`${PI}/envelopes?ids=${ids.join(',')}`); if (!r.ok) throw new Error(`envelopes ${r.status}`); return r.data.blobs },
  }
  const reader = createPreviewIndexReader({ kek: ctx.kek, api, fetchBytes: ctx.t.fetchBytes })
  const loaded = await reader.load({ treeId: ctx.session.head.treeId, generation: ctx.session.head.generation, index: ctx.session.head.index })
  const node = findChild(ctx.session, rootId(ctx.session), state.index[cls].node)
  const entry = loaded.status === 'READY' ? await reader.lookup(ctx.session.head.index.nodes.get(node.nodeId), 'thumb') : null
  return { status: loaded.status, derivative: entry?.blobRef?.id ?? null }
}

/** ordinary Vault flows of the build under test: upload, byte-exact download, rename, move, trash, restore, orphan listing */
async function ordinaryFlows(cls, ctx, label) {
  const root = rootId(ctx.session)
  const name = `${label}-${cls.toLowerCase()}.txt`; const b = fileBytes(`${cls} ${name}`, 20)
  await check(cls, `${label}: upload`, () => upload(ctx, root, name, b, 'text/plain').then(() => ''))
  await check(cls, `${label}: download byte-exact (new upload)`, async () => { assert.equal(sha(await download(ctx, name, root)), sha(b)); return '' })
  const renamed = `${label}-renamed-${cls.toLowerCase()}.txt`
  await check(cls, `${label}: rename`, async () => { await ctx.session.commit(intents.rename({ nodeId: findChild(ctx.session, root, name).nodeId, name: renamed })); assert.ok(findChild(ctx.session, root, renamed)); return '' })
  const docs = findChild(ctx.session, root, 'Docs')
  await check(cls, `${label}: move`, async () => { await ctx.session.commit(intents.move({ nodeIds: [findChild(ctx.session, root, renamed).nodeId], destinationNodeId: docs.nodeId })); assert.ok(findChild(ctx.session, docs.nodeId, renamed)); return '' })
  await check(cls, `${label}: trash + restore`, async () => {
    const n = findChild(ctx.session, docs.nodeId, renamed)
    await ctx.session.commit(intents.trash({ nodeIds: [n.nodeId] })); assert.equal(findChild(ctx.session, docs.nodeId, renamed), undefined)
    await ctx.session.commit(intents.restore({ nodeId: n.nodeId })); assert.ok(findChild(ctx.session, docs.nodeId, renamed)); return ''
  })
  await check(cls, `${label}: download byte-exact after rename/move/restore`, async () => { assert.equal(sha(await download(ctx, renamed, docs.nodeId)), sha(b)); return '' })
  state.files.push({ account: cls, name: renamed, folder: 'Docs', sha256: sha(b), createdBy: label }); save()
  await check(cls, `${label}: recovery lists no orphan and no index/derivative blob`, async () => {
    const orphans = await listOrphanBlobs({ kek: ctx.kek, api: ctx.t.api, index: ctx.session.head.index })
    const ids = Object.values(state.index[cls]?.ids ?? {})
    assert.equal(orphans.filter((o) => ids.includes(String(o.blobRef?.id))).length, 0, 'index blob offered')
    assert.equal(orphans.length, 0, JSON.stringify(orphans.map((o) => o.blobRef))); return '0 orphans'
  })
  await check(cls, `${label}: main manifest stays schema v1`, async () => { assert.equal(ctx.session.head.manifestSchemaVersion ?? ctx.session.head.manifest?.schemaVersion ?? 1, 1); return '' })
}

const OWNERS = ['ADMIN', 'EXISTING_USER']
const ALL = ['ADMIN', 'EXISTING_USER', 'NEWLY_CREATED_USER']

if (PHASE === 'seed') {
  // Stage 1 build: two TREE_V1 owners (as Production) + one provisioned user without a Vault (FLAT, like Production's third user)
  for (const cls of OWNERS) {
    const client = await login(cls)
    await check(cls, 'Stage 1 flags schema=true read=true write=false', async () => { const f = await flags(client); assert.deepEqual([f.previewIndexSchemaAvailable, f.previewIndexReadEnabled, f.previewIndexWriteEnabled], [true, true, false]); return '' })
    await check(cls, 'vault setup + genesis TREE_V1', () => setupTreeVault(client, cls))
    const ctx = await unlock(client, cls)
    await ctx.session.commit(intents.createFolder({ parentNodeId: rootId(ctx.session), name: 'Docs' }))
    for (const [name, folder, type] of [['photo.jpg', null, 'image/jpeg'], ['notes.txt', null, 'text/plain'], ['report.txt', 'Docs', 'text/plain']]) {
      const b = fileBytes(`${cls} ${name}`)
      await check(cls, `seed upload ${folder ?? ''}/${name}`, () => upload(ctx, folderId(ctx, folder), name, b, type).then(() => ''))
      state.files.push({ account: cls, name, folder, sha256: sha(b), createdBy: 'Stage1-seed' })
    }
    state.index[cls] = { node: 'photo.jpg' }; save()
    await verifyKnownFiles(cls, ctx)
    await check(cls, 'Stage 1: GET head => 404 PREVIEW_INDEX_NOT_FOUND', async () => { const h = await headOf(client); assert.deepEqual([h.status, h.code], [404, 'PREVIEW_INDEX_NOT_FOUND']); return '' })
    await check(cls, 'Stage 1: POST head => 404 (no write route)', async () => { const h = await postStatus(client, `${PI}/head`); assert.equal(h.status, 404); return '' })
  }
  const admin = await login('ADMIN')
  const username = `d1jnew${Date.now().toString(36)}`
  const created = await admin.req('/api/users', { method: 'POST', body: { name: 'D1 Phase J Replica', username, role: 'DataLake-User' } })
  await check('ADMIN', 'provision NEWLY_CREATED_USER (no Vault yet)', async () => { assert.equal(created.status, 201); return username })
  state.accounts.NEWLY_CREATED_USER = { username, tempPassword: created.data.tempPassword }; save()
} else if (PHASE === 'stage2') {
  for (const cls of OWNERS) {
    const client = await login(cls)
    await check(cls, 'Stage 2 flags schema=true read=true write=false', async () => { const f = await flags(client); assert.deepEqual([f.previewIndexSchemaAvailable, f.previewIndexReadEnabled, f.previewIndexWriteEnabled], [true, true, false]); return '' })
    await check(cls, 'Stage 2: GET head => 404 PREVIEW_INDEX_NOT_FOUND', async () => { const h = await headOf(client); assert.deepEqual([h.status, h.code], [404, 'PREVIEW_INDEX_NOT_FOUND']); return '' })
    for (const p of [`${PI}/head`, `${PI}/uploads`]) await check(cls, `Stage 2: POST ${p} => 503 PREVIEW_INDEX_WRITE_DISABLED`, async () => { const h = await postStatus(client, p); assert.deepEqual([h.status, h.code], [503, 'PREVIEW_INDEX_WRITE_DISABLED']); return '' })
    await verifyKnownFiles(cls, await unlock(client, cls))
  }
} else if (PHASE === 'stage3') {
  // Stage 3 (WRITE=true, approved budget): create real D-1 state through the Stage 2/3 writer path for three owners
  assert.ok(WRITER_ROOT, '--writer-root required')
  const { buildPreviewIndexFor } = await imp(WRITER_ROOT, 'tests/helpers/previewIndexOldClientSpec.mjs')
  const fresh = await login('NEWLY_CREATED_USER')
  await check('NEWLY_CREATED_USER', 'vault setup + genesis TREE_V1 (after writer enablement)', () => setupTreeVault(fresh, 'NEWLY_CREATED_USER'))
  {
    const ctx = await unlock(fresh, 'NEWLY_CREATED_USER')
    await ctx.session.commit(intents.createFolder({ parentNodeId: rootId(ctx.session), name: 'Docs' }))
    const b = fileBytes('NEWLY_CREATED_USER photo.jpg')
    await check('NEWLY_CREATED_USER', 'upload /photo.jpg', () => upload(ctx, rootId(ctx.session), 'photo.jpg', b, 'image/jpeg').then(() => ''))
    state.files.push({ account: 'NEWLY_CREATED_USER', name: 'photo.jpg', folder: null, sha256: sha(b), createdBy: 'Stage3' })
    state.index.NEWLY_CREATED_USER = { node: 'photo.jpg' }; save()
  }
  for (const cls of ALL) {
    const client = await login(cls)
    await check(cls, 'Stage 3 flags write=true', async () => { const f = await flags(client); assert.equal(f.previewIndexWriteEnabled, true); return '' })
    const ctx = await unlock(client, cls)
    await check(cls, 'writer path: seal thumb + shard + root, CAS index head (generation 1)', async () => {
      const built = await buildPreviewIndexFor({ client, kek: ctx.kek, treeId: ctx.session.head.treeId, node: findChild(ctx.session, rootId(ctx.session), state.index[cls].node) })
      assert.equal(built.status, 200, JSON.stringify(built.data))
      state.index[cls].ids = built.ids; save()
      return JSON.stringify(built.ids)
    })
    await check(cls, 'Stage 3 reader READY, thumb resolves to the new derivative', async () => {
      const r = await readIndexed(ctx, WRITER_ROOT, cls); assert.equal(r.status, 'READY'); assert.equal(r.derivative, state.index[cls].ids.derivative); return r.status
    })
    await check(cls, 'Stage 3: GET /api/vault excludes index envelopes', async () => {
      const ids = (await client.req('/api/vault')).data.blobs.map((b) => String(b.id))
      for (const id of Object.values(state.index[cls].ids)) assert.equal(ids.includes(id), false, id)
      state.index[cls].inventoryEnvelopesStage3 = ids.length; save(); return `${ids.length} envelopes`
    })
    await verifyKnownFiles(cls, ctx)
  }
} else if (PHASE === 'case-e') {
  // V6 Case E: Stage 3 -> Stage 2 (same image, WRITE=false, budget unset). Plan I.2 E: flag false; writer inert; index still read; originals intact
  for (const cls of ALL) {
    const client = await login(cls)
    await check(cls, 'Case E: /state write=false read=true schema=true', async () => { const f = await flags(client); assert.deepEqual([f.previewIndexSchemaAvailable, f.previewIndexReadEnabled, f.previewIndexWriteEnabled], [true, true, false]); return '' })
    for (const p of [`${PI}/head`, `${PI}/uploads`]) await check(cls, `Case E: POST ${p} => 503 PREVIEW_INDEX_WRITE_DISABLED (fail closed)`, async () => { const h = await postStatus(client, p); assert.deepEqual([h.status, h.code], [503, 'PREVIEW_INDEX_WRITE_DISABLED']); return '' })
    await check(cls, 'Case E: GET head => 200 (existing index readable)', async () => { const h = await headOf(client); assert.equal(h.status, 200); return '' })
    const ctx = await unlock(client, cls)
    await check(cls, 'Case E: reader READY on retained index (derivative-first tiles)', async () => { const r = await readIndexed(ctx, ROOT, cls); assert.equal(r.status, 'READY'); assert.equal(r.derivative, state.index[cls].ids.derivative); return r.status })
    await verifyKnownFiles(cls, ctx)
    await ordinaryFlows(cls, ctx, 'case-e')
  }
} else if (PHASE === 'case-d') {
  // V6 Case D: writer-capable build -> Stage 1 accepted read-only build with D-1 rows. Plan I.2 D: index read-only and used; no writes; originals intact
  for (const cls of ALL) {
    const client = await login(cls)
    await check(cls, 'Case D: Stage 1 flags schema=true read=true write=false', async () => { const f = await flags(client); assert.deepEqual([f.previewIndexSchemaAvailable, f.previewIndexReadEnabled, f.previewIndexWriteEnabled], [true, true, false]); return '' })
    for (const p of [`${PI}/head`, `${PI}/uploads`]) await check(cls, `Case D: POST ${p} => 404 (Stage 1 has no write route)`, async () => { const h = await postStatus(client, p); assert.equal(h.status, 404); return `${h.status}` })
    const ctx = await unlock(client, cls)
    await check(cls, 'Case D: Stage 1 reader READY on retained index (read-only, still used)', async () => { const r = await readIndexed(ctx, ROOT, cls); assert.equal(r.status, 'READY'); assert.equal(r.derivative, state.index[cls].ids.derivative); return r.status })
    await verifyKnownFiles(cls, ctx)
    await ordinaryFlows(cls, ctx, 'case-d')
  }
} else if (PHASE === 'case-b') {
  // Plan I.2 B (V6 names Case B; the plan defines it): new reader/server -> baseline (P1) AFTER index exists
  for (const cls of ALL) {
    const client = await login(cls)
    const ids = Object.values(state.index[cls].ids)
    await check(cls, 'Case B: baseline has no preview-index route', async () => { const h = await headOf(client); assert.notEqual(h.code, 'PREVIEW_INDEX_NOT_FOUND'); assert.equal(h.status, 404); return `${h.status}` })
    await check(cls, 'Case B: /tree/blobs?lifecycle=UNREFERENCED excludes INDEX_* blobs', async () => {
      const r = await client.req('/api/vault/tree/blobs?lifecycle=UNREFERENCED'); assert.equal(r.status, 200)
      for (const id of ids) assert.equal(JSON.stringify(r.data).includes(id), false, id); return ''
    })
    await check(cls, 'Case B: GET /api/vault includes index envelopes (documented degraded payload)', async () => {
      const inv = (await client.req('/api/vault')).data
      const got = inv.blobs.map((b) => String(b.id))
      for (const id of ids) assert.equal(got.includes(id), true, id)
      state.index[cls].inventoryEnvelopesBaseline = got.length; state.index[cls].inventoryBytesBaseline = Buffer.byteLength(JSON.stringify(inv)); save()
      return `${got.length} envelopes (Stage 3: ${state.index[cls].inventoryEnvelopesStage3})`
    })
    {
      const ctx = await unlock(client, cls)
      const real = ctx.t.api.casHead
      let refused = null
      ctx.t.api.casHead = async (body, x) => {
        // the wire field is attachBlobIds: [{ formatVersion, id }] (server/routes/vaultTree.js CAS_KEYS)
        try { return await real({ ...body, attachBlobIds: [...(body.attachBlobIds ?? []), { formatVersion: 2, id: state.index[cls].ids.derivative }] }, x) } catch (e) { refused = e; throw e }
      }
      await check(cls, 'Case B: baseline main CAS refuses to attach an INDEX_* blob', async () => {
        const n = findChild(ctx.session, rootId(ctx.session), state.index[cls].node)
        await assert.rejects(() => ctx.session.commit(intents.rename({ nodeId: n.nodeId, name: 'attach-probe.jpg' })))
        assert.equal(refused?.code, 'TREE_BLOB_STATE_CONFLICT', `got ${refused?.code} ${refused?.status}`); return `${refused.status} ${refused.code}`
      })
    }
    const ctx = await unlock(client, cls)
    await verifyKnownFiles(cls, ctx)
    await ordinaryFlows(cls, ctx, 'case-b')
  }
} else throw new Error(`unknown phase ${PHASE}`)

console.log(JSON.stringify({ phase: PHASE, root: path.basename(path.dirname(ROOT)), results }, null, 1))
const fails = results.filter((r) => r.result !== 'PASS')
console.log(`DRIVER_${PHASE.toUpperCase().replace(/-/g, '_')}=${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`)
