// tests/vaultTreeMigration.test.js — AEGIS Drive (IDEA1) · PR #157 Task 3.2 · client genesis migration (PM-*)
//
// PM-1  แผนจากซอง V1+V2 ด้วย KEK จริง → หนึ่ง entry ต่อ blob (ชื่อ/ชนิด/ขนาด มาจาก metadata เข้ารหัสเท่านั้น)
// PM-2  ซองที่พิสูจน์ไม่ผ่าน → ENVELOPE_UNDECRYPTABLE พร้อม opaque blob id; ไม่มีแผนบางส่วน
// PM-3  ชื่อชนกัน → COLLISION_UNRESOLVED จนกว่าผู้ใช้ตั้งชื่อใหม่เอง; ห้าม auto-rename
// PM-4  ขอบเขต (จำนวนโหนด/ความยาวชื่อ) → BOUNDS ก่อนยิงเน็ตเวิร์กใด ๆ
// PM-5  ลำดับ genesis: begin → plan จาก frozen blobs → TRK/slot → publish → ciphertext → commitGenesis
// PM-6  resume: lease ของเราข้าม begin; หมดอายุ → takeover; lease คนอื่น → LEASE_STALE + retry-after
// PM-7  commitGenesis 409 TREE_LEASE_STALE → โผล่เป็น TreeApiError ตรง ๆ ไม่มี retry loop
// PM-8  abort signal / unlockedState purge → ABORTED ก่อน publish เสมอ
// PM-9  เส้นทาง migration ไม่เข้ารหัส/อัปโหลดเนื้อหาไฟล์ และไม่เรียก DELETE เด็ดขาด
// PM-10 genesis manifest ถอดกลับได้เป็นชุด frozen blobs พอดี; bytes ที่ถึงเซิร์ฟเวอร์ไม่มีชื่อ (NO-LEAK-2)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptFileEnvelope, bytesToB64 } from '../src/lib/vaultCrypto.js'
import { metadataAad } from '../src/lib/vaultChunkCrypto.js'
import { unwrapTrkSlots } from '../src/lib/vaultTreeKeys.js'
import { decryptManifestRevision } from '../src/lib/vaultTreeManifestCrypto.js'
import { validateManifest, childrenOf, collisionKey } from '../src/lib/vaultTreeManifest.js'
import { VAULT_TREE_CLIENT_LIMITS, treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { planMigration, resolveCollisions, runGenesis, MigrationError } from '../src/lib/vaultTreeMigration.js'
import { TreeApiError } from '../src/lib/vaultTreeApi.js'
import { randomId } from './helpers/vaultTreeFixtures.mjs'

const subtle = globalThis.crypto.subtle
const te = new TextEncoder()
const NOW = 1_700_000_000_000
const LEASE_MS = 600_000
const ID_RE = /^[A-Za-z0-9_-]{22}$/

async function kek(seed = 7) {
  return subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function makeV1(k, name, type = 'application/pdf', size = 123) {
  const env = await encryptFileEnvelope(k, { name, type, size, bytes: new Uint8Array([1, 2, 3]) })
  return { formatVersion: 1, id: randomId(), ...env }
}

// V2 envelope สร้างตรง ๆ ตามสูตรของ vaultChunkCrypto (dek wrap ไม่มี AAD; meta ผูก metadataAad)
async function makeV2(k, name, type = 'video/mp4', plainSize = 456) {
  // contentIdB64 = base64 มาตรฐาน 16 ไบต์ (asContentId ใช้ atob) — ต่างจาก id ของ blob ที่เป็น base64url
  const contentIdB64 = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  const dekRaw = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const dek = await subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['encrypt'])
  const wrapIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, k, dekRaw))
  const metaIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const meta = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: metaIv, additionalData: metadataAad(contentIdB64, 1) }, dek, te.encode(JSON.stringify({ name, type, plainSize }))))
  dekRaw.fill(0)
  return { formatVersion: 2, id: randomId(), contentIdB64, chunkCount: 1, wrappedDekB64: bytesToB64(wrapped), wrapIvB64: bytesToB64(wrapIv), metaIvB64: bytesToB64(metaIv), metaB64: bytesToB64(meta), plainSize }
}

