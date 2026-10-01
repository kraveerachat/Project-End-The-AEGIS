// src/lib/vaultPreviewIndexCodec.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · root + shard codecs
//
// Plaintext formats of the two encrypted index objects (they are encrypted as ordinary V2 blobs elsewhere):
//   root  = { schemaVersion, treeId, indexGeneration, createdAtClient, shards: [{ prefix, blobRef:{formatVersion:2,id}, contentId }] }
//   shard = { schemaVersion, treeId, prefix, entries: Map<nodeId, PreviewEntry[]> }   (encoded as sorted [nodeId, entries] pairs)
// Canonical JSON (vaultTreeCanonical), closed key sets, strict bindings. Every failure is an IndexCodecError and
// disables preview acceleration only — callers fall back to the original file path.
// ⚠️ Unknown schema versions fail secure BEFORE key checks (a future format is never half-read).
// ⚠️ Shard entries reuse the manifest-v2 entry rule (validatePreviewEntry). An unknown profile is kept structurally
//    but has no known bounds; the reader must ignore it (never render it).
// ⚠️ Pure functions — no I/O, no storage, no DOM.

import { canonicalEncodeValue, canonicalParseStrict, CanonicalError } from './vaultTreeCanonical.js'
import { validatePreviewEntry } from './vaultTreeManifest.js'
import { MAX_PREVIEWS_PER_NODE } from './vaultPreviewProfiles.js'
import { PREVIEW_INDEX_SCHEMA_VERSION, PREVIEW_INDEX_SCHEMA_VERSIONS_READ, PREVIEW_INDEX_LIMITS } from './vaultPreviewIndexConstants.js'
import { IndexCodecError, assertPrefixFree, routingBits, prefixOf } from './vaultPreviewIndexRouting.js'

export { IndexCodecError }

const ID_RE = /^[A-Za-z0-9_-]{22}$/
const BLOB_ID_RE = /^[0-9a-f]{48}$/
const CONTENT_ID_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/
const ROOT_KEYS = new Set(['schemaVersion', 'treeId', 'indexGeneration', 'createdAtClient', 'shards'])
const DESCRIPTOR_KEYS = new Set(['prefix', 'blobRef', 'contentId'])
const BLOBREF_KEYS = new Set(['formatVersion', 'id'])
const SHARD_KEYS = new Set(['schemaVersion', 'treeId', 'prefix', 'entries'])

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map)
const isInt = (v, min) => Number.isSafeInteger(v) && v >= min
const bad = (msg) => { throw new IndexCodecError('BAD_FIELD', msg) }
const closed = (o, keys, where) => {
  if (!isObj(o)) bad(where)
  for (const k of Object.keys(o)) if (!keys.has(k)) throw new IndexCodecError('UNKNOWN_KEY', `${where}.${k}`)
}
const limitsFor = (maxDecodedBytes) => ({ maxJsonDepth: PREVIEW_INDEX_LIMITS.maxJsonDepth, maxDecodedBytes })

function encode(value, maxDecodedBytes) {
  try { return canonicalEncodeValue(value, limitsFor(maxDecodedBytes)) } catch (e) { throw mapCanonical(e) }
}
function parse(bytes, maxDecodedBytes) {
  try { return canonicalParseStrict(bytes, limitsFor(maxDecodedBytes), { topObjectMessage: 'index document must be an object' }) } catch (e) { throw mapCanonical(e) }
}
function mapCanonical(e) {
  if (!(e instanceof CanonicalError)) return e
  if (e.code === 'LIMIT_DECODED_BYTES') return new IndexCodecError('LIMIT', 'decoded bytes')
  if (e.code === 'DUPLICATE_KEY') return new IndexCodecError('DUPLICATE', e.message)
  if (e.code === 'BAD_NUMBER' || e.code === 'BAD_STRING' || e.code === 'BAD_TYPE') return new IndexCodecError('BAD_FIELD', e.message)
  return new IndexCodecError('BAD_SYNTAX', e.message)
}
function checkVersion(v) {
  if (!PREVIEW_INDEX_SCHEMA_VERSIONS_READ.includes(v)) throw new IndexCodecError('UNKNOWN_VERSION', String(v))
}
function checkBlobRef(r, where) {
  closed(r, BLOBREF_KEYS, where)
  if (r.formatVersion !== 2 || typeof r.id !== 'string' || !BLOB_ID_RE.test(r.id)) bad(where)
}

// ── root catalog ─────────────────────────────────────────────────────────────

function validateRoot(r) {
  if (!isObj(r)) bad('root')
  checkVersion(r.schemaVersion)
  closed(r, ROOT_KEYS, 'root')
  if (typeof r.treeId !== 'string' || !ID_RE.test(r.treeId)) bad('root.treeId')
  if (!isInt(r.indexGeneration, 1)) bad('root.indexGeneration')
  if (!isInt(r.createdAtClient, 0)) bad('root.createdAtClient')
  if (!Array.isArray(r.shards)) bad('root.shards')
  if (r.shards.length > PREVIEW_INDEX_LIMITS.maxShards) throw new IndexCodecError('LIMIT', 'root.shards')
  for (const d of r.shards) {
    closed(d, DESCRIPTOR_KEYS, 'root.shards[]')
    checkBlobRef(d.blobRef, 'root.shards[].blobRef')
    if (typeof d.contentId !== 'string' || !CONTENT_ID_RE.test(d.contentId)) bad('root.shards[].contentId')
  }
  assertPrefixFree(r.shards.map((d) => d.prefix), { minBits: PREVIEW_INDEX_LIMITS.initialPrefixBits, maxBits: PREVIEW_INDEX_LIMITS.maxPrefixBits })
}

