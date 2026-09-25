// tests/vaultUploadRecovery.test.js — PRIVATE-VAULT-STAGE-D · hard-refresh recovery for encrypted TREE uploads
//
// Real WebCrypto, the real V2 transport (uploadVaultFileChunked) and a fake owner-scoped upload server.
// "Reload" = every in-memory resume object (and therefore the non-extractable DEK) is dropped; only the
// allowlisted browser record and the authoritative server status survive.
import test from 'node:test'
import assert from 'node:assert/strict'

const { createVaultSetup, b64ToBytes } = await import('../src/lib/vaultCrypto.js')
const { unwrapVaultV2Dek, decryptVaultChunk, GCM_TAG_BYTES } = await import('../src/lib/vaultChunkCrypto.js')
const { uploadVaultFileChunked } = await import('../src/lib/vaultChunkedUpload.js')
const { TREE_UPLOAD_ROUTE_BASE } = await import('../src/lib/vaultTreeUpload.js')
const recovery = await import('../src/lib/vaultUploadRecovery.js')
const { RECOVERY_STORAGE_KEY } = await import('../src/lib/uploadRecovery.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const kek = (await createVaultSetup('vault-recovery-passphrase-42', FAST)).kek
const CHUNK = 4 * 1024
const SECRET_NAME = 'family-video-PRIVATE-2026.mov'
const SECRET_TYPE = 'video/quicktime'
const PARENT = 'P'.repeat(22)
const SCOPE = 'user-17'
const bytesOf = (n, salt = 7) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 1) b[i] = (i * 31 + salt) & 0xff; return b }
const SOURCE = bytesOf(3 * CHUNK + 123)
const mkFile = (bytes = SOURCE, name = SECRET_NAME) => new File([bytes], name, { type: SECRET_TYPE, lastModified: 1_700_000_000_000 })

function memStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    dump: () => [...map.entries()].map(([k, v]) => `${k}=${v}`).join('\n'),
  }
}

/** owner-scoped fake of /api/vault/tree/uploads — stores exactly what a real server stores */
function fakeServer({ failFromIndex = null } = {}) {
  const state = { session: null, chunks: new Map(), puts: [], failFromIndex, statusBodies: [] }
  const view = () => {
    const s = state.session
    const received = [...state.chunks.keys()].sort((a, b) => a - b)
    const missing = []
    for (let i = 0; i < s.chunkCount; i += 1) if (!state.chunks.has(i)) missing.push(i)
    return {
      uploadId: s.uploadId, formatVersion: 2, contentIdB64: s.contentIdB64, ciphertextSize: s.ciphertextSize,
      chunkSize: s.chunkSize, chunkCount: s.chunkCount, status: 'open', expiresAt: Date.now() + 60_000,
      received, missing, receivedBytes: received.reduce((n, i) => n + state.chunks.get(i).ciphertext.length, 0),
    }
  }
  const fetchJson = async (path, { method = 'GET', body } = {}) => {
    if (path === TREE_UPLOAD_ROUTE_BASE && method === 'POST') {
      state.session = { ...body, uploadId: 'a'.repeat(48) }
      return { ok: true, status: 201, data: { upload: view() } }
    }
    if (path === `${TREE_UPLOAD_ROUTE_BASE}/${'a'.repeat(48)}` && method === 'GET') {
      if (!state.session) return { ok: false, status: 404, data: { error: 'Not found' } }
      const s = state.session
      const data = { upload: view(), envelope: { wrappedDekB64: s.wrappedDekB64, wrapIvB64: s.wrapIvB64, metaIvB64: s.metaIvB64, metaB64: s.metaB64 } }
      state.statusBodies.push(JSON.stringify(data))
      return { ok: true, status: 200, data }
    }
    if (path.endsWith('/commit') && method === 'POST') {
      if (view().missing.length) return { ok: false, status: 409, data: { code: 'UPLOAD_INCOMPLETE', upload: view() } }
      return { ok: true, status: 201, data: { blob: { id: 'B'.repeat(22), formatVersion: 2 } } }
    }
    return { ok: false, status: 404, data: {} }
  }
  const sendUpload = async (path, { body, headers }) => {
    const index = Number(path.split('/').pop())
    state.puts.push(index)
    if (state.failFromIndex !== null && index >= state.failFromIndex) return { ok: false, status: 400, data: { code: 'BAD' } }
    state.chunks.set(index, { ivB64: headers['X-Vault-Chunk-IV'], ciphertext: new Uint8Array(await body.arrayBuffer()) })
    return { ok: true, status: 200, data: { upload: view() } }
  }
  return { state, fetchJson, sendUpload }
}

