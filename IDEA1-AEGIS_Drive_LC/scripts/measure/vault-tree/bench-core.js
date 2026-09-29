// scripts/measure/vault-tree/bench-core.js — PR #157 · disposable measurement core (product-module edition)
//
// ⚠️ DISPOSABLE MEASUREMENT CODE, NOT PRODUCT CODE. Nothing here is imported by src/ or
//    server/. Since Task 1.6 (gate G1) the ONLY benchmark implementation is the real
//    product modules under src/lib/ — the Phase 0 prototype encoder/padder/AAD/validator
//    that lived here was compared byte-for-byte against the product encoder on the whole
//    shared fixture grid (96/96 identical, recorded in the Limits Evidence note) and then
//    deleted. There is no second implementation of the format any more.
//
// Runs unchanged in Node 24 (globalThis.crypto) and in a browser (ESM; the driver serves
// /src/ and an import map for hash-wasm, which vaultCrypto.js imports).

import { canonicalEncode, padToBucket, stripPadding } from '../../../src/lib/vaultTreeCanonical.js'
import { validateManifest } from '../../../src/lib/vaultTreeManifest.js'
import { encryptManifestRevision, decryptManifestRevision } from '../../../src/lib/vaultTreeManifestCrypto.js'
import { generateTrkBytes, wrapTrkSlots, unwrapTrkSlots } from '../../../src/lib/vaultTreeKeys.js'
import { VAULT_TREE_CLIENT_LIMITS, PADDING_BUCKETS, treeLimitsFrom } from '../../../src/lib/vaultTreeLimits.js'

export const BENCH_IMPLEMENTATION = 'product-modules'

// ── shapes (unchanged from Phase 0 so G1 compares like with like) ───────────
export const NODE_COUNTS = [100, 1_000, 5_000, 10_000, 25_000, 50_000]
export const DEPTHS = [1, 8, 32, 64]
export const NAME_BYTES = [16, 64, 255, 600, 1_024] // 600 = the selected maxNameBytes edge, added at G1

// ── ids ─────────────────────────────────────────────────────────────────────
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function randomIdB64url(bytes = 16) {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(bytes))
  let bits = 0, acc = 0, out = ''
  for (const b of raw) {
    acc = (acc << 8) | b; bits += 8
    while (bits >= 6) { bits -= 6; out += B64URL[(acc >> bits) & 63] }
  }
  if (bits > 0) out += B64URL[(acc << (6 - bits)) & 63]
  return out
}

// Deterministic pseudo-random for reproducible shapes (xorshift32)
export function seeded(seed) {
  let x = seed >>> 0 || 1
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000 }
}

// Name of exactly `bytes` UTF-8 bytes, mixing ASCII and 3-byte Thai characters.
export function makeName(bytes, rnd) {
  const thai = 'กขคงจฉชซญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ'
  let s = '', n = 0
  while (n < bytes) {
    if (bytes - n >= 3 && rnd() < 0.5) { s += thai[Math.floor(rnd() * thai.length)]; n += 3 }
    else { s += String.fromCharCode(97 + Math.floor(rnd() * 26)); n += 1 }
  }
  return s
}

// ── manifest generator (unchanged) ──────────────────────────────────────────
export function makeManifest({ nodes, depth, nameBytes, seed = 1 }) {
  const rnd = seeded(seed)
  const rootNodeId = randomIdB64url()
  const treeId = randomIdB64url()
  const now = 1_790_000_000_000
  const map = new Map()
  const folders = [rootNodeId]
  map.set(rootNodeId, {
    nodeId: rootNodeId, kind: 'folder', parentNodeId: null, name: '',
    createdAtClient: now, modifiedAtClient: now, lifecycle: { state: 'active' },
  })
  const depthOf = new Map([[rootNodeId, 0]])
  let created = 1
  let parent = rootNodeId
  for (let d = 1; d <= depth && created < nodes; d++) {
    const id = randomIdB64url()
    map.set(id, {
      nodeId: id, kind: 'folder', parentNodeId: parent, name: makeName(nameBytes, rnd),
      createdAtClient: now, modifiedAtClient: now, lifecycle: { state: 'active' },
    })
    depthOf.set(id, d); folders.push(id); parent = id; created++
  }
  while (created < nodes) {
    let p
    for (let tries = 0; tries < 50; tries++) {
      p = folders[Math.floor(rnd() * folders.length)]
      if (depthOf.get(p) < depth) break
    }
    if (depthOf.get(p) >= depth) p = rootNodeId
    const id = randomIdB64url()
    const isFolder = rnd() < 0.1
    const base = {
      nodeId: id, kind: isFolder ? 'folder' : 'file', parentNodeId: p, name: makeName(nameBytes, rnd),
      createdAtClient: now, modifiedAtClient: now,
      lifecycle: rnd() < 0.05 ? { state: 'trashed', trashedAtClient: now, trashedFromParentNodeId: p } : { state: 'active' },
    }
    if (!isFolder) {
      base.blobRef = { formatVersion: rnd() < 0.5 ? 1 : 2, id: rnd() < 0.5 ? String(Math.floor(rnd() * 1e9)) : randomIdB64url(12) }
      base.mediaType = 'application/octet-stream'
      base.plainSize = Math.floor(rnd() * 1e9)
    } else { folders.push(id) }
    depthOf.set(id, depthOf.get(p) + 1)
    map.set(id, base)
    created++
  }
  return {
    schemaVersion: 1, treeId, generation: 7, revisionId: randomIdB64url(), baseRevisionId: randomIdB64url(),
    rootNodeId, createdAtClient: now, nodes: map,
    recentOperationIds: Array.from({ length: 32 }, () => randomIdB64url()),
  }
}

