// scripts/measure/vault-preview-index-audit-volume.mjs — D-1 PR-E Task H.3 · preview-index audit volume (LOCAL, DISPOSABLE ONLY)
//
// Measures audit_log rows by action/result for one owner on a disposable local server:
//   BASELINE   — no preview index: unlock inventory + head 404 + 60 visible tiles read through the ORIGINAL path
//   WITH_INDEX — same visible set read derivative-first (head → root → shards → envelope batch → 60 derivatives)
//   BACKFILL   — one backfill batch: maxEntriesPerCas jobs (8 replaced files × thumb + poster) through the real writer
// and scans every new audit row for secrets (names, nodeIds, user MIME, markers, raw blob ids, content ids).
// Measurement only: no audit semantic, de-duplication or limit change. The server runs with the HG-G approved
// retained budget (8,589,934,592 B/owner). Output is exclusive-create JSON; never a Production URL or credential.
//
// Usage (from IDEA1-AEGIS_Drive_LC/):
//   node scripts/measure/vault-preview-index-audit-volume.mjs --server memory --nodes 1000 --runs 20 --out "$SCRATCH/idx-audit-memory.json"
//   D1_IDX_AUDIT_PG_CONFIRMED=1 node scripts/measure/vault-preview-index-audit-volume.mjs --server pg --nodes 1000 --runs 20 --out …   (after scripts/pg-integration-env.sh up)
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { encodeShard } from '../../src/lib/vaultPreviewIndexCodec.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, PREVIEW_INDEX_LIMITS as L } from '../../src/lib/vaultPreviewIndexConstants.js'
import { routingBits, prefixOf } from '../../src/lib/vaultPreviewIndexRouting.js'
import { createPreviewIndexReader } from '../../src/lib/vaultPreviewIndexReader.js'
import { readDerivative } from '../../src/lib/vaultDerivativeRead.js'
import { uploadVaultFileChunked } from '../../src/lib/vaultChunkedUpload.js'
import {
  localServer, transportFor, webpStub, uploadEntry, uploadIndex, attachAll, writeJobs, changeSource,
} from './vault-preview-index-e2e.mjs'

export const APPROVED_BUDGET_BYTES = 8_589_934_592
const ROOT_ID = 'R'.repeat(22)
const VISIBLE = 60
const id22 = () => randomBytes(16).toString('base64url')
const hex48 = () => randomBytes(24).toString('hex')
const pick = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]

export function parseArgs(argv, env = process.env) {
  const o = { server: null, nodes: 1000, runs: 20, out: null }
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (v === undefined) throw new Error(`missing value for ${k}`)
    if (k === '--server') o.server = v
    else if (k === '--nodes') o.nodes = Number(v)
    else if (k === '--runs') o.runs = Number(v)
    else if (k === '--out') o.out = v
    else throw new Error(`unknown argument ${k}`)
  }
  if (!['memory', 'pg'].includes(o.server)) throw new Error('--server must be memory or pg')
  if (!o.out) throw new Error('--out is required')
  if (!Number.isSafeInteger(o.runs) || o.runs < 20) throw new Error('--runs must be >= 20')
  if (!Number.isSafeInteger(o.nodes) || o.nodes < 7 || o.nodes > 10_000) throw new Error('--nodes must be total nodes 7..10000')
  if (o.server === 'pg') {
    if (env.D1_IDX_AUDIT_PG_CONFIRMED !== '1') throw new Error('pg requires D1_IDX_AUDIT_PG_CONFIRMED=1')
    if (!env.TEST_DATABASE_URL || !env.AEGIS_PGTEST_SUPER_URL) throw new Error('pg requires disposable TEST_DATABASE_URL and AEGIS_PGTEST_SUPER_URL')
    const db = new URL(env.TEST_DATABASE_URL)
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.username !== 'drive_app' || db.pathname !== '/aegis_drive_test' || !['55433', '55750'].includes(db.port) || db.search || db.hash) throw new Error('pg refuses database outside the local disposable harness')
    const superDb = new URL(env.AEGIS_PGTEST_SUPER_URL)
    if (superDb.protocol !== 'postgresql:' || superDb.hostname !== '127.0.0.1' || superDb.username !== 'lftv2_admin' || superDb.pathname !== '/postgres' || superDb.port !== db.port || superDb.search || superDb.hash) {
      throw new Error('pg refuses a superuser URL outside the same local disposable harness')
    }
  }
  return o
}

