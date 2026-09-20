// tests/vaultTreeUploadClient.test.js — AEGIS Drive (IDEA1) · PR #157 Task 4.3 · client tree-aware upload, attach and orphan recovery
//
// ⚠️ uploadTreeFile = uploadVaultFileChunked เดิมทุกขั้น (แผนการแบ่ง/ซอง/chunk/retry/commit) ต่างเพียง routeBase →
//    '/api/vault/tree/uploads' แล้วจึงส่ง attachBlob intent ให้ session.commit() — ชื่อไฟล์/parentNodeId/nodeId อยู่ใน
//    manifest ที่เข้ารหัสฝั่ง client เท่านั้น: ไม่มีคำขอใดในชุดนี้บรรจุค่าเหล่านั้น (NO-LEAK-4)
// ⚠️ TU-SAME-1: ค่าคงที่และ planVaultChunks ของ vaultChunkedUpload/vaultChunkCrypto ต้องเท่ากับ snapshot ที่แช่แข็ง
//    (Global Constraints: transfer performance excluded) และ routeBase ค่าเริ่มต้นคือครอบครัวเก่า
// session ในชุดนี้เป็น stub ตาม interface ของ vaultTreeSync (Task 5.3); Task 5.5 รันชุดนี้ซ้ำกับ session จริง
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'

const storageCounts = installStorageGuards()

const { createVaultSetup, encryptFileEnvelope } = await import('../src/lib/vaultCrypto.js')
const { createVaultV2Envelope, planVaultChunks, VAULT_FORMAT_V2, GCM_TAG_BYTES } = await import('../src/lib/vaultChunkCrypto.js')
const upload = await import('../src/lib/vaultChunkedUpload.js')
const { uploadTreeFile, listOrphanBlobs, recoverOrphan, TREE_UPLOAD_ROUTE_BASE } = await import('../src/lib/vaultTreeUpload.js')
const { listTreeBlobs } = await import('../src/lib/vaultTreeApi.js')
const { createTreeSession } = await import('../src/lib/vaultTreeSync.js')
const { createFakeTreeServer } = await import('./helpers/vaultTreeFakeServer.mjs')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const kek = (await createVaultSetup('tree-upload-client-passphrase-77', FAST)).kek
const SECRET_NAME = 'board-minutes-CONFIDENTIAL-2026.pdf'
const PARENT = 'P'.repeat(22)
const NODE = 'N'.repeat(22)
const CHUNK = 64 * 1024
const bytesOf = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) & 0xff; return b }
const mkFile = (n = 3 * CHUNK + 123, name = SECRET_NAME) => new File([bytesOf(n)], name, { type: 'application/pdf' })

/** ทุกคำขอที่ออกจาก client ถูกบันทึกไว้ที่นี่ (path + header + body ที่ serialize ได้) เพื่อ NO-LEAK-4 */
const wire = []
/** fake backend ของครอบครัว upload — ยอมรับได้ทั้งสอง routeBase และจำว่าใช้อันไหน */
function fakeTransport({ failCommit = false } = {}) {
  const state = { session: null, chunks: new Map(), calls: [], committed: null }
  const view = () => {
    const received = [...state.chunks.keys()].sort((a, b) => a - b)
    const missing = []; for (let i = 0; i < state.session.chunkCount; i += 1) if (!state.chunks.has(i)) missing.push(i)
    return { ...state.session, received, missing, receivedBytes: received.reduce((n, i) => n + state.chunks.get(i).length, 0) }
  }
  const record = (method, path, body, headers) => {
    const text = body instanceof Blob ? `<blob ${body.size}>` : JSON.stringify(body ?? null)
    wire.push({ method, path, body: text, headers: JSON.stringify(headers ?? {}) })
    state.calls.push({ method, path: path.replace(/^\/api\/vault(\/tree)?\/uploads/, '/UPLOADS'), keys: body && !(body instanceof Blob) ? Object.keys(body).sort() : body instanceof Blob ? body.size : null })
  }
  const fetchJson = async (path, opts = {}) => {
    record(opts.method ?? 'GET', path, opts.body, opts.headers)
    if (opts.method === 'POST' && /\/uploads$/.test(path)) {
      state.session = { uploadId: 'a'.repeat(48), formatVersion: 2, contentIdB64: opts.body.contentIdB64, ciphertextSize: opts.body.ciphertextSize, chunkSize: opts.body.chunkSize, chunkCount: opts.body.chunkCount, status: 'open', expiresAt: Date.now() + 3_600_000 }
      return { ok: true, status: 201, data: { upload: view() }, errorKind: null }
    }
    if (/\/commit$/.test(path)) {
      if (failCommit) return { ok: false, status: 500, data: { error: 'boom' }, errorKind: 'server' }
      if (view().missing.length) return { ok: false, status: 409, data: { code: 'UPLOAD_INCOMPLETE', upload: view() }, errorKind: 'server' }
      state.committed = { id: 'b'.repeat(48), formatVersion: 2, size: state.session.ciphertextSize, chunkSize: state.session.chunkSize, chunkCount: state.session.chunkCount, contentIdB64: state.session.contentIdB64, ...(path.includes('/tree/') ? { lifecycle: 'UNREFERENCED' } : {}) }
      return { ok: true, status: 201, data: { blob: state.committed }, errorKind: null }
    }
    if (opts.method === 'DELETE') return { ok: true, status: 200, data: { ok: true }, errorKind: null }
    return { ok: true, status: 200, data: { upload: view() }, errorKind: null }
  }
  const sendUpload = async (path, opts = {}) => {
    record('PUT', path, opts.body, opts.headers)
    const index = Number(path.split('/').pop())
    const ct = new Uint8Array(await opts.body.arrayBuffer())
    state.chunks.set(index, ct)
    return { ok: true, status: 200, data: { index, size: ct.length, upload: view() }, errorKind: null }
  }
  return { state, fetchJson, sendUpload }
}
/** stub session ตาม interface { commit(intent, { signal }) } ของ vaultTreeSync */
function stubSession({ conflict = null } = {}) {
  const commits = []
  return {
    commits,
    head: { generation: 4, revisionId: 'R'.repeat(22) },
    async commit(intent, { signal } = {}) {
      commits.push({ intent: structuredClone(intent), aborted: Boolean(signal?.aborted) })
      if (conflict) return { conflict }
      return { generation: 5, revisionId: 'S'.repeat(22), nodeId: NODE }
    },
  }
}

