// scripts/measure/vault-preview-index-size.mjs — D-1 IDX-SIZE probe. Mode `codec` (PR-B, Task B.10) only.
//
// Label of every result: CODEC_ONLY_PRELIMINARY — this is NOT the IDX-SIZE gate (Phase G adds CAS, end-to-end mutation,
// Chrome and PostgreSQL). It builds synthetic preview indexes with the REAL D-1 codec, routing, padding and V2 chunk
// encryption primitives (no network, no server, no Production), and reports sizes, shard distribution, simulated splits
// and codec/crypto timings. Limits used are the PROVISIONAL ones in src/lib/vaultPreviewIndexConstants.js.
//
// Run from IDEA1-AEGIS_Drive_LC:
//   node scripts/measure/vault-preview-index-size.mjs --mode codec --nodes 1000,5000,10000 --variants 2,3 --runs 20 --out <scratch>/idx-size-codec.json
// The output path is exclusive-create (never overwrites).
import fs from 'node:fs/promises'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { canonicalEncodeValue, padToBucket, canonicalEncode } from '../../src/lib/vaultTreeCanonical.js'
import { encodeShard, decodeShard, encodeRoot, decodeRoot } from '../../src/lib/vaultPreviewIndexCodec.js'
import { routingBits, prefixOf } from '../../src/lib/vaultPreviewIndexRouting.js'
import { PREVIEW_INDEX_LIMITS as L } from '../../src/lib/vaultPreviewIndexConstants.js'
import { createVaultV2Envelope, encryptVaultChunk, decryptVaultChunk } from '../../src/lib/vaultChunkCrypto.js'
import { createGenesisManifest } from '../../src/lib/vaultTreeManifest.js'

const LABEL = 'CODEC_ONLY_PRELIMINARY'
const TREE_ID = 'T'.repeat(22)
const FOLDERS = 5 // + root = 6 non-file nodes, matching the PR #278 fixture (994 / 4,994 / 9,994 files)
const hex48 = () => randomBytes(24).toString('hex')
const cid = () => randomBytes(16).toString('base64')
const id22 = () => randomBytes(16).toString('base64url')
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] }
const stats = (xs) => ({ p50: +pct(xs, 0.5).toFixed(3), p95: +pct(xs, 0.95).toFixed(3), min: +Math.min(...xs).toFixed(3), max: +Math.max(...xs).toFixed(3), samples: xs.length })
const time = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r] }
const ENC_LIMITS = { maxJsonDepth: L.maxJsonDepth, maxDecodedBytes: Number.MAX_SAFE_INTEGER }

function parseArgs(argv) {
  const o = { mode: 'codec', nodes: [1000, 5000, 10000], variants: [2, 3], runs: 20, out: null }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1]
    if (v === undefined) throw new Error(`missing value for ${k}`)
    if (k === '--mode') o.mode = v
    else if (k === '--nodes') o.nodes = v.split(',').map(Number)
    else if (k === '--variants') o.variants = v.split(',').map(Number)
    else if (k === '--runs') o.runs = Number(v)
    else if (k === '--out') o.out = v
    else throw new Error(`unknown argument ${k}`)
  }
  if (o.mode !== 'codec') throw new Error('only --mode codec exists in PR-B (Phase G adds e2e)')
  if (!o.out) throw new Error('--out is required')
  if (o.runs < 20) throw new Error('--runs must be >= 20')
  return o
}

function entriesFor(source, variant) {
  const base = { blobRef: { formatVersion: 2, id: hex48() }, contentId: cid(), sourceBlobRef: { formatVersion: 2, id: source }, createdAtClient: 1_759_300_000_000 + Math.floor(Math.random() * 1e9) }
  const list = [
    { ...base, kind: 'poster', profile: 'vp1', mime: 'image/webp', width: 512, height: 288, plainSize: 20_000 + Math.floor(Math.random() * 100_000) },
    { ...base, blobRef: { formatVersion: 2, id: hex48() }, contentId: cid(), kind: 'thumb', profile: 'vp1', mime: 'image/webp', width: 512, height: 384, plainSize: 20_000 + Math.floor(Math.random() * 100_000) },
  ]
  // third-entry STRESS SHAPE only: a structurally valid future-profile entry (D-1 never writes motion)
  if (variant === 3) list.unshift({ ...base, blobRef: { formatVersion: 2, id: hex48() }, contentId: cid(), kind: 'motion', profile: 'vp9', mime: 'video/mp4', width: 480, height: 270, plainSize: 1_000_000 + Math.floor(Math.random() * 3_000_000), durationMs: 6_000 })
  return list.sort((a, b) => (a.kind < b.kind ? -1 : 1))
}

