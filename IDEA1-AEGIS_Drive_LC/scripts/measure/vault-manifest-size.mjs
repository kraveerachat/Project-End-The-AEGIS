// Pre-implementation P2b size/cost probe. No writer flag, derivative, or production I/O.
// `--server memory|pg` uses the real local Drive routes with schema-v1, size-matched
// ciphertext. That measures opaque transfer/row-write cost, NOT v2 compatibility.
// Run from IDEA1-AEGIS_Drive_LC after `npm ci`:
//   node scripts/measure/vault-manifest-size.mjs --nodes 1000,5000,10000 --variants none,previews --runs 20 --server memory --out <scratch>/memory.json
//   P2B_LOCAL_PG_CONFIRMED=1 TEST_DATABASE_URL=<repository disposable PG harness URL> node scripts/measure/vault-manifest-size.mjs --nodes 1000,5000,10000 --variants none,previews --runs 20 --server pg --out <scratch>/pg.json
//   node scripts/measure/vault-manifest-size.mjs --nodes 1000,5000,10000 --variants none,previews --runs 20 --browser <Chrome path> --out <scratch>/chrome.json
// All output paths are exclusive-create; do not use Production credentials or endpoints.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createGenesisManifest, validateManifest } from '../../src/lib/vaultTreeManifest.js'
import { canonicalEncode, padToBucket } from '../../src/lib/vaultTreeCanonical.js'
import { encryptManifestRevision, decryptManifestRevision } from '../../src/lib/vaultTreeManifestCrypto.js'
import { generateTrkBytes, importTrk, generateManifestDekBytes, wrapManifestDek } from '../../src/lib/vaultTreeKeys.js'
import { manifestCiphertextAad } from '../../src/lib/vaultTreeAad.js'
import { VAULT_TREE_CLIENT_LIMITS, PADDING_BUCKETS } from '../../src/lib/vaultTreeLimits.js'
import { bytesToB64 } from '../../src/lib/vaultCrypto.js'

const ID = (n) => String(n).padStart(22, 'A')
const NOW = 1_700_000_000_000
const MAX = VAULT_TREE_CLIENT_LIMITS.maxNodes
const CONTENT_ID = 'AAECAwQFBgcICQoLDA0ODw=='
const hr = () => performance.now()
const timing = async (fn) => { const start = hr(); const result = await fn(); return [hr() - start, result] }
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1]
const stats = (xs) => ({ p50Ms: percentile(xs, 0.5), p95Ms: percentile(xs, 0.95), samples: xs.length })
const ctxFor = (m) => ({ treeId: m.treeId, revisionId: m.revisionId, baseRevisionId: m.baseRevisionId, generation: m.generation, manifestSchemaVersion: m.schemaVersion })

function parseArgs(args) {
  const o = { nodes: [1000, 5000, 10000], variants: ['none', 'previews'], runs: 20, server: 'none', out: null, browser: null }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], val = args[i + 1]
    if (!val) throw new Error(`missing value for ${key}`)
    if (key === '--nodes') o.nodes = val.split(',').map(Number)
    else if (key === '--variants') o.variants = val.split(',')
    else if (key === '--runs') o.runs = Number(val)
    else if (key === '--server') o.server = val
    else if (key === '--out') o.out = val
    else if (key === '--browser') o.browser = val
    else throw new Error(`unknown argument ${key}`)
  }
  if (!o.nodes.length || o.nodes.some((n) => !Number.isSafeInteger(n) || n < 7 || n > MAX)) throw new Error(`nodes must be 7..${MAX} total, including root and five folders`)
  if (!o.variants.length || o.variants.some((x) => !['none', 'previews'].includes(x))) throw new Error('variants must be none,previews')
  if (!Number.isSafeInteger(o.runs) || o.runs < 1) throw new Error('runs must be a positive integer')
  if (!['none', 'memory', 'pg'].includes(o.server)) throw new Error('server must be none, memory, or pg')
  if (o.server === 'pg') {
    if (process.env.P2B_LOCAL_PG_CONFIRMED !== '1') throw new Error('pg requires explicit confirmation of the disposable local harness')
    if (!process.env.TEST_DATABASE_URL) throw new Error('pg requires TEST_DATABASE_URL for a disposable local test database')
    const db = new URL(process.env.TEST_DATABASE_URL)
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' || db.pathname !== '/aegis_drive_test') throw new Error('pg refuses any database outside the repository disposable local harness')
  }
  if (o.browser && o.server !== 'none') throw new Error('browser run measures client operations only; run local server separately')
  return o
}

