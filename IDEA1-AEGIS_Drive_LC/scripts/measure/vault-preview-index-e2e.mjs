// D-1 G.1: disposable local protocol measurement. Never accepts a remote endpoint.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { encodeRoot, encodeShard } from '../../src/lib/vaultPreviewIndexCodec.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, PREVIEW_INDEX_LIMITS as L } from '../../src/lib/vaultPreviewIndexConstants.js'
import { sealIndexObject } from '../../src/lib/vaultPreviewIndexObject.js'
import { uploadVaultFileChunked } from '../../src/lib/vaultChunkedUpload.js'
import { createVaultSetup } from '../../src/lib/vaultCrypto.js'
import { createPreviewIndexReader } from '../../src/lib/vaultPreviewIndexReader.js'
import { readDerivative } from '../../src/lib/vaultDerivativeRead.js'
import { createPreviewIndexWriter } from '../../src/lib/vaultPreviewIndexWriter.js'
import { ROLES } from '../../server/rbac/permissions.js'

const ROOT_ID = 'R'.repeat(22)
const id22 = () => randomBytes(16).toString('base64url')
const hex48 = () => randomBytes(24).toString('hex')
const utf8 = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const median = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]
const samplesMs = (xs) => ({ p50: median(xs, 0.5), p95: median(xs, 0.95), unit: 'ms', runs: xs.length })

function webpStub(length, width, height) {
  const b = Buffer.alloc(length)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(length - 8, 4); b.write('WEBPVP8X', 8, 'ascii')
  b.writeUInt32LE(10, 16)
  b[24] = (width - 1) & 255; b[25] = ((width - 1) >> 8) & 255; b[26] = ((width - 1) >> 16) & 255
  b[27] = (height - 1) & 255; b[28] = ((height - 1) >> 8) & 255; b[29] = ((height - 1) >> 16) & 255
  return b
}