test('TU-SAME-1 vaultChunkedUpload constants and planVaultChunks output equal the frozen snapshot; default routeBase is the legacy family', () => {
  assert.deepEqual(
    { MIN: upload.MIN_UPLOAD_CONCURRENCY, MAX: upload.MAX_UPLOAD_CONCURRENCY, DEFAULT: upload.DEFAULT_UPLOAD_CONCURRENCY, FORMAT: VAULT_FORMAT_V2, TAG: GCM_TAG_BYTES, routeBase: upload.DEFAULT_VAULT_UPLOAD_ROUTE_BASE },
    { MIN: 1, MAX: 4, DEFAULT: 2, FORMAT: 2, TAG: 16, routeBase: '/api/vault/uploads' },
  )
  assert.equal(TREE_UPLOAD_ROUTE_BASE, '/api/vault/tree/uploads')
  const plan = (n) => planVaultChunks(n, 8 * 1024 * 1024)
  assert.deepEqual([0, 1, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1, 5 * 1024 * 1024 * 1024].map(plan), [
    { chunkCount: 1, plaintextChunkBytes: 8_388_608, chunkSize: 8_388_624, lastChunkSize: 16, ciphertextSize: 16 },
    { chunkCount: 1, plaintextChunkBytes: 8_388_608, chunkSize: 8_388_624, lastChunkSize: 17, ciphertextSize: 17 },
    { chunkCount: 1, plaintextChunkBytes: 8_388_608, chunkSize: 8_388_624, lastChunkSize: 8_388_624, ciphertextSize: 8_388_624 },
    { chunkCount: 2, plaintextChunkBytes: 8_388_608, chunkSize: 8_388_624, lastChunkSize: 17, ciphertextSize: 8_388_641 },
    { chunkCount: 640, plaintextChunkBytes: 8_388_608, chunkSize: 8_388_624, lastChunkSize: 8_388_624, ciphertextSize: 5_368_719_360 },
  ])
})

