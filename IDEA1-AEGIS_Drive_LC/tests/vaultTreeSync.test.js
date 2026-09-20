// tests/vaultTreeSync.test.js — AEGIS Drive (IDEA1) · PR #157 Task 5.3 · mutation protocol session (SY-1..SY-11)
//
// backend = tests/helpers/vaultTreeFakeServer.mjs (route plan ในหน่วยความจำ) ผ่าน vaultTreeApi.js จริง
// ⚠️ NO-LEAK-5: ทุก body ที่ออกจาก session มีแต่ฟิลด์ทึบ — ชื่อ/parent/node id ไม่เคยอยู่ใน log ของ backend
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'

const storage = installStorageGuards()
const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
const { treeLimitsFrom } = await import('../src/lib/vaultTreeLimits.js')
const { intents } = await import('../src/lib/vaultTreeOps.js')
const { createTreeSession, SyncError } = await import('../src/lib/vaultTreeSync.js')
const { unwrapTrkSlots } = await import('../src/lib/vaultTreeKeys.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const kek = (await createVaultSetup('sync-passphrase-xyz-11', FAST)).kek
const LIMITS = treeLimitsFrom({ maxRebaseAttempts: 3 })
const SECRET = ['Q3-board-minutes-CONFIDENTIAL.pdf', 'โฟลเดอร์ลับมาก', 'merger-target']

/** stub ของ vaultUnlockedState (Task 5.4) — พอสำหรับ registerAbort/registerDisposer/registerKey/isPurged/purge */
function stubUnlockedState() {
  const aborts = [], disposers = [], keys = []
  let purged = false
  return {
    aborts, disposers, keys,
    registerAbort: (c) => { aborts.push(c); return c },
    registerDisposer: (fn) => { disposers.push(fn); return fn },
    registerKey: (ref) => { keys.push(ref); return ref },
    isPurged: () => purged,
    purge() { purged = true; for (const c of aborts) c.abort(); for (const d of disposers) d(); aborts.length = 0 },
  }
}
const server = (o = {}) => createFakeTreeServer({ kek, limits: LIMITS, ...o })
const session = (srv, o = {}) => createTreeSession({ kek, api: srv.api, limits: LIMITS, ...o })
const rejectsSync = (p, code) => assert.rejects(p, (e) => e instanceof SyncError && e.code === code ? true : (() => { throw new Error(`expected SyncError ${code}, got ${e.name} ${e.code ?? ''} ${e.message}`) })())

test('SY-1 loadHead: GET head → GET revision → unwrap Manifest DEK under TRK → decrypt → validate; keyStatus surfaced (HEALTHY / DEGRADED)', async () => {
  const srv = await server()
  const s = session(srv)
  assert.equal(s.head, null)
  const head = await s.loadHead()
  assert.deepEqual({ treeId: head.treeId, generation: head.generation, revisionId: head.revisionId, root: head.manifest.rootNodeId, nodes: head.manifest.nodes.size }, { treeId: srv.treeId, generation: 1, revisionId: srv.state.head.revisionId, root: srv.rootNodeId, nodes: 1 })
  assert.ok(head.index.nodes.has(srv.rootNodeId))
  assert.equal(s.keyStatus, 'HEALTHY')
  assert.deepEqual(srv.state.log.map((l) => `${l.method} ${l.path}`), ['GET /api/vault/tree/head', `GET /api/vault/tree/revisions/${srv.state.head.revisionId}`])
  // degraded envelope: corrupt the recovery slot on the server
  const bad = await server()
  bad.state.envelope.recovery = { ...bad.state.envelope.recovery, wrappedTrkB64: bad.state.envelope.primary.wrappedTrkB64 }
  const s2 = session(bad)
  await s2.loadHead()
  assert.equal(s2.keyStatus, 'DEGRADED'); assert.equal(s2.keyBadSlot, 'recovery')
})

test('SY-2 commit(rename): fresh revision (generation+1, base = head) → publish → put → CAS; success updates the in-memory head; manifest plaintext reflects the intent', async () => {
  const srv = await server()
  const s = session(srv)
  await s.loadHead()
  const created = await s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: SECRET[1] }))
  assert.deepEqual({ generation: created.generation, size: created.manifest.nodes.size, conflict: created.conflict }, { generation: 2, size: 2, conflict: undefined })
  assert.equal(s.head.generation, 2); assert.equal(s.head.revisionId, created.revisionId); assert.equal(s.head.baseRevisionId, srv.state.revisions.values().next().value.revisionId)
  const folderId = created.changedNodeIds[0]
  assert.equal(created.nodeId, folderId)
  const renamed = await s.commit(intents.rename({ nodeId: folderId, name: SECRET[2] }))
  assert.equal(renamed.generation, 3); assert.equal(renamed.manifest.nodes.get(folderId).name, SECRET[2])
  const seq = srv.state.log.map((l) => `${l.method} ${l.path.replace(/[A-Za-z0-9_-]{22}/g, ':id')}`)
  assert.deepEqual(seq.slice(2, 5), ['POST /api/vault/tree/revisions', 'PUT /api/vault/tree/revisions/:id/ciphertext', 'POST /api/vault/tree/head'])
  assert.equal(srv.state.revisions.get(renamed.revisionId).state, 'HEAD_COMMITTED'); assert.equal(srv.state.revisions.get(created.revisionId).state, 'SUPERSEDED')
  // a fresh session decrypts the same head
  const s2 = session(srv); const h2 = await s2.loadHead()
  assert.equal(h2.generation, 3); assert.equal(h2.manifest.nodes.get(folderId).name, SECRET[2])
  assert.equal(h2.manifest.recentOperationIds.length, 2)
})