function nameFor(n) {
  const targetBytes = 24 + n % 37
  const prefix = n % 3 === 0 ? `r${n}-ไทย-` : `report-${n}-`
  const remaining = targetBytes - new TextEncoder().encode(prefix).length - 4
  if (remaining < 0) throw new Error('name fixture exceeded target length')
  const stem = 'holiday-photo-archive-2026-'
  return prefix + stem.repeat(Math.ceil(remaining / stem.length)).slice(0, remaining) + '.jpg'
}

function previewFor(kind, n, sourceBlobRef) {
  const isMotion = kind === 'motion'
  return {
    kind, profile: 'vp1', blobRef: { formatVersion: 2, id: `pv-${kind}-${n}` },
    contentId: CONTENT_ID, sourceBlobRef, mime: isMotion ? 'video/mp4' : 'image/webp',
    width: isMotion ? 480 : 512, height: isMotion ? 270 : 512,
    ...(isMotion ? { durationMs: 3000 } : {}), plainSize: isMotion ? 500_000 : 80_000,
    createdAtClient: NOW,
  }
}

function fixture(totalNodes, variant, schemaVersion = 2) {
  const m = createGenesisManifest({ treeId: ID(900), rootNodeId: ID(0), revisionId: ID(901), now: NOW })
  m.schemaVersion = schemaVersion
  m.generation = 2
  m.baseRevisionId = ID(899)
  for (let n = 1; n <= 5; n++) {
    m.nodes.set(ID(n), { nodeId: ID(n), kind: 'folder', parentNodeId: ID(n - 1), name: `archive-${n}-reports-2026`, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } })
  }
  for (let n = 6; n < totalNodes; n++) {
    const sourceBlobRef = { formatVersion: 2, id: `blob-${n}` }
    m.nodes.set(ID(n), {
      nodeId: ID(n), kind: 'file', parentNodeId: ID(1 + n % 5), name: nameFor(n),
      createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' },
      blobRef: sourceBlobRef, mediaType: 'image/jpeg', plainSize: 1_000_000 + n,
      ...(schemaVersion === 2 && variant === 'previews' ? { previews: ['thumb', 'poster', 'motion'].map((kind) => previewFor(kind, n, sourceBlobRef)) } : {}),
    })
  }
  validateManifest(m)
  return m
}

async function removeBenchmarkStorage(storage) {
  const resolved = path.resolve(storage)
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('aegis-p2b-size-')) throw new Error('refusing cleanup outside disposable benchmark storage')
  await fs.rm(resolved, { recursive: true, force: true })
}

async function localServer(mode) {
  if (mode === 'none') return null
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-p2b-size-'))
  let server
  try {
  // Set before importing the real server/DB modules. PG must be the throwaway harness.
  process.env.STORAGE_ROOT = storage
  process.env.SESSION_SECRET = randomBytes(32).toString('hex')
  if (mode === 'pg') process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  else delete process.env.DATABASE_URL
  const [{ createApp }, { vaultTreeConfigFromEnv }, { initStorage }, { initVaultStorage }, { initVaultManifestStorage }, { initVaultStaging }, tree, { getUserByUsername }, { loginClient, DEMO_USER }, { seedTree }] = await Promise.all([
    import('../../server/app.js'), import('../../server/config/vaultTreeLimits.js'),
    import('../../server/storage/fileStore.js'), import('../../server/storage/vaultStore.js'),
    import('../../server/storage/vaultManifestStore.js'), import('../../server/storage/vaultStaging.js'),
    import('../../server/db/vaultTreeStore.js'), import('../../server/db/connection.js'),
    import('../../tests/helpers/testClient.mjs'), import('../../tests/helpers/vaultTreeStoreSpec.mjs'),
  ])
  await initStorage(); await initVaultStorage(); await initVaultManifestStorage(); await initVaultStaging()
  const config = vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES: String(VAULT_TREE_CLIENT_LIMITS.maxCiphertextBytes) })
  server = createApp({ vaultTreeConfig: config }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const owner = String((await getUserByUsername(DEMO_USER.username)).id)
  await tree.__resetVaultTreeForTests()
  const { treeId, rootRevision } = await seedTree(tree, owner)
  const client = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  return {
    client, treeId, generation: 1, revisionId: rootRevision,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await removeBenchmarkStorage(storage)
    },
  }
  } catch (error) {
    if (server) await new Promise((resolve) => server.close(resolve))
    await removeBenchmarkStorage(storage)
    throw error
  }
}