/** every audit row of `userId` newer than `mark` (memory: monotonic ids in a 500-row ring; PG: bigserial ids) */
async function auditRowsSince(server, userId, mark) {
  if (server.connection.usingPostgres) {
    const r = await server.connection.query(
      'SELECT id, actor_label, role, action, target_hash, result, source_ip FROM audit_log WHERE actor_id = $1 AND id > $2 ORDER BY id', [userId, mark])
    return r.rows.map((x) => ({ id: Number(x.id), actorLabel: x.actor_label, role: x.role, action: x.action, targetHash: x.target_hash, result: x.result, sourceIp: x.source_ip }))
  }
  return (await server.connection.readAudit(500)).filter((r) => String(r.actorId) === userId && r.id > mark).sort((a, b) => a.id - b.id)
}
async function auditMark(server, userId) {
  const rows = await auditRowsSince(server, userId, -1)
  return rows.length ? rows.at(-1).id : 0
}
const tally = (rows) => rows.reduce((m, r) => { const k = `${r.action}/${r.result}`; m[k] = (m[k] ?? 0) + 1; return m }, {})

function distribution(runs) {
  const keys = [...new Set(runs.flatMap((t) => Object.keys(t)))].sort()
  const byAction = Object.fromEntries(keys.map((k) => {
    const xs = runs.map((t) => t[k] ?? 0)
    return [k, { p50: pick(xs, 0.5), p95: pick(xs, 0.95), min: Math.min(...xs), max: Math.max(...xs), unit: 'rows' }]
  }))
  const totals = runs.map((t) => Object.values(t).reduce((a, b) => a + b, 0))
  return { runs: runs.length, byAction, total: { p50: pick(totals, 0.5), p95: pick(totals, 0.95), min: Math.min(...totals), max: Math.max(...totals), unit: 'rows' } }
}