function transportFor(client) {
  const counts = { json: 0, upload: 0, bytes: 0 }
  const timings = { cas: [], uploadPut: [] }
  const objectUploads = { derivative: [], shard: [], root: [] }
  const headers = (extra = {}) => ({ ...extra, cookie: client.cookie, 'X-CSRF-Token': client.csrf })
  const result = async (res) => {
    let data = null
    try { data = await res.json() } catch { /* byte response */ }
    return { ok: res.ok, status: res.status, data, errorKind: res.ok ? null : 'server' }
  }
  const fetchJson = async (route, opts = {}) => {
    counts.json++
    const start = performance.now()
    const r = await fetch(client.baseUrl + route, {
      method: opts.method ?? 'GET', headers: headers(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal,
    }).catch((error) => { throw new Error(`local fetchJson ${opts.method ?? 'GET'} ${route} failed`, { cause: error }) })
    if (route === '/api/vault/tree/preview-index/head' && opts.method === 'POST') timings.cas.push(performance.now() - start)
    return result(r)
  }
  const sendUpload = async (route, opts = {}) => {
    counts.upload++
    const start = performance.now()
    const r = await fetch(client.baseUrl + route, { method: opts.method ?? 'PUT', headers: headers(opts.headers), body: opts.body, signal: opts.signal })
      .catch((error) => { throw new Error(`local sendUpload ${opts.method ?? 'PUT'} ${route} failed`, { cause: error }) })
    timings.uploadPut.push(performance.now() - start)
    opts.onProgress?.({ loadedBytes: opts.body.size, totalBytes: opts.body.size })
    return result(r)
  }
  const fetchBytes = async (route, opts = {}) => {
    counts.bytes++
    const r = await fetch(client.baseUrl + route, { headers: headers(), signal: opts.signal })
      .catch((error) => { throw new Error(`local fetchBytes GET ${route} failed`, { cause: error }) })
    return { ok: r.ok, status: r.status, headers: r.headers, bytes: new Uint8Array(await r.arrayBuffer()) }
  }
  return { fetchJson, sendUpload, fetchBytes, counts, timings, objectUploads }
}

function uploadKind(type) {
  if (type === INDEX_ROOT_MARKER) return 'root'
  if (type === INDEX_SHARD_MARKER) return 'shard'
  return 'derivative'
}

async function measuredUpload(transport, options) {
  const start = performance.now()
  const result = await uploadVaultFileChunked(options)
  transport.objectUploads[uploadKind(options.file.type)].push(performance.now() - start)
  return result
}

async function localServer(mode) {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-idx-size-'))
  let server = null, superPool = null, database = null, connection = null
  try {
    process.env.STORAGE_ROOT = storage
    process.env.SESSION_SECRET = randomBytes(32).toString('hex')
    if (mode === 'pg') {
      const pg = (await import('pg')).default
      superPool = new pg.Pool({ connectionString: process.env.AEGIS_PGTEST_SUPER_URL, max: 2 })
      database = `aegis_drive_idx_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
      const template = new URL(process.env.TEST_DATABASE_URL).pathname.slice(1)
      await superPool.query(`CREATE DATABASE ${database} TEMPLATE ${template}`)
      await superPool.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`)
      await superPool.query(`GRANT CONNECT ON DATABASE ${database} TO drive_app`)
      const u = new URL(process.env.TEST_DATABASE_URL); u.pathname = '/' + database
      process.env.DATABASE_URL = u.toString()
    } else delete process.env.DATABASE_URL
    const [appMod, cfgMod, fileStore, vaultStore, manifestStore, staging, tree, pindex, v2, conn, clients, seed] = await Promise.all([
      import('../../server/app.js'), import('../../server/config/vaultTreeLimits.js'), import('../../server/storage/fileStore.js'),
      import('../../server/storage/vaultStore.js'), import('../../server/storage/vaultManifestStore.js'), import('../../server/storage/vaultStaging.js'),
      import('../../server/db/vaultTreeStore.js'), import('../../server/db/vaultPreviewIndexStore.js'), import('../../server/db/vaultV2Store.js'),
      import('../../server/db/connection.js'), import('../../tests/helpers/testClient.mjs'), import('../../tests/helpers/previewIndexCasSpec.mjs'),
    ])
    connection = conn
    await fileStore.initStorage(); await vaultStore.initVaultStorage(); await manifestStore.initVaultManifestStorage(); await staging.initVaultStaging()
    const flags = { VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true',
      VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true', VAULT_PREVIEW_INDEX_READ_ENABLED: 'true',
      VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(64 * 1024 ** 3) }
    const app = appMod.createApp({ vaultTreeConfig: cfgMod.vaultTreeConfigFromEnv(flags) })
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    return {
      base, app, tree, pindex, v2, connection: conn,
      async newOwner(treeId) {
        const username = `idx${randomBytes(6).toString('hex')}`
        const user = await conn.createUserWithTempPassword({ username, displayName: 'IDX size disposable', role: ROLES.USER })
        if (!user) throw new Error('disposable owner creation failed')
        const client = await clients.loginClient(base, username, user.tempPassword)
        const setup = await createVaultSetup('idx-size-local-only-passphrase', { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 })
        const response = await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
        if (response.status !== 201) throw new Error(`disposable vault setup HTTP ${response.status}`)
        await seed.seedTreeOwner({ tree }, String(user.id), { treeId })
        return { userId: String(user.id), client, kek: setup.kek }
      },
      async close() {
        await new Promise((resolve) => server.close(resolve)); server = null
        await conn.closePool(); connection = null
        if (superPool && database) { await superPool.query(`DROP DATABASE ${database} WITH (FORCE)`); await superPool.end(); superPool = null }
        const resolved = path.resolve(storage)
        if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('aegis-idx-size-')) throw new Error('refusing unsafe scratch cleanup')
        await fs.rm(resolved, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (connection) await connection.closePool()
    if (superPool && database) { await superPool.query(`DROP DATABASE ${database} WITH (FORCE)`); await superPool.end() }
    if (path.basename(storage).startsWith('aegis-idx-size-')) await fs.rm(storage, { recursive: true, force: true })
    throw error
  }
}

async function uploadEntry(kek, transport, entry) {
  const bytes = entry.kind === 'motion' ? Buffer.alloc(entry.plainSize) : webpStub(entry.plainSize, entry.width, entry.height)
  const file = new File([bytes], '', { type: entry.mime })
  const start = performance.now()
  const result = await measuredUpload(transport, { kek, file, plaintextChunkBytes: 8 * 1024 * 1024, concurrency: 1,
    fetchJson: transport.fetchJson, sendUpload: transport.sendUpload, routeBase: '/api/vault/tree/preview-index/uploads' })
  if (!result.ok) throw new Error(`entry upload ${entry.kind} failed: ${result.response?.data?.code ?? result.reason}`)
  return { ...result.blob, elapsedMs: performance.now() - start }
}

async function uploadIndex(kek, transport, marker, plaintext, buckets) {
  const start = performance.now()
  const result = await sealIndexObject({ kek, marker, plaintext, buckets, transport,
    upload: (options) => measuredUpload(transport, options) })
  return { ...result, elapsedMs: performance.now() - start, canonicalBytes: plaintext.length }
}

function mainHeadOf(items, treeId) {
  const nodes = new Map([[ROOT_ID, { nodeId: ROOT_ID, kind: 'folder', parentNodeId: null, lifecycle: { state: 'active' } }]])
  for (let i = 0; i < 5; i++) {
    const id = `F${String(i).padStart(21, '0')}`
    nodes.set(id, { nodeId: id, kind: 'folder', parentNodeId: ROOT_ID, lifecycle: { state: 'active' } })
  }
  for (const it of items) nodes.set(it.nodeId, { nodeId: it.nodeId, kind: 'file', parentNodeId: ROOT_ID,
    lifecycle: { state: 'active' }, blobRef: it.list[0].sourceBlobRef })
  return { treeId, generation: 1, index: { nodes, rootNodeId: ROOT_ID, limits: { maxDepth: 64 } } }
}

async function attachAll(server, owner, transport, treeId, ids, descriptors) {
  let generation = 0, prior = null, root = null, rootPlain = null
  const casMs = [], rootUploadMs = []
  const pending = [...ids]
  do {
    const final = pending.length <= 63
    const chunk = pending.splice(0, 63)
    rootPlain = encodeRoot({ schemaVersion: 1, treeId, indexGeneration: generation + 1,
      createdAtClient: 1_759_300_000_000, shards: final ? descriptors : [] })
    root = await uploadIndex(owner.kek, transport, INDEX_ROOT_MARKER, rootPlain, L.rootPaddingBuckets)
    rootUploadMs.push(root.elapsedMs)
    const body = { expectedGeneration: generation, expectedRootBlobId: prior?.blobRef.id ?? null,
      rootBlobId: root.blobRef.id, rootContentIdB64: root.contentId,
      attachBlobIds: [root.blobRef.id, ...chunk], supersededBlobIds: prior ? [prior.blobRef.id] : [], idempotencyKey: id22() }
    const start = performance.now()
    const response = await owner.client.req('/api/vault/tree/preview-index/head', { method: 'POST', body })
    casMs.push(performance.now() - start)
    if (response.status !== 200) throw new Error(`initial-build CAS HTTP ${response.status}: ${response.data?.code ?? ''}`)
    generation++
    prior = root
  } while (pending.length)
  return { root, rootPlain, generation, casMs, rootUploadMs }
}

async function auditCount(server, userId) {
  if (server.connection.usingPostgres) {
    const r = await server.connection.query('SELECT count(*)::bigint AS n FROM audit_log WHERE actor_id=$1', [userId])
    return Number(r.rows[0].n)
  }
  const recent = (await server.connection.readAudit(500)).filter((r) => String(r.actorId) === userId)
  return recent.length ? Math.max(...recent.map((r) => r.id)) : 0 // memory ring holds 500, ids remain monotonic
}

async function measureColdTiles(server, owner, transport, mainHead, items) {
  const start = performance.now()
  const beforeReq = { ...transport.counts }
  const beforeAudit = await auditCount(server, owner.userId)
  const api = {
    async getPreviewIndexHead() {
      const r = await transport.fetchJson('/api/vault/tree/preview-index/head')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`head HTTP ${r.status}`)
      return r.data
    },
    async getPreviewIndexEnvelopes(ids) {
      const r = await transport.fetchJson(`/api/vault/tree/preview-index/envelopes?ids=${ids.join(',')}`)
      if (!r.ok) throw new Error(`envelopes HTTP ${r.status}`)
      return r.data.blobs
    },
  }
  const reader = createPreviewIndexReader({ kek: owner.kek, api, fetchBytes: transport.fetchBytes })
  const loaded = await reader.load(mainHead)
  if (loaded.status !== 'READY') throw new Error(`cold reader ${loaded.status}:${loaded.reason ?? ''}`)
  const entries = []
  for (const it of items.slice(0, 60)) {
    const entry = await reader.lookup(mainHead.index.nodes.get(it.nodeId), 'thumb')
    if (!entry) throw new Error('cold tile lookup missing thumb')
    entries.push(entry)
  }
  await reader.prefetchEnvelopes(entries.map((e) => e.blobRef.id))
  for (const entry of entries) {
    const r = await readDerivative({ kek: owner.kek, entry, envelopeOf: reader.envelopeOf, fetchBytes: transport.fetchBytes,
      decodeImage: async () => ({ width: entry.width, height: entry.height, close() {} }) })
    if (!r.ok) throw new Error(`cold derivative read ${r.reason}`)
    r.bytes.fill(0)
  }
  reader.clear()
  const requests = Object.values(transport.counts).reduce((a, b) => a + b, 0) - Object.values(beforeReq).reduce((a, b) => a + b, 0)
  return { visibleTiles: Math.min(60, items.length), requests, unit: 'HTTP requests',
    auditRows: (await auditCount(server, owner.userId)) - beforeAudit, elapsedMs: performance.now() - start }
}

function writerApi(transport) {
  const requireOk = (r) => {
    if (!r.ok) throw Object.assign(new Error(`index API HTTP ${r.status}`), { status: r.status, code: r.data?.code ?? null })
    return r.data
  }
  return {
    async getPreviewIndexHead(o = {}) {
      const r = await transport.fetchJson('/api/vault/tree/preview-index/head', o)
      return r.status === 404 ? null : requireOk(r)
    },
    async getPreviewIndexEnvelopes(ids, o = {}) {
      const r = await transport.fetchJson(`/api/vault/tree/preview-index/envelopes?ids=${ids.join(',')}`, o)
      return requireOk(r).blobs
    },
    async casPreviewIndexHead(body, o = {}) {
      return requireOk(await transport.fetchJson('/api/vault/tree/preview-index/head', { ...o, method: 'POST', body }))
    },
  }
}

function newWriter(owner, transport, mainHead) {
  return createPreviewIndexWriter({ kek: owner.kek, api: writerApi(transport), transport,
    getMainHead: () => mainHead, writeAllowed: () => true, autoFlush: false,
    upload: (options) => measuredUpload(transport, options) })
}

function changeSource(mainHead, item) {
  const node = mainHead.index.nodes.get(item.nodeId)
  node.blobRef = { formatVersion: 2, id: hex48() }
  return node.blobRef
}

async function writeJobs(server, owner, transport, mainHead, jobs, sessionWriter = null) {
  const writer = sessionWriter ?? newWriter(owner, transport, mainHead)
  const beforeAudit = await auditCount(server, owner.userId)
  const beforeRequests = { ...transport.counts }
  try {
    for (const job of jobs) {
      const offered = writer.offer(job)
      if (offered !== 'QUEUED') throw new Error(`writer offered ${offered}`)
    }
    const start = performance.now()
    const result = await writer.flush()
    const elapsedMs = performance.now() - start
    if (result.committed !== jobs.length || result.failed || result.dropped || result.budgetExhausted) {
      throw new Error(`writer did not commit batch: ${JSON.stringify(result)} ${JSON.stringify(writer.stats())}`)
    }
    return { elapsedMs, auditRows: (await auditCount(server, owner.userId)) - beforeAudit,
      requests: Object.values(transport.counts).reduce((a, b) => a + b, 0) - Object.values(beforeRequests).reduce((a, b) => a + b, 0) }
  } finally { if (!sessionWriter) writer.dispose() }
}

function jobFor(mainHead, item, kind) {
  const sourceBlobRef = mainHead.index.nodes.get(item.nodeId).blobRef
  const width = 320, height = 240
  return { nodeId: item.nodeId, kind, sourceBlobRef, bytes: webpStub(20_000, width, height),
    mime: 'image/webp', width, height }
}

async function measureMutations(server, owner, transport, mainHead, items, runs) {
  // B: one full D-1 lazy backfill after every source changes; the stress-only motion entry is not a D-1 write kind.
  for (const item of items) changeSource(mainHead, item)
  const backfillAuditStart = await auditCount(server, owner.userId)
  const backfillWriter = newWriter(owner, transport, mainHead)
  try {
    for (let i = 0; i < items.length; i += 8) {
      const batch = items.slice(i, i + 8).flatMap((item) => [jobFor(mainHead, item, 'thumb'), jobFor(mainHead, item, 'poster')])
      await writeJobs(server, owner, transport, mainHead, batch, backfillWriter)
    }
  } finally { backfillWriter.dispose() }
  const retainedB = await server.pindex.getRetainedIndexBytes(owner.userId)
  const backfillAuditRows = (await auditCount(server, owner.userId)) - backfillAuditStart

  // C: N stated sessions, each replacing one source then writing one entry and a full 16-entry batch.
  const single = [], full = [], batchAudits = [], curve = []
  for (let run = 0; run < runs; run++) {
    const first = items[run % items.length]
    changeSource(mainHead, first)
    single.push((await writeJobs(server, owner, transport, mainHead, [jobFor(mainHead, first, 'thumb')])).elapsedMs)
    const selected = Array.from({ length: Math.min(16, items.length) }, (_, j) => items[(run * 17 + j) % items.length])
    for (const item of selected) changeSource(mainHead, item)
    const r = await writeJobs(server, owner, transport, mainHead, selected.map((item) => jobFor(mainHead, item, 'thumb')))
    full.push(r.elapsedMs); batchAudits.push(r.auditRows)
    curve.push({ session: run + 1, entriesWritten: 1 + selected.length, retainedBytes: await server.pindex.getRetainedIndexBytes(owner.userId) })
  }
  const retainedC = await server.pindex.getRetainedIndexBytes(owner.userId)

  // D: after authenticated uploads, inject a lost CAS before submission. Blobs stay INDEX_STAGED and count in the budget.
  const lossCurve = []
  for (let run = 0; run < runs; run++) {
    const entry = { kind: 'thumb', mime: 'image/webp', width: 320, height: 240, plainSize: 20_000 }
    await uploadEntry(owner.kek, transport, entry)
    lossCurve.push({ loop: run + 1, retainedBytes: await server.pindex.getRetainedIndexBytes(owner.userId) })
  }
  const retainedD = await server.pindex.getRetainedIndexBytes(owner.userId)
  return { retainedB, retainedC, retainedD, backfillAuditRows, curve, lossCurve,
    mutationTimings: { singleEntry: samplesMs(single), fullBatch: samplesMs(full) },
    batchWriteAuditRows: { min: Math.min(...batchAudits), p50: median(batchAudits, 0.5), p95: median(batchAudits, 0.95), max: Math.max(...batchAudits), unit: 'rows', runs } }
}

async function budgetCheckSamples(server, owner, runs) {
  const times = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    if (server.connection.usingPostgres) {
      await server.connection.withTransaction((client) => server.pindex.assertIndexBudgetWithinCommit(client, owner.userId,
        { addBytes: 0, maxBytes: 64 * 1024 ** 3 }))
    } else await server.pindex.assertIndexBudgetWithinCommit(null, owner.userId, { addBytes: 0, maxBytes: 64 * 1024 ** 3 })
    times.push(performance.now() - start)
  }
  return samplesMs(times)
}

