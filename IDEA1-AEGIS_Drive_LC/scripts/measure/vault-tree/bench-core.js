// scripts/measure/vault-tree/bench-core.js — PR #157 Phase 0 · disposable measurement core
//
// ⚠️ DISPOSABLE PROTOTYPE, NOT PRODUCT CODE. Nothing here is imported by src/ or
//    server/. It exists only so that Task 0.1 can measure manifest sizes and
//    crypto/validation costs before the Phase 1 product modules exist. Task 1.6
//    (gate G1) retires the prototype encoder below and re-runs the same shapes
//    through the real src/lib/vaultTree*.js modules.
//
// Runs unchanged in Node 24 (globalThis.crypto) and in a browser (ESM).

const subtle = globalThis.crypto.subtle
const te = new TextEncoder()
const td = new TextDecoder()

export const PROTOTYPE_VERSION = 'phase0-prototype-1'

// ── shapes ──────────────────────────────────────────────────────────────────
export const NODE_COUNTS = [100, 1_000, 5_000, 10_000, 25_000, 50_000]
export const DEPTHS = [1, 8, 32, 64]
export const NAME_BYTES = [16, 64, 255, 1_024]

// Candidate padding buckets under measurement (bytes). The selected table is a
// Task 0.3 decision; these are only what the bench pads against.
export const CANDIDATE_BUCKETS = [
  4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288,
  1_048_576, 2_097_152, 4_194_304, 8_388_608, 16_777_216, 33_554_432, 67_108_864, 134_217_728,
]

// ── ids ─────────────────────────────────────────────────────────────────────
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function randomIdB64url(bytes = 16) {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(bytes))
  // 16 bytes → 22 chars base64url without padding
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

// ── manifest generator ──────────────────────────────────────────────────────
// Builds a tree with `nodes` nodes whose maximum depth is `depth` (root = depth 0).
// Folders are created first along a spine to reach the depth, then remaining
// nodes are attached under random existing folders. ~10% folders, ~90% files.
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
  // spine to reach depth
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
    // choose a parent folder whose depth < depth
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

// ── prototype canonical encoder (retired at G1) ─────────────────────────────
function canonValue(v) {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('BAD_NUMBER')
    return String(v)
  }
  if (typeof v === 'string') return canonString(v)
  if (v instanceof Map) {
    const keys = [...v.keys()].sort()
    return '[' + keys.map((k) => '[' + canonString(k) + ',' + canonValue(v.get(k)) + ']').join(',') + ']'
  }
  if (Array.isArray(v)) return '[' + v.map(canonValue).join(',') + ']'
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort()
    return '{' + keys.map((k) => canonString(k) + ':' + canonValue(v[k])).join(',') + '}'
  }
  throw new Error('BAD_TYPE')
}
function canonString(s) {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0')
    else out += s[i]
  }
  return out + '"'
}
export function prototypeEncode(manifest) {
  return te.encode(canonValue(manifest))
}
export function prototypeDecode(bytes) {
  // Prototype uses JSON.parse as the parser; the product module (Task 1.3) uses a strict hand parser.
  const obj = JSON.parse(td.decode(bytes))
  obj.nodes = new Map(obj.nodes)
  return obj
}

// ── padding: plaintext ‖ zero-fill ‖ u32be(plaintextLength) ──────────────────
export function padToBucket(bytes, buckets = CANDIDATE_BUCKETS) {
  const need = bytes.length + 4
  const bucket = buckets.find((b) => b >= need)
  if (!bucket) throw new Error('LIMIT_DECODED_BYTES')
  const out = new Uint8Array(bucket)
  out.set(bytes, 0)
  new DataView(out.buffer).setUint32(bucket - 4, bytes.length, false)
  return { padded: out, paddedLength: bucket }
}
export function stripPadding(padded) {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(padded.length - 4, false)
  if (len > padded.length - 4) throw new Error('BAD_PADDING')
  for (let i = len; i < padded.length - 4; i++) if (padded[i] !== 0) throw new Error('BAD_PADDING')
  return padded.subarray(0, len)
}

// ── prototype AAD (same layout as the plan's spec: tag/len/value) ────────────
function u64be(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), false); return b }
function field(tag, bytes) {
  const out = new Uint8Array(1 + 4 + bytes.length)
  out[0] = tag
  new DataView(out.buffer).setUint32(1, bytes.length, false)
  out.set(bytes, 5)
  return out
}
function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
export function manifestCiphertextAad({ treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion, paddedPlaintextLength }) {
  const label = te.encode('AEGIS-Vault-Tree-Manifest-Ciphertext-v1')
  const head = new Uint8Array(3); head[0] = 1; new DataView(head.buffer).setUint16(1, label.length, false)
  return concat([
    head, label,
    field(1, te.encode(treeId)), field(2, te.encode(revisionId)),
    field(3, baseRevisionId ? te.encode(baseRevisionId) : new Uint8Array(0)),
    field(4, u64be(generation)), field(5, u64be(manifestSchemaVersion)), field(6, u64be(paddedPlaintextLength)),
  ])
}

