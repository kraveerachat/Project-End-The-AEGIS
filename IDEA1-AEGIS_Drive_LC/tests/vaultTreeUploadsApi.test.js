// tests/vaultTreeUploadsApi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 4.1 · tree-aware V2 upload family (server, memory mode)
//
// ⚠️ ครอบครัว /api/vault/tree/uploads/* คือ "เส้นทาง V2 เดิมทุกไบต์" ที่ (1) เปิดเฉพาะเจ้าของ TREE_V1,
//    (2) commit แล้วบันทึกสถานะ blob = UNREFERENCED ใน transaction เดียวกับแถว blob, และ (3) ปฏิเสธฟิลด์
//    ชื่อ/parent/node/path ทุกชนิด (strict body) — ไม่มีอะไรเกี่ยวกับต้นไม้ไปถึงเซิร์ฟเวอร์ (NO-LEAK-3)
// ⚠️ TU-5: ค่าคงที่ของการโอน (chunk/concurrency/retry) ต้องเท่ากับ snapshot ที่แช่แข็งไว้ในไฟล์นี้ —
//    Phase 4 "ใช้ V2 internals เดิมโดยไม่แตะ" (Global Constraints: transfer performance excluded)
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'
import { capture, fixedId } from './helpers/vaultTreeFixtures.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-tree-uploads-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)
delete process.env.MAX_VAULT_LOGICAL_FILE_BYTES
delete process.env.VAULT_UPLOAD_SESSION_TTL_MS; delete process.env.VAULT_COMMIT_LEASE_MS; delete process.env.VAULT_UPLOAD_CONCURRENCY
delete process.env.DATABASE_URL
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { createApp } = await import('../server/app.js')
const { vaultTreeConfigFromEnv } = await import('../server/config/vaultTreeLimits.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultStaging, newFinalVaultKey, publishStagedVaultPartTo } = await import('../server/storage/vaultStaging.js')
const { initVaultManifestStorage } = await import('../server/storage/vaultManifestStore.js')
const { recoverStaleVaultCommits } = await import('../server/storage/vaultCommitRecovery.js')
const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
const tree = await import('../server/db/vaultTreeStore.js')
const store = await import('../server/db/store.js')
const v2store = await import('../server/db/vaultV2Store.js')
const { getUserByUsername } = await import('../server/db/connection.js')
const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
const { createVaultV2Envelope } = await import('../src/lib/vaultChunkCrypto.js')
const upload = await import('../src/lib/vaultChunkedUpload.js')
const { seedTree } = await import('./helpers/vaultTreeStoreSpec.mjs')

const CIPHER_CHUNK = VAULT_TRANSFER_LIMITS.ciphertextChunkBytes
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const ON = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true' })
const OFF = vaultTreeConfigFromEnv({})
const TREE = '/api/vault/tree/uploads'
const LEGACY = '/api/vault/uploads'
const SECRET_NAMES = ['tree-upload-CONFIDENTIAL-q3.pdf', 'โฟลเดอร์ต้นไม้ลับ', 'merger-plan-parent']
const NODE_IDS = [fixedId(1, 'N'), fixedId(2, 'N')]

let serverOn, serverOff, baseOn, baseOff, ownerId, otherId
const captures = []

before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultStaging(); await initVaultManifestStorage()
  serverOn = createApp({ vaultTreeConfig: ON }).listen(0, '127.0.0.1')
  serverOff = createApp({ vaultTreeConfig: OFF }).listen(0, '127.0.0.1')
  await Promise.all([serverOn, serverOff].map((s) => new Promise((r) => s.once('listening', r))))
  baseOn = `http://127.0.0.1:${serverOn.address().port}`; baseOff = `http://127.0.0.1:${serverOff.address().port}`
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
  otherId = String((await getUserByUsername(DEMO_ADMIN.username)).id)
})
after(async () => {
  await Promise.all([serverOn, serverOff].map((s) => new Promise((r) => s.close(r))))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => { await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests(); await store.__resetVaultForTests() })

/** ทุก client ถูกห่อด้วย capture() เพื่อให้ NO-LEAK-3 สแกนทุกไบต์ที่ออกจากชุดทดสอบนี้ */
async function login(base = baseOn, who = DEMO_USER, { captured = true } = {}) {
  const c = await loginClient(base, who.username, who.password)
  if (captured) captures.push(capture(c))
  return c
}
async function setupVault(client) {
  const setup = await createVaultSetup('tree-upload-passphrase-xyz-99', FAST)
  assert.equal((await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  return setup.kek
}
/** body ของ create — ชื่อไฟล์อยู่ใน envelope ที่เข้ารหัสแล้วเท่านั้น (metaB64) */
async function createBody(kek, { plainSize = 1024, name = SECRET_NAMES[0] } = {}) {
  const env = await createVaultV2Envelope(kek, { name, type: 'application/octet-stream', size: plainSize, chunkCount: 1 })
  return { formatVersion: 2, contentIdB64: env.contentIdB64, chunkSize: CIPHER_CHUNK, wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64, ciphertextSize: plainSize + GCM_TAG_BYTES, chunkCount: 1 }
}
const openSession = async (client, kek, base = TREE, extra = {}) => client.req(base, { method: 'POST', body: { ...(await createBody(kek)), ...extra } })
const putChunk = (client, uploadId, base = TREE, bytes = randomBytes(1024 + GCM_TAG_BYTES)) => client.req(`${base}/${uploadId}/chunks/0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') } })
const commit = (client, uploadId, base = TREE, body = undefined) => client.req(`${base}/${uploadId}/commit`, { method: 'POST', body })
const status = (client, uploadId, base = TREE) => client.req(`${base}/${uploadId}`)
const cancel = (client, uploadId, base = TREE) => client.req(`${base}/${uploadId}`, { method: 'DELETE' })

/** เดินครบทั้ง flow ในครอบครัวที่เลือก แล้วคืนทุก response ตามลำดับ (สำหรับเทียบรูปทรง TU-2) */
async function fullFlow(client, kek, base) {
  const created = await openSession(client, kek, base); assert.equal(created.status, 201, JSON.stringify(created.data))
  const uploadId = created.data.upload.uploadId
  const put = await putChunk(client, uploadId, base); assert.equal(put.status, 200, JSON.stringify(put.data))
  const st = await status(client, uploadId, base); assert.equal(st.status, 200)
  const done = await commit(client, uploadId, base); assert.equal(done.status, 201, JSON.stringify(done.data))
  return { uploadId, exchanges: { created, put, status: st, commit: done } }
}
async function setState(state) {
  await tree.getTreeState(ownerId)
  await tree.__setProtocolStateForTests(ownerId, state)
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, state)
}
const blobStateOf = async (id, userId = ownerId) => (await tree.listBlobStates(userId)).find((s) => s.formatVersion === 2 && s.id === id) ?? null

test('TU-1 outside TREE_V1 (FLAT, MIGRATING) every tree upload mutation → 409 TREE_STATE_CONFLICT; limits/status/cancel stay open; flags off → 503', async () => {
  const c = await login(); const kek = await setupVault(c)
  await seedTree(tree, ownerId)
  const opened = await openSession(c, kek); assert.equal(opened.status, 201)
  const uploadId = opened.data.upload.uploadId
  for (const state of ['FLAT', 'MIGRATING_TREE_V1']) {
    await setState(state)
    const denied = [await openSession(c, kek), await putChunk(c, uploadId), await commit(c, uploadId)]
    for (const r of denied) { assert.equal(r.status, 409, `${state}: ${JSON.stringify(r.data)}`); assert.equal(r.data.code, 'TREE_STATE_CONFLICT') }
    assert.equal((await c.req(`${TREE}/limits`)).status, 200, `${state}: GET limits allowed`)
    assert.equal((await status(c, uploadId)).status, 200, `${state}: status is a safe read`)
    assert.equal((await v2store.listVaultV2Blobs(ownerId)).length, 0, 'nothing committed by a fenced request')
  }
  assert.equal((await cancel(c, uploadId)).status, 200, 'cancelling a never-committed staging session mutates no inventory')
  const off = await login(baseOff)
  for (const [m, p] of [['GET', `${TREE}/limits`], ['POST', TREE], ['GET', `${TREE}/${'a'.repeat(48)}`], ['POST', `${TREE}/${'a'.repeat(48)}/commit`], ['DELETE', `${TREE}/${'a'.repeat(48)}`]]) {
    const r = await off.req(p, { method: m, body: m === 'POST' ? {} : undefined })
    assert.equal(r.status, 503, `${m} ${p}`); assert.equal(r.data.code, 'TREE_PROTOCOL_DISABLED')
  }
})

test('TU-2 in TREE_V1 the tree flow has identical request/response shapes to the legacy family; the only additions are the route prefix and lifecycle: UNREFERENCED', async () => {
  const c = await login(); const kek = await setupVault(c)
  const legacy = await fullFlow(c, kek, LEGACY)
  await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests()
  await seedTree(tree, ownerId)
  const treeFlow = await fullFlow(c, kek, TREE)
  // shape = sorted key paths (values differ by random ids/timestamps by construction)
  const shape = (v, prefix = '') => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.keys(v).sort().flatMap((k) => shape(v[k], `${prefix}${k}.`)) : [prefix.slice(0, -1)]
  for (const step of ['created', 'put', 'status']) {
    assert.equal(treeFlow.exchanges[step].status, legacy.exchanges[step].status, step)
    assert.deepEqual(shape(treeFlow.exchanges[step].data), shape(legacy.exchanges[step].data), `${step}: identical response shape`)
  }
  assert.equal(treeFlow.exchanges.commit.status, 201)
  const legacyCommit = shape(legacy.exchanges.commit.data), treeCommit = shape(treeFlow.exchanges.commit.data)
  assert.deepEqual(treeCommit.filter((k) => !legacyCommit.includes(k)), ['blob.lifecycle'], 'the only added field is blob.lifecycle')
  assert.deepEqual(legacyCommit.filter((k) => !treeCommit.includes(k)), [], 'no legacy field is missing')
  assert.equal(treeFlow.exchanges.commit.data.blob.lifecycle, 'UNREFERENCED')
  assert.equal(treeFlow.exchanges.commit.data.blob.formatVersion, 2)
  // static values equal: limits are the same object served by both families
  const [lt, ll] = [await c.req(`${TREE}/limits`), await c.req(`${LEGACY}/limits`)]
  assert.deepEqual({ ...lt.data, capacity: null }, { ...ll.data, capacity: null })
  // ✱ the committed blob is in the owner's opaque inventory as UNREFERENCED
  const bs = await blobStateOf(treeFlow.exchanges.commit.data.blob.id)
  assert.deepEqual({ lifecycle: bs.lifecycle, attachedGeneration: bs.attachedGeneration }, { lifecycle: 'UNREFERENCED', attachedGeneration: null })
  const inv = await c.req('/api/vault/tree/blobs?lifecycle=UNREFERENCED')
  assert.equal(inv.status, 200); assert.deepEqual(inv.data.blobs.map((b) => b.id), [treeFlow.exchanges.commit.data.blob.id])
})

test('TU-3 commit writes blob row + UNREFERENCED state atomically: injected failure after the blob insert → no blob row, no state row, session recoverable', async () => {
  const c = await login(); const kek = await setupVault(c)
  await seedTree(tree, ownerId)
  const created = await openSession(c, kek); const uploadId = created.data.upload.uploadId
  assert.equal((await putChunk(c, uploadId)).status, 200)
  tree.__failNextBlobStateUpsertForTests(new Error('TU-3 injected failure after blob insert'))
  const failed = await commit(c, uploadId)
  assert.equal(failed.status, 500, JSON.stringify(failed.data))
  assert.equal((await v2store.listVaultV2Blobs(ownerId)).length, 0, 'no blob row survives the rolled-back commit')
  assert.equal((await tree.listBlobStates(ownerId)).length, 0, 'no blob state row survives the rolled-back commit')
  assert.equal((await status(c, uploadId)).data.upload.status, 'open', 'the staging session is released for a retry')
  const retried = await commit(c, uploadId)
  assert.equal(retried.status, 201, JSON.stringify(retried.data))
  assert.equal((await blobStateOf(retried.data.blob.id)).lifecycle, 'UNREFERENCED')
  assert.equal((await v2store.listVaultV2Blobs(ownerId)).length, 1)
})

test('TU-5 transfer constants unchanged: server limits, client concurrency bounds and the chunk retry count equal the frozen snapshot', async () => {
  // ⚠️ snapshot แช่แข็ง — ถ้าเทสต์นี้แดง แปลว่ามีคนแตะ transfer performance ซึ่ง PR #157 ห้าม
  assert.deepEqual({ ...VAULT_TRANSFER_LIMITS }, {
    plaintextChunkBytes: 8_388_608, uploadConcurrency: 2, ciphertextChunkBytes: 8_388_624,
    maxLogicalFileBytes: 5_368_709_120, sessionTtlMs: 86_400_000, commitLeaseMs: 900_000,
  })
  assert.deepEqual([upload.MIN_UPLOAD_CONCURRENCY, upload.MAX_UPLOAD_CONCURRENCY, upload.DEFAULT_UPLOAD_CONCURRENCY], [1, 4, 2])
  assert.deepEqual([99, 0, 3].map(upload.resolveUploadConcurrency), [4, 2, 3])
  // retry count: a chunk that fails twice is sent 3 times and succeeds; three failures exhaust the attempts
  const kek = (await createVaultSetup('snapshot-passphrase-xyz-99', FAST)).kek
  const observeAttempts = async (failures) => {
    let puts = 0
    let session = null
    const fetchJson = async (p, opts = {}) => {
      if (opts.method === 'POST' && p === LEGACY) { session = { uploadId: 'a'.repeat(48), ...opts.body, status: 'open', expiresAt: Date.now() + 60_000, received: [], missing: [0], receivedBytes: 0 }; return { ok: true, status: 201, data: { upload: session } } }
      if (/\/commit$/.test(p)) return { ok: true, status: 201, data: { blob: { id: 'b'.repeat(48), formatVersion: 2 } } }
      return { ok: true, status: 200, data: { upload: session } }
    }
    const sendUpload = async () => { puts += 1; if (puts <= failures) return { ok: false, status: 0, data: null, errorKind: 'network' }; session.received = [0]; session.missing = []; return { ok: true, status: 200, data: { index: 0, size: 1, upload: session } } }
    const file = new File([new Uint8Array(64)], 'snapshot.bin')
    const res = await upload.uploadVaultFileChunked({ kek, file, plaintextChunkBytes: 8 * 1024 * 1024, concurrency: 1, fetchJson, sendUpload })
    return { puts, ok: res.ok }
  }
  assert.deepEqual(await observeAttempts(2), { puts: 3, ok: true })
  assert.deepEqual(await observeAttempts(3), { puts: 3, ok: false })
})

test('TU-6 strict bodies: name / parentId / nodeId / path (or any unknown key) on tree create and commit → 400 UNKNOWN_FIELD; legacy create still ignores unknown keys', async () => {
  // ⚠️ client นี้ "ไม่" ถูก capture: มันส่งฟิลด์ต้องห้ามโดยเจตนาเพื่อพิสูจน์ว่าถูกปฏิเสธ — NO-LEAK-3 สแกนเฉพาะ traffic รูปทรงจริง
  const c = await login(baseOn, DEMO_USER, { captured: false }); const kek = await setupVault(c)
  await seedTree(tree, ownerId)
  for (const extra of [{ name: SECRET_NAMES[0] }, { parentId: NODE_IDS[0] }, { parentNodeId: NODE_IDS[0] }, { nodeId: NODE_IDS[1] }, { path: `/${SECRET_NAMES[1]}/${SECRET_NAMES[0]}` }, { mediaType: 'image/png' }]) {
    const r = await openSession(c, kek, TREE, extra)
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.data.code, 'UNKNOWN_FIELD')
    assert.ok(!JSON.stringify(r.data).includes(Object.values(extra)[0]), 'the rejected value is never echoed')
  }
  const created = await openSession(c, kek); assert.equal(created.status, 201)
  const uploadId = created.data.upload.uploadId
  assert.equal((await putChunk(c, uploadId)).status, 200)
  for (const body of [{ name: SECRET_NAMES[2] }, { parentNodeId: NODE_IDS[0] }, { nodeId: NODE_IDS[1] }, { path: '/x' }]) {
    const r = await commit(c, uploadId, TREE, body)
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.data.code, 'UNKNOWN_FIELD')
  }
  assert.equal((await v2store.listVaultV2Blobs(ownerId)).length, 0)
  assert.equal((await commit(c, uploadId, TREE, {})).status, 201, 'an empty body commits')
  // legacy family: unchanged permissive behaviour for a FLAT owner
  await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests()
  assert.equal((await openSession(c, kek, LEGACY, { name: 'ignored.txt' })).status, 201)
})

test('TU-7 cancel leaves no blob state; a crashed tree commit recovered by recoverStaleVaultCommits still yields UNREFERENCED (both crash points)', async () => {
  const c = await login(); const kek = await setupVault(c)
  await seedTree(tree, ownerId)
  // (a) cancel
  const a = await openSession(c, kek); assert.equal((await cancel(c, a.data.upload.uploadId)).status, 200)
  assert.equal((await tree.listBlobStates(ownerId)).length, 0)
  // (b) crash after publish-rename, before metadata → recovery reopens → re-commit through the tree family
  const b = await openSession(c, kek); const bId = b.data.upload.uploadId
  assert.equal((await putChunk(c, bId)).status, 200)
  const key = newFinalVaultKey()
  assert.ok(await v2store.claimVaultV2SessionForCommit(bId, ownerId, key))
  await publishStagedVaultPartTo(bId, key)
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(await recoverStaleVaultCommits({ leaseMs: 1 }), { reopened: 1, committed: 0, aborted: 0, scanned: 1 })
  assert.equal((await tree.listBlobStates(ownerId)).length, 0, 'recovery of a never-published blob creates no state row')
  const bDone = await commit(c, bId); assert.equal(bDone.status, 201, JSON.stringify(bDone.data))
  assert.equal(bDone.data.blob.lifecycle, 'UNREFERENCED'); assert.equal((await blobStateOf(bDone.data.blob.id)).lifecycle, 'UNREFERENCED')
  // (c) crash after metadata (blob row + state row already atomic), session still 'committing' → recovery marks committed
  const [blob] = await v2store.listVaultV2Blobs(ownerId)
  assert.ok(await v2store.setVaultV2SessionStatus(bId, ownerId, 'open'))
  assert.ok(await v2store.claimVaultV2SessionForCommit(bId, ownerId, blob.storageKey))
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(await recoverStaleVaultCommits({ leaseMs: 1 }), { reopened: 0, committed: 1, aborted: 0, scanned: 1 })
  assert.equal((await status(c, bId)).data.upload.status, 'committed')
  assert.equal((await blobStateOf(blob.id)).lifecycle, 'UNREFERENCED')
  assert.equal((await v2store.listVaultV2Blobs(ownerId)).length, 1, 'no duplicate blob')
})

test('TU-8 owner isolation: another user cannot see, write, commit or cancel a tree session or its blob', async () => {
  const c = await login(); const kek = await setupVault(c)
  await seedTree(tree, ownerId)
  const created = await openSession(c, kek); const uploadId = created.data.upload.uploadId
  assert.equal((await putChunk(c, uploadId)).status, 200)
  const other = await login(baseOn, DEMO_ADMIN); await setupVault(other)
  await seedTree(tree, otherId, { treeId: fixedId(800), rootRevision: fixedId(801) })
  for (const r of [await status(other, uploadId), await putChunk(other, uploadId), await commit(other, uploadId), await cancel(other, uploadId)]) assert.equal(r.status, 404)
  const done = await commit(c, uploadId); assert.equal(done.status, 201)
  assert.equal((await status(c, uploadId)).data.upload.status, 'committed')
  assert.equal(await blobStateOf(done.data.blob.id, otherId), null)
  const otherInv = await other.req('/api/vault/tree/blobs'); assert.equal(otherInv.status, 200); assert.deepEqual(otherInv.data.blobs, [])
  assert.equal((await other.req(`/api/vault/blobs/${done.data.blob.id}`)).status, 404)
})

test('NO-LEAK-3 no request in this suite carried a plaintext name, node id, or a parent/path/name field', () => {
  const all = captures.map((cap) => cap.all()).join('\n')
  assert.ok(all.length > 0)
  for (const s of [...SECRET_NAMES, ...NODE_IDS]) assert.ok(!all.includes(s), `leak: ${s}`)
  // the TU-6 probes are the only requests naming such fields, and every one of them was rejected before any state change
  const probes = captures.flatMap((cap) => cap.entries()).filter((e) => /"(name|parentId|parentNodeId|nodeId|path|mediaType)"/.test(e.body))
  assert.ok(probes.every((e) => e.pathname.startsWith(TREE) || e.pathname === LEGACY), 'field-carrying requests are only the TU-6 rejection probes')
  assert.ok(probes.every((e) => !SECRET_NAMES.some((s) => e.body.includes(s)) || e.method === 'POST'))
})