// Construct a *valid decryptable v1* ciphertext in the same padded bucket as a
// v2 cell, rather than claiming that the current server accepts v2 revisions.
async function v1SizeMatchedEnvelope(trk, v1, revisionId, baseRevisionId, generation, targetCipherBytes) {
  const ctx = { treeId: v1.treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion: 1 }
  const body = canonicalEncode({ ...v1, revisionId, baseRevisionId, generation })
  const targetBucket = targetCipherBytes - 16
  const minimum = padToBucket(body, PADDING_BUCKETS).paddedLength
  if (targetBucket < minimum || !PADDING_BUCKETS.includes(targetBucket)) throw new Error('v1 body cannot fit target bucket')
  const padded = new Uint8Array(targetBucket)
  padded.set(body)
  padded[targetBucket - 5] = 1
  new DataView(padded.buffer).setUint32(targetBucket - 4, body.length, false)
  const dekBytes = generateManifestDekBytes()
  const dek = await crypto.subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const wrapped = await wrapManifestDek(trk, dekBytes, ctx)
  const iv = randomBytes(12)
  const aad = manifestCiphertextAad({ ...ctx, paddedPlaintextLength: targetBucket })
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, padded))
  padded.fill(0); body.fill(0)
  if (ciphertext.length !== targetCipherBytes) throw new Error('size match failed')
  return { ciphertext, ivB64: bytesToB64(iv), ...wrapped }
}

async function serverSamples(server, trk, totalNodes, cipherBytes, runs) {
  if (!server) return null
  const v1 = fixture(totalNodes, 'none', 1)
  const upload = [], cas = []
  for (let i = 0; i < runs; i++) {
    const generation = server.generation + 1
    const revisionId = Buffer.from(randomBytes(16)).toString('base64url')
    const idempotencyKey = Buffer.from(randomBytes(16)).toString('base64url')
    const baseRevisionId = server.revisionId
    const env = await v1SizeMatchedEnvelope(trk, v1, revisionId, baseRevisionId, generation, cipherBytes)
    if (i === 0) {
      const roundTrip = await decryptManifestRevision(trk, env, { treeId: v1.treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion: 1 })
      if (roundTrip.schemaVersion !== 1 || roundTrip.nodes.size !== totalNodes) throw new Error('size-matched v1 proxy failed authenticated round trip')
    }
    const desc = { revisionId, baseRevisionId, generation, manifestSchemaVersion: 1, idempotencyKey, treeId: server.treeId, ivB64: env.ivB64, wrappedManifestDekB64: env.wrappedManifestDekB64, wrapIvB64: env.wrapIvB64 }
    const staged = await server.client.req('/api/vault/tree/revisions', { method: 'POST', body: desc })
    if (staged.status !== 201) throw new Error(`v1 stage failed: HTTP ${staged.status} ${staged.data?.code ?? ''}`)
    const [uploadMs, put] = await timing(() => server.client.req(`/api/vault/tree/revisions/${revisionId}/ciphertext`, { method: 'PUT', body: env.ciphertext, headers: { 'Content-Type': 'application/octet-stream' } }))
    if (put.status !== 200) throw new Error(`v1 upload failed: HTTP ${put.status} ${put.data?.code ?? ''}`)
    upload.push(uploadMs)
    const [casMs, committed] = await timing(() => server.client.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: server.generation, expectedRevisionId: baseRevisionId, revisionId, idempotencyKey, attachBlobIds: [], purgeBlobIds: [] } }))
    if (committed.status !== 200) throw new Error(`v1 CAS failed: HTTP ${committed.status} ${committed.data?.code ?? ''}`)
    cas.push(casMs)
    server.generation = generation; server.revisionId = revisionId
  }
  return { upload: stats(upload), cas: stats(cas), substitution: 'valid decryptable schema-v1 revision, zero-padded to the v2 ciphertext bucket; server v2 compatibility untested' }
}