// ── crypto ──────────────────────────────────────────────────────────────────
export async function randomAesKey() {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
export async function encryptPadded(dek, padded, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, padded))
  return { iv, ct }
}
export async function decryptPadded(dek, iv, ct, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, ct))
}

// ── prototype graph validation (mirrors the plan's MF-* rules; not the product) ─
export function prototypeValidate(m, { maxDepth = 256 } = {}) {
  const nodes = m.nodes
  if (!nodes.has(m.rootNodeId)) throw new Error('NO_ROOT')
  const children = new Map()
  let roots = 0
  for (const [id, n] of nodes) {
    if (n.nodeId !== id) throw new Error('DUP_NODE')
    if (n.parentNodeId === null) { roots++; continue }
    const p = nodes.get(n.parentNodeId)
    if (!p) throw new Error('PARENT_MISSING')
    if (p.kind !== 'folder') throw new Error('PARENT_NOT_FOLDER')
    if (!children.has(n.parentNodeId)) children.set(n.parentNodeId, [])
    children.get(n.parentNodeId).push(id)
  }
  if (roots !== 1) throw new Error('MULTI_ROOT')
  // reachability + depth (iterative)
  const depth = new Map([[m.rootNodeId, 0]])
  const stack = [m.rootNodeId]
  let seen = 0
  while (stack.length) {
    const id = stack.pop(); seen++
    const d = depth.get(id)
    if (d > maxDepth) throw new Error('LIMIT_DEPTH')
    for (const c of children.get(id) ?? []) { depth.set(c, d + 1); stack.push(c) }
  }
  if (seen !== nodes.size) throw new Error('UNREACHABLE')
  // sibling collision on active nodes (NFC + lowercase as the prototype's stand-in for full case folding)
  const keys = new Map()
  for (const [id, n] of nodes) {
    if (n.parentNodeId === null || n.lifecycle.state !== 'active') continue
    const k = n.parentNodeId + '\u0000' + n.name.normalize('NFC').toLowerCase()
    if (keys.has(k)) throw new Error('COLLISION')
    keys.set(k, id)
  }
  return { depth, children }
}

// ── one measurement cell ────────────────────────────────────────────────────
export async function measureCell({ nodes, depth, nameBytes, seed = 1, memory = null }) {
  const now = () => (globalThis.performance?.now?.() ?? Date.now())
  const heap = async () => (memory ? await memory() : null)
  const m0 = await heap()
  let t = now()
  const manifest = makeManifest({ nodes, depth, nameBytes, seed })
  const genMs = now() - t
  t = now(); const encoded = prototypeEncode(manifest); const encodeMs = now() - t
  t = now(); const { padded, paddedLength } = padToBucket(encoded); const padMs = now() - t
  const aad = manifestCiphertextAad({
    treeId: manifest.treeId, revisionId: manifest.revisionId, baseRevisionId: manifest.baseRevisionId,
    generation: manifest.generation, manifestSchemaVersion: 1, paddedPlaintextLength: paddedLength,
  })
  const dek = await randomAesKey()
  t = now(); const { iv, ct } = await encryptPadded(dek, padded, aad); const encryptMs = now() - t
  t = now(); const plain = await decryptPadded(dek, iv, ct, aad); const decryptMs = now() - t
  t = now(); const decoded = prototypeDecode(stripPadding(plain)); const decodeMs = now() - t
  t = now(); prototypeValidate(decoded); const validateMs = now() - t
  const m1 = await heap()
  return {
    prototype: PROTOTYPE_VERSION, nodes, depth, nameBytes,
    encodedBytes: encoded.length, paddedBytes: paddedLength, ciphertextBytes: ct.length,
    genMs: +genMs.toFixed(1), encodeMs: +encodeMs.toFixed(1), padMs: +padMs.toFixed(1),
    encryptMs: +encryptMs.toFixed(1), decryptMs: +decryptMs.toFixed(1), decodeMs: +decodeMs.toFixed(1),
    validateMs: +validateMs.toFixed(1),
    decryptValidateMs: +(decryptMs + decodeMs + validateMs).toFixed(1),
    heapDeltaMB: m0 == null || m1 == null ? 'NOT_MEASURED' : +((m1 - m0) / 1_048_576).toFixed(1),
  }
}

export function toMarkdownTable(rows) {
  if (!rows.length) return '(no rows)'
  const cols = Object.keys(rows[0])
  const lines = ['| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|']
  for (const r of rows) lines.push('| ' + cols.map((c) => String(r[c])).join(' | ') + ' |')
  return lines.join('\n')
}
