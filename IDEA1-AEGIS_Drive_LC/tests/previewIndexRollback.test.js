// tests/previewIndexRollback.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task I.2 · rollback matrix without down-migration (PostgreSQL)
//
// One disposable PostgreSQL 15 database (TEMPLATE aegis_drive_test = current schema incl. migration 012, drive_app
// non-superuser) and ONE storage root are served side by side by three code revisions, so every "rollback" is the
// same data under different server code — exactly what a Production image swap does:
//   current  — this branch: WRITE on (approved 8 GiB), WRITE off, READ off
//   stage1   — D1_STAGE1_ROOT  = 9f5a0114 (PR-A + PR-B + #297; compatibility reader, no write route)
//   baseline — D1_BASELINE_ROOT = 2dc596d1 (A.0; server/src/package byte-identical to the accepted P1 runtime 8634360f)
// Tree flows use the baseline (P1) client modules. Every SQL statement of the run is captured: no DROP/DELETE/TRUNCATE
// may reach a blob, lifecycle or preview-index table; there is no down-migration anywhere.
// Needs TEST_DATABASE_URL, D1_BASELINE_ROOT and D1_STAGE1_ROOT; otherwise skipped with an explicit reason — an evidence
// run must show 0 skips. Tests are ordered: A, A′ run before any index exists; B–E after.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE_ROOT = process.env.D1_BASELINE_ROOT ? path.resolve(process.env.D1_BASELINE_ROOT) : null
const S1_ROOT = process.env.D1_STAGE1_ROOT ? path.resolve(process.env.D1_STAGE1_ROOT) : null
const skip = !process.env.TEST_DATABASE_URL ? 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'
  : !BASE_ROOT || !S1_ROOT ? 'needs D1_BASELINE_ROOT (2dc596d1) and D1_STAGE1_ROOT (9f5a0114) IDEA1 worktree directories' : false
if (!skip) process.env.PI_UPLOAD_PG = '1'
const H = skip ? null : await import('./helpers/previewIndexUploadHarness.mjs')
const { loadClientModules, transportOf, buildPreviewIndexFor } = await import('./helpers/previewIndexOldClientSpec.mjs')
const { APPROVED_BUDGET_BYTES } = await import('./helpers/previewIndexSecurityGateSpec.mjs')
const { loginClient, DEMO_ADMIN } = await import('./helpers/testClient.mjs')

const TREE = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true', VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_DESTRUCTIVE_PURGE_ENABLED: 'false' }
const READ = { ...TREE, VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true' }
const PROTECTED = /\b(vault_v2_blobs|vault_v2_blob_chunks|vault_tree_blob_state|vault_tree_revisions|vault_tree_heads|vault_preview_index_heads|vault_preview_index_generations|vault_preview_index_blob_refs)\b/i
const PI = '/api/vault/tree/preview-index'
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

const statements = []
let restoreCapture = () => {}
const url = {}
const extra = []
let OLD, baseMods, s1Mods
const ev = {} // per-case end-state evidence, printed at the end

async function startRevision(root, envFlags, label) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
  const [appMod, cfgMod, fileStore, vaultStore, staging, manifest, probe, treeStore] = await Promise.all([
    imp('server/app.js'), imp('server/config/vaultTreeLimits.js'), imp('server/storage/fileStore.js'), imp('server/storage/vaultStore.js'),
    imp('server/storage/vaultStaging.js'), imp('server/storage/vaultManifestStore.js'), imp('server/db/vaultTreeSchemaProbe.js'), imp('server/db/vaultTreeStore.js'),
  ])
  const conn = await imp('server/db/connection.js')
  await fileStore.initStorage(); await vaultStore.initVaultStorage(); await staging.initVaultStaging(); await manifest.initVaultManifestStorage()
  const config = cfgMod.vaultTreeConfigFromEnv(envFlags)
  const boot = { tree: await cfgMod.verifyTreeSchema(config, probe.probeTreeSchema) }
  if (cfgMod.verifyPreviewIndexSchema) boot.previewIndex = await cfgMod.verifyPreviewIndexSchema(config, probe.probePreviewIndexSchema)
  const s = appMod.createApp({ vaultTreeConfig: config }).listen(0, '127.0.0.1')
  await new Promise((r) => s.once('listening', r))
  extra.push(s)
  url[label] = `http://127.0.0.1:${s.address().port}`
  return { treeStore, boot, config, conn }
}

