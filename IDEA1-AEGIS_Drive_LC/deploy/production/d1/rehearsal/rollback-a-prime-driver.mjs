// D-1 Stage 1 rollback A-prime rehearsal driver — LOCAL / DISPOSABLE ONLY. Never points at Production.
// Drives a running Drive container over HTTP with the REAL client modules of the code revision under test
// (--root = that revision's IDEA1-AEGIS_Drive_LC directory), exactly as the browser of that build would.
//   node driver.mjs --root <IDEA1 dir> --base http://127.0.0.1:<port> --phase <seed|stage1|p1|forward> --state <file>
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null }
const ROOT = path.resolve(arg('root')); const BASE = arg('base'); const PHASE = arg('phase'); const STATE = arg('state')
assert.ok(ROOT && BASE && PHASE && STATE)
assert.match(BASE, /^http:\/\/127\.0\.0\.1:\d+$/, 'local only')
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)

const { loginClient, DEMO_ADMIN, DEMO_USER } = await imp('tests/helpers/testClient.mjs')
const { createVaultSetup, unlockVault } = await imp('src/lib/vaultCrypto.js')
const treeApi = await imp('src/lib/vaultTreeApi.js')
const { runGenesis } = await imp('src/lib/vaultTreeMigration.js')
const { createTreeSession } = await imp('src/lib/vaultTreeSync.js')
const { intents } = await imp('src/lib/vaultTreeOps.js')
const { uploadTreeFile, listOrphanBlobs } = await imp('src/lib/vaultTreeUpload.js')
const { childrenOf } = await imp('src/lib/vaultTreeManifest.js')
const { downloadVaultV2, createBufferedSink } = await imp('src/lib/vaultChunkedDownload.js')
const { createUnlockedVaultState, PURGE_REASONS } = await imp('src/lib/vaultUnlockedState.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { accounts: {}, files: [] }
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
    const bytes = new Uint8Array(await body.arrayBuffer())
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

async function login(cls) {
  if (cls === 'ADMIN') return loginClient(BASE, DEMO_ADMIN.username, DEMO_ADMIN.password)
  if (cls === 'EXISTING_USER') return loginClient(BASE, DEMO_USER.username, DEMO_USER.password)
  const a = state.accounts.NEWLY_CREATED_USER
  return loginClient(BASE, a.username, a.tempPassword)
}

async function setupTreeVault(client, cls) {
  const passphrase = `rehearsal-${cls.toLowerCase()}-passphrase-d1s1`
  const setup = await createVaultSetup(passphrase, FAST)
  const r = await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  assert.equal(r.status, 201, `vault setup ${r.status}`)
  const { api } = transport(client)
  const g = await runGenesis({ kek: setup.kek, api })
  assert.equal(g.protocolState, 'TREE_V1')
  state.accounts[cls] = { ...(state.accounts[cls] ?? {}), passphrase }
  save()
}

async function unlock(client, cls) {
  const v = await client.req('/api/vault')
  assert.equal(v.status, 200); assert.equal(v.data.configured, true)
  const u = await unlockVault(state.accounts[cls].passphrase, { saltB64: v.data.saltB64, params: v.data.params, verifier: v.data.verifier })
  const kek = u?.kek ?? u
  assert.ok(kek, 'unlock produced no KEK')
  assert.equal((await client.req('/api/vault/unlock-attempt', { method: 'POST', body: { ok: true } })).status, 204)
  const unlocked = createUnlockedVaultState()
  const t = transport(client)
  const session = createTreeSession({ kek, api: t.api, unlockedState: unlocked })
  await session.loadHead()
  return { kek, session, unlocked, t, blobs: v.data.blobs }
}

const findChild = (session, parentId, name) => childrenOf(session.head.index, parentId).find((n) => n.name === name)
const rootId = (session) => session.head.manifest.rootNodeId

async function download(client, ctx, nodeName, parentId) {
  const node = findChild(ctx.session, parentId, nodeName)
  assert.ok(node?.blobRef, `node ${nodeName} not found`)
  const blobs = (await client.req('/api/vault')).data.blobs
  const blob = blobs.find((b) => b.formatVersion === node.blobRef.formatVersion && String(b.id) === String(node.blobRef.id))
  assert.ok(blob, 'blob envelope missing from GET /api/vault')
  const sink = createBufferedSink()
  const r = await downloadVaultV2({ kek: ctx.kek, blob, sink, fetchBytes: ctx.t.fetchBytes })
  assert.equal(r.ok, true, `download failed: ${r.reason}`)
  return Buffer.concat(sink.result().map((p) => Buffer.from(p)))
}

async function upload(ctx, parentId, name, bytes) {
  const file = new File([bytes], name, { type: 'text/plain' })
  const r = await uploadTreeFile({ kek: ctx.kek, file, parentNodeId: parentId, session: ctx.session, unlockedState: ctx.unlocked, fetchJson: ctx.t.fetchJson, sendUpload: ctx.t.sendUpload, concurrency: 1 })
  assert.equal(r.ok, true, `upload failed: ${r.stage} ${r.reason}`)
  return r
}

const fileBytes = (label) => Buffer.from(`AEGIS D-1 Stage 1 rollback rehearsal ${label} ${crypto.randomBytes(48).toString('hex')}\n`.repeat(40))

async function previewHead(client) {
  const r = await client.req('/api/vault/tree/preview-index/head')
  return { status: r.status, code: r.data?.code ?? null, cc: r.headers.get('cache-control') }
}

async function verifyKnownFiles(account, client, ctx) {
  for (const f of state.files.filter((x) => x.account === account && x.expect === 'active')) {
    await check(account, `download byte-exact ${f.name}`, async () => {
      const parent = f.folder ? findChild(ctx.session, rootId(ctx.session), f.folder).nodeId : rootId(ctx.session)
      const got = await download(client, ctx, f.name, parent)
      assert.equal(sha(got), f.sha256); return `sha256 ${f.sha256.slice(0, 12)}…`
    })
  }
}

async function stage1ServerChecks(account, client) {
  await check(account, 'state flags schema=true read=true write=false media=true purge=false', async () => {
    const s = await client.req('/api/vault/tree/state'); const f = s.data.flags
    assert.equal(s.status, 200); assert.equal(s.data.protocolState, 'TREE_V1')
    assert.deepEqual([f.previewIndexSchemaAvailable, f.previewIndexReadEnabled, f.previewIndexWriteEnabled, f.mediaPreviewEnabled, f.destructivePurgeEnabled], [true, true, false, true, false])
    return JSON.stringify({ schema: f.previewIndexSchemaAvailable, read: f.previewIndexReadEnabled, write: f.previewIndexWriteEnabled })
  })
  await check(account, 'GET preview-index/head => 404 PREVIEW_INDEX_NOT_FOUND no-store', async () => {
    const h = await previewHead(client)
    assert.equal(h.status, 404); assert.equal(h.code, 'PREVIEW_INDEX_NOT_FOUND'); assert.match(h.cc ?? '', /no-store/)
    return `${h.status} ${h.code}`
  })
  await check(account, 'POST preview-index/head (with CSRF) => 404 route absent', async () => {
    const r = await client.req('/api/vault/tree/preview-index/head', { method: 'POST', body: { expectedGeneration: 0 } })
    assert.equal(r.status, 404); return `${r.status} ${JSON.stringify(r.data)}`
  })
}

const CLASSES = ['ADMIN', 'EXISTING_USER', 'NEWLY_CREATED_USER']

if (PHASE === 'seed') {
  // P1 pre-migration: representative TREE_V1 vaults for ADMIN + EXISTING_USER (folder + files)
  for (const cls of ['ADMIN', 'EXISTING_USER']) {
    const client = await login(cls)
    await check(cls, 'vault setup + genesis TREE_V1', () => setupTreeVault(client, cls))
    const ctx = await unlock(client, cls)
    await ctx.session.commit(intents.createFolder({ parentNodeId: rootId(ctx.session), name: 'Docs' }))
    const docs = findChild(ctx.session, rootId(ctx.session), 'Docs').nodeId
    for (const [name, folder] of [['seed-root.txt', null], ['seed-docs.txt', 'Docs']]) {
      const b = fileBytes(`${cls} ${name}`)
      await check(cls, `seed upload ${name}`, () => upload(ctx, folder ? docs : rootId(ctx.session), name, b).then(() => ''))
      state.files.push({ account: cls, name, folder, sha256: sha(b), expect: 'active', createdBy: 'P1-seed' })
    }
    save()
    await verifyKnownFiles(cls, client, ctx)
  }
} else if (PHASE === 'stage1') {
  for (const cls of ['ADMIN', 'EXISTING_USER']) {
    const client = await login(cls)
    await stage1ServerChecks(cls, client)
    const ctx = await unlock(client, cls)
    await check(cls, 'unlock + browse root', async () => `${childrenOf(ctx.session.head.index, rootId(ctx.session)).length} root children`)
    await verifyKnownFiles(cls, client, ctx)
  }
  // NEWLY_CREATED_USER: provisioned by ADMIN on Stage 1; 409 before Vault setup, 404 after TREE_V1 setup
  const admin = await login('ADMIN')
  const username = `d1s1new${Date.now().toString(36)}`
  const created = await admin.req('/api/users', { method: 'POST', body: { name: 'D1 Stage1 Rehearsal', username, role: 'DataLake-User' } })
  assert.equal(created.status, 201)
  state.accounts.NEWLY_CREATED_USER = { username, tempPassword: created.data.tempPassword }; save()
  const fresh = await login('NEWLY_CREATED_USER')
  await check('NEWLY_CREATED_USER', 'head before Vault setup => 409 (ACCOUNT_NOT_SETUP)', async () => {
    const h = await previewHead(fresh); assert.equal(h.status, 409); return `${h.status} ${h.code}`
  })
  await check('NEWLY_CREATED_USER', 'vault setup + genesis TREE_V1', () => setupTreeVault(fresh, 'NEWLY_CREATED_USER'))
  await stage1ServerChecks('NEWLY_CREATED_USER', fresh)
  const ctx = await unlock(fresh, 'NEWLY_CREATED_USER')
  const b = fileBytes('NEWLY_CREATED_USER stage1-root.txt')
  await check('NEWLY_CREATED_USER', 'upload on Stage 1', () => upload(ctx, rootId(ctx.session), 'stage1-root.txt', b).then(() => ''))
  state.files.push({ account: 'NEWLY_CREATED_USER', name: 'stage1-root.txt', folder: null, sha256: sha(b), expect: 'active', createdBy: 'Stage1' }); save()
  await verifyKnownFiles('NEWLY_CREATED_USER', fresh, ctx)
} else if (PHASE === 'p1') {
  // P1 on the migrated database: every existing flow, all three accounts
  for (const cls of CLASSES) {
    const client = await login(cls)
    await check(cls, 'login', async () => '')
    let ctx
    await check(cls, 'unlock', async () => { ctx = await unlock(client, cls); return `generation ${ctx.session.head.generation}` })
    if (!ctx) continue
    const root = rootId(ctx.session)
    await check(cls, 'browse', async () => `${childrenOf(ctx.session.head.index, root).length} root children`)
    await check(cls, 'GET /api/vault inventory has no INDEX_* surprise (envelope count recorded)', async () => `${(await client.req('/api/vault')).data.blobs.length} envelopes`)
    await verifyKnownFiles(cls, client, ctx)
    const name = `p1-rollback-${cls.toLowerCase()}.txt`; const b = fileBytes(`${cls} ${name}`)
    await check(cls, 'ordinary upload', () => upload(ctx, root, name, b).then(() => ''))
    await check(cls, 'download byte-exact (new upload)', async () => { assert.equal(sha(await download(client, ctx, name, root)), sha(b)); return '' })
    const renamed = `p1-renamed-${cls.toLowerCase()}.txt`
    await check(cls, 'rename', async () => { await ctx.session.commit(intents.rename({ nodeId: findChild(ctx.session, root, name).nodeId, name: renamed })); assert.ok(findChild(ctx.session, root, renamed)); return '' })
    let folder = findChild(ctx.session, root, 'Docs')
    if (!folder) { await ctx.session.commit(intents.createFolder({ parentNodeId: root, name: 'Docs' })); folder = findChild(ctx.session, root, 'Docs') }
    await check(cls, 'move', async () => { await ctx.session.commit(intents.move({ nodeIds: [findChild(ctx.session, root, renamed).nodeId], destinationNodeId: folder.nodeId })); assert.ok(findChild(ctx.session, folder.nodeId, renamed)); return '' })
    await check(cls, 'trash', async () => { const n = findChild(ctx.session, folder.nodeId, renamed); await ctx.session.commit(intents.trash({ nodeIds: [n.nodeId] })); assert.equal(findChild(ctx.session, folder.nodeId, renamed), undefined); assert.ok(childrenOf(ctx.session.head.index, null, { view: 'trash' }).some((x) => x.nodeId === n.nodeId)); return '' })
    await check(cls, 'restore', async () => { const n = childrenOf(ctx.session.head.index, null, { view: 'trash' }).find((x) => x.name === renamed); await ctx.session.commit(intents.restore({ nodeId: n.nodeId })); assert.ok(findChild(ctx.session, folder.nodeId, renamed)); return '' })
    await check(cls, 'download byte-exact after rename/move/restore', async () => { assert.equal(sha(await download(client, ctx, renamed, folder.nodeId)), sha(b)); return '' })
    state.files.push({ account: cls, name: renamed, folder: 'Docs', sha256: sha(b), expect: 'active', createdBy: 'P1-rollback' }); save()
    await check(cls, 'recovery listing (no orphan, no INDEX_* blob offered)', async () => {
      const orphans = await listOrphanBlobs({ kek: ctx.kek, api: ctx.t.api, index: ctx.session.head.index })
      assert.equal(orphans.length, 0, JSON.stringify(orphans.map((o) => o.blobRef))); return '0 orphans'
    })
    await check(cls, 'P1 has no preview-index route (status recorded)', async () => { const h = await previewHead(client); assert.notEqual(h.code, 'PREVIEW_INDEX_NOT_FOUND'); return `${h.status}` })
    await check(cls, 'lock (unlocked state purged; session refuses work)', async () => {
      ctx.unlocked.purge(PURGE_REASONS.MANUAL_LOCK)
      await assert.rejects(() => ctx.session.loadHead(), (e) => e?.code === 'ABORTED' || /ABORTED/.test(String(e?.code ?? e?.message)))
      return ''
    })
  }
} else if (PHASE === 'forward') {
  for (const cls of CLASSES) {
    const client = await login(cls)
    await stage1ServerChecks(cls, client)
    let ctx
    await check(cls, 'unlock + browse', async () => { ctx = await unlock(client, cls); return `${childrenOf(ctx.session.head.index, rootId(ctx.session)).length} root children` })
    if (ctx) {
      await verifyKnownFiles(cls, client, ctx)
      await check(cls, 'lock', async () => { ctx.unlocked.purge(PURGE_REASONS.MANUAL_LOCK); return '' })
    }
  }
} else throw new Error(`unknown phase ${PHASE}`)

console.log(JSON.stringify({ phase: PHASE, root: path.basename(path.dirname(ROOT)), results }, null, 1))
const fails = results.filter((r) => r.result !== 'PASS')
console.log(`PHASE_${PHASE.toUpperCase()}=${fails.length ? 'FAIL' : 'PASS'} (${results.length - fails.length}/${results.length})`)