/** exact canonical size of a shard = header + Σ pair bytes + separators (canonical JSON is concatenative) */
function shardHeaderBytes(prefix) {
  return canonicalEncodeValue({ entries: [], prefix, schemaVersion: 1, treeId: TREE_ID }, ENC_LIMITS).length
}

async function buildOnce(files, variant) {
  const items = []
  for (let i = 0; i < files; i++) {
    const nodeId = id22()
    const list = entriesFor(hex48(), variant)
    const pairBytes = canonicalEncodeValue([nodeId, list], ENC_LIMITS).length
    items.push({ nodeId, list, pairBytes, bits: await routingBits(nodeId) })
  }
  // incremental build in random order with the provisional split rule
  const shards = new Map() // prefix → { items: [], bytes }
  const sizeOf = (prefix, its) => shardHeaderBytes(prefix) + its.reduce((t, x) => t + x.pairBytes, 0) + Math.max(0, its.length - 1)
  let splits = 0, overflowSkips = 0
  const splitPrefixes = new Set()
  const targetPrefix = (bits) => {
    let p = prefixOf(bits, L.initialPrefixBits)
    while (splitPrefixes.has(p)) p = prefixOf(bits, p.length + 1) // a split region routes to its child (prefix-free)
    return p
  }
  for (const it of items) {
    const p = targetPrefix(it.bits)
    const s = shards.get(p) ?? { items: [] }
    s.items.push(it)
    shards.set(p, s)
    if (sizeOf(p, s.items) > L.maxShardDecodedBytes) {
      if (p.length < L.maxPrefixBits) {
        shards.delete(p)
        splitPrefixes.add(p)
        splits++
        for (const bit of ['0', '1']) {
          const child = p + bit
          const its = s.items.filter((x) => prefixOf(x.bits, child.length) === child)
          if (its.length) shards.set(child, { items: its })
        }
      } else {
        s.items.pop(); overflowSkips++ // writer would skip (fail-soft), never truncate
      }
    }
  }
  return { items, shards, splits, overflowSkips }
}