test('SY-3 CAS conflict → refetch head → rebase AUTO → retry; retries bounded by limits.maxRebaseAttempts → REBASE_EXHAUSTED (SY-REBASE-BOUND)', async () => {
  const srv = await server()
  const a = session(srv), b = session(srv)
  await a.loadHead(); await b.loadHead()
  // b moves the head first (disjoint change) → a's commit rebases automatically once
  await b.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'theirs' }))
  const r = await a.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'mine' }))
  assert.equal(r.generation, 3); assert.equal(r.rebased, 1)
  assert.equal([...srv.state.revisions.values()].filter((x) => x.state === 'ORPHANED').length, 1, 'the losing candidate is left ORPHANED on the server')
  assert.equal(r.manifest.nodes.size, 3)
  // a contender that always wins: pre-build a chain of b's revisions, roll the server head back, and promote one per CAS from a
  const contenders = []
  for (let i = 0; i < LIMITS.maxRebaseAttempts + 2; i++) {
    await b.refreshHead()
    contenders.push(srv.state.revisions.get((await b.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: `b${i}` }))).revisionId))
  }
  const rollbackTo = r.revisionId
  srv.state.head = { revisionId: rollbackTo, generation: 3 }
  srv.state.revisions.get(rollbackTo).state = 'HEAD_COMMITTED'
  for (const c of contenders) c.state = 'PUBLISHED'
  srv.hooks.beforeCas = () => {
    const next = contenders.find((c) => c.state === 'PUBLISHED' && c.baseRevisionId === srv.state.head.revisionId)
    if (next) { srv.state.revisions.get(srv.state.head.revisionId).state = 'SUPERSEDED'; next.state = 'HEAD_COMMITTED'; srv.state.head = { revisionId: next.revisionId, generation: next.generation } }
  }
  await a.refreshHead()
  const casBefore = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length
  await rejectsSync(a.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'loser' })), 'REBASE_EXHAUSTED')
  const casCalls = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length - casBefore
  assert.equal(casCalls, 1 + LIMITS.maxRebaseAttempts, 'one initial CAS plus exactly maxRebaseAttempts rebased retries')
  srv.hooks.beforeCas = null
})

test('SY-4 CAS conflict → rebase CONFLICT → { conflict } without retry; the candidate stays ORPHANED on the server (no delete call); head refreshed', async () => {
  const srv = await server()
  const a = session(srv), b = session(srv)
  await a.loadHead(); await b.loadHead()
  const folder = await b.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'shared' }))
  await a.refreshHead()
  await b.commit(intents.trash({ nodeIds: [folder.nodeId] }))
  const r = await a.commit(intents.rename({ nodeId: folder.nodeId, name: 'renamed' }))
  assert.deepEqual(r.conflict, { kind: 'CONFLICT', reason: 'TARGET_DELETED' })
  assert.equal(r.generation, undefined)
  const casCalls = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head')
  assert.equal(casCalls.length, 3, 'exactly one CAS for the conflicting attempt — no retry')
  assert.equal(srv.state.log.filter((l) => l.method === 'DELETE').length, 0)
  assert.equal([...srv.state.revisions.values()].filter((x) => x.state === 'ORPHANED').length, 1)
  assert.equal(a.head.generation, 3, 'head refreshed to the current server head')
})