/** first tab: starts the upload, seals the recovery record at session creation, then gets interrupted */
async function interruptedUpload({ storage, server }) {
  const store = recovery.createVaultRecoveryStore({ storage, scope: SCOPE })
  const file = mkFile()
  let sealing = null
  const first = await uploadVaultFileChunked({
    kek, file, plaintextChunkBytes: CHUNK, concurrency: 1, routeBase: TREE_UPLOAD_ROUTE_BASE,
    fetchJson: server.fetchJson, sendUpload: server.sendUpload,
    onSession: (s) => {
      sealing = recovery.sealVaultRecovery({ dek: s.dek, uploadId: s.upload.uploadId, file, plan: s.plan, parentNodeId: PARENT })
        .then((record) => store.save(record))
    },
  })
  await sealing
  return { first, file }
}

test('VAULT-RECOVERY-3 after reload the same file resumes with a DEK rebuilt from the wrapped envelope and uploads ONLY missing chunks', async () => {
  const storage = memStorage()
  const server = fakeServer({ failFromIndex: 2 })
  const { first } = await interruptedUpload({ storage, server })
  assert.equal(first.stage, 'paused', 'the first tab was interrupted with chunks 0-1 stored')
  assert.deepEqual([...server.state.chunks.keys()].sort(), [0, 1])

  // ── reload: nothing from the first tab survives except the browser record ──
  server.state.failFromIndex = null
  const store = recovery.createVaultRecoveryStore({ storage, scope: SCOPE })
  const [record] = store.list()
  assert.ok(record, 'a recovery record survived the reload')
  const status = await recovery.fetchVaultUploadStatus(record.uploadId, { fetchJson: server.fetchJson })
  assert.equal(status.ok, true)
  const opened = await recovery.openVaultRecovery({ kek, record, status })
  assert.equal(opened.name, SECRET_NAME, 'the tray name comes only from decrypting the server envelope')
  assert.equal(opened.parentNodeId, PARENT, 'the destination folder was sealed, not stored in clear')
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', opened.dek), 'the rebuilt DEK is non-extractable')

  const sameFile = mkFile(new Uint8Array(SOURCE), 'renamed-copy.mov')
  assert.deepEqual(await recovery.verifyVaultRecoveryFile({ record, opened, file: sameFile }), { ok: true })
  const resume = recovery.rebuildVaultResume({ opened, status, file: sameFile })
  server.state.puts.length = 0
  const second = await uploadVaultFileChunked({
    kek, file: sameFile, resume, routeBase: TREE_UPLOAD_ROUTE_BASE, fetchJson: server.fetchJson, sendUpload: server.sendUpload,
  })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.deepEqual([...server.state.puts].sort(), [2, 3], 'MISSING CHUNKS ONLY: received chunks 0-1 were never resent')

  // the assembled ciphertext decrypts with the KEK-unwrapped DEK back to the exact source bytes
  const dek = await unwrapVaultV2Dek(kek, server.state.session)
  const parts = []
  for (let i = 0; i < server.state.session.chunkCount; i += 1) {
    const c = server.state.chunks.get(i)
    parts.push(await decryptVaultChunk(dek, { contentId: b64ToBytes(server.state.session.contentIdB64), chunkIndex: i, chunkCount: server.state.session.chunkCount, ivB64: c.ivB64, ciphertext: c.ciphertext }))
  }
  assert.deepEqual(Buffer.concat(parts), Buffer.from(SOURCE))

  store.remove(record.uploadId)
  assert.deepEqual(recovery.createVaultRecoveryStore({ storage, scope: SCOPE }).list(), [], 'VAULT-RECOVERY-6 completion clears the record')
})