async function measureCell(totalNodes, variant, runs, trk, server) {
  const m = fixture(totalNodes, variant)
  const ctx = ctxFor(m)
  const { index } = validateManifest(m)
  const maxDepth = Math.max(...index.depthOf.values())
  const names = [...m.nodes.values()].filter((n) => n.parentNodeId !== null).map((n) => new TextEncoder().encode(n.name).length)
  const encode = [], encrypt = [], decrypt = []
  let env, plainBytes, bucketBytes
  for (let i = -1; i < runs; i++) {
    const [encodeMs, encoded] = await timing(() => canonicalEncode(m))
    const [encryptMs, sealed] = await timing(() => encryptManifestRevision(trk, m, ctx))
    const [decryptMs, back] = await timing(() => decryptManifestRevision(trk, sealed, ctx))
    if (back.nodes.size !== totalNodes) throw new Error('crypto round trip changed node count')
    if (i >= 0) { encode.push(encodeMs); encrypt.push(encryptMs); decrypt.push(decryptMs) }
    plainBytes = encoded.length; bucketBytes = sealed.paddedLength; env = sealed
    encoded.fill(0)
  }
  const serverResult = await serverSamples(server, trk, totalNodes, env.ciphertext.length, runs)
  return {
    totalNodes, fileNodes: totalNodes - 6, folderNodes: 6, variant,
    previewEntries: variant === 'previews' ? (totalNodes - 6) * 3 : 0,
    nameUtf8Bytes: { min: Math.min(...names), max: Math.max(...names) }, maxDepth,
    schemaVersion: 2, validated: true, samples: runs,
    plainBytes, bucketBytes, cipherBytes: env.ciphertext.length,
    encode: stats(encode), encrypt: stats(encrypt), decryptDecodeValidate: stats(decrypt),
    server: serverResult,
  }
}

