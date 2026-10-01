// src/lib/vaultPreviewIndexReader.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · read-only reader
//
// head (server) → encrypted root (bound to treeId + generation) → only the shards covering requested nodes (bound to
// treeId + prefix) → entries bound to the CURRENT main-manifest node (active file, same sourceBlobRef). Any failure
// anywhere returns null for that lookup: the caller keeps the existing original-file tile path. The reader never
// writes, never retries in a loop, and never touches browser storage — every cache is page memory, cleared on purge.
// ⚠️ Replay: within one page session an older index generation than already seen is rejected; across fresh sessions a
//    malicious server can serve an older valid head (accepted, documented D-1 limitation — no durable anti-rollback claim).

import * as treeApi from './vaultTreeApi.js'
import { apiFetchBytes } from './api.js'
import { effectiveState } from './vaultTreeManifest.js'
import { previewProfileBounds } from './vaultPreviewProfiles.js'
import { decodeRoot, decodeShard } from './vaultPreviewIndexCodec.js'
import { openIndexObject } from './vaultPreviewIndexObject.js'
import { routingBits, resolveShardDescriptor } from './vaultPreviewIndexRouting.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, D1_WRITE_KINDS, DERIVATIVE_MIMES, PREVIEW_INDEX_LIMITS } from './vaultPreviewIndexConstants.js'

/** client-side envelope batch; the server enforces its own (provisional) maximum */
const ENVELOPE_BATCH = 32
const MAX_ENVELOPE_CACHE = 1024

/**
 * @param {{ kek: CryptoKey, api?: { getPreviewIndexHead: Function, getPreviewIndexEnvelopes: Function },
 *           fetchBytes?: Function, unlockedState?: object|null, limits?: typeof PREVIEW_INDEX_LIMITS,
 *           diagnostics?: { count?: (name: string) => void } | null }} o
 */