test('VAULT-RECOVERY-4 a different file (same size or different size) is rejected before any chunk is sent', async () => {
  const storage = memStorage()
  const server = fakeServer({ failFromIndex: 2 })
  await interruptedUpload({ storage, server })
  const [record] = recovery.createVaultRecoveryStore({ storage, scope: SCOPE }).list()
  const status = await recovery.fetchVaultUploadStatus(record.uploadId, { fetchJson: server.fetchJson })
  const opened = await recovery.openVaultRecovery({ kek, record, status })

  const sameSizeOtherBytes = bytesOf(SOURCE.length, 99)
  assert.deepEqual(await recovery.verifyVaultRecoveryFile({ record, opened, file: mkFile(sameSizeOtherBytes) }), { ok: false, reason: 'content' })
  const lastByteChanged = new Uint8Array(SOURCE); lastByteChanged[lastByteChanged.length - 1] ^= 1
  assert.deepEqual(await recovery.verifyVaultRecoveryFile({ record, opened, file: mkFile(lastByteChanged) }), { ok: false, reason: 'content' })
  assert.deepEqual(await recovery.verifyVaultRecoveryFile({ record, opened, file: mkFile(bytesOf(SOURCE.length + 1)) }), { ok: false, reason: 'size' })
  assert.equal(server.state.puts.filter((i) => i >= 2).length, 1, 'no resume PUT was issued for a rejected file (only the original failed attempt)')
})

test('VAULT-RECOVERY-5 browser storage holds no KEK/DEK/plaintext/decrypted metadata; the allowlist drops injected secrets', async () => {
  const storage = memStorage()
  const server = fakeServer({ failFromIndex: 1 })
  await interruptedUpload({ storage, server })
  const dump = storage.dump()
  assert.ok(dump.length > 0)
  const [key] = [...storage.map.keys()]
  assert.ok(key.startsWith(recovery.VAULT_RECOVERY_STORAGE_KEY), 'Vault uses its own namespace')
  assert.ok(!key.startsWith(`${RECOVERY_STORAGE_KEY}.`), 'never the Files recovery namespace')
  for (const secret of [SECRET_NAME, SECRET_TYPE, PARENT, 'family-video']) assert.ok(!dump.includes(secret), `no plaintext: ${secret}`)
  const s = server.state.session
  for (const field of [s.wrappedDekB64, s.metaB64, s.contentIdB64]) assert.ok(!dump.includes(field), 'envelope material is not duplicated into the browser')
  const [record] = recovery.createVaultRecoveryStore({ storage, scope: SCOPE }).list()
  assert.deepEqual(Object.keys(record).filter((k) => !recovery.VAULT_RECOVERY_FIELDS.includes(k)), [], 'only allowlisted fields')
  const opened = await recovery.openVaultRecovery({ kek, record, status: await recovery.fetchVaultUploadStatus(record.uploadId, { fetchJson: server.fetchJson }) })
  assert.ok(!dump.includes(opened.fingerprint), 'the content fingerprint exists only sealed under the DEK')

  // a careless caller cannot push secrets through the store
  const store = recovery.createVaultRecoveryStore({ storage, scope: SCOPE })
  store.save({ ...record, name: SECRET_NAME, type: SECRET_TYPE, parentNodeId: PARENT, sha256: 'f'.repeat(64), dek: opened.dek, kek, rawDek: 'AAAA', csrf: 'csrf-secret', token: 'bearer' })
  const after = storage.dump()
  for (const secret of [SECRET_NAME, SECRET_TYPE, PARENT, 'f'.repeat(64), 'AAAA', 'csrf-secret', 'bearer', '"dek"', '"kek"']) assert.ok(!after.includes(secret), `dropped: ${secret}`)

  // the sealed record is useless without the KEK: another KEK cannot rebuild the DEK
  const wrongKek = (await createVaultSetup('some-other-passphrase-000', FAST)).kek
  await assert.rejects(recovery.openVaultRecovery({ kek: wrongKek, record, status: await recovery.fetchVaultUploadStatus(record.uploadId, { fetchJson: server.fetchJson }) }), /wrong-key/)
  // the status response the client consumed carries ciphertext only
  for (const body of server.state.statusBodies) for (const secret of [SECRET_NAME, SECRET_TYPE, PARENT]) assert.ok(!body.includes(secret))
})

test('VAULT-RECOVERY identity sampling reads bounded slices and whole small files', () => {
  assert.deepEqual(recovery.identitySampleIndexes(1), [0])
  assert.deepEqual(recovery.identitySampleIndexes(8), [0, 1, 2, 3, 4, 5, 6, 7])
  const big = recovery.identitySampleIndexes(640)
  assert.equal(big.length, 8)
  assert.equal(big[0], 0); assert.equal(big.at(-1), 639)
  assert.equal(recovery.receivedPlainBytes({ chunkSize: CHUNK + GCM_TAG_BYTES, received: [0, 3] }, 3 * CHUNK + 123), CHUNK + 123)
})
