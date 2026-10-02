// src/lib/vaultPreviewIndexMerge.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · pure merge / rebase / split / prune
//
// The writer (PR-D) will use these to turn "new derivative entries" into a new root generation without
// last-writer-wins. This file only decides; it performs NO I/O (no fetch, no upload, no CAS), no storage, no DOM.
//
// Rules (plan Task C.6):
//   - the current DECRYPTED main-manifest node is the only authority on validity: an entry is valid iff its node
//     exists, is a file, and entry.sourceBlobRef equals the node's current blobRef;
//   - a valid existing entry beats an incoming one (EXISTING_VALID — no churn); a stale existing entry is replaced;
//   - incoming entries for a missing node (NODE_MISSING), a stale source (STALE_SOURCE), or a non-D-1 kind/profile
//     (BAD_KIND) are dropped, never applied; a structurally invalid entry is dropped as BAD_ENTRY;
//   - prune removes entries whose node is absent from the main manifest or whose source no longer matches;
//     trashed/purge-pending nodes still exist in the manifest and are KEPT (restore keeps its preview);
//   - timestamps (createdAtClient) never decide a winner;
//   - split happens at maxShardDecodedBytes into prefix+'0' / prefix+'1'; at maxPrefixBits the answer is
//     { overflow: true } — the caller skips persistence (fail-soft), it never truncates entries;
//   - a root with more than maxShards descriptors is { overflow: true } (fail-soft as well).
// ⚠️ Pruning/dropping here only shapes the NEXT encrypted index object. It never deletes a blob, and its outputs are
//    never deletion authority (SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO).

import { validatePreviewEntry } from './vaultTreeManifest.js'
import { D1_WRITE_KINDS, D1_WRITE_PROFILE, PREVIEW_INDEX_LIMITS, PREVIEW_INDEX_SCHEMA_VERSION } from './vaultPreviewIndexConstants.js'
import { routingBits, prefixOf, assertPrefixFree, IndexCodecError } from './vaultPreviewIndexRouting.js'
import { encodeShard } from './vaultPreviewIndexCodec.js'

export const DROP_REASON = Object.freeze({
  NODE_MISSING: 'NODE_MISSING', STALE_SOURCE: 'STALE_SOURCE', EXISTING_VALID: 'EXISTING_VALID', BAD_KIND: 'BAD_KIND', BAD_ENTRY: 'BAD_ENTRY',
})

const sameRef = (a, b) => !!a && !!b && a.formatVersion === b.formatVersion && a.id === b.id
const isLiveFile = (node) => !!node && node.kind === 'file' && !!node.blobRef
const entryValidFor = (entry, node) => isLiveFile(node) && sameRef(entry.sourceBlobRef, node.blobRef)
const copyList = (list) => list.map((e) => ({ ...e }))
const byKind = (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)

/**
 * Apply incoming entries to one shard against the current main manifest. Pure: the input shard is not modified.
 * @param {{ shard: { schemaVersion, treeId, prefix, entries: Map<string, object[]> },
 *           upserts: Array<{ nodeId: string, entry: object }>,
 *           currentNodeOf: (nodeId: string) => object | null }} o
 * @returns {{ shard, applied: Array<{nodeId, entry}>, dropped: Array<{ upsert, reason }>, pruned: number }}
 */