test('TUC-1 uploadTreeFile runs the unchanged chunked upload against the tree routeBase, then commits an attachBlob intent carrying the blobRef', async () => {
  const file = mkFile()
  // legacy reference run: same file, same fake transport → identical call sequence modulo the route prefix
  const legacy = fakeTransport()
  const ref = await upload.uploadVaultFileChunked({ kek, file, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: legacy.fetchJson, sendUpload: legacy.sendUpload })
  assert.equal(ref.ok, true)
  const t = fakeTransport()
  const session = stubSession()
  const res = await uploadTreeFile({ kek, file, parentNodeId: PARENT, session, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: t.fetchJson, sendUpload: t.sendUpload })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(t.state.calls, legacy.state.calls, 'same request sequence (method, path shape, body keys, chunk sizes)')
  assert.ok(t.state.calls.length >= 6)
  assert.ok(wire.filter((w) => w.path.startsWith('/api/vault/tree/uploads')).length === t.state.calls.length, 'every tree request used the tree routeBase')
  assert.equal(session.commits.length, 1)
  const { intent } = session.commits[0]
  assert.deepEqual(intent, { type: 'attachBlob', parentNodeId: PARENT, name: SECRET_NAME, mediaType: 'application/pdf', plainSize: file.size, blobRef: { formatVersion: 2, id: 'b'.repeat(48) } })
  assert.deepEqual({ blobRef: res.blobRef, generation: res.generation, revisionId: res.revisionId, nodeId: res.nodeId }, { blobRef: intent.blobRef, generation: 5, revisionId: 'S'.repeat(22), nodeId: NODE })
  assert.equal(res.blob.lifecycle, 'UNREFERENCED', 'the server reply is passed through untouched')
  // plan/ciphertext sizes identical between the two runs
  assert.equal(t.state.session.ciphertextSize, legacy.state.session.ciphertextSize); assert.equal(t.state.session.chunkCount, 4)
})

test('TUC-2 commit conflict without auto-rebase → { orphan: blobRef, conflict }; the blob is neither deleted nor re-uploaded', async () => {
  const t = fakeTransport()
  const conflict = { kind: 'CONFLICT', reason: 'PARENT_CHANGED' }
  const session = stubSession({ conflict })
  const res = await uploadTreeFile({ kek, file: mkFile(CHUNK), parentNodeId: PARENT, session, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: t.fetchJson, sendUpload: t.sendUpload })
  assert.deepEqual({ ok: res.ok, stage: res.stage, reason: res.reason, orphan: res.orphan, conflict: res.conflict }, { ok: false, stage: 'attach-conflict', reason: 'conflict', orphan: { formatVersion: 2, id: 'b'.repeat(48) }, conflict })
  assert.equal(session.commits.length, 1, 'no automatic retry')
  assert.equal(t.state.calls.filter((c) => c.method === 'DELETE').length, 0, 'never deletes the blob')
  assert.equal(t.state.calls.filter((c) => c.method === 'PUT').length, 1, 'never re-uploads')
  // a failed upload (before any blob exists) reports the plain upload failure and never touches the session
  const f = fakeTransport({ failCommit: true }); const s2 = stubSession()
  const failed = await uploadTreeFile({ kek, file: mkFile(CHUNK), parentNodeId: PARENT, session: s2, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: f.fetchJson, sendUpload: f.sendUpload })
  assert.equal(failed.ok, false); assert.equal(failed.stage, 'failed'); assert.equal(failed.orphan, undefined); assert.equal(s2.commits.length, 0)
})

