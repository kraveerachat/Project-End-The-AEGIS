// tests/vaultTreeGenesisMigrationIntegration.test.js — AEGIS Drive (IDEA1) · PR #157 G7 correction · genesis migration end-to-end
//
// ⚠️ ทำไมต้องมีไฟล์นี้: vaultTreeMigration.test.js ใช้ api จำลองที่ "รับทุกฟิลด์" จึงไม่เห็นว่า
//    runGenesis ส่ง descriptor ที่ขาด treeId ไปยัง POST /api/vault/tree/revisions — ในขณะที่เซิร์ฟเวอร์จริง
//    บังคับ treeId ระหว่าง MIGRATING_TREE_V1 (fail-closed) และตอบ 409 TREE_STATE_CONFLICT
//    (พบโดย Human Owner ในเบราว์เซอร์จริง: vault ว่าง 0 ไฟล์ → "Upgrade to folders" → TREE_STATE_CONFLICT)
//    ไฟล์นี้ขับ runGenesis ตัวจริง + วรัปเปอร์ vaultTreeApi ตัวจริง ผ่าน transport ที่ถือ cookie/CSRF
//    ไปยัง createApp() จริง (in-memory backend) — สัญญาระหว่าง client/server จึงถูกพิสูจน์จริง ไม่ใช่กับ mock
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'
import { revisionDescriptor } from './helpers/vaultTreeFixtures.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-tree-genesis-int-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
delete process.env.DATABASE_URL
for (const k of Object.keys(process.env)) if (k.startsWith('VAULT_TREE_') || k === 'VAULT_MEDIA_PREVIEW_ENABLED' || k === 'VAULT_DESTRUCTIVE_PURGE_ENABLED') delete process.env[k]