test('SY-5 response loss: CAS throws after the server applied it → session re-fetches head; head.revisionId === candidate → success; the semantic action is never re-sent', async () => {
  const srv = await server()
  const s = session(srv)
  await s.loadHead()
  srv.hooks.dropNextCasResponse = true
  const r = await s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'once' }))
  assert.equal(r.generation, 2); assert.equal(r.recoveredFromResponseLoss, true)
  const casCalls = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head')
  assert.equal(casCalls.length, 1, 'no CAS replay was needed: the head already pointed at the candidate')
  assert.equal(srv.state.revisions.size, 2, 'no second revision was published')
  assert.equal(s.head.revisionId, r.revisionId); assert.equal(s.head.manifest.nodes.size, 2)
})

test('SY-6 idempotency key is fresh per attempt and reused only for the exact same candidate replay (response lost before the server applied it)', async () => {
  const srv = await server()
  const s = session(srv)
  await s.loadHead()
  // lose the response before the server applied it: the head is unchanged, so the same candidate is replayed with the same key
  srv.hooks.dropNextCasBeforeApply = true
  const r = await s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'replayed' }))
  assert.equal(r.generation, 2); assert.equal(r.replayed, 1)
  const cas = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').map((l) => JSON.parse(l.body))
  assert.equal(cas.length, 2); assert.equal(cas[0].idempotencyKey, cas[1].idempotencyKey, 'same candidate → same key'); assert.equal(cas[0].revisionId, cas[1].revisionId)
  assert.equal(srv.state.revisions.size, 2, 'no second revision published for the replay')
  // a genuinely new attempt (after a rebase) publishes a new candidate with a new key
  const other = session(srv); await other.loadHead(); await other.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'x' }))
  const r2 = await s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'y' }))
  assert.equal(r2.rebased, 1)
  const keys = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').map((l) => JSON.parse(l.body).idempotencyKey)
  assert.equal(new Set(keys).size, keys.length - 1, 'only the replay pair shares a key')
})

test('SY-7 (NO-LEAK-5) attachBlobRefs/purgeBlobRefs reach the server as opaque attachBlobIds only; no name, node id, parent or manifest field is ever sent', async () => {
  const blob = { formatVersion: 2, id: 'b'.repeat(48) }
  const srv = await server({ blobs: [blob] })
  const s = session(srv)
  await s.loadHead()
  const folder = await s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: SECRET[1] }))
  const r = await s.commit(intents.attachBlob({ parentNodeId: folder.nodeId, name: SECRET[0], mediaType: 'application/pdf', plainSize: 7, blobRef: blob }))
  assert.equal(r.generation, 3)
  assert.equal(srv.state.blobStates.get(`2:${blob.id}`).lifecycle, 'TREE_MANAGED')
  const cas = srv.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').map((l) => JSON.parse(l.body))
  assert.deepEqual(Object.keys(cas[1]).sort(), ['attachBlobIds', 'expectedGeneration', 'expectedRevisionId', 'idempotencyKey', 'purgeBlobIds', 'revisionId'])
  assert.deepEqual(cas[1].attachBlobIds, [blob]); assert.deepEqual(cas[1].purgeBlobIds, [])
  const all = srv.state.log.map((l) => `${l.method} ${l.path} ${l.body}`).join('\n')
  for (const needle of [...SECRET, srv.rootNodeId, folder.nodeId, r.nodeId, '"name"', 'parentNodeId', 'nodeId', 'nodes']) assert.ok(!all.includes(needle), `leak: ${needle}`)
  assert.equal(storage.writes, 0)
})