async function candidateBudgetSamples(server, owner, retainedBytes) {
  const check = async (addBytes, maxBytes) => {
    try {
      if (server.connection.usingPostgres) {
        await server.connection.withTransaction((client) => server.pindex.assertIndexBudgetWithinCommit(client, owner.userId,
          { addBytes, maxBytes }))
      } else await server.pindex.assertIndexBudgetWithinCommit(null, owner.userId, { addBytes, maxBytes })
      return 'accepted'
    } catch (error) {
      if (error?.code !== 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED') throw error
      return 'rejected'
    }
  }
  const candidates = []
  for (const maxBytes of [64, 256, 1024, 4096, 16384, 65536].map((n) => n * 1024 ** 2)) {
    const atCapAddBytes = Math.max(0, maxBytes - retainedBytes)
    candidates.push({ maxBytes, retainedBytes, atCapAddBytes,
      atCapResult: await check(atCapAddBytes, maxBytes), beyondCapResult: await check(atCapAddBytes + 1, maxBytes),
      unit: 'B', method: 'assertIndexBudgetWithinCommit; no committed upload or Production limit change' })
  }
  return candidates
}

export async function getInventoryWithRetry(client) {
  for (let attempts = 1; attempts <= 2; attempts++) {
    try { return { result: await client.req('/api/vault'), attempts } } catch (error) {
      const code = error?.code ?? error?.cause?.code ?? error?.cause?.cause?.code
      if (attempts === 2 || code !== 'ECONNRESET') throw new Error('local inventory GET /api/vault failed', { cause: error })
    }
  }
  throw new Error('unreachable inventory retry state')
}

async function inventoryBytes(server, owner) {
  const { result: actual, attempts } = await getInventoryWithRetry(owner.client)
  if (actual.status !== 200) throw new Error(`inventory HTTP ${actual.status}`)
  const ids = await server.pindex.excludeIndexBlobIds(owner.userId)
  const all = await server.v2.listVaultV2Blobs(owner.userId)
  const excluded = all.filter((blob) => ids.has(String(blob.id)))
  return { withExclusionBytes: utf8(actual.data), withoutExclusionCounterfactualBytes: utf8({ ...actual.data,
    blobs: [...actual.data.blobs, ...excluded] }), excludedBlobCount: excluded.length, unit: 'JSON UTF-8 B',
    attempts, method: 'actual GET /api/vault and counterfactual serialization of the same public V2 envelope rows' }
}

async function currentGenerationCipherBytes(server, owner, transport, mainHead) {
  const reader = createPreviewIndexReader({ kek: owner.kek, api: writerApi(transport), fetchBytes: transport.fetchBytes })
  try {
    const loaded = await reader.load(mainHead)
    if (loaded.status !== 'READY') throw new Error(`final index reader ${loaded.status}:${loaded.reason ?? ''}`)
    const { head, root } = reader.snapshot()
    const ids = new Set([String(head.rootBlobRef.id)])
    for (const descriptor of root.shards) {
      ids.add(String(descriptor.blobRef.id))
      const shard = await reader.shardOf(descriptor.prefix)
      if (!shard) throw new Error(`final shard unreadable: ${descriptor.prefix}`)
      for (const entries of shard.entries.values()) for (const entry of entries) ids.add(String(entry.blobRef.id))
    }
    const sizes = new Map((await server.v2.listVaultV2Blobs(owner.userId)).map((blob) => [String(blob.id), Number(blob.size)]))
    let bytes = 0
    for (const id of ids) {
      if (!Number.isSafeInteger(sizes.get(id))) throw new Error('current-generation blob missing from owner store')
      bytes += sizes.get(id)
    }
    return { bytes, blobs: ids.size, method: 'verified final head/root/shards and distinct referenced derivative ids; owner V2 ciphertext sizes' }
  } finally { reader.clear() }
}

async function measureServerCell(server, nodes, variant, runs, f) {
  const owner = await server.newOwner(f.treeId)
  const transport = transportFor(owner.client)
  const { items, shards, splits, overflowSkips } = await f.buildOnce(nodes - 6, variant)
  if (overflowSkips) throw new Error(`initial build overflowed ${overflowSkips} entries`)
  const mainHead = mainHeadOf(items, f.treeId)
  const derivativeIds = [], derivativeSizes = []
  for (const item of items) for (const entry of item.list) {
    const uploaded = await uploadEntry(owner.kek, transport, entry)
    entry.blobRef = { formatVersion: 2, id: uploaded.id }
    entry.contentId = uploaded.contentIdB64
    derivativeIds.push(uploaded.id); derivativeSizes.push(uploaded.size)
  }
  process.stderr.write(`[idx-size] uploaded derivatives nodes=${nodes} variant=${variant} count=${derivativeIds.length}\n`)
  const descriptors = [], shardSizes = [], shardIds = []
  for (const [prefix, group] of [...shards.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const plaintext = await encodeShard({ schemaVersion: 1, treeId: f.treeId, prefix,
      entries: new Map(group.items.map((it) => [it.nodeId, it.list])) })
    const uploaded = await uploadIndex(owner.kek, transport, INDEX_SHARD_MARKER, plaintext, L.shardPaddingBuckets)
    descriptors.push({ prefix, blobRef: uploaded.blobRef, contentId: uploaded.contentId })
    shardIds.push(uploaded.blobRef.id)
    shardSizes.push({ canonicalBytes: plaintext.length, paddedBytes: uploaded.paddedBytes, cipherBytes: uploaded.cipherBytes })
    plaintext.fill(0)
  }
  const attached = await attachAll(server, owner, transport, f.treeId, [...derivativeIds, ...shardIds], descriptors)
  process.stderr.write(`[idx-size] attached initial index nodes=${nodes} variant=${variant} generations=${attached.generation}\n`)
  const retainedA = await server.pindex.getRetainedIndexBytes(owner.userId)
  const initialGenerationCipherBytes = derivativeSizes.reduce((a, b) => a + b, 0) + shardSizes.reduce((a, s) => a + s.cipherBytes, 0) + attached.root.cipherBytes
  const coldRuns = []
  for (let i = 0; i < runs; i++) coldRuns.push(await measureColdTiles(server, owner, transport, mainHead, items))
  process.stderr.write(`[idx-size] cold views nodes=${nodes} variant=${variant} runs=${runs}\n`)
  const cold = { visibleTiles: 60, requests: coldRuns.map((r) => r.requests),
    requestDistribution: { p50: median(coldRuns.map((r) => r.requests), 0.5), p95: median(coldRuns.map((r) => r.requests), 0.95), unit: 'HTTP requests', runs },
    latency: samplesMs(coldRuns.map((r) => r.elapsedMs)),
    auditRows: coldRuns.map((r) => r.auditRows),
    auditDistribution: { p50: median(coldRuns.map((r) => r.auditRows), 0.5), p95: median(coldRuns.map((r) => r.auditRows), 0.95), unit: 'rows', runs } }
  const mutation = await measureMutations(server, owner, transport, mainHead, items, runs)
  process.stderr.write(`[idx-size] mutations nodes=${nodes} variant=${variant} backfill=${items.length * 2} churn=${runs}\n`)
  const finalGeneration = await currentGenerationCipherBytes(server, owner, transport, mainHead)
  const supersededAfterChurnCipherBytes = mutation.retainedC - finalGeneration.bytes
  if (supersededAfterChurnCipherBytes < 0) throw new Error('final reachable bytes exceed retained C')
  const entriesWrittenThroughC = derivativeIds.length + items.length * 2 + runs * (1 + Math.min(16, items.length))
  const budgetCheck = await budgetCheckSamples(server, owner, runs)
  process.stderr.write(`[idx-size] budget-check samples nodes=${nodes} variant=${variant} runs=${runs}\n`)
  const candidateBudgets = await candidateBudgetSamples(server, owner, mutation.retainedD)
  process.stderr.write(`[idx-size] budget candidates nodes=${nodes} variant=${variant} count=${candidateBudgets.length}\n`)
  const inventory = await inventoryBytes(server, owner)
  process.stderr.write(`[idx-size] inventory nodes=${nodes} variant=${variant} actualBytes=${inventory.withExclusionBytes}\n`)
  const measuredSizes = (key) => ({ largest: Math.max(...shardSizes.map((s) => s[key])),
    average: shardSizes.reduce((a, s) => a + s[key], 0) / shardSizes.length,
    p95: median(shardSizes.map((s) => s[key]), 0.95), unit: 'B' })
  return {
    root: { canonicalBytes: attached.rootPlain.length, paddedBytes: attached.root.paddedBytes, cipherBytes: attached.root.cipherBytes, unit: 'B' },
    shards: { count: shardSizes.length, splitCount: splits, canonical: measuredSizes('canonicalBytes'),
      padded: measuredSizes('paddedBytes'), cipher: measuredSizes('cipherBytes'), unit: 'B' },
    storage: { initialGenerationCipherBytes, currentGenerationFinalCipherBytes: finalGeneration.bytes,
      currentGenerationFinalBlobCount: finalGeneration.blobs, retainedAfterChurnCipherBytes: mutation.retainedC,
      supersededAfterChurnCipherBytes, supersededBytesPerEntryWritten: supersededAfterChurnCipherBytes / entriesWrittenThroughC,
      entriesWrittenThroughC, casLossStagedCipherBytes: mutation.retainedD - mutation.retainedC,
      method: `${finalGeneration.method}; superseded after churn = retained C - final reachable; no GC`,
      inventory, unit: 'B' },
    retainedBudget: {
      A: { bytes: retainedA, entries: derivativeIds.length, method: 'full initial encrypted build; getRetainedIndexBytes' },
      B: { bytes: mutation.retainedB, entries: items.length * 2, writerSessions: 1,
        method: 'one persistent real writer session, full thumb+poster lazy backfill after source replacement; getRetainedIndexBytes' },
      C: { bytes: mutation.retainedC, sessions: runs, entriesPerSession: `1 + ${Math.min(16, items.length)}`,
        curve: mutation.curve, method: 'real writer source-replacement churn; getRetainedIndexBytes' },
      D: { bytes: mutation.retainedD, injectedLossLoops: runs, curve: mutation.lossCurve,
        method: 'encrypted preview uploads followed by injected pre-submission CAS loss; blobs remain INDEX_STAGED' },
      budgetCheck: { ...budgetCheck, method: 'assertIndexBudgetWithinCommit; owner lock on PostgreSQL' },
      candidateBudgets,
      unit: 'B',
    },
    coldTiles: cold,
    serverTimings: { indexCas: samplesMs([...attached.casMs, ...transport.timings.cas]), derivativeUpload: samplesMs(transport.objectUploads.derivative),
      shardUpload: samplesMs(transport.objectUploads.shard), rootUpload: samplesMs(transport.objectUploads.root), chunkPut: samplesMs(transport.timings.uploadPut) },
    mutationTimings: mutation.mutationTimings,
    audit: { cold60Rows: cold.auditDistribution.p50, cold60RowsDistribution: cold.auditDistribution, batchWriteRows: mutation.batchWriteAuditRows.p50,
      batchWriteRowsDistribution: mutation.batchWriteAuditRows, unit: 'audit rows' },
  }
}

export async function runE2eMatrix(o, f) {
  if (o.browser) return runChromeMatrix(o, f)
  const started = new Date().toISOString()
  const server = await localServer(o.server)
  const cells = []
  try {
    for (const nodes of o.nodes) for (const variant of o.variants) {
      process.stderr.write(`[idx-size] e2e ${o.server} nodes=${nodes} variant=${variant} runs=${o.runs}\n`)
      const codec = await f.measureCell(nodes, variant, o.runs)
      const mainManifest = await f.mainManifestDelta(nodes)
      if (mainManifest.deltaBytes !== 0 || !mainManifest.canonicalBytesEqual) throw new Error('main manifest changed')
      const measured = await measureServerCell(server, nodes, variant, o.runs, f)
      cells.push({ nodes, variant, runs: o.runs, mainManifest, root: measured.root, shards: measured.shards,
        storage: measured.storage, retainedBudget: measured.retainedBudget, coldTiles: measured.coldTiles,
        nodeTimings: codec.timingsMs, serverTimings: measured.serverTimings,
        mutationTimings: measured.mutationTimings, audit: measured.audit,
        preliminaryCodec: codec })
    }
  } finally { await server.close() }
  return { label: 'IDX_SIZE_EVIDENCE', status: 'PARTIAL_NOT_GATE_READY', mode: 'e2e', server: o.server,
    started, finished: new Date().toISOString(), env: { node: process.version, platform: os.platform(), release: os.release() }, cells }
}

async function runChromeMatrix(o, f) {
  const browser = path.resolve(o.browser)
  if (!(await fs.stat(browser).then((s) => s.isFile(), () => false))) throw new Error('--browser must name an existing Chrome executable')
  const fixtures = []
  for (const nodes of o.nodes) for (const variant of o.variants) {
    const built = await f.buildOnce(nodes - 6, variant)
    let largest = null
    for (const [prefix, shard] of built.shards) {
      const entries = [...shard.items].map((item) => [item.nodeId, item.list])
      const plaintext = await encodeShard({ schemaVersion: 1, treeId: f.treeId, prefix, entries: new Map(entries) })
      if (!largest || plaintext.length > largest.canonicalBytes) largest = { prefix, entries, canonicalBytes: plaintext.length }
    }
    const root = { schemaVersion: 1, treeId: f.treeId, indexGeneration: 1,
      createdAtClient: 1_759_300_000_000,
      shards: [...built.shards.keys()].sort().map((prefix) => ({ prefix, blobRef: { formatVersion: 2, id: hex48() }, contentId: randomBytes(16).toString('base64') })) }
    fixtures.push({ nodes, variant, root, shard: { schemaVersion: 1, treeId: f.treeId, prefix: largest.prefix, entries: largest.entries },
      mainManifest: await f.mainManifestDelta(nodes) })
  }
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault-tree')
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-idx-chrome-'))
  const nonce = randomBytes(10).toString('hex')
  const jsName = `.idx-size-${nonce}.js`, htmlName = `.idx-size-${nonce}.html`
  const jsPath = path.join(scratch, jsName), htmlPath = path.join(scratch, htmlName)
  const tmpOut = path.join(os.tmpdir(), `aegis-idx-browser-${nonce}.json`)
  const source = `
import { encodeRoot, decodeRoot, encodeShard, decodeShard } from '/src/lib/vaultPreviewIndexCodec.js'
import { padToBucket } from '/src/lib/vaultTreeCanonical.js'
import { createVaultV2Envelope, encryptVaultChunk, decryptVaultChunk } from '/src/lib/vaultChunkCrypto.js'
import { PREVIEW_INDEX_LIMITS as L } from '/src/lib/vaultPreviewIndexConstants.js'
const fixtures = ${JSON.stringify(fixtures)}
const runs = ${o.runs}
const sample = (xs) => { const sorted = [...xs].sort((a,b)=>a-b); return { p50: sorted[Math.ceil(xs.length*.5)-1], p95: sorted[Math.ceil(xs.length*.95)-1], unit:'ms', runs:xs.length } }
globalThis.runIdxSizeChrome = async () => {
  const cells = []
  const kek = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt','decrypt'])
  for (const f of fixtures) {
    const timings = { shardEncode:[], shardEncrypt:[], shardDecrypt:[], shardDecode:[], rootEncode:[], rootEncrypt:[], rootDecrypt:[], rootDecode:[] }
    let shardBytes, rootBytes
    for (let i=0; i<runs; i++) for (const kind of ['shard','root']) {
      const t0=performance.now()
      const encoded = kind==='shard'
        ? await encodeShard({ ...f.shard, entries:new Map(f.shard.entries) })
        : encodeRoot(f.root)
      timings[kind+'Encode'].push(performance.now()-t0)
      const padded=padToBucket(encoded, kind==='shard'?L.shardPaddingBuckets:L.rootPaddingBuckets).padded
      const envelope=await createVaultV2Envelope(kek,{name:'',type:kind==='shard'?'application/vnd.aegis.vault-preview-index-shard.v1':'application/vnd.aegis.vault-preview-index-root.v1',size:padded.length,chunkCount:1})
      const t1=performance.now()
      const sealed=await encryptVaultChunk(envelope.dek,{contentId:envelope.contentId,chunkIndex:0,chunkCount:1,plaintext:padded})
      timings[kind+'Encrypt'].push(performance.now()-t1)
      const t2=performance.now()
      const opened=await decryptVaultChunk(envelope.dek,{contentId:envelope.contentIdB64,chunkIndex:0,chunkCount:1,ivB64:sealed.ivB64,ciphertext:sealed.ciphertext})
      timings[kind+'Decrypt'].push(performance.now()-t2)
      const t3=performance.now()
      if (kind==='shard') await decodeShard(opened.subarray(0,encoded.length),{treeId:f.shard.treeId,prefix:f.shard.prefix})
      else decodeRoot(opened.subarray(0,encoded.length),{treeId:f.root.treeId,indexGeneration:1})
      timings[kind+'Decode'].push(performance.now()-t3)
      if (kind==='shard') shardBytes={canonical:encoded.length,padded:padded.length,cipher:sealed.ciphertext.length,unit:'B'}
      else rootBytes={canonical:encoded.length,padded:padded.length,cipher:sealed.ciphertext.length,unit:'B'}
    }
    cells.push({nodes:f.nodes,variant:f.variant,runs,mainManifest:f.mainManifest,
      root:rootBytes,largestShard:shardBytes,chromeTimings:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,sample(v)]))})
  }
  return { label:'IDX_SIZE_EVIDENCE', status:'CHROME_CLIENT_ONLY', mode:'e2e', server:'none',
    browser:{userAgent:navigator.userAgent,platform:navigator.platform}, cells }
}
`
  const html = `<!doctype html><meta charset="utf-8"><title>IDX-SIZE local Chrome</title><script type="importmap">{"imports":{"hash-wasm":"/node_modules/hash-wasm/dist/index.esm.js"}}</script><script type="module" src="./${jsName}"></script>`
  try {
    await fs.writeFile(jsPath, source, { flag: 'wx' })
    await fs.writeFile(htmlPath, html, { flag: 'wx' })
    const runner = path.join(dir, 'run-browser-bench.mjs')
    const args = [runner, '--browser', browser, '--fixtures', scratch, '--page', `fixtures/${htmlName}`,
      '--fn', 'runIdxSizeChrome', '--arg', '{}', '--out', tmpOut, '--timeout-ms', '1800000']
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' })
      child.on('error', reject); child.on('exit', resolve)
    })
    if (exit !== 0) throw new Error(`Chrome measurement exited ${exit}`)
    return JSON.parse(await fs.readFile(tmpOut, 'utf8'))
  } finally {
    if (path.basename(scratch).startsWith('aegis-idx-chrome-') && path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await fs.rm(scratch, { recursive: true, force: true })
    }
    await fs.rm(tmpOut, { force: true })
  }
}