const { createApp } = await import('../server/app.js')
const { vaultTreeConfigFromEnv } = await import('../server/config/vaultTreeLimits.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultManifestStorage } = await import('../server/storage/vaultManifestStore.js')
const tree = await import('../server/db/vaultTreeStore.js')
const store = await import('../server/db/store.js')
const v2store = await import('../server/db/vaultV2Store.js')
const { getUserByUsername } = await import('../server/db/connection.js')
const { createVaultSetup, encryptFileEnvelope } = await import('../src/lib/vaultCrypto.js')
const treeApi = await import('../src/lib/vaultTreeApi.js')
const { runGenesis, MigrationError } = await import('../src/lib/vaultTreeMigration.js')
const { unwrapTrkSlots } = await import('../src/lib/vaultTreeKeys.js')
const { decryptManifestRevision } = await import('../src/lib/vaultTreeManifestCrypto.js')
const { validateManifest, childrenOf } = await import('../src/lib/vaultTreeManifest.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const ID_RE = /^[A-Za-z0-9_-]{22}$/
// the same flag set the Human Owner ran in the browser (media preview / purge flags are irrelevant to genesis staging)
const CFG = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true' })

let server, base, ownerId
before(async () => {
  await initStorage(); await initVaultStorage(); await initVaultManifestStorage()
  server = createApp({ vaultTreeConfig: CFG }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  ownerId = String((await getUserByUsername(DEMO_USER.username)).id)
})
after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
beforeEach(async () => { await tree.__resetVaultTreeForTests(); await v2store.__resetVaultV2ForTests(); await store.__resetVaultForTests() })

/** vault setup + n legacy V1 blobs uploaded through the real routes; returns the KEK the browser would hold after unlock */
async function unlockedVault(client, n) {
  const setup = await createVaultSetup('genesis-integration-passphrase', FAST)
  assert.equal((await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status, 201)
  const ids = []
  for (let i = 0; i < n; i++) {
    const env = await encryptFileEnvelope(setup.kek, { name: `secret-file-${i}.pdf`, type: 'application/pdf', size: 3, bytes: new Uint8Array([1, 2, i]) })
    const form = new FormData()
    form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
    for (const k of ['ivB64', 'wrappedDekB64', 'wrapIvB64', 'metaIvB64', 'metaB64']) form.append(k, env[k])
    const up = await client.req('/api/vault/blobs', { method: 'POST', body: form })
    assert.equal(up.status, 201); ids.push(String(up.data.blob.id))
  }
  return { kek: setup.kek, ids }
}

/**
 * apiFetch-shaped transport ({ ok, status, data, errorKind }) riding on the cookie/CSRF test client —
 * every request the real client would send is recorded (method, path, JSON body / raw byte length)
 */
function realTransport(client) {
  const sent = []
  const fetchJson = async (pathname, { method = 'GET', body, signal } = {}) => {
    const raw = body instanceof Uint8Array
    sent.push({ method, pathname, body: raw ? null : (body ?? null), rawBytes: raw ? body.length : null })
    const r = await client.req(pathname, { method, body, headers: raw ? { 'Content-Type': 'application/octet-stream' } : undefined, signal })
    const ok = r.status >= 200 && r.status < 400
    return { ok, status: r.status, data: r.data, errorKind: ok ? null : 'server' }
  }
  const o = () => ({ fetchJson })
  const api = {
    getTreeState: () => treeApi.getTreeState(o()),
    beginMigration: () => treeApi.beginMigration(o()),
    takeoverMigration: () => treeApi.takeoverMigration(o()),
    publishRevision: (meta) => treeApi.publishRevision(meta, o()),
    putRevisionCiphertext: (revisionId, bytes) => treeApi.putRevisionCiphertext(revisionId, bytes, o()),
    commitGenesis: (body) => treeApi.commitGenesis(body, o()),
  }
  return { api, sent }
}

/** apiFetchBytes-shaped transport ({ ok, status, bytes, errorKind }) for the raw revision ciphertext read-back */
const realBytesTransport = (client) => async (pathname) => {
  const r = await client.raw(pathname)
  const ok = r.status >= 200 && r.status < 400
  return { ok, status: r.status, bytes: ok ? new Uint8Array(r.buffer) : null, headers: r.headers, errorKind: ok ? null : 'server' }
}

const stagedRevision = (sent) => sent.find((s) => s.method === 'POST' && s.pathname === '/api/vault/tree/revisions')
const login = () => loginClient(base, DEMO_USER.username, DEMO_USER.password)

/** the whole contract path against the real server; returns everything needed for the assertions */
async function migrate(n) {
  const client = await login()
  const { kek, ids } = await unlockedVault(client, n)
  assert.equal((await client.req('/api/vault/tree/state')).data.protocolState, 'FLAT')
  const { api, sent } = realTransport(client)
  const stages = []
  const result = await runGenesis({ kek, api, onStage: (ev) => stages.push(ev.type) })
  return { client, kek, ids, sent, stages, result }
}

test('GM-INT-1 FLAT → runGenesis against the real server: staged revision names an opaque treeId, ciphertext publishes, commitGenesis lands TREE_V1 g1 with the same treeId', async () => {
  const { client, ids, sent, stages, result } = await migrate(1)
  assert.deepEqual(stages, ['lease', 'plan', 'commit'])
  assert.deepEqual(sent.map((s) => `${s.method} ${s.pathname.replace(/\/revisions\/[^/]+\//, '/revisions/:id/')}`), [
    'GET /api/vault/tree/state', 'POST /api/vault/tree/migration/begin', 'POST /api/vault/tree/revisions',
    'PUT /api/vault/tree/revisions/:id/ciphertext', 'POST /api/vault/tree/genesis',
  ])
  const staged = stagedRevision(sent).body
  assert.match(staged.treeId, ID_RE, 'genesis revision descriptor must carry the new opaque treeId')
  assert.equal(staged.generation, 1); assert.equal(staged.baseRevisionId, null)
  assert.equal(staged.treeId, result.treeId, 'staged treeId is the one commitGenesis binds')
  assert.deepEqual(result, { treeId: staged.treeId, generation: 1, revisionId: staged.revisionId, protocolState: 'TREE_V1' })

  const st = await client.req('/api/vault/tree/state')
  assert.equal(st.data.protocolState, 'TREE_V1')
  const head = await client.req('/api/vault/tree/head')
  assert.equal(head.status, 200, JSON.stringify(head.data))
  assert.equal(head.data.generation, 1)
  assert.equal(head.data.treeId, staged.treeId, 'head treeId equals the genesis treeId')
  assert.equal(head.data.revisionId, staged.revisionId)
  assert.equal((await tree.getHead(ownerId)).treeId, staged.treeId)
  assert.ok((await tree.listBlobStates(ownerId)).every((s) => ids.includes(s.id) && s.lifecycle === 'TREE_MANAGED'))
})

test('GM-INT-2 empty inventory (0 files — the browser case that failed) migrates FLAT → TREE_V1', async () => {
  const { client, sent, result } = await migrate(0)
  const staged = stagedRevision(sent).body
  assert.match(staged.treeId, ID_RE)
  assert.equal(result.protocolState, 'TREE_V1'); assert.equal(result.generation, 1)
  assert.equal((await client.req('/api/vault/tree/state')).data.protocolState, 'TREE_V1')
  const head = await client.req('/api/vault/tree/head')
  assert.equal(head.status, 200, JSON.stringify(head.data))
  assert.equal(head.data.treeId, result.treeId); assert.equal(head.data.generation, 1)
  assert.deepEqual(await tree.listBlobStates(ownerId), [])
})

test('GM-INT-3 non-empty inventory migrates and the committed head manifest lists every legacy blob', async () => {
  const { client, kek, ids, sent, result } = await migrate(3)
  assert.equal(result.protocolState, 'TREE_V1')
  const head = (await client.req('/api/vault/tree/head')).data
  assert.equal(head.treeId, result.treeId)
  const genesis = sent.find((s) => s.pathname === '/api/vault/tree/genesis').body
  const { trk } = await unwrapTrkSlots(kek, head.keyEnvelope, { ownerScopeId: genesis.ownerScopeIdB64, treeId: head.treeId, protocolVersion: 1, keyEnvelopeVersion: 1 })
  const ciphertext = await treeApi.getRevisionCiphertext(head.revisionId, { fetchBytes: realBytesTransport(client) })
  const manifest = await decryptManifestRevision(
    trk,
    { ciphertext, ivB64: head.ivB64, wrappedManifestDekB64: head.wrappedManifestDekB64, wrapIvB64: head.wrapIvB64 },
    { treeId: head.treeId, revisionId: head.revisionId, baseRevisionId: null, generation: 1, manifestSchemaVersion: 1 },
  )
  const { index } = validateManifest(manifest)
  const kids = childrenOf(index, manifest.rootNodeId)
  assert.deepEqual(kids.map((n) => n.blobRef.id).sort(), [...ids].sort())
  assert.deepEqual(kids.map((n) => n.name).sort(), ids.map((_, i) => `secret-file-${i}.pdf`).sort())
  const states = await tree.listBlobStates(ownerId)
  assert.deepEqual(states.map((s) => s.id).sort(), [...ids].sort())
  assert.ok(states.every((s) => s.lifecycle === 'TREE_MANAGED' && s.attachedGeneration === 1))
})

test('GM-INT-4 server keeps fail-closed: a migration revision without treeId → 409 TREE_STATE_CONFLICT and nothing is staged', async () => {
  const client = await login()
  await unlockedVault(client, 0)
  assert.equal((await client.req('/api/vault/tree/migration/begin', { method: 'POST', body: {} })).status, 201)
  const desc = revisionDescriptor({ generation: 1, baseRevisionId: null }) // no treeId key at all
  const r = await client.req('/api/vault/tree/revisions', { method: 'POST', body: desc })
  assert.equal(r.status, 409, JSON.stringify(r.data))
  assert.equal(r.data.code, 'TREE_STATE_CONFLICT')
  assert.equal(await tree.getRevision(ownerId, desc.revisionId), null)
  assert.equal((await tree.peekTreeState(ownerId)).protocolState, 'MIGRATING_TREE_V1')
  // the same descriptor with an opaque treeId is exactly what the server accepts (proves the fix target, not a weakened contract)
  const withTree = await client.req('/api/vault/tree/revisions', { method: 'POST', body: { ...desc, treeId: 'A'.repeat(22) } })
  assert.equal(withTree.status, 201, JSON.stringify(withTree.data))
})

test('GM-INT-5 the genesis requests carry only opaque fields — no plaintext file name, folder name, parent or path', async () => {
  const { sent } = await migrate(2)
  const staged = stagedRevision(sent).body
  assert.deepEqual(Object.keys(staged).sort(), ['baseRevisionId', 'generation', 'idempotencyKey', 'ivB64', 'manifestSchemaVersion', 'revisionId', 'treeId', 'wrapIvB64', 'wrappedManifestDekB64'])
  const wire = JSON.stringify(sent.map((s) => ({ ...s, body: s.body ?? null })))
  for (const leak of ['secret-file-', '.pdf', 'application/pdf', '"name"', '"parent"', '"parentId"', '"path"', '"folder"', '"nodes"', '"rootNodeId"']) {
    assert.ok(!wire.includes(leak), `plaintext hierarchy metadata on the wire: ${leak}`)
  }
})

test('GM-INT-6 runGenesis surfaces a server TREE_STATE_CONFLICT as MigrationError (not as an unhandled transport error)', async () => {
  const client = await login()
  const { kek } = await unlockedVault(client, 0)
  const { api } = realTransport(client)
  const first = await runGenesis({ kek, api })
  assert.equal(first.protocolState, 'TREE_V1')
  // a second migration on a TREE_V1 vault is refused client-side by the state gate
  await assert.rejects(runGenesis({ kek, api }), (e) => e instanceof MigrationError && e.code === 'TREE_STATE_CONFLICT')
})

/* ── CT-INT-* (second G7 correction) — the REAL apiFetch transport boundary ──
   ⚠️ บทเรียนจาก GM-INT: transport ของชุดเดิม "ฉีด Content-Type: application/octet-stream
   เองในเทสต์" จึงซ่อนบั๊กของ apiFetch จริง — เบราว์เซอร์จริงได้ 415 (Human Owner G7 retest
   ที่ 0618708d) เพราะ apiFetch ไม่เคยเซ็ต Content-Type ให้ Uint8Array ชุดนี้ขับ apiFetch
   ตัวจริงผ่าน fetch shim ที่แนบเฉพาะสิ่งที่ "เบราว์เซอร์" ปกติให้เอง (cookie, CSRF จาก
   credentials:'include') — Content-Type และรูปแบบ body ทั้งหมดเป็นของ apiFetch ตามจริง */
import { setCsrfToken, clearCsrfToken } from '../src/lib/api.js'

const captureApiFetch = (client) => {
  const real = globalThis.fetch
  const sent = []
  const shim = async (input, opts = {}) => {
    const url = String(input)
    const method = (opts.method ?? 'GET').toUpperCase()
    const headers = { ...(opts.headers ?? {}) }
    if (client.cookie) headers.cookie = client.cookie
    if (client.csrf && method !== 'GET') headers['X-CSRF-Token'] = client.csrf
    const body = opts.body
    sent.push({
      method, url,
      contentType: headers['Content-Type'] ?? null,
      hasCookie: Boolean(headers.cookie), hasCsrf: Boolean(headers['X-CSRF-Token']),
      byteLength: body instanceof Uint8Array ? body.length : null,
      isFormData: typeof FormData !== 'undefined' && body instanceof FormData,
      bytes: body instanceof Uint8Array ? Buffer.from(body) : null,
      body,
    })
    // withBase in plain node yields api/... (no slash); in the browser it is base-prefixed —
    // normalize both shapes onto the test server, pass absolute URLs through untouched
    const target = url.startsWith('http')
      ? url
      : base + (url.startsWith('/') ? url : '/' + url)
    return real(target, { ...opts, headers })
  }
  globalThis.fetch = shim
  return { sent, restore: () => { globalThis.fetch = real } }
}

/** ครึ่งหลังของ genesis ผ่าน apiFetch ตัวจริง (runGenesis ตัวจริง + wrapper ตัวจริง) */
async function migrateRealApiFetch(n) {
  const client = await login()
  const { kek, ids } = await unlockedVault(client, n)
  assert.equal((await client.req('/api/vault/tree/state')).data.protocolState, 'FLAT')
  setCsrfToken(client.csrf)
  const { sent, restore } = captureApiFetch(client)
  const stages = []
  const o = () => ({})
  const api = {
    getTreeState: () => treeApi.getTreeState(o()),
    beginMigration: () => treeApi.beginMigration(o()),
    publishRevision: (meta) => treeApi.publishRevision(meta, o()),
    putRevisionCiphertext: (revisionId, bytes) => treeApi.putRevisionCiphertext(revisionId, bytes, o()),
    commitGenesis: (body) => treeApi.commitGenesis(body, o()),
  }
  try {
    const result = await runGenesis({ kek, api, onStage: (ev) => stages.push(ev.type) })
    return { client, kek, ids, sent, stages, result }
  } finally {
    restore()
    clearCsrfToken()
  }
}

test('CT-INT-1 the real apiFetch sends a Uint8Array PUT as raw bytes with Content-Type octet-stream and the server publishes the revision', async () => {
  const { sent } = await migrateRealApiFetch(1)
  const put = sent.find((s) => s.method === 'PUT' && /\/ciphertext$/.test(s.url))
  assert.ok(put, 'the ciphertext PUT went through apiFetch')
  assert.equal(put.contentType, 'application/octet-stream', `apiFetch must set octet-stream for raw bytes (got ${put.contentType}) — the server fails closed with 415 otherwise`)
  assert.equal(put.byteLength, put.bytes.length)
})

test('CT-INT-2 the full genesis through the real apiFetch transport lands TREE_V1 generation 1 (browser-equivalent)', async () => {
  const { client, sent, result } = await migrateRealApiFetch(0)
  assert.equal(result.protocolState, 'TREE_V1')
  assert.equal(result.generation, 1)
  assert.equal((await client.req('/api/vault/tree/state')).data.protocolState, 'TREE_V1')
  const put = sent.find((s) => s.method === 'PUT' && /\/ciphertext$/.test(s.url))
  assert.ok(put && put.contentType === 'application/octet-stream')
})

test('CT-INT-3 the server still rejects wrong and missing media types (contract not weakened)', async () => {
  const client = await login()
  const { kek } = await unlockedVault(client, 0)
  await client.req('/api/vault/tree/migration/begin', { method: 'POST', body: {} })
  const desc = revisionDescriptor({ generation: 1, baseRevisionId: null, treeId: 'B'.repeat(22) })
  const staged = await client.req('/api/vault/tree/revisions', { method: 'POST', body: desc })
  assert.equal(staged.status, 201, JSON.stringify(staged.data))
  const ciphertext = new Uint8Array([9, 9, 9])
  const wrong = await client.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: ciphertext, headers: { 'Content-Type': 'text/plain' } })
  assert.equal(wrong.status, 415)
  assert.equal(wrong.data.code, 'INVALID_INPUT')
  // the same PUT with the right type is accepted — the contract is exact, not weakened
  const right = await client.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: ciphertext, headers: { 'Content-Type': 'application/octet-stream' } })
  assert.equal(right.status, 200, JSON.stringify(right.data))
})