test('TUC-3 listOrphanBlobs decrypts UNREFERENCED envelopes not referenced by the manifest and returns display names; recoverOrphan commits attachBlob with the chosen folder and name', async () => {
  const v1 = await encryptFileEnvelope(kek, { name: 'orphan-one.png', type: 'image/png', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) })
  const v2 = await createVaultV2Envelope(kek, { name: 'orphan-two.mp4', type: 'video/mp4', size: 9_000, chunkCount: 1 })
  const referenced = await createVaultV2Envelope(kek, { name: 'already-in-tree.txt', type: 'text/plain', size: 5, chunkCount: 1 })
  const other = await createVaultSetup('another-vault-passphrase-99', FAST)
  const foreign = await createVaultV2Envelope(other.kek, { name: 'undecryptable.bin', type: 'application/octet-stream', size: 1, chunkCount: 1 })
  const blobs = [
    { id: 11, formatVersion: 1, size: 20, createdAt: 1, ivB64: v1.ivB64, wrappedDekB64: v1.wrappedDekB64, wrapIvB64: v1.wrapIvB64, metaIvB64: v1.metaIvB64, metaB64: v1.metaB64, lifecycle: 'UNREFERENCED', attachedGeneration: null, orphanSince: 1_000 },
    { id: 'v2-orphan', formatVersion: 2, size: 9_016, createdAt: 2, chunkSize: 8_388_624, chunkCount: 1, contentIdB64: v2.contentIdB64, wrappedDekB64: v2.wrappedDekB64, wrapIvB64: v2.wrapIvB64, metaIvB64: v2.metaIvB64, metaB64: v2.metaB64, lifecycle: 'UNREFERENCED', attachedGeneration: null, orphanSince: 2_000 },
    { id: 'v2-referenced', formatVersion: 2, size: 21, createdAt: 3, chunkSize: 8_388_624, chunkCount: 1, contentIdB64: referenced.contentIdB64, wrappedDekB64: referenced.wrappedDekB64, wrapIvB64: referenced.wrapIvB64, metaIvB64: referenced.metaIvB64, metaB64: referenced.metaB64, lifecycle: 'UNREFERENCED', attachedGeneration: null, orphanSince: 3_000 },
    { id: 'v2-foreign', formatVersion: 2, size: 17, createdAt: 4, chunkSize: 8_388_624, chunkCount: 1, contentIdB64: foreign.contentIdB64, wrappedDekB64: foreign.wrappedDekB64, wrapIvB64: foreign.wrapIvB64, metaIvB64: foreign.metaIvB64, metaB64: foreign.metaB64, lifecycle: 'UNREFERENCED', attachedGeneration: null, orphanSince: 4_000 },
  ]
  const requests = []
  const fetchJson = async (path, opts = {}) => { requests.push({ path, opts }); wire.push({ method: opts.method ?? 'GET', path, body: 'null', headers: '{}' }); return { ok: true, status: 200, data: { blobs: blobs.filter((b) => !path.includes('lifecycle=') || b.lifecycle === 'UNREFERENCED'), orphanRetentionMs: 2_592_000_000 } } }
  const api = { listTreeBlobs: (opts) => listTreeBlobs({ ...opts, fetchJson }) }
  // manifest index: one file node already references 'v2-referenced' (a race between attach and inventory refresh)
  const index = { nodes: new Map([[NODE, { nodeId: NODE, kind: 'file', blobRef: { formatVersion: 2, id: 'v2-referenced' } }], ['F'.repeat(22), { nodeId: 'F'.repeat(22), kind: 'folder' }]]) }
  const orphans = await listOrphanBlobs({ kek, api, index })
  assert.equal(requests[0].path, '/api/vault/tree/blobs?lifecycle=UNREFERENCED', 'listTreeBlobs forwards the lifecycle filter')
  assert.deepEqual(orphans.map((o) => ({ ...o, blob: undefined })), [
    { blobRef: { formatVersion: 1, id: '11' }, name: 'orphan-one.png', mediaType: 'image/png', plainSize: 4, orphanSince: 1_000, orphanRetentionMs: 2_592_000_000, undecryptable: false, blob: undefined },
    { blobRef: { formatVersion: 2, id: 'v2-orphan' }, name: 'orphan-two.mp4', mediaType: 'video/mp4', plainSize: 9_000, orphanSince: 2_000, orphanRetentionMs: 2_592_000_000, undecryptable: false, blob: undefined },
    { blobRef: { formatVersion: 2, id: 'v2-foreign' }, name: null, mediaType: null, plainSize: null, orphanSince: 4_000, orphanRetentionMs: 2_592_000_000, undecryptable: true, blob: undefined },
  ])
  assert.deepEqual(orphans.map((o) => o.blob.id), [11, 'v2-orphan', 'v2-foreign'], 'the opaque envelope rides along for download')
  const session = stubSession()
  const r = await recoverOrphan({ session, blobRef: orphans[1].blobRef, parentNodeId: PARENT, name: 'renamed-on-recovery.mp4', mediaType: 'video/mp4', plainSize: 9_000 })
  assert.deepEqual(session.commits[0].intent, { type: 'attachBlob', parentNodeId: PARENT, name: 'renamed-on-recovery.mp4', mediaType: 'video/mp4', plainSize: 9_000, blobRef: { formatVersion: 2, id: 'v2-orphan' } })
  assert.equal(r.generation, 5)
  const c = stubSession({ conflict: { kind: 'CONFLICT', reason: 'COLLISION' } })
  assert.deepEqual(await recoverOrphan({ session: c, blobRef: orphans[0].blobRef, parentNodeId: PARENT, name: 'orphan-one.png', mediaType: 'image/png', plainSize: 4 }), { conflict: { kind: 'CONFLICT', reason: 'COLLISION' }, orphan: { formatVersion: 1, id: '11' } })
})