async function measureCell(nodes, variant, runs) {
  const files = nodes - 1 - FOLDERS
  const perRun = []
  const t = { shardEncode: [], shardEncrypt: [], shardDecrypt: [], shardDecode: [], rootEncode: [], rootEncrypt: [], rootDecrypt: [], rootDecode: [] }
  let detail = null
  for (let run = 0; run < runs; run++) {
    const { shards, splits, overflowSkips } = await buildOnce(files, variant)
    const sizes = []
    let largest = null, shardLimitExceeded = 0
    for (const [prefix, s] of shards) {
      let bytes
      try {
        bytes = await encodeShard({ schemaVersion: 1, treeId: TREE_ID, prefix, entries: new Map(s.items.map((x) => [x.nodeId, x.list])) })
      } catch (e) {
        if (e?.code !== 'LIMIT') throw e
        // over the provisional decoded cap: measure the canonical size anyway and flag it (never silently relaxed)
        bytes = canonicalEncodeValue({ entries: new Map(s.items.map((x) => [x.nodeId, x.list])), prefix, schemaVersion: 1, treeId: TREE_ID }, ENC_LIMITS)
        shardLimitExceeded++
      }
      const paddedLength = bytes.length + 5 <= L.shardPaddingBuckets.at(-1) ? padToBucket(bytes, L.shardPaddingBuckets).paddedLength : null
      sizes.push({ prefix, entries: s.items.length, canonical: bytes.length, padded: paddedLength, cipher: paddedLength === null ? null : paddedLength + 16 })
      if ((!largest || bytes.length > largest.bytes.length) && paddedLength !== null && bytes.length <= L.maxShardDecodedBytes) largest = { prefix, bytes }
    }
    const descriptors = [...shards.keys()].sort().map((prefix) => ({ prefix, blobRef: { formatVersion: 2, id: hex48() }, contentId: cid() }))
    let rootCanonical = null, rootPadded = null, rootError = null, rootBytes = null
    try {
      rootBytes = encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 1 + run, createdAtClient: 1_759_300_000_000, shards: descriptors })
      rootCanonical = rootBytes.length
      rootPadded = padToBucket(rootBytes, L.rootPaddingBuckets).paddedLength
    } catch (e) {
      rootError = e?.code ?? String(e)
      rootCanonical = canonicalEncodeValue({ createdAtClient: 1_759_300_000_000, indexGeneration: 1 + run, schemaVersion: 1, shards: descriptors, treeId: TREE_ID }, ENC_LIMITS).length
    }
    // timings on the largest shard and the root, real primitives
    const kek = await globalThis.crypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt'])
    const shardMap = new Map(shards.get(largest.prefix).items.map((x) => [x.nodeId, x.list]))
    const [encMs, encoded] = await time(() => encodeShard({ schemaVersion: 1, treeId: TREE_ID, prefix: largest.prefix, entries: shardMap }))
    const padded = padToBucket(encoded, L.shardPaddingBuckets).padded
    const env = await createVaultV2Envelope(kek, { name: '', type: 'application/vnd.aegis.vault-preview-index-shard.v1', size: padded.length, chunkCount: 1 })
    const [cryMs, sealed] = await time(() => encryptVaultChunk(env.dek, { contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: padded }))
    const [decMs, plain] = await time(() => decryptVaultChunk(env.dek, { contentId: env.contentIdB64, chunkIndex: 0, chunkCount: 1, ivB64: sealed.ivB64, ciphertext: sealed.ciphertext }))
    const [dcdMs] = await time(() => decodeShard(plain.subarray(0, encoded.length), { treeId: TREE_ID, prefix: largest.prefix }))
    t.shardEncode.push(encMs); t.shardEncrypt.push(cryMs); t.shardDecrypt.push(decMs); t.shardDecode.push(dcdMs)
    if (rootBytes) {
      const [reMs, rb] = await time(async () => encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 1 + run, createdAtClient: 1_759_300_000_000, shards: descriptors }))
      const rp = padToBucket(rb, L.rootPaddingBuckets).padded
      const renv = await createVaultV2Envelope(kek, { name: '', type: 'application/vnd.aegis.vault-preview-index-root.v1', size: rp.length, chunkCount: 1 })
      const [rcMs, rs] = await time(() => encryptVaultChunk(renv.dek, { contentId: renv.contentId, chunkIndex: 0, chunkCount: 1, plaintext: rp }))
      const [rdMs, rplain] = await time(() => decryptVaultChunk(renv.dek, { contentId: renv.contentIdB64, chunkIndex: 0, chunkCount: 1, ivB64: rs.ivB64, ciphertext: rs.ciphertext }))
      const [rdcMs] = await time(async () => decodeRoot(rplain.subarray(0, rb.length), { treeId: TREE_ID, indexGeneration: 1 + run }))
      t.rootEncode.push(reMs); t.rootEncrypt.push(rcMs); t.rootDecrypt.push(rdMs); t.rootDecode.push(rdcMs)
    }
    const canon = sizes.map((s) => s.canonical)
    const r = {
      liveShards: sizes.length, splits, overflowSkips,
      largestShardCanonical: Math.max(...canon), averageShardCanonical: Math.round(canon.reduce((a, b) => a + b, 0) / canon.length),
      largestShardPadded: Math.max(...sizes.map((s) => s.padded ?? Infinity)), largestShardCipher: Math.max(...sizes.map((s) => s.cipher ?? Infinity)),
      averageShardPadded: Math.round(sizes.reduce((a, s) => a + (s.padded ?? 0), 0) / sizes.length),
      totalShardCanonical: canon.reduce((a, b) => a + b, 0), totalShardPadded: sizes.reduce((a, s) => a + (s.padded ?? 0), 0), totalShardCipher: sizes.reduce((a, s) => a + (s.cipher ?? 0), 0),
      shardLimitExceeded,
      maxEntriesPerShard: Math.max(...sizes.map((s) => s.entries)),
      rootCanonical, rootPadded, rootCipher: rootPadded === null ? null : rootPadded + 16, rootError,
    }
    perRun.push(r)
    if (run === 0) detail = { shards: sizes }
  }
  const field = (k) => perRun.map((r) => r[k])
  const summarize = (k) => { const xs = field(k).filter((x) => x !== null); return xs.length ? { min: Math.min(...xs), median: pct(xs, 0.5), max: Math.max(...xs) } : null }
  return {
    label: LABEL, nodes, files, variant, runs,
    entries: files * variant,
    sizes: Object.fromEntries(['liveShards', 'splits', 'overflowSkips', 'shardLimitExceeded', 'largestShardCanonical', 'averageShardCanonical', 'largestShardPadded', 'largestShardCipher', 'averageShardPadded', 'totalShardCanonical', 'totalShardPadded', 'totalShardCipher', 'maxEntriesPerShard', 'rootCanonical', 'rootPadded', 'rootCipher'].map((k) => [k, summarize(k)])),
    rootErrors: [...new Set(field('rootError').filter(Boolean))],
    timingsMs: Object.fromEntries(Object.entries(t).map(([k, xs]) => [k, xs.length ? stats(xs) : null])),
    firstRunShards: detail.shards,
  }
}