async function browserMeasurement(args) {
  if (!args.out) throw new Error('--browser requires --out')
  if (await fs.stat(args.out).then(() => true, () => false)) throw new Error('--out already exists; refusing to overwrite browser evidence')
  const browserDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault-tree')
  const nonce = Buffer.from(randomBytes(8)).toString('hex')
  const pageName = `.p2b-${nonce}.html`
  const jsName = `.p2b-${nonce}.js`
  const pagePath = path.join(browserDir, pageName)
  const jsPath = path.join(browserDir, jsName)
  const source = `
import { createGenesisManifest, validateManifest } from '/src/lib/vaultTreeManifest.js'
import { canonicalEncode } from '/src/lib/vaultTreeCanonical.js'
import { encryptManifestRevision, decryptManifestRevision } from '/src/lib/vaultTreeManifestCrypto.js'
import { generateTrkBytes, importTrk } from '/src/lib/vaultTreeKeys.js'
import { VAULT_TREE_CLIENT_LIMITS } from '/src/lib/vaultTreeLimits.js'
const ID = (n) => String(n).padStart(22, 'A')
const NOW = 1700000000000
const CONTENT_ID = 'AAECAwQFBgcICQoLDA0ODw=='
const hr = () => performance.now()
const nameFor = ${nameFor.toString()}
const previewFor = ${previewFor.toString()}
const fixture = ${fixture.toString()}
const ctxFor = ${ctxFor.toString()}
const percentile = ${percentile.toString()}
const stats = ${stats.toString()}
const timing = ${timing.toString()}
globalThis.runP2bManifestSize = async function ({ nodes, variants, runs }) {
  const trk = await importTrk(generateTrkBytes())
  const cells = []
  for (const n of nodes) for (const variant of variants) {
    const m = fixture(n, variant)
    const ctx = ctxFor(m)
    const { index } = validateManifest(m)
    const maxDepth = Math.max(...index.depthOf.values())
    const names = [...m.nodes.values()].filter((x) => x.parentNodeId !== null).map((x) => new TextEncoder().encode(x.name).length)
    const encode = [], encrypt = [], decrypt = []
    let plainBytes, bucketBytes, cipherBytes
    for (let i = -1; i < runs; i++) {
      const [eMs, encoded] = await timing(() => canonicalEncode(m))
      const [cMs, sealed] = await timing(() => encryptManifestRevision(trk, m, ctx))
      const [dMs, back] = await timing(() => decryptManifestRevision(trk, sealed, ctx))
      if (back.nodes.size !== n) throw new Error('browser round trip changed node count')
      if (i >= 0) { encode.push(eMs); encrypt.push(cMs); decrypt.push(dMs) }
      plainBytes = encoded.length; bucketBytes = sealed.paddedLength; cipherBytes = sealed.ciphertext.length
      encoded.fill(0)
    }
    cells.push({ totalNodes: n, fileNodes: n - 6, folderNodes: 6, variant,
      previewEntries: variant === 'previews' ? 3 * (n - 6) : 0,
      nameUtf8Bytes: { min: Math.min(...names), max: Math.max(...names) }, maxDepth,
      schemaVersion: 2, validated: true, samples: runs,
      plainBytes, bucketBytes, cipherBytes,
      encode: stats(encode), encrypt: stats(encrypt), decryptDecodeValidate: stats(decrypt) })
  }
  return { schema: 'P2B_T_MAN_SIZE_BROWSER_V1', userAgent: navigator.userAgent,
    platform: navigator.platform, crossOriginIsolated: globalThis.crossOriginIsolated === true,
    measurementSurface: 'Chromium static harness; real product modules, local loopback', cells }
}
`
  const html = `<!doctype html><meta charset="utf-8"><title>P2b local manifest size probe</title><script type="importmap">{"imports":{"hash-wasm":"/node_modules/hash-wasm/dist/index.esm.js"}}</script><script type="module" src="./${jsName}"></script>`
  try {
    await fs.writeFile(jsPath, source, { flag: 'wx' })
    await fs.writeFile(pagePath, html, { flag: 'wx' })
    const runner = path.join(browserDir, 'run-browser-bench.mjs')
    const command = [runner, '--browser', args.browser, '--page', pageName, '--fn', 'runP2bManifestSize', '--arg', JSON.stringify({ nodes: args.nodes, variants: args.variants, runs: args.runs }), '--out', args.out, '--timeout-ms', '1800000']
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, command, { stdio: 'inherit' })
      child.on('error', reject); child.on('exit', (code) => resolve(code))
    })
    if (exitCode !== 0) throw new Error(`Chromium static harness exited ${exitCode}`)
  } finally {
    await fs.rm(pagePath, { force: true }); await fs.rm(jsPath, { force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.browser) return browserMeasurement(args)
  const startedAt = new Date().toISOString()
  const trk = await importTrk(generateTrkBytes())
  const server = await localServer(args.server)
  const cells = []
  try {
    for (const n of args.nodes) for (const variant of args.variants) cells.push(await measureCell(n, variant, args.runs, trk, server))
  } finally { if (server) await server.close() }
  const result = {
    schema: 'P2B_T_MAN_SIZE_V1', startedAt, endedAt: new Date().toISOString(),
    environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), server: args.server },
    limits: { maxNodes: MAX, maxDecodedBytes: VAULT_TREE_CLIENT_LIMITS.maxDecodedBytes, maxCiphertextBytes: VAULT_TREE_CLIENT_LIMITS.maxCiphertextBytes },
    caveats: ['Node counts include the root and five folder nodes; 10,000 file nodes would violate product maxNodes=10,000.', 'encrypt includes validation+encode; decrypt includes decode+validate. Encode and encrypt timings overlap.', 'Server measurements use a real v1 revision padded to each v2 ciphertext bucket; this is a server-size/row-write proxy, not v2 compatibility.', 'Local loopback is not LAN or Remote.'],
    cells,
  }
  const json = JSON.stringify(result, null, 2) + '\n'
  if (args.out) await fs.writeFile(args.out, json, { flag: 'wx' })
  else process.stdout.write(json)
}

main().catch((error) => { console.error(`T_MAN_SIZE_ERROR=${error.message}`); process.exitCode = 1 })