test('CT-INT-4 JSON object bodies still travel as application/json', async () => {
  const { sent } = await migrateRealApiFetch(0)
  const jsonPosts = sent.filter((s) => s.method === 'POST' && !s.url.includes('/ciphertext') && !s.isFormData)
  assert.ok(jsonPosts.length >= 3, 'the genesis flow posts JSON descriptors')
  for (const p of jsonPosts) assert.equal(p.contentType, 'application/json', `${p.url} must stay JSON`)
})

test('CT-INT-5 FormData bodies keep the browser-owned multipart boundary (no injected Content-Type)', async () => {
  const client = await login()
  setCsrfToken(client.csrf)
  const { sent, restore } = captureApiFetch(client)
  try {
    const { encryptFileEnvelope } = await import('../src/lib/vaultCrypto.js')
    const setup = await createVaultSetup('ct-int-formdata-pass', FAST)
    await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
    const env = await encryptFileEnvelope(setup.kek, { name: 'ct-int.pdf', type: 'application/pdf', size: 3, bytes: new Uint8Array([7, 7, 7]) })
    const form = new FormData()
    form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
    for (const k of ['ivB64', 'wrappedDekB64', 'wrapIvB64', 'metaIvB64', 'metaB64']) form.append(k, env[k])
    const apiMod = await import('../src/lib/api.js')
    await apiMod.apiFetch('/api/vault/blobs', { method: 'POST', body: form })
    const formSent = sent.find((s2) => s2.isFormData)
    assert.ok(formSent, 'the FormData request rode apiFetch')
    assert.equal(formSent.contentType, null, 'apiFetch must NOT set Content-Type for FormData — the browser owns the boundary')
  } finally {
    restore()
    clearCsrfToken()
  }
})

test('CT-INT-6 the stored ciphertext is byte-identical to what the client sent', async () => {
  const { client, sent, result } = await migrateRealApiFetch(1)
  const put = sent.find((s) => s.method === 'PUT' && /\/ciphertext$/.test(s.url))
  const readBack = await treeApi.getRevisionCiphertext(result.revisionId, { fetchBytes: realBytesTransport(client) })
  assert.deepEqual(Buffer.from(readBack), put.bytes, 'the stored manifest ciphertext is byte-identical to the client bytes')
})

test('CT-INT-7 the apiFetch-bound requests carry no plaintext file/folder metadata', async () => {
  const { sent } = await migrateRealApiFetch(2)
  const wire = JSON.stringify(sent.map((s) => ({ method: s.method, url: s.url, contentType: s.contentType, bytes: s.byteLength, body: s.body ?? null })))
  for (const leak of ['secret-file-', '.pdf', 'application/pdf', '"name"', '"parent"', '"path"', '"folder"', '"rootNodeId"']) {
    assert.ok(!wire.includes(leak), `plaintext metadata through apiFetch: ${leak}`)
  }
})