test('SY-8 degraded key (one slot bad) → commit rejected with KEY_DEGRADED until repairKeyEnvelope() succeeds via casKeyEnvelope; then commits proceed and a fresh session sees HEALTHY', async () => {
  const srv = await server()
  srv.state.envelope.primary = { ...srv.state.envelope.primary, wrappedTrkB64: srv.state.envelope.recovery.wrappedTrkB64 }
  const s = session(srv)
  await s.loadHead()
  assert.equal(s.keyStatus, 'DEGRADED'); assert.equal(s.keyBadSlot, 'primary')
  await rejectsSync(s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'blocked' })), 'KEY_DEGRADED')
  assert.equal(srv.state.log.filter((l) => l.method === 'POST').length, 0, 'nothing was published while degraded')
  const repaired = await s.repairKeyEnvelope()
  assert.equal(repaired.envelopeCasVersion, 2); assert.equal(s.keyStatus, 'HEALTHY'); assert.equal(s.keyBadSlot, null)
  const r = await s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'ok' }))
  assert.equal(r.generation, 2)
  const fresh = session(srv); await fresh.loadHead(); assert.equal(fresh.keyStatus, 'HEALTHY')
  const unwrapped = await unwrapTrkSlots(kek, srv.state.envelope, { ownerScopeId: srv.state.ownerScopeIdB64, treeId: srv.treeId, protocolVersion: 1, keyEnvelopeVersion: 1 })
  assert.equal(unwrapped.status, 'HEALTHY')
  // stale envelope version → CONFLICT, no silent overwrite
  const s3 = session(srv); srv.state.envelope.primary = { ...srv.state.envelope.primary, wrappedTrkB64: srv.state.envelope.recovery.wrappedTrkB64 }
  await s3.loadHead(); assert.equal(s3.keyStatus, 'DEGRADED')
  srv.state.envelope.envelopeCasVersion += 1
  await rejectsSync(s3.repairKeyEnvelope(), 'CONFLICT')
})

test('SY-9 abort/purge: unlockedState.purge() aborts the in-flight fetch, invalidates the pending rebase, commit rejects ABORTED and the session holds no manifest', async () => {
  const srv = await server()
  const us = stubUnlockedState()
  const s = session(srv, { unlockedState: us })
  await s.loadHead()
  assert.ok(us.keys.length >= 1, 'TRK reference registered with the unlocked state')
  // purge while a commit is between publish and CAS
  srv.hooks.beforeCas = () => { us.purge() }
  await rejectsSync(s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'mid' })), 'ABORTED')
  assert.equal(s.head, null, 'no manifest retained after purge')
  await rejectsSync(s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'after' })), 'ABORTED')
  await rejectsSync(s.loadHead(), 'ABORTED')
  srv.hooks.beforeCas = null
  // an abort signal passed to commit cancels the in-flight fetch before any CAS
  const s2 = session(srv); await s2.loadHead()
  const genBefore = s2.head.generation
  const ctrl = new AbortController()
  srv.hooks.beforeCas = () => ctrl.abort()
  await rejectsSync(s2.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'sig' }), { signal: ctrl.signal }), 'ABORTED')
  srv.hooks.beforeCas = null
  // honest semantics: a request that already reached the server may have been applied; the aborted sessions just never adopt it
  assert.equal(srv.state.head.generation, 3)
  assert.equal(s2.head.generation, genBefore, 'the aborted session did not adopt the server outcome')
  const fresh = session(srv); assert.equal((await fresh.loadHead()).manifest.nodes.size, 3)
})

test('SY-10 protocol disabled mid-session (503) → PROTOCOL_DISABLED; the loaded head is retained for read/export', async () => {
  const srv = await server()
  const s = session(srv)
  await s.loadHead()
  srv.state.protocolEnabled = false
  await rejectsSync(s.commit(intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'x' })), 'PROTOCOL_DISABLED')
  await rejectsSync(s.refreshHead(), 'PROTOCOL_DISABLED')
  assert.equal(s.head.generation, 1); assert.equal(s.head.manifest.nodes.size, 1, 'head kept')
  const s2 = session(srv)
  await rejectsSync(s2.loadHead(), 'PROTOCOL_DISABLED')
})

test('SY-11 stale-after-lock: a session created before the lock cannot commit after purge even if its promise chain continues; close() is idempotent', async () => {
  const srv = await server()
  const us = stubUnlockedState()
  const s = session(srv, { unlockedState: us })
  await s.loadHead()
  const intent = intents.createFolder({ parentNodeId: srv.rootNodeId, name: 'late' })
  // a chain that awaits something else first, then commits — the purge lands in between
  const chain = (async () => { await new Promise((r) => setTimeout(r, 10)); return s.commit(intent) })()
  us.purge()
  await rejectsSync(chain, 'ABORTED')
  assert.equal(srv.state.log.filter((l) => l.method === 'POST').length, 0, 'the late commit never reached the network')
  s.close(); s.close()
  assert.equal(s.head, null)
  const s2 = session(srv); await s2.loadHead(); s2.close()
  await rejectsSync(s2.commit(intent), 'ABORTED')
})