before(async () => {
  if (skip) return
  await H.setup({
    curWrite: H.vaultTreeConfigFromEnv({ ...READ, VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(APPROVED_BUDGET_BYTES) }),
    curOff: H.vaultTreeConfigFromEnv(READ),
    curReadOff: H.vaultTreeConfigFromEnv(TREE),
  })
  await H.reset() // test-only full-table reset of the fresh database — BEFORE statement capture starts
  // every statement from here on belongs to the matrix (server code of all three revisions + test reads)
  const pg = (await import('pg')).default
  const real = pg.Client.prototype.query
  pg.Client.prototype.query = function (q, ...rest) { statements.push(typeof q === 'string' ? q : q?.text ?? ''); return real.call(this, q, ...rest) }
  restoreCapture = () => { pg.Client.prototype.query = real }
  for (const k of ['curWrite', 'curOff', 'curReadOff']) url[k] = H.base(k)
  baseMods = await startRevision(BASE_ROOT, TREE, 'baseline')
  s1Mods = await startRevision(S1_ROOT, READ, 'stage1')
  OLD = await loadClientModules(BASE_ROOT)
})
after(async () => {
  if (skip) return
  await Promise.all(extra.map((s) => new Promise((r) => s.close(r))))
  // the older revisions own separate pools on the same database: close them before the harness drops it
  for (const m of [baseMods, s1Mods]) await m?.conn?.closePool?.()
  restoreCapture()
  await H.teardown()
})

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const q = async (sql, params = []) => (await H.connection.query(sql, params)).rows
async function indexSnapshot() {
  const blobs = await q(`SELECT s.blob_id, s.lifecycle, b.ciphertext_size::bigint AS size FROM vault_tree_blob_state s JOIN vault_v2_blobs b ON b.id = s.blob_id AND b.user_id = s.user_id
                          WHERE s.lifecycle IN ('INDEX_STAGED','INDEX_MANAGED') ORDER BY s.blob_id`)
  const [heads] = await q('SELECT count(*)::int AS n FROM vault_preview_index_heads')
  const [gens] = await q('SELECT count(*)::int AS n FROM vault_preview_index_generations')
  const [refs] = await q('SELECT count(*)::int AS n FROM vault_preview_index_blob_refs')
  return { blobs: blobs.map((r) => `${r.blob_id}:${r.lifecycle}:${r.size}`), heads: heads.n, generations: gens.n, refs: refs.n }
}
async function schemaFacts() {
  const [t] = await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs')`)
  const [c] = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='vault_tree_blob_state'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%'`)
  return { d1Tables: t.n, lifecycleCheckHasIndexValues: /INDEX_STAGED/.test(c.def) && /INDEX_MANAGED/.test(c.def) }
}
async function newAccount(base) {
  const admin = await loginClient(base, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const username = `rb${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
  const res = await admin.req('/api/users', { method: 'POST', body: { name: 'Rollback Matrix', username, role: 'DataLake-User' } })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  const acct = { username, password: res.data.tempPassword, passphrase: `rb-${crypto.randomBytes(6).toString('hex')}`, files: {} }
  const client = await loginClient(base, username, acct.password)
  acct.password = client.password ?? acct.password
  acct.userId = String((await H.connection.getUserByUsername(username)).id)
  const setup = await OLD.createVaultSetup(acct.passphrase, FAST)
  assert.equal((await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  const g = await OLD.runGenesis({ kek: setup.kek, api: transportOf(client, OLD.treeApi).api })
  assert.equal(g.protocolState, 'TREE_V1')
  acct.loginPassword = acct.password
  acct.clients = { [base]: client }
  return acct
}
async function clientFor(acct, base) {
  if (!acct.clients[base]) {
    const any = Object.values(acct.clients)[0]
    acct.clients[base] = await loginClient(base, acct.username, any.currentPassword ?? acct.loginPassword)
  }
  return acct.clients[base]
}
async function unlock(acct, base) {
  const client = await clientFor(acct, base)
  const v = await client.req('/api/vault'); assert.equal(v.status, 200)
  const u = await OLD.unlockVault(acct.passphrase, { saltB64: v.data.saltB64, params: v.data.params, verifier: v.data.verifier })
  const kek = u?.kek ?? u
  const unlocked = OLD.createUnlockedVaultState()
  const t = transportOf(client, OLD.treeApi)
  const session = OLD.createTreeSession({ kek, api: t.api, unlockedState: unlocked })
  await session.loadHead()
  return { client, kek, unlocked, t, session, inventory: v.data.blobs, inventoryBytes: Buffer.byteLength(JSON.stringify(v.data)) }
}
const child = (o, parent, name) => OLD.childrenOf(o.session.head.index, parent, { view: 'all' }).find((n) => n.name === name)
const rootOf = (o) => o.session.head.manifest.rootNodeId
async function download(o, node) {
  const blob = (await o.client.req('/api/vault')).data.blobs.find((b) => String(b.id) === String(node.blobRef.id))
  const sink = OLD.createBufferedSink()
  const r = await OLD.downloadVaultV2({ kek: o.kek, blob, sink, fetchBytes: o.t.fetchBytes })
  assert.equal(r.ok, true, r.reason)
  return sha(Buffer.concat(sink.result().map((p) => Buffer.from(p))))
}
/** P1/baseline client flows on `base`: upload, byte-exact downloads (new + every known file), rename, trash, restore, orphan listing, lock */
async function p1Flows(acct, base, label) {
  const o = await unlock(acct, base)
  const root = rootOf(o)
  const name = `${label}-${crypto.randomBytes(3).toString('hex')}.txt`
  const bytes = Buffer.from(`${label} ${crypto.randomBytes(32).toString('hex')}\n`.repeat(25))
  const up = await OLD.uploadTreeFile({ kek: o.kek, file: new File([bytes], name, { type: 'text/plain' }), parentNodeId: root, session: o.session, unlockedState: o.unlocked, fetchJson: o.t.fetchJson, sendUpload: o.t.sendUpload, concurrency: 1 })
  assert.equal(up.ok, true, `upload ${up.stage} ${up.reason}`)
  acct.files[name] = sha(bytes)
  for (const [n, h] of Object.entries(acct.files)) assert.equal(await download(o, child(o, root, n)), h, `byte-exact ${n} on ${label}`)
  const renamed = `r-${name}`
  await o.session.commit(OLD.intents.rename({ nodeId: child(o, root, name).nodeId, name: renamed }))
  acct.files[renamed] = acct.files[name]; delete acct.files[name]
  const n = child(o, root, renamed)
  await o.session.commit(OLD.intents.trash({ nodeIds: [n.nodeId] }))
  await o.session.commit(OLD.intents.restore({ nodeId: n.nodeId }))
  assert.ok(child(o, root, renamed))
  const orphans = await OLD.listOrphanBlobs({ kek: o.kek, api: o.t.api, index: o.session.head.index })
  assert.equal(orphans.length, 0, 'recovery offers nothing')
  assert.equal(o.session.head.manifestSchemaVersion, 1)
  o.unlocked.purge(OLD.PURGE_REASONS.MANUAL_LOCK)
  return { inventoryBytes: o.inventoryBytes, inventoryIds: o.inventory.map((b) => String(b.id)) }
}
async function readerOn(acct, base, nodeName) {
  const { createPreviewIndexReader } = await import('../src/lib/vaultPreviewIndexReader.js')
  const o = await unlock(acct, base)
  const t = o.t
  const api = {
    async getPreviewIndexHead() { const r = await t.fetchJson(`${PI}/head`); if (r.status === 404) return null; if (!r.ok) throw Object.assign(new Error(`head ${r.status}`), { status: r.status, code: r.data?.code }); return r.data },
    async getPreviewIndexEnvelopes(ids) { const r = await t.fetchJson(`${PI}/envelopes?ids=${ids.join(',')}`); if (!r.ok) throw new Error(`envelopes ${r.status}`); return r.data.blobs },
  }
  const reader = createPreviewIndexReader({ kek: o.kek, api, fetchBytes: t.fetchBytes })
  const loaded = await reader.load({ treeId: o.session.head.treeId, generation: o.session.head.generation, index: o.session.head.index })
  const node = child(o, rootOf(o), nodeName)
  const entry = loaded.status === 'READY' ? await reader.lookup(o.session.head.index.nodes.get(node.nodeId), 'thumb') : null
  const original = await download(o, node)
  o.unlocked.purge(OLD.PURGE_REASONS.MANUAL_LOCK)
  return { status: loaded.status, entry, original }
}

const ctx = {}
// ── cases ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('RB-A new server → baseline (P1) code BEFORE any index exists: baseline boots on the migrated DB, ignores the D-1 tables, all baseline flows pass', { skip }, async () => {
  assert.deepEqual(await indexSnapshot(), { blobs: [], heads: 0, generations: 0, refs: 0 })
  assert.equal(baseMods.boot.tree.probed, true, 'baseline 7-table tree probe passes on the 012-migrated database')
  const acct = await newAccount(url.curWrite)
  const onNew = await p1Flows(acct, url.curWrite, 'a-new')
  const onBase = await p1Flows(acct, url.baseline, 'a-base')
  ctx.a = acct
  ev.A = { ...(await schemaFacts()), index: await indexSnapshot(), flows: { newServer: Boolean(onNew), baseline: Boolean(onBase) } }
  assert.deepEqual(ev.A.index, { blobs: [], heads: 0, generations: 0, refs: 0 })
  assert.equal(ev.A.d1Tables, 3, 'migration 012 retained')
})

test('RB-A′ Stage 1 → P1 runtime (migration 012 retained, no index): P1 boots and every P1 flow passes; the D-1 tables stay', { skip }, async () => {
  assert.equal(s1Mods.boot.tree.probed, true); assert.equal(s1Mods.boot.previewIndex?.probed, true, 'Stage 1 preview-index probe passes')
  const acct = await newAccount(url.stage1)
  await p1Flows(acct, url.stage1, 'a1-stage1')
  const head = await (await clientFor(acct, url.stage1)).req(`${PI}/head`)
  assert.deepEqual([head.status, head.data?.code], [404, 'PREVIEW_INDEX_NOT_FOUND'], 'Stage 1 reader: absent index')
  await p1Flows(acct, url.baseline, 'a1-p1')
  ev.Aprime = { ...(await schemaFacts()), index: await indexSnapshot() }
  assert.deepEqual(ev.Aprime.index, { blobs: [], heads: 0, generations: 0, refs: 0 })
  assert.equal(ev.Aprime.d1Tables, 3)
})

test('RB-SETUP the current writer path creates a preview index (WRITE on, approved budget)', { skip }, async () => {
  const acct = await newAccount(url.curWrite)
  const o = await unlock(acct, url.curWrite)
  const bytes = Buffer.from(`indexed original ${crypto.randomBytes(32).toString('hex')}\n`.repeat(25))
  const up = await OLD.uploadTreeFile({ kek: o.kek, file: new File([bytes], 'photo.txt', { type: 'text/plain' }), parentNodeId: rootOf(o), session: o.session, unlockedState: o.unlocked, fetchJson: o.t.fetchJson, sendUpload: o.t.sendUpload, concurrency: 1 })
  assert.equal(up.ok, true)
  acct.files['photo.txt'] = sha(bytes)
  const built = await buildPreviewIndexFor({ client: o.client, kek: o.kek, treeId: o.session.head.treeId, node: child(o, rootOf(o), 'photo.txt') })
  assert.equal(built.status, 200, JSON.stringify(built.data))
  o.unlocked.purge(OLD.PURGE_REASONS.MANUAL_LOCK)
  ctx.x = acct; ctx.ids = built.ids
  ctx.snapshot = await indexSnapshot()
  assert.equal(ctx.snapshot.blobs.length, 3); assert.equal(ctx.snapshot.heads, 1)
  const now = await readerOn(acct, url.curWrite, 'photo.txt')
  assert.equal(now.status, 'READY'); assert.equal(now.entry?.blobRef.id, ctx.ids.derivative)
})

test('RB-B new server → baseline AFTER index creation: boots; UNREFERENCED excludes INDEX_*; main CAS refuses INDEX_*; GET /api/vault carries the index envelopes (documented degraded payload); no data loss', { skip }, async () => {
  const acct = ctx.x
  const client = await clientFor(acct, url.baseline)
  const unref = await client.req('/api/vault/tree/blobs?lifecycle=UNREFERENCED')
  assert.equal(unref.status, 200)
  for (const id of Object.values(ctx.ids)) assert.equal(JSON.stringify(unref.data).includes(id), false, `UNREFERENCED lists ${id}`)
  const head = await baseMods.treeStore.getHead(acct.userId)
  const rev = crypto.randomBytes(16).toString('base64url'), key = crypto.randomBytes(16).toString('base64url')
  assert.equal((await baseMods.treeStore.createRevision(acct.userId, { revisionId: rev, treeId: head.treeId, baseRevisionId: head.revisionId, generation: head.generation + 1, manifestSchemaVersion: 1, ivB64: crypto.randomBytes(12).toString('base64'), wrappedManifestDekB64: crypto.randomBytes(48).toString('base64'), wrapIvB64: crypto.randomBytes(12).toString('base64'), idempotencyKey: key })).ok, true)
  assert.equal((await baseMods.treeStore.markRevisionPublished(acct.userId, rev, { storageKey: `vault-tree/${rev}.aegisenc`, ciphertextSize: 4112, sha256: 'b'.repeat(64) })).ok, true)
  const cas = await baseMods.treeStore.casHead(acct.userId, { expectedGeneration: head.generation, expectedRevisionId: head.revisionId, revisionId: rev, attachBlobRefs: [{ formatVersion: 2, id: ctx.ids.derivative }], idempotencyKey: key })
  assert.deepEqual([cas.ok, cas.code], [false, 'TREE_BLOB_STATE_CONFLICT'], 'baseline main CAS refuses an INDEX_* blob')
  const newInv = await (await clientFor(acct, url.curWrite)).req('/api/vault')
  const baseInv = await client.req('/api/vault')
  const ids = (d) => d.blobs.map((b) => String(b.id))
  for (const id of Object.values(ctx.ids)) {
    assert.equal(ids(newInv.data).includes(id), false, 'current server excludes index envelopes')
    assert.equal(ids(baseInv.data).includes(id), true, 'baseline includes them (documented degraded payload)')
  }
  await p1Flows(acct, url.baseline, 'b-base')
  ev.B = { index: await indexSnapshot(), inventoryBytesNew: Buffer.byteLength(JSON.stringify(newInv.data)), inventoryBytesBaseline: Buffer.byteLength(JSON.stringify(baseInv.data)), extraEnvelopes: Object.values(ctx.ids).length }
  assert.deepEqual(ev.B.index, ctx.snapshot, 'no index row/blob lost or changed')
})

test('RB-C writer-capable build with WRITE off → Stage 1 build: identical reads, zero index writes before and after', { skip }, async () => {
  const acct = await newAccount(url.curOff)
  const before = await indexSnapshot()
  await p1Flows(acct, url.curOff, 'c-off')
  await p1Flows(acct, url.stage1, 'c-s1')
  for (const who of [acct, ctx.x]) {
    const off = await (await clientFor(who, url.curOff)).req(`${PI}/head`)
    const s1 = await (await clientFor(who, url.stage1)).req(`${PI}/head`)
    assert.equal(off.status, s1.status); assert.deepEqual(off.data, s1.data, 'identical head read on both builds')
  }
  const offPost = await (await clientFor(acct, url.curOff)).req(`${PI}/head`, { method: 'POST', body: {} })
  const s1Post = await (await clientFor(acct, url.stage1)).req(`${PI}/head`, { method: 'POST', body: {} })
  assert.deepEqual([offPost.status, offPost.data?.code], [503, 'PREVIEW_INDEX_WRITE_DISABLED'])
  assert.equal(s1Post.status, 404, 'Stage 1 has no write route')
  ev.C = { index: await indexSnapshot(), writeRoute: { writerCapableWriteOff: offPost.status, stage1: s1Post.status } }
  assert.deepEqual(ev.C.index, before, 'zero index writes')
})

test('RB-D writer-capable build after index creation → Stage 1 compatibility reader: the index is read-only and still used; no write possible; originals intact', { skip }, async () => {
  const r = await readerOn(ctx.x, url.stage1, 'photo.txt')
  assert.equal(r.status, 'READY'); assert.equal(r.entry?.blobRef.id, ctx.ids.derivative, 'tiles still derivative-first')
  assert.equal(r.original, ctx.x.files['photo.txt'], 'original byte-exact')
  const c = await clientFor(ctx.x, url.stage1)
  assert.equal((await c.req(`${PI}/head`, { method: 'POST', body: {} })).status, 404)
  assert.equal((await c.req(`${PI}/uploads`, { method: 'POST', body: {} })).status, 404, 'no preview-index upload family on Stage 1')
  ev.D = { index: await indexSnapshot(), reader: r.status }
  assert.deepEqual(ev.D.index, ctx.snapshot)
})

test('RB-E writer disabled in place (same code, WRITE=false): flag off, writer routes 503, index read with READ on and ignored with READ off; originals intact', { skip }, async () => {
  const c = await clientFor(ctx.x, url.curOff)
  const state = await c.req('/api/vault/tree/state')
  assert.equal(state.data.flags.previewIndexWriteEnabled, false)
  for (const p of [`${PI}/head`, `${PI}/uploads`]) {
    const r = await c.req(p, { method: 'POST', body: {} })
    assert.deepEqual([r.status, r.data?.code], [503, 'PREVIEW_INDEX_WRITE_DISABLED'], p)
  }
  const on = await readerOn(ctx.x, url.curOff, 'photo.txt')
  assert.equal(on.status, 'READY'); assert.equal(on.entry?.blobRef.id, ctx.ids.derivative)
  const offHead = await (await clientFor(ctx.x, url.curReadOff)).req(`${PI}/head`)
  assert.deepEqual([offHead.status, offHead.data?.code], [503, 'PREVIEW_INDEX_DISABLED'])
  const off = await readerOn(ctx.x, url.curReadOff, 'photo.txt')
  assert.notEqual(off.status, 'READY'); assert.equal(off.entry, null, 'READ off → original path')
  assert.equal(off.original, ctx.x.files['photo.txt'])
  ev.E = { index: await indexSnapshot(), readOn: on.status, readOff: off.status }
  assert.deepEqual(ev.E.index, ctx.snapshot)
})

test('RB-NODELETE across the whole matrix: no down-migration, no DROP/DELETE/TRUNCATE on protected tables, no purge candidate, D-1 schema intact', { skip }, async () => {
  const destructive = statements.filter((sql) => /\b(DELETE|TRUNCATE|DROP)\b/i.test(sql) && PROTECTED.test(sql))
  assert.deepEqual(destructive, [])
  assert.equal(statements.filter((sql) => /INSERT\s+INTO\s+vault_tree_purge_candidates/i.test(sql)).length, 0)
  assert.equal(statements.filter((sql) => /\bDROP\s+(TABLE|CONSTRAINT|TRIGGER|FUNCTION)\b/i.test(sql)).length, 0, 'no down-migration DDL')
  assert.ok(statements.length > 200, `statement capture live (${statements.length})`)
  const facts = await schemaFacts()
  assert.deepEqual(facts, { d1Tables: 3, lifecycleCheckHasIndexValues: true })
  assert.deepEqual(await indexSnapshot(), ctx.snapshot, 'index objects identical to creation time')
  console.log(`# RB_EVIDENCE ${JSON.stringify({ ...ev, statementsCaptured: statements.length })}`)
})