export function createPreviewIndexReader({ kek, api = treeApi, fetchBytes = apiFetchBytes, unlockedState = null, limits = PREVIEW_INDEX_LIMITS, diagnostics = null }) {
  let status = 'IDLE'
  let head = null
  let root = null
  let mainIndex = null
  let lastGeneration = 0
  let cleared = false
  const shards = new Map()      // `${prefix}:${contentId}` → Promise<shard|null>  (insertion order = LRU order)
  const envelopes = new Map()   // blob id → Promise<envelope|null>
  const controllers = new Set()
  const count = (name) => { try { diagnostics?.count?.(name) } catch { /* diagnostics never break reads */ } }
  const purged = () => cleared || Boolean(unlockedState?.isPurged?.())

  function newController() {
    const c = new AbortController()
    controllers.add(c)
    try { unlockedState?.registerAbort?.(c) } catch { c.abort() }
    return c
  }

  function clear() {
    cleared = true
    status = 'CLEARED'
    for (const c of controllers) { try { c.abort() } catch { /* already done */ } }
    controllers.clear()
    shards.clear(); envelopes.clear()
    head = null; root = null; mainIndex = null
  }
  try { unlockedState?.registerDisposer?.(clear) } catch { cleared = true; status = 'CLEARED' }

  /** envelopes for these ids, fetched in bounded batches; each id requested at most once per reader */
  function envelopeFor(id, signal) {
    if (!envelopes.has(id)) {
      const p = (async () => {
        const list = await api.getPreviewIndexEnvelopes([id], { signal })
        return list.find((e) => String(e.id) === String(id)) ?? null
      })().catch(() => null)
      envelopes.set(id, p)
      if (envelopes.size > MAX_ENVELOPE_CACHE) envelopes.delete(envelopes.keys().next().value)
    }
    return envelopes.get(id)
  }

  /** pre-fetch envelopes for many ids in batches (used by the tile path for visible derivatives) */
  async function prefetchEnvelopes(ids) {
    const missing = [...new Set(ids.map(String))].filter((id) => !envelopes.has(id))
    for (let i = 0; i < missing.length; i += ENVELOPE_BATCH) {
      const batch = missing.slice(i, i + ENVELOPE_BATCH)
      const ctrl = newController()
      const p = api.getPreviewIndexEnvelopes(batch, { signal: ctrl.signal }).catch(() => []).finally(() => controllers.delete(ctrl))
      for (const id of batch) envelopes.set(id, p.then((list) => list.find((e) => String(e.id) === id) ?? null))
    }
  }

  async function load(mainHead) {
    if (purged()) return { status: 'FAILED', reason: 'PURGED' }
    const ctrl = newController()
    const fail = (reason) => { status = 'FAILED'; root = null; count(`index.${reason}`); return { status: 'FAILED', reason } }
    try {
      let h
      try { h = await api.getPreviewIndexHead({ signal: ctrl.signal }) } catch { return fail('HEAD_ERROR') }
      if (purged()) return { status: 'FAILED', reason: 'PURGED' }
      mainIndex = mainHead?.index ?? null
      if (h === null) { status = 'ABSENT'; head = null; root = null; shards.clear(); return { status: 'ABSENT' } }
      if (!mainHead || h.treeId !== mainHead.treeId) return fail('TREE_MISMATCH')
      if (h.indexGeneration < lastGeneration) return fail('GENERATION_REGRESSED')
      if (root && head && head.indexGeneration === h.indexGeneration && head.rootBlobRef?.id === h.rootBlobRef?.id && head.rootContentIdB64 === h.rootContentIdB64) {
        status = 'READY'; return { status: 'READY' }
      }
      const env = await envelopeFor(String(h.rootBlobRef?.id), ctrl.signal)
      const opened = await openIndexObject({
        kek, envelope: env, expected: { blobRef: h.rootBlobRef, contentId: h.rootContentIdB64 }, marker: INDEX_ROOT_MARKER,
        maxPaddedBytes: limits.rootPaddingBuckets.at(-1), fetchBytes, signal: ctrl.signal,
      })
      if (purged()) return { status: 'FAILED', reason: 'PURGED' }
      if (!opened.ok) return fail(`ROOT_${opened.reason}`)
      let decoded
      try { decoded = decodeRoot(opened.plaintext, { treeId: h.treeId, indexGeneration: h.indexGeneration }) } catch (e) { return fail(`ROOT_${e?.code ?? 'DECODE'}`) } finally { opened.plaintext.fill(0) }
      head = h; root = decoded; lastGeneration = h.indexGeneration
      shards.clear()
      status = 'READY'
      return { status: 'READY' }
    } finally { controllers.delete(ctrl) }
  }

  function loadShard(d) {
    const key = `${d.prefix}:${d.contentId}`
    if (shards.has(key)) {
      const p = shards.get(key); shards.delete(key); shards.set(key, p) // touch (LRU)
      return p
    }
    const treeId = root.treeId
    const p = (async () => {
      const ctrl = newController()
      try {
        const env = await envelopeFor(d.blobRef.id, ctrl.signal)
        const opened = await openIndexObject({
          kek, envelope: env, expected: { blobRef: d.blobRef, contentId: d.contentId }, marker: INDEX_SHARD_MARKER,
          maxPaddedBytes: limits.shardPaddingBuckets.at(-1), fetchBytes, signal: ctrl.signal,
        })
        if (!opened.ok) { count(`shard.${opened.reason}`); return null }
        try { return await decodeShard(opened.plaintext, { treeId, prefix: d.prefix }) } catch (e) { count(`shard.${e?.code ?? 'DECODE'}`); return null } finally { opened.plaintext.fill(0) }
      } finally { controllers.delete(ctrl) }
    })().catch(() => null)
    shards.set(key, p)
    while (shards.size > limits.maxLiveDecodedShards) shards.delete(shards.keys().next().value)
    return p
  }

  /**
   * the validated, source-bound entry for (node, kind), or null → original path
   * @param {object} node current main-manifest node
   * @param {'thumb'|'poster'} kind
   * @param {{ signal?: AbortSignal, index?: object }} [o] index defaults to the main head given to load()
   */
  async function lookup(node, kind, { signal = null, index = null } = {}) {
    if (purged() || status !== 'READY' || !root) return null
    if (!node || node.kind !== 'file' || !node.blobRef || !D1_WRITE_KINDS.includes(kind)) return null
    const idx = index ?? mainIndex
    try {
      if (!idx?.nodes?.get?.(node.nodeId) || effectiveState(idx, node.nodeId) !== 'active') return null
    } catch { return null }
    let bits
    try { bits = await routingBits(node.nodeId) } catch { return null }
    const d = resolveShardDescriptor(root, bits)
    if (!d) return null
    const shard = await loadShard(d)
    if (!shard || signal?.aborted || purged()) return null
    const entry = shard.entries.get(node.nodeId)?.find((e) => e.kind === kind) ?? null
    if (!entry) return null
    if (!previewProfileBounds(entry.profile, entry.kind) || !DERIVATIVE_MIMES.includes(entry.mime)) { count('entry.UNSUPPORTED'); return null }
    if (entry.sourceBlobRef.formatVersion !== node.blobRef.formatVersion || String(entry.sourceBlobRef.id) !== String(node.blobRef.id)) { count('entry.STALE_SOURCE'); return null }
    return entry
  }

  return {
    load, lookup, clear, prefetchEnvelopes,
    /** envelope of a derivative blob (cached, batched) — for vaultDerivativeRead */
    envelopeOf: (blobRef, { signal } = {}) => (purged() ? Promise.resolve(null) : envelopeFor(String(blobRef.id), signal)),
    snapshot: () => ({ head, root }),
    stats: () => ({ status, shards: shards.size, envelopes: envelopes.size, inflight: controllers.size }),
    /** tests only: the decoded shard for a prefix of the loaded root (null when missing or invalid) */
    shardForPrefixForTests: (prefix) => { const d = root?.shards.find((s) => s.prefix === prefix); return d ? loadShard(d) : Promise.resolve(null) },
  }
}