test('TUC-5 unlockedState.purge during the upload → the registered abort fires, the transfer cancels and no commit is attempted', async () => {
  const t = fakeTransport()
  const session = stubSession()
  const controllers = []
  let purged = false
  const unlockedState = { registerAbort: (c) => { controllers.push(c); return c }, isPurged: () => purged }
  const originalSend = t.sendUpload
  let puts = 0
  t.sendUpload = async (path, opts) => { puts += 1; if (puts === 2) { purged = true; for (const c of controllers) c.abort() } return originalSend(path, opts) }
  const res = await uploadTreeFile({ kek, file: mkFile(), parentNodeId: PARENT, session, unlockedState, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: t.fetchJson, sendUpload: t.sendUpload })
  assert.equal(controllers.length, 1, 'one AbortController registered with the unlocked state')
  assert.deepEqual({ ok: res.ok, stage: res.stage, reason: res.reason }, { ok: false, stage: 'cancelled', reason: 'cancelled' })
  assert.equal(session.commits.length, 0, 'no attach after purge')
  assert.equal(t.state.committed, null, 'no commit request after purge')
  assert.ok(puts < 4, 'the transfer stopped early')
  // an external signal that is already aborted short-circuits before the first request
  const ctrl = new AbortController(); ctrl.abort()
  const t2 = fakeTransport(); const s2 = stubSession()
  const pre = await uploadTreeFile({ kek, file: mkFile(CHUNK), parentNodeId: PARENT, session: s2, signal: ctrl.signal, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: t2.fetchJson, sendUpload: t2.sendUpload })
  assert.equal(pre.ok, false); assert.equal(pre.stage, 'cancelled'); assert.equal(s2.commits.length, 0)
})

test('TUC-REAL-1 (Task 5.5) uploadTreeFile and recoverOrphan against the real vaultTreeSync session: the blob becomes TREE_MANAGED at the new generation and a file node with the plaintext name exists only in the decrypted manifest', async () => {
  const srv = await createFakeTreeServer({ kek })
  const session = createTreeSession({ kek, api: srv.api })
  await session.loadHead()
  const t = fakeTransport()
  // the fake upload backend returns a blob id; make the tree server know it as UNREFERENCED (as /tree/uploads commit would)
  srv.state.blobStates.set('2:' + 'b'.repeat(48), { formatVersion: 2, id: 'b'.repeat(48), lifecycle: 'UNREFERENCED' })
  const res = await uploadTreeFile({ kek, file: mkFile(CHUNK), parentNodeId: srv.rootNodeId, session, plaintextChunkBytes: CHUNK, concurrency: 1, fetchJson: t.fetchJson, sendUpload: t.sendUpload })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.generation, 2); assert.equal(srv.state.blobStates.get('2:' + 'b'.repeat(48)).lifecycle, 'TREE_MANAGED')
  const node = session.head.manifest.nodes.get(res.nodeId)
  assert.deepEqual({ name: node.name, parent: node.parentNodeId, blob: node.blobRef }, { name: SECRET_NAME, parent: srv.rootNodeId, blob: { formatVersion: 2, id: 'b'.repeat(48) } })
  // the same blob cannot be attached twice; an orphan can be recovered through the same session
  await assert.rejects(recoverOrphan({ session, blobRef: { formatVersion: 2, id: 'b'.repeat(48) }, parentNodeId: srv.rootNodeId, name: 'dup.pdf', mediaType: 'application/pdf', plainSize: 1 }), (e) => e.code === 'BLOB_ALREADY_REFERENCED')
  srv.state.blobStates.set('2:orphan', { formatVersion: 2, id: 'orphan', lifecycle: 'UNREFERENCED' })
  const rec = await recoverOrphan({ session, blobRef: { formatVersion: 2, id: 'orphan' }, parentNodeId: srv.rootNodeId, name: 'recovered.bin', mediaType: '', plainSize: 3 })
  assert.equal(rec.generation, session.head.generation); assert.equal(srv.state.blobStates.get('2:orphan').lifecycle, 'TREE_MANAGED')
  const all = srv.state.log.map((l) => `${l.method} ${l.path} ${l.body}`).join('\n')
  for (const needle of [SECRET_NAME, 'recovered.bin', 'dup.pdf', srv.rootNodeId, res.nodeId, 'parentNodeId', '"name"']) assert.ok(!all.includes(needle), `leak: ${needle}`)
  for (const l of srv.state.log) wire.push({ method: l.method, path: l.path, body: l.body, headers: '{}' })
})

test('TUC-4 (NO-LEAK-4) no request in this suite contains the file name, parentNodeId or any nodeId; no browser storage was written', () => {
  assert.ok(wire.length > 10)
  const all = wire.map((w) => `${w.method} ${w.path}\n${w.headers}\n${w.body}`).join('\n')
  for (const needle of [SECRET_NAME, PARENT, NODE, 'orphan-one.png', 'orphan-two.mp4', 'renamed-on-recovery', 'parentNodeId', 'nodeId', '"name"']) assert.ok(!all.includes(needle), `leak: ${needle}`)
  assert.equal(storageCounts.writes, 0)
})