const ok = (data, status = 200) => ({ ok: true, status, data, errorKind: null })
const leaseWith = (blobs, epoch = 1) => ({ leaseId: randomId(), epoch, expiresAt: NOW + LEASE_MS, frozenInventoryId: randomId(), blobs })
const flatState = () => ok({ protocolState: 'FLAT', minProtocolVersion: 1, flags: {}, lease: null, head: null, purgeBarrierGeneration: 0 })

function recordingApi({ state = flatState, handlers = {} } = {}) {
  const calls = []
  const api = {
    calls,
    getTreeState: async (o = {}) => { calls.push(['getTreeState', o?.signal ?? null]); return state() },
    beginMigration: async (o = {}) => { calls.push(['beginMigration', o?.signal ?? null]); return handlers.begin ? handlers.begin() : ok({}) },
    takeoverMigration: async (o = {}) => { calls.push(['takeoverMigration', o?.signal ?? null]); return handlers.takeover ? handlers.takeover() : ok({}) },
    publishRevision: async (meta, o = {}) => { calls.push(['publishRevision', meta]); return handlers.publish ? handlers.publish(meta) : ok({ revisionId: meta.revisionId, state: 'CREATED' }, 201) },
    putRevisionCiphertext: async (revisionId, bytes, o = {}) => { calls.push(['putRevisionCiphertext', revisionId, bytes]); return handlers.put ? handlers.put(revisionId, bytes) : ok({ revisionId, state: 'PUBLISHED', ciphertextSize: bytes.length }) },
    commitGenesis: async (body, o = {}) => { calls.push(['commitGenesis', body]); return handlers.commit ? handlers.commit(body) : ok({ treeId: body.treeId, generation: 1, revisionId: body.revision.revisionId, protocolState: 'TREE_V1' }, 201) },
  }
  return api
}

const readSrc = (name) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', name), 'utf8')
const namesOf = (calls) => calls.map((c) => c[0])

test('PM-1 planMigration decrypts V1 and V2 envelopes with the KEK and builds one entry per blob', async () => {
  const k = await kek()
  const blobs = [await makeV1(k, 'รายงาน.pdf', 'application/pdf', 123), await makeV2(k, 'คลิป.mp4', 'video/mp4', 456)]
  const plan = await planMigration({ kek: k, inventory: blobs, limits: VAULT_TREE_CLIENT_LIMITS })
  assert.equal(plan.entries.length, 2)
  const byId = new Map(plan.entries.map((e) => [e.blobRef.id, e]))
  assert.deepEqual(byId.get(blobs[0].id), { name: 'รายงาน.pdf', mediaType: 'application/pdf', plainSize: 123, blobRef: { formatVersion: 1, id: blobs[0].id } })
  assert.deepEqual(byId.get(blobs[1].id), { name: 'คลิป.mp4', mediaType: 'video/mp4', plainSize: 456, blobRef: { formatVersion: 2, id: blobs[1].id } })
  assert.equal(plan.collisions.length, 0)
  assert.deepEqual([...plan.blobIds].sort(), blobs.map((b) => b.id).sort())
})

test('PM-2 an envelope that fails to authenticate → ENVELOPE_UNDECRYPTABLE with the opaque blob id; no partial plan', async () => {
  const k = await kek()
  const good = await makeV1(k, 'good.txt', 'text/plain', 3)
  const bad = await makeV1(await kek(9), 'secret.txt', 'text/plain', 3)
  await assert.rejects(
    planMigration({ kek: k, inventory: [good, bad], limits: VAULT_TREE_CLIENT_LIMITS }),
    (e) => e instanceof MigrationError && e.code === 'ENVELOPE_UNDECRYPTABLE' && e.blobId === bad.id,
  )
})