async function mainManifestDelta(nodes) {
  // The index is encoded as a separate object. Re-encode an independent main-manifest copy after that operation;
  // no index field may appear in the schema-v1 manifest and the canonical bytes must remain identical.
  const m = createGenesisManifest({ treeId: TREE_ID, rootNodeId: 'R'.repeat(22), revisionId: 'V'.repeat(22), now: 1_759_300_000_000 })
  const folders = []
  for (let i = 0; i < FOLDERS; i++) {
    const nodeId = id22()
    folders.push(nodeId)
    m.nodes.set(nodeId, { nodeId, kind: 'folder', parentNodeId: 'R'.repeat(22), name: `folder-${i}`, createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } })
  }
  const files = nodes - 1 - FOLDERS
  if (files < 0) throw new RangeError('nodes must include root and five folders')
  for (let i = 0; i < files; i++) {
    const nodeId = id22()
    m.nodes.set(nodeId, { nodeId, kind: 'file', parentNodeId: folders[i % folders.length], name: `photo-${i}.jpg`, createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' }, blobRef: { formatVersion: 2, id: hex48() }, mediaType: 'image/jpeg', plainSize: 1_000_000 })
  }
  const opts = { maxJsonDepth: 8, maxDecodedBytes: 64 * 1024 * 1024 }
  const before = canonicalEncode(m, opts)
  encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 1, createdAtClient: 1_759_300_000_000, shards: [] })
  const after = canonicalEncode(structuredClone(m), opts)
  const canonicalBytesEqual = Buffer.from(before).equals(Buffer.from(after))
  return { nodes, files, nonFileNodes: 1 + folders.length, mainManifestCanonicalBytes: before.length, deltaBytes: after.length - before.length, canonicalBytesEqual }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const started = new Date().toISOString()
  const cells = []
  for (const nodes of o.nodes) for (const variant of o.variants) {
    process.stderr.write(`[idx-size] ${LABEL} nodes=${nodes} variant=${variant} runs=${o.runs}\n`)
    cells.push(await measureCell(nodes, variant, o.runs))
  }
  const manifest = []
  for (const nodes of o.nodes) manifest.push(await mainManifestDelta(nodes))
  const out = {
    label: LABEL, notGate: 'NOT IDX_SIZE_GATE_PASS — codec-only preliminary signal; Phase G is the gate',
    started, finished: new Date().toISOString(),
    env: { node: process.version, platform: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model },
    provisionalLimits: { ...L, shardPaddingBuckets: [...L.shardPaddingBuckets], rootPaddingBuckets: [...L.rootPaddingBuckets] },
    cells, mainManifest: manifest,
  }
  const fh = await fs.open(o.out, 'wx')
  await fh.writeFile(JSON.stringify(out, null, 2))
  await fh.close()
  for (const c of cells) {
    const s = c.sizes
    process.stdout.write(`${LABEL} nodes=${c.nodes} variant=${c.variant} liveShards=${JSON.stringify(s.liveShards)} largestShardCanonical=${JSON.stringify(s.largestShardCanonical)} splits=${JSON.stringify(s.splits)} rootCanonical=${JSON.stringify(s.rootCanonical)} rootErrors=${JSON.stringify(c.rootErrors)}\n`)
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