function readerApi(transport) {
  return {
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
}

export async function runAuditVolume(o) {
  const started = new Date().toISOString()
  const server = await localServer(o.server, { retainedBudgetBytes: APPROVED_BUDGET_BYTES })
  const secrets = new Set()
  const scanned = []
  try {
    const treeId = id22()
    const owner = await server.newOwner(treeId)
    const transport = transportFor(owner.client)
    const files = o.nodes - 6
    const visible = Math.min(VISIBLE, files)

    // fixture: `files` file nodes; the visible ones get a real ORIGINAL V2 blob (tree upload family)
    const items = []
    for (let i = 0; i < files; i++) {
      const nodeId = id22(); secrets.add(nodeId)
      let source = hex48()
      if (i < visible) {
        const name = `tile-${i}-${randomBytes(3).toString('hex')}.webp`; secrets.add(name)
        const r = await uploadVaultFileChunked({ kek: owner.kek, file: new File([webpStub(4096, 320, 240)], name, { type: 'image/webp' }),
          plaintextChunkBytes: 8 * 1024 * 1024, concurrency: 1, fetchJson: transport.fetchJson, sendUpload: transport.sendUpload, routeBase: '/api/vault/tree/uploads' })
        if (!r.ok) throw new Error(`original upload failed: ${r.response?.data?.code ?? r.reason}`)
        source = r.blob.id; secrets.add(r.blob.contentIdB64)
      }
      secrets.add(source)
      items.push({ nodeId, source, visible: i < visible, list: [] })
    }
    const nodes = new Map([[ROOT_ID, { nodeId: ROOT_ID, kind: 'folder', parentNodeId: null, lifecycle: { state: 'active' } }]])
    for (const it of items) nodes.set(it.nodeId, { nodeId: it.nodeId, kind: 'file', parentNodeId: ROOT_ID, lifecycle: { state: 'active' }, blobRef: { formatVersion: 2, id: it.source } })
    const mainHead = { treeId, generation: 1, index: { nodes, rootNodeId: ROOT_ID, limits: { maxDepth: 64 } } }
    const visibleItems = items.filter((it) => it.visible)

    const coldView = async (withIndex) => {
      const mark = await auditMark(server, owner.userId)
      const inv = await transport.fetchJson('/api/vault')
      if (!inv.ok) throw new Error(`inventory HTTP ${inv.status}`)
      if (!withIndex) {
        const head = await transport.fetchJson('/api/vault/tree/preview-index/head')
        if (head.status !== 404) throw new Error(`baseline head must be 404, got ${head.status}`)
        for (const it of visibleItems) {
          const r = await transport.fetchBytes(`/api/vault/blobs/${it.source}/chunks/0`)
          if (!r.ok) throw new Error(`original chunk HTTP ${r.status}`)
          r.bytes.fill(0)
        }
      } else {
        const reader = createPreviewIndexReader({ kek: owner.kek, api: readerApi(transport), fetchBytes: transport.fetchBytes })
        const loaded = await reader.load(mainHead)
        if (loaded.status !== 'READY') throw new Error(`reader ${loaded.status}:${loaded.reason ?? ''}`)
        const entries = []
        for (const it of visibleItems) {
          const e = await reader.lookup(mainHead.index.nodes.get(it.nodeId), 'thumb')
          if (!e) throw new Error('indexed tile missing thumb')
          entries.push(e)
        }
        await reader.prefetchEnvelopes(entries.map((e) => e.blobRef.id))
        for (const entry of entries) {
          const r = await readDerivative({ kek: owner.kek, entry, envelopeOf: reader.envelopeOf, fetchBytes: transport.fetchBytes,
            decodeImage: async () => ({ width: entry.width, height: entry.height, close() {} }) })
          if (!r.ok) throw new Error(`derivative read ${r.reason}`)
          r.bytes.fill(0)
        }
        reader.clear()
      }
      const rows = await auditRowsSince(server, owner.userId, mark)
      scanned.push(...rows)
      return tally(rows)
    }

    // BASELINE: no index exists yet
    const baseline = []
    for (let r = 0; r < o.runs; r++) baseline.push(await coldView(false))

    // initial index build (thumb + poster per file); its audit volume is informational
    const buildMark = await auditMark(server, owner.userId)
    const byPrefix = new Map(), derivativeIds = []
    for (const it of items) {
      for (const [kind, width, height] of [['poster', 512, 288], ['thumb', 320, 240]]) {
        const entry = { kind, profile: 'vp1', mime: 'image/webp', width, height, plainSize: 20_000, sourceBlobRef: { formatVersion: 2, id: it.source }, createdAtClient: 1_759_300_000_000 }
        const up = await uploadEntry(owner.kek, transport, entry)
        entry.blobRef = { formatVersion: 2, id: up.id }; entry.contentId = up.contentIdB64
        secrets.add(up.id); secrets.add(up.contentIdB64); derivativeIds.push(up.id)
        it.list.push(entry)
      }
      const p = prefixOf(await routingBits(it.nodeId), L.initialPrefixBits)
      if (!byPrefix.has(p)) byPrefix.set(p, new Map())
      byPrefix.get(p).set(it.nodeId, it.list)
    }
    const descriptors = [], shardIds = []
    for (const prefix of [...byPrefix.keys()].sort()) {
      const plaintext = await encodeShard({ schemaVersion: 1, treeId, prefix, entries: byPrefix.get(prefix) })
      const s = await uploadIndex(owner.kek, transport, INDEX_SHARD_MARKER, plaintext, L.shardPaddingBuckets)
      descriptors.push({ prefix, blobRef: s.blobRef, contentId: s.contentId }); shardIds.push(s.blobRef.id)
      secrets.add(s.blobRef.id); secrets.add(s.contentId)
      plaintext.fill(0)
    }
    const attached = await attachAll(server, owner, transport, treeId, [...derivativeIds, ...shardIds], descriptors)
    secrets.add(attached.root.blobRef.id); secrets.add(attached.root.contentId)
    const buildRows = await auditRowsSince(server, owner.userId, buildMark)
    scanned.push(...buildRows)

    // WITH_INDEX: same visible set, derivative-first
    const withIndex = []
    for (let r = 0; r < o.runs; r++) withIndex.push(await coldView(true))

    // BACKFILL: one batch of maxEntriesPerCas jobs per run (replaced sources → new thumb + poster)
    const backfill = []
    const perBatch = Math.max(1, Math.floor(L.maxEntriesPerCas / 2))
    for (let r = 0; r < o.runs; r++) {
      const batch = Array.from({ length: Math.min(perBatch, items.length) }, (_, j) => items[(r * perBatch + j) % items.length])
      const jobs = []
      for (const it of batch) {
        const src = changeSource(mainHead, it); secrets.add(src.id)
        for (const [kind, width, height] of [['thumb', 320, 240], ['poster', 512, 288]]) jobs.push({ nodeId: it.nodeId, kind, sourceBlobRef: src, bytes: webpStub(20_000, width, height), mime: 'image/webp', width, height })
      }
      const mark = await auditMark(server, owner.userId)
      await writeJobs(server, owner, transport, mainHead, jobs)
      const rows = await auditRowsSince(server, owner.userId, mark)
      scanned.push(...rows)
      backfill.push(tally(rows))
    }

    // privacy scan over every row this run produced
    const forbidden = [...secrets, 'image/webp', INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, treeId]
    const labels = new Set(scanned.map((r) => r.actorLabel))
    const violations = []
    for (const row of scanned) {
      const text = JSON.stringify(row)
      if (row.targetHash !== null && row.targetHash !== undefined && !/^[0-9a-f]{64}$/.test(row.targetHash)) violations.push({ id: row.id, issue: 'targetHash not a SHA-256 hex' })
      const hit = forbidden.find((s) => s && text.includes(s))
      if (hit) violations.push({ id: row.id, action: row.action, issue: 'secret value present in audit row' })
      const extra = Object.keys(row).filter((k) => !['id', 'at', 'actorId', 'actorLabel', 'role', 'action', 'targetHash', 'result', 'sourceIp'].includes(k))
      if (extra.length) violations.push({ id: row.id, issue: `unexpected fields ${extra.join(',')}` })
    }
    if (labels.size !== 1) violations.push({ issue: `expected one actor label, got ${labels.size}` })

    let gitHead = null
    try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* not a checkout */ }
    return {
      label: 'IDX_AUDIT_VOLUME', status: 'MEASUREMENT_ONLY', server: o.server, nodes: o.nodes, files, visibleTiles: visible, runs: o.runs,
      approvedRetainedBudgetBytes: APPROVED_BUDGET_BYTES, maxEntriesPerCas: L.maxEntriesPerCas, backfillJobsPerBatch: perBatch * 2,
      started, finished: new Date().toISOString(), env: { gitHead, node: process.version, platform: os.platform(), release: os.release() },
      method: 'BASELINE = GET /api/vault + head 404 + 60 original chunk-0 reads; WITH_INDEX = GET /api/vault + reader(head, root, shards, envelope batch) + 60 derivative reads; BACKFILL = one writer batch of maxEntriesPerCas jobs; audit rows of the owner counted by action/result',
      phases: { baseline: distribution(baseline), withIndex: distribution(withIndex), backfill: distribution(backfill) },
      // memory audit is a 500-row ring: a larger initial build is truncated there (PostgreSQL keeps every row)
      initialBuild: { rows: buildRows.length, byAction: tally(buildRows), generations: attached.generation,
        memoryRingTruncated: !server.connection.usingPostgres && buildRows.length >= 499 },
      privacy: { rowsScanned: scanned.length, forbiddenValuesChecked: forbidden.length, violations },
    }
  } finally { await server.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const o = parseArgs(process.argv.slice(2))
  // exclusive create: evidence is never overwritten (checked before the run, enforced again by 'wx' at write time)
  if (await fs.stat(o.out).then(() => true, () => false)) throw new Error(`--out already exists: ${o.out}`)
  const result = await runAuditVolume(o)
  await fs.writeFile(o.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  if (result.privacy.violations.length) { process.stderr.write(`[idx-audit] PRIVACY VIOLATIONS ${result.privacy.violations.length}\n`); process.exitCode = 2 }
  process.stderr.write(`[idx-audit] wrote ${o.out}\n`)
}