const copyRoot = (r) => ({
  schemaVersion: r.schemaVersion, treeId: r.treeId, indexGeneration: r.indexGeneration, createdAtClient: r.createdAtClient,
  shards: r.shards.map((d) => ({ prefix: d.prefix, blobRef: { formatVersion: 2, id: d.blobRef.id }, contentId: d.contentId })),
})

/** root → canonical UTF-8 bytes (≤ maxRootDecodedBytes) */
export function encodeRoot(root) {
  if (root?.schemaVersion !== PREVIEW_INDEX_SCHEMA_VERSION) throw new IndexCodecError('UNKNOWN_VERSION', 'writer schema')
  validateRoot(root)
  return encode(copyRoot(root), PREVIEW_INDEX_LIMITS.maxRootDecodedBytes)
}

/** canonical bytes → root; binds the expected treeId and indexGeneration (from the server head) */
export function decodeRoot(bytes, { treeId, indexGeneration }) {
  const r = parse(bytes, PREVIEW_INDEX_LIMITS.maxRootDecodedBytes)
  validateRoot(r)
  if (r.treeId !== treeId) throw new IndexCodecError('TREE_MISMATCH')
  if (r.indexGeneration !== indexGeneration) throw new IndexCodecError('GENERATION_MISMATCH')
  return copyRoot(r)
}

// ── shard ────────────────────────────────────────────────────────────────────

function validateEntryList(list, where) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PREVIEWS_PER_NODE) bad(where)
  const kinds = new Set()
  for (const e of list) {
    try { validatePreviewEntry(e) } catch (err) { bad(`${where}: ${err?.code ?? 'invalid'}`) }
    if (kinds.has(e.kind)) throw new IndexCodecError('DUPLICATE', `${where} kind`)
    kinds.add(e.kind)
  }
}

const copyEntry = (e) => {
  const out = { ...e, blobRef: { formatVersion: e.blobRef.formatVersion, id: e.blobRef.id }, sourceBlobRef: { formatVersion: e.sourceBlobRef.formatVersion, id: e.sourceBlobRef.id } }
  return out
}
const byKind = (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)

async function validateShardHead(s) {
  if (!isObj(s)) bad('shard')
  checkVersion(s.schemaVersion)
  closed(s, SHARD_KEYS, 'shard')
  if (typeof s.treeId !== 'string' || !ID_RE.test(s.treeId)) bad('shard.treeId')
  if (typeof s.prefix !== 'string' || !/^[01]+$/.test(s.prefix)
    || s.prefix.length < PREVIEW_INDEX_LIMITS.initialPrefixBits || s.prefix.length > PREVIEW_INDEX_LIMITS.maxPrefixBits) bad('shard.prefix')
}

async function checkRoutesUnder(nodeId, prefix) {
  if (typeof nodeId !== 'string' || !ID_RE.test(nodeId)) bad('shard nodeId')
  if (prefixOf(await routingBits(nodeId), prefix.length) !== prefix) throw new IndexCodecError('PREFIX_MISMATCH', 'nodeId outside shard prefix')
}

/** shard (entries: Map) → canonical UTF-8 bytes (≤ maxShardDecodedBytes); every nodeId must route under the prefix */
export async function encodeShard(shard) {
  if (shard?.schemaVersion !== PREVIEW_INDEX_SCHEMA_VERSION) throw new IndexCodecError('UNKNOWN_VERSION', 'writer schema')
  if (!(shard.entries instanceof Map)) bad('shard.entries')
  await validateShardHead({ ...shard, entries: [] })
  const entries = new Map()
  for (const [nodeId, list] of shard.entries) {
    await checkRoutesUnder(nodeId, shard.prefix)
    validateEntryList(list, 'shard.entries[]')
    entries.set(nodeId, list.map(copyEntry).sort(byKind))
  }
  return encode({ schemaVersion: shard.schemaVersion, treeId: shard.treeId, prefix: shard.prefix, entries }, PREVIEW_INDEX_LIMITS.maxShardDecodedBytes)
}

/** canonical bytes → shard (entries: Map); binds the expected treeId and prefix (from the root descriptor) */
export async function decodeShard(bytes, { treeId, prefix }) {
  const s = parse(bytes, PREVIEW_INDEX_LIMITS.maxShardDecodedBytes)
  await validateShardHead({ ...s, entries: undefined })
  if (!Array.isArray(s.entries)) bad('shard.entries')
  if (s.treeId !== treeId) throw new IndexCodecError('TREE_MISMATCH')
  if (s.prefix !== prefix) throw new IndexCodecError('PREFIX_MISMATCH')
  const entries = new Map()
  let prev = null
  for (const pair of s.entries) {
    if (!Array.isArray(pair) || pair.length !== 2) bad('shard.entries pair')
    const [nodeId, list] = pair
    if (entries.has(nodeId)) throw new IndexCodecError('DUPLICATE', 'nodeId')
    if (prev !== null && !(prev < nodeId)) bad('shard.entries order')
    prev = nodeId
    await checkRoutesUnder(nodeId, s.prefix)
    validateEntryList(list, 'shard.entries[]')
    entries.set(nodeId, list.map(copyEntry))
  }
  return { schemaVersion: s.schemaVersion, treeId: s.treeId, prefix: s.prefix, entries }
}