// ── one measurement cell through the product modules ────────────────────────
// Product limits are enforced: a cell outside VAULT_TREE_CLIENT_LIMITS is reported as
// rejected with the product error code (that rejection is itself evidence), not measured.
let cachedTrk = null
async function trk() {
  if (cachedTrk) return cachedTrk
  const kek = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(32).fill(3), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const ctx = { ownerScopeId: randomIdB64url(), treeId: randomIdB64url(), protocolVersion: 1, keyEnvelopeVersion: 1 }
  cachedTrk = (await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), ctx), ctx)).trk
  return cachedTrk
}

export async function measureCell({ nodes, depth, nameBytes, seed = 1, memory = null, limits = VAULT_TREE_CLIENT_LIMITS }) {
  const now = () => (globalThis.performance?.now?.() ?? Date.now())
  const heap = async () => (memory ? await memory() : null)
  const m0 = await heap()
  let t = now()
  const manifest = makeManifest({ nodes, depth, nameBytes, seed })
  const genMs = now() - t
  const ctx = { treeId: manifest.treeId, revisionId: manifest.revisionId, baseRevisionId: manifest.baseRevisionId, generation: manifest.generation, manifestSchemaVersion: manifest.schemaVersion }
  const base = { implementation: BENCH_IMPLEMENTATION, nodes, depth, nameBytes, genMs: +genMs.toFixed(1) }
  // validate first so an out-of-limit shape reports the product's rejection code
  t = now()
  try { validateManifest(manifest, limits) } catch (e) {
    return { ...base, rejected: e.code, encodedBytes: '', paddedBytes: '', ciphertextBytes: '', validateMs: +(now() - t).toFixed(1), encodeMs: '', padMs: '', encryptMs: '', decryptValidateMs: '', heapDeltaMB: '' }
  }
  const validateOnlyMs = now() - t
  t = now(); const encoded = canonicalEncode(manifest, limits); const encodeMs = now() - t
  t = now(); const { paddedLength } = padToBucket(encoded, PADDING_BUCKETS); const padMs = now() - t
  const key = await trk()
  t = now(); const env = await encryptManifestRevision(key, manifest, ctx, limits); const encryptMs = now() - t
  t = now(); const back = await decryptManifestRevision(key, env, ctx, limits); const decryptValidateMs = now() - t
  if (back.nodes.size !== manifest.nodes.size) throw new Error('round trip mismatch')
  const m1 = await heap()
  return {
    ...base, rejected: '',
    encodedBytes: encoded.length, paddedBytes: paddedLength, ciphertextBytes: env.ciphertext.length,
    encodeMs: +encodeMs.toFixed(1), padMs: +padMs.toFixed(1), encryptMs: +encryptMs.toFixed(1),
    validateMs: +validateOnlyMs.toFixed(1),
    decryptValidateMs: +decryptValidateMs.toFixed(1), // unwrap DEK + GCM + strip padding + strict parse + validateManifest
    heapDeltaMB: m0 == null || m1 == null ? 'NOT_MEASURED' : +((m1 - m0) / 1_048_576).toFixed(1),
  }
}

export { treeLimitsFrom, VAULT_TREE_CLIENT_LIMITS, PADDING_BUCKETS, stripPadding }

export function toMarkdownTable(rows) {
  if (!rows.length) return '(no rows)'
  const cols = Object.keys(rows[0])
  const lines = ['| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|']
  for (const r of rows) lines.push('| ' + cols.map((c) => String(r[c])).join(' | ') + ' |')
  return lines.join('\n')
}