export function applyUpserts({ shard, upserts, currentNodeOf }) {
  const entries = new Map()
  let pruned = 0
  // 1. prune against the current manifest (absent node or mismatched source); trashed nodes still exist → kept
  for (const [nodeId, list] of shard.entries) {
    const node = currentNodeOf(nodeId)
    const keep = list.filter((e) => entryValidFor(e, node))
    pruned += list.length - keep.length
    if (keep.length) entries.set(nodeId, copyList(keep))
  }
  // 2. upserts, in caller order; a timestamp never matters
  const applied = [], dropped = []
  for (const upsert of upserts) {
    const { nodeId, entry } = upsert
    if (!entry || !D1_WRITE_KINDS.includes(entry.kind) || entry.profile !== D1_WRITE_PROFILE) { dropped.push({ upsert, reason: DROP_REASON.BAD_KIND }); continue }
    try { validatePreviewEntry(entry) } catch { dropped.push({ upsert, reason: DROP_REASON.BAD_ENTRY }); continue }
    const node = currentNodeOf(nodeId)
    if (!isLiveFile(node)) { dropped.push({ upsert, reason: DROP_REASON.NODE_MISSING }); continue }
    if (!sameRef(entry.sourceBlobRef, node.blobRef)) { dropped.push({ upsert, reason: DROP_REASON.STALE_SOURCE }); continue }
    const list = entries.get(nodeId) ?? []
    if (list.some((e) => e.kind === entry.kind)) { dropped.push({ upsert, reason: DROP_REASON.EXISTING_VALID }); continue } // existing ones are valid after step 1
    entries.set(nodeId, [...list, { ...entry }].sort(byKind))
    applied.push(upsert)
  }
  const sorted = new Map([...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return { shard: { schemaVersion: shard.schemaVersion, treeId: shard.treeId, prefix: shard.prefix, entries: sorted }, applied, dropped, pruned }
}

async function encodedSize(shard, encode) {
  try { return (await encode(shard)).length } catch (e) {
    if (e instanceof IndexCodecError && e.code === 'LIMIT') return Infinity
    throw e
  }
}

/**
 * Split a shard that encodes larger than maxShardDecodedBytes by the next routing bit (prefix+'0' / prefix+'1').
 * Empty children are omitted (sparse prefix sets are valid). Recurses until maxPrefixBits.
 * @returns {Promise<{ shards: object[] } | { overflow: true }>}
 */
export async function planSplit(shard, { maxShardDecodedBytes = PREVIEW_INDEX_LIMITS.maxShardDecodedBytes, maxPrefixBits = PREVIEW_INDEX_LIMITS.maxPrefixBits, encode = encodeShard } = {}) {
  if ((await encodedSize(shard, encode)) <= maxShardDecodedBytes) return { shards: [shard] }
  if (shard.prefix.length >= maxPrefixBits) return { overflow: true }
  const children = { 0: new Map(), 1: new Map() }
  for (const [nodeId, list] of shard.entries) {
    const bit = prefixOf(await routingBits(nodeId), shard.prefix.length + 1).slice(-1)
    children[bit].set(nodeId, copyList(list))
  }
  const out = []
  for (const bit of ['0', '1']) {
    if (!children[bit].size) continue
    const r = await planSplit({ schemaVersion: shard.schemaVersion, treeId: shard.treeId, prefix: shard.prefix + bit, entries: children[bit] }, { maxShardDecodedBytes, maxPrefixBits, encode })
    if (r.overflow) return { overflow: true }
    out.push(...r.shards)
  }
  return { shards: out }
}

/**
 * Rebase this writer's shard changes onto the LATEST root (after a lost CAS, or before the first one).
 * Each change says which descriptor it was based on and what replaces it:
 *   { basePrefix, baseBlobId: string|null (null = region had no shard), replacement: [{ prefix, blobRef, contentId }] }
 * Outcomes:
 *   - { root }      every base descriptor is unchanged in latestRoot → our replacements are swapped in; other writers'
 *                   descriptors (disjoint shards) are kept as they are;
 *   - { reapply }   another writer changed or split a shard we changed (or created one in our empty region): the caller
 *                   re-reads those latest shards and re-applies its upserts with applyUpserts — never last-writer-wins;
 *   - { overflow }  more than maxShards descriptors → fail-soft (skip persistence).
 * @returns {{ root: object } | { reapply: string[] } | { overflow: true }}
 */
export function rebaseRoot({ latestRoot, changes, treeId, nextGeneration, createdAtClient, maxShards = PREVIEW_INDEX_LIMITS.maxShards }) {
  const latest = latestRoot?.shards ?? []
  const reapply = new Set()
  const replacedPrefixes = new Set()
  for (const ch of changes) {
    const covering = latest.filter((d) => d.prefix.startsWith(ch.basePrefix) || ch.basePrefix.startsWith(d.prefix))
    const exact = covering.find((d) => d.prefix === ch.basePrefix)
    const unchanged = ch.baseBlobId === null ? covering.length === 0 : (covering.length === 1 && exact && exact.blobRef.id === ch.baseBlobId)
    if (!unchanged) { for (const d of covering) reapply.add(d.prefix); if (!covering.length) reapply.add(ch.basePrefix); continue }
    if (exact) replacedPrefixes.add(exact.prefix)
  }
  if (reapply.size) return { reapply: [...reapply].sort() }
  const shards = latest.filter((d) => !replacedPrefixes.has(d.prefix)).map((d) => ({ prefix: d.prefix, blobRef: { formatVersion: 2, id: d.blobRef.id }, contentId: d.contentId }))
  for (const ch of changes) for (const d of ch.replacement) shards.push({ prefix: d.prefix, blobRef: { formatVersion: 2, id: d.blobRef.id }, contentId: d.contentId })
  shards.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0))
  if (shards.length > maxShards) return { overflow: true }
  assertPrefixFree(shards.map((d) => d.prefix), { minBits: PREVIEW_INDEX_LIMITS.initialPrefixBits, maxBits: PREVIEW_INDEX_LIMITS.maxPrefixBits })
  return { root: { schemaVersion: PREVIEW_INDEX_SCHEMA_VERSION, treeId, indexGeneration: nextGeneration, createdAtClient, shards } }
}
