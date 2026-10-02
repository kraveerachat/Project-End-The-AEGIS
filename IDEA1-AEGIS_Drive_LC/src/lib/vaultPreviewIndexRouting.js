// src/lib/vaultPreviewIndexRouting.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · shard routing
//
// Entries are routed to shards by a domain-separated SHA-256 of the opaque 22-character nodeId — never by name,
// parent or MIME. The hash is routing only: it is not a secret and not an authorization primitive. Node ids exist
// only inside encrypted client state, and shard prefixes only inside the encrypted root and shard plaintexts.
// ⚠️ Pure functions (WebCrypto digest only) — no I/O, no storage, no DOM.

export const ROUTING_DOMAIN = 'AEGIS-VPI-ROUTE-v1:'
const NODE_ID_RE = /^[A-Za-z0-9_-]{22}$/
const PREFIX_RE = /^[01]+$/
const te = new TextEncoder()

/** codec/routing failure for the preview index — every failure disables acceleration only, never original access */
export class IndexCodecError extends Error {
  /** @param {'UNKNOWN_VERSION'|'UNKNOWN_KEY'|'BAD_FIELD'|'BAD_PREFIX_SET'|'TREE_MISMATCH'|'GENERATION_MISMATCH'|'PREFIX_MISMATCH'|'LIMIT'|'DUPLICATE'|'BAD_SYNTAX'} code */
  constructor(code, message = code) { super(message); this.name = 'IndexCodecError'; this.code = code }
}

/** SHA-256(UTF-8(ROUTING_DOMAIN + nodeId)) — 32 bytes, read MSB-first by prefixOf */
export async function routingBits(nodeId) {
  if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) throw new IndexCodecError('BAD_FIELD', 'nodeId')
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(ROUTING_DOMAIN + nodeId)))
}

/** first `length` bits of `bits`, MSB-first, as a '0'/'1' string */
export function prefixOf(bits, length) {
  if (!(bits instanceof Uint8Array) || !Number.isSafeInteger(length) || length < 1 || length > bits.length * 8) throw new IndexCodecError('BAD_FIELD', 'prefix length')
  let out = ''
  for (let i = 0; i < length; i++) out += (bits[i >> 3] >> (7 - (i & 7))) & 1
  return out
}

/** a valid shard set: binary strings, lengths in [minBits, maxBits], strictly sorted, no prefix of another (sparse allowed) */
export function assertPrefixFree(prefixes, { minBits, maxBits }) {
  if (!Array.isArray(prefixes)) throw new IndexCodecError('BAD_PREFIX_SET')
  for (let i = 0; i < prefixes.length; i++) {
    const p = prefixes[i]
    if (typeof p !== 'string' || !PREFIX_RE.test(p) || p.length < minBits || p.length > maxBits) throw new IndexCodecError('BAD_PREFIX_SET', 'prefix')
    if (i > 0 && !(prefixes[i - 1] < p)) throw new IndexCodecError('BAD_PREFIX_SET', 'order')
  }
  // sorted order puts a prefix immediately before the strings it prefixes, so adjacent checks are sufficient
  for (let i = 1; i < prefixes.length; i++) if (prefixes[i].startsWith(prefixes[i - 1])) throw new IndexCodecError('BAD_PREFIX_SET', 'nested')
}

/** the root shard descriptor whose prefix covers these routing bits, or null when that region has no shard */
export function resolveShardDescriptor(root, bits) {
  for (const d of root?.shards ?? []) {
    if (prefixOf(bits, d.prefix.length) === d.prefix) return d
  }
  return null
}