test('PM-3 collisions must be resolved with explicit names; runGenesis refuses; resolver never auto-renames', async () => {
  const k = await kek()
  const a = await makeV1(k, 'notes.txt', 'text/plain', 1)
  const a2 = await makeV2(k, 'NOTES.TXT', 'text/plain', 2)
  const b = await makeV1(k, 'other.bin', 'application/octet-stream', 3)
  const inv = [a, a2, b]
  const plan = await planMigration({ kek: k, inventory: inv, limits: VAULT_TREE_CLIENT_LIMITS })
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].key, collisionKey('notes.txt'))
  assert.deepEqual(plan.collisions[0].entries.map((e) => e.blobRef.id).sort(), [a.id, a2.id].sort())

  const lease = leaseWith(inv)
  const api = recordingApi({ handlers: { begin: () => ok(lease, 201) } })
  await assert.rejects(
    runGenesis({ kek: k, api, unlockedState: null, signal: null, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'COLLISION_UNRESOLVED' && e.plan?.collisions?.length === 1 && e.plan.entries.length === 3,
  )
  assert.deepEqual(namesOf(api.calls), ['getTreeState', 'beginMigration'])

  const src = readSrc('vaultTreeMigration.js')
  assert.doesNotMatch(src, /\(\s*1\s*\)|autoRename|auto_rename/i)
  assert.deepEqual(plan.entries.map((e) => e.name).sort(), ['NOTES.TXT', 'notes.txt', 'other.bin'].sort())

  const resolved = resolveCollisions(plan, new Map([[plan.collisions[0].entries[1], 'ตัวสำรอง.txt']]))
  assert.equal(resolved.collisions.length, 0)
  assert.equal(resolved.entries.find((e) => e.blobRef.id === a2.id).name, 'ตัวสำรอง.txt')

  const still = resolveCollisions(plan, new Map([[plan.collisions[0].entries[1], 'notes.txt']]))
  assert.equal(still.collisions.length, 1)
  await assert.rejects(
    runGenesis({ kek: k, api, plan: still, unlockedState: null, signal: null, lease, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'COLLISION_UNRESOLVED',
  )

  assert.throws(() => resolveCollisions(plan, new Map([[plan.collisions[0].entries[1], 'x'.repeat(601)]])), (e) => e instanceof MigrationError && e.code === 'BOUNDS')

  const res = await runGenesis({ kek: k, api, plan: resolved, unlockedState: null, signal: null, lease, now: NOW })
  assert.equal(res.generation, 1)
  assert.match(res.treeId, ID_RE)
})

test('PM-4 bounds: too many entries or too-long names → BOUNDS before any network call', async () => {
  const k = await kek()
  const lim = treeLimitsFrom({ maxNodes: 3 })
  const blobs = []
  for (let i = 0; i < 4; i++) blobs.push(await makeV1(k, `f${i}.txt`, 'text/plain', 1))
  await assert.rejects(planMigration({ kek: k, inventory: blobs, limits: lim }), (e) => e instanceof MigrationError && e.code === 'BOUNDS')
  const long = await makeV1(k, 'ย'.repeat(250), 'text/plain', 1)
  await assert.rejects(planMigration({ kek: k, inventory: [long], limits: VAULT_TREE_CLIENT_LIMITS }), (e) => e instanceof MigrationError && e.code === 'BOUNDS')
})

test('PM-5 runGenesis: begin → plan from the lease response → TRK genesis → publish → ciphertext → commitGenesis', async () => {
  const k = await kek()
  const blobs = [await makeV1(k, 'a.png', 'image/png', 11), await makeV2(k, 'b.mp4', 'video/mp4', 22)]
  let lease = null
  const api = recordingApi({
    handlers: {
      begin: () => { lease = leaseWith(blobs); return ok(lease, 201) },
      publish: (meta) => { pub = meta; return ok({ revisionId: meta.revisionId, state: 'CREATED' }, 201) },
      put: (id, bytes) => { putBytes = bytes; return ok({ revisionId: id, state: 'PUBLISHED', ciphertextSize: bytes.length }) },
    },
  })
  let pub = null
  let putBytes = null
  const res = await runGenesis({ kek: k, api, unlockedState: null, signal: null, now: NOW })
  assert.equal(res.generation, 1)
  assert.deepEqual(namesOf(api.calls), ['getTreeState', 'beginMigration', 'publishRevision', 'putRevisionCiphertext', 'commitGenesis'])
  assert.ok(pub instanceof Object && putBytes instanceof Uint8Array)
  const com = api.calls[4][1]
  assert.equal(pub.generation, 1)
  assert.equal(pub.baseRevisionId, null)
  assert.equal(pub.manifestSchemaVersion, 1)
  assert.equal(com.leaseId, lease.leaseId)
  assert.equal(com.epoch, 1)
  assert.equal(com.frozenInventoryId, lease.frozenInventoryId)
  assert.match(com.treeId, ID_RE)
  assert.match(com.ownerScopeIdB64, ID_RE)
  assert.match(com.idempotencyKey, ID_RE)
  assert.equal(com.idempotencyKey, pub.idempotencyKey)
  assert.deepEqual(Object.keys(com.keyEnvelope).sort(), ['primary', 'recovery'])
  assert.deepEqual(Object.keys(com.keyEnvelope.primary).sort(), ['wrapIvB64', 'wrappedTrkB64'])
  assert.deepEqual(Object.keys(com.revision).sort(), ['ivB64', 'manifestSchemaVersion', 'revisionId', 'wrapIvB64', 'wrappedManifestDekB64'])
  assert.equal(api.calls[3][1], pub.revisionId)
  assert.ok(api.calls[3][2] instanceof Uint8Array && api.calls[3][2].length > 16)
})

test('PM-6 resume: our lease skips begin; expired lease takes over; foreign lease is LEASE_STALE with retry-after', async () => {
  const k = await kek()
  const blobs = [await makeV1(k, 'r.txt', 'text/plain', 1)]
  const plan = await planMigration({ kek: k, inventory: blobs, limits: VAULT_TREE_CLIENT_LIMITS })
  const lease = leaseWith(blobs)

  const apiA = recordingApi({ state: () => ok({ protocolState: 'MIGRATING_TREE_V1', lease: { held: true, expiresAt: lease.expiresAt, epoch: 1 }, head: null, purgeBarrierGeneration: 0 }) })
  await runGenesis({ kek: k, api: apiA, plan, unlockedState: null, signal: null, lease, now: NOW })
  assert.deepEqual(namesOf(apiA.calls), ['getTreeState', 'publishRevision', 'putRevisionCiphertext', 'commitGenesis'])

  const apiB = recordingApi({
    state: () => ok({ protocolState: 'MIGRATING_TREE_V1', lease: { held: true, expiresAt: NOW - 1, epoch: 1 }, head: null, purgeBarrierGeneration: 0 }),
    handlers: { takeover: () => ok({ ...lease, epoch: 2, expiresAt: NOW + LEASE_MS }, 200) },
  })
  const resB = await runGenesis({ kek: k, api: apiB, plan, unlockedState: null, signal: null, lease, now: NOW })
  assert.equal(resB.generation, 1)
  assert.deepEqual(namesOf(apiB.calls), ['getTreeState', 'takeoverMigration', 'publishRevision', 'putRevisionCiphertext', 'commitGenesis'])
  assert.equal(apiB.calls[4][1].epoch, 2)

  const apiC = recordingApi({ state: () => ok({ protocolState: 'MIGRATING_TREE_V1', lease: { held: true, expiresAt: NOW + LEASE_MS, epoch: 3 }, head: null, purgeBarrierGeneration: 0 }) })
  await assert.rejects(
    runGenesis({ kek: k, api: apiC, plan, unlockedState: null, signal: null, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'LEASE_STALE' && e.expiresAt === NOW + LEASE_MS && e.retryAfterMs === LEASE_MS,
  )
  assert.deepEqual(namesOf(apiC.calls), ['getTreeState'])

  const apiD = recordingApi({ state: () => ok({ protocolState: 'MIGRATING_TREE_V1', lease: { held: true, expiresAt: NOW + LEASE_MS, epoch: 2 }, head: null, purgeBarrierGeneration: 0 }) })
  await assert.rejects(
    runGenesis({ kek: k, api: apiD, plan, unlockedState: null, signal: null, lease, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'LEASE_STALE',
  )
})

test('PM-7 commitGenesis 409 TREE_LEASE_STALE surfaces as TreeApiError; no retry; ciphertext discarded', async () => {
  const k = await kek()
  const blobs = [await makeV1(k, 's.txt', 'text/plain', 1)]
  let lease = null
  const api = recordingApi({
    handlers: {
      begin: () => { lease = leaseWith(blobs); return ok(lease, 201) },
      commit: () => ({ ok: false, status: 409, data: { error: 'stale', code: 'TREE_LEASE_STALE' }, errorKind: 'server' }),
    },
  })
  await assert.rejects(
    runGenesis({ kek: k, api, unlockedState: null, signal: null, now: NOW }),
    (e) => e instanceof TreeApiError && e.code === 'TREE_LEASE_STALE' && e.status === 409,
  )
  assert.deepEqual(namesOf(api.calls), ['getTreeState', 'beginMigration', 'publishRevision', 'putRevisionCiphertext', 'commitGenesis'])
})

test('PM-8 abort signal or unlocked-state purge invalidates the run before any publish', async () => {
  const k = await kek()
  const blobs = [await makeV1(k, 'x.txt', 'text/plain', 1)]

  const ctrl = new AbortController()
  const apiA = recordingApi({ handlers: { begin: () => { ctrl.abort(); return ok(leaseWith(blobs), 201) } } })
  await assert.rejects(
    runGenesis({ kek: k, api: apiA, unlockedState: null, signal: ctrl.signal, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'ABORTED',
  )
  assert.deepEqual(namesOf(apiA.calls), ['getTreeState', 'beginMigration'])

  let purged = false
  const apiB = recordingApi({ handlers: { begin: () => { purged = true; return ok(leaseWith(blobs), 201) } } })
  await assert.rejects(
    runGenesis({ kek: k, api: apiB, unlockedState: { isPurged: () => purged }, signal: null, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'ABORTED',
  )
  assert.deepEqual(namesOf(apiB.calls), ['getTreeState', 'beginMigration'])

  const apiC = recordingApi()
  await assert.rejects(
    runGenesis({ kek: k, api: apiC, unlockedState: { isPurged: () => true }, signal: null, now: NOW }),
    (e) => e instanceof MigrationError && e.code === 'ABORTED',
  )
  assert.deepEqual(namesOf(apiC.calls), [])
})

test('PM-9 ciphertext unchanged: the migration path uploads no file content and never calls DELETE', async () => {
  const k = await kek()
  const blobs = [await makeV1(k, 'a.txt', 'text/plain', 1), await makeV2(k, 'b.mp4', 'video/mp4', 2)]
  const api = recordingApi({ handlers: { begin: () => ok(leaseWith(blobs), 201) } })
  await runGenesis({ kek: k, api, unlockedState: null, signal: null, now: NOW })
  assert.deepEqual(namesOf(api.calls).sort(), ['beginMigration', 'commitGenesis', 'getTreeState', 'publishRevision', 'putRevisionCiphertext'])
  const srcM = readSrc('vaultTreeMigration.js')
  const srcA = readSrc('vaultTreeApi.js')
  assert.doesNotMatch(srcM, /encryptVaultChunk|uploadVaultFileChunked|vaultChunkedUpload/)
  assert.doesNotMatch(srcM, /\bDELETE\b/)
  assert.doesNotMatch(srcA, /\bDELETE\b/)
})

test('PM-10 the genesis manifest decrypts back to exactly the frozen blobs; server-bound bytes carry no names (NO-LEAK-2)', async () => {
  const k = await kek()
  const names = ['รายงาน Q4.pdf', 'holiday-photo.jpg']
  const blobs = [await makeV1(k, names[0], 'application/pdf', 100), await makeV2(k, names[1], 'image/jpeg', 200)]
  let pub = null
  let putBytes = null
  const api = recordingApi({
    handlers: {
      begin: () => ok(leaseWith(blobs), 201),
      publish: (meta) => { pub = meta; return ok({ revisionId: meta.revisionId, state: 'CREATED' }, 201) },
      put: (id, bytes) => { putBytes = bytes; return ok({ revisionId: id, state: 'PUBLISHED', ciphertextSize: bytes.length }) },
    },
  })
  await runGenesis({ kek: k, api, unlockedState: null, signal: null, now: NOW })
  const com = api.calls.find((c) => c[0] === 'commitGenesis')[1]
  const { trk } = await unwrapTrkSlots(k, com.keyEnvelope, { ownerScopeId: com.ownerScopeIdB64, treeId: com.treeId, protocolVersion: 1, keyEnvelopeVersion: 1 })
  const manifest = await decryptManifestRevision(
    trk,
    { ciphertext: putBytes, ivB64: pub.ivB64, wrappedManifestDekB64: pub.wrappedManifestDekB64, wrapIvB64: pub.wrapIvB64 },
    { treeId: com.treeId, revisionId: pub.revisionId, baseRevisionId: null, generation: 1, manifestSchemaVersion: 1 },
  )
  const { index } = validateManifest(manifest)
  const kids = childrenOf(index, manifest.rootNodeId)
  assert.deepEqual(kids.map((n) => n.blobRef.id).sort(), blobs.map((b) => b.id).sort())
  assert.deepEqual(kids.map((n) => n.name).sort(), names.slice().sort())

  const bound = JSON.stringify([com, pub]) + Buffer.from(putBytes).toString('latin1')
  for (const n of names) assert.ok(!bound.includes(n), `plaintext name leaked to server: ${n}`)
})
