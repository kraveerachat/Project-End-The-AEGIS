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
 *           diagnostics?: { count?: (name: string) => void } | null, readEnabled?: boolean }} o
 */
export function createPreviewIndexReader({ kek, api = treeApi, fetchBytes = apiFetchBytes, unlockedState = null, limits = PREVIEW_INDEX_LIMITS, diagnostics = null, readEnabled = true }) {
  let status = readEnabled ? 'IDLE' : 'DISABLED'
  let head = null
  let root = null
  let mainIndex = null
  let lastGeneration = 0
  let loadEpoch = 0
  let cleared = false
  const shards = new Map()      // `${prefix}:${contentId}` → Promise<shard|null>  (insertion order = LRU order)
  const envelopes = new Map()   // blob id → Promise<envelope|null>
  const ciphertext = new Map()  // authenticated index chunk path → { bytes, ivB64 }; page-memory LRU
  let ciphertextBytes = 0
  const controllers = new Set()
  const count = (name) => { try { diagnostics?.count?.(name) } catch { /* diagnostics never break reads */ } }
  const purged = () => cleared || Boolean(unlockedState?.isPurged?.())

  function fetchIndexBytes(path, options) {
    const hit = ciphertext.get(path)
    if (hit && !purged()) {
      ciphertext.delete(path); ciphertext.set(path, hit)
      return Promise.resolve({ ok: true, bytes: hit.bytes, headers: { get: (name) => name.toLowerCase() === 'x-vault-chunk-iv' ? hit.ivB64 : null } })
    }
    return fetchBytes(path, options)
  }

  function cacheAuthenticatedCiphertext(id, bytes, ivB64) {
    const budget = limits.ciphertextLruBytes
    if (purged() || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(budget) || bytes.length > budget) return
    const path = `/api/vault/blobs/${encodeURIComponent(id)}/chunks/0`
    const copy = new Uint8Array(bytes)
    const old = ciphertext.get(path)
    if (old) { ciphertextBytes -= old.bytes.length; old.bytes.fill(0); ciphertext.delete(path) }
    ciphertext.set(path, { bytes: copy, ivB64 })
    ciphertextBytes += copy.length
    while (ciphertextBytes > budget) {
      const oldest = ciphertext.keys().next().value
      const value = ciphertext.get(oldest)
      ciphertextBytes -= value.bytes.length
      value.bytes.fill(0)
      ciphertext.delete(oldest)
    }
  }

  function newController() {
    const c = new AbortController()
    controllers.add(c)
    try { unlockedState?.registerAbort?.(c) } catch { c.abort() }
    return c
  }

  function clear() {
    loadEpoch++
    cleared = true
    status = 'CLEARED'
    for (const c of controllers) { try { c.abort() } catch { /* already done */ } }
    controllers.clear()
    shards.clear(); envelopes.clear()
    for (const value of ciphertext.values()) value.bytes.fill(0)
    ciphertext.clear(); ciphertextBytes = 0
    head = null; root = null; mainIndex = null
  }
  try { unlockedState?.registerDisposer?.(clear) } catch { cleared = true; status = 'CLEARED' }

  /** envelopes for these ids, fetched in bounded batches; each id requested at most once per reader */
  function envelopeFor(id, signal) {
    if (!readEnabled || purged()) return Promise.resolve(null)
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
    if (!readEnabled || purged()) return
    const missing = [...new Set(ids.map(String))].filter((id) => !envelopes.has(id)).slice(0, MAX_ENVELOPE_CACHE - envelopes.size)
    for (let i = 0; i < missing.length; i += ENVELOPE_BATCH) {
      if (purged()) return
      const batch = missing.slice(i, i + ENVELOPE_BATCH)
      const ctrl = newController()
      let list
      try { list = await api.getPreviewIndexEnvelopes(batch, { signal: ctrl.signal }) } catch { list = [] } finally { controllers.delete(ctrl) }
      if (purged()) return
      for (const id of batch) envelopes.set(id, Promise.resolve(list.find((e) => String(e.id) === id) ?? null))
    }
  }

  async function load(mainHead) {
    if (!readEnabled) return { status: 'DISABLED' }
    if (purged()) return { status: 'FAILED', reason: 'PURGED' }
    const epoch = ++loadEpoch
    const ctrl = newController()
    const current = () => epoch === loadEpoch && !purged()
    const fail = (reason) => {
      if (!current()) return { status: 'FAILED', reason: 'SUPERSEDED' }
      status = 'FAILED'; root = null; count(`index.${reason}`); return { status: 'FAILED', reason }
    }
    try {
      let h
      try { h = await api.getPreviewIndexHead({ signal: ctrl.signal }) } catch { return fail('HEAD_ERROR') }
      if (!current()) return { status: 'FAILED', reason: purged() ? 'PURGED' : 'SUPERSEDED' }
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
        maxPaddedBytes: limits.rootPaddingBuckets.at(-1), fetchBytes: fetchIndexBytes, signal: ctrl.signal,
        onAuthenticatedCiphertext: cacheAuthenticatedCiphertext,
      })
      if (!current()) { if (opened.ok) opened.plaintext.fill(0); return { status: 'FAILED', reason: purged() ? 'PURGED' : 'SUPERSEDED' } }
      if (!opened.ok) return fail(`ROOT_${opened.reason}`)
      let decoded
      try { decoded = decodeRoot(opened.plaintext, { treeId: h.treeId, indexGeneration: h.indexGeneration }) } catch (e) { return fail(`ROOT_${e?.code ?? 'DECODE'}`) } finally { opened.plaintext.fill(0) }
      if (!current() || h.indexGeneration < lastGeneration) return { status: 'FAILED', reason: 'SUPERSEDED' }
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
          maxPaddedBytes: limits.shardPaddingBuckets.at(-1), fetchBytes: fetchIndexBytes, signal: ctrl.signal,
          onAuthenticatedCiphertext: cacheAuthenticatedCiphertext,
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
    if (idx !== mainIndex) return null
    try {
      const current = idx?.nodes?.get?.(node.nodeId)
      if (!current || current.kind !== 'file' || current.blobRef?.formatVersion !== node.blobRef.formatVersion || String(current.blobRef?.id) !== String(node.blobRef.id) || effectiveState(idx, node.nodeId) !== 'active') return null
    } catch { return null }
    const epoch = loadEpoch
    let bits
    try { bits = await routingBits(node.nodeId) } catch { return null }
    if (purged() || status !== 'READY' || !root || epoch !== loadEpoch || signal?.aborted) return null
    const d = resolveShardDescriptor(root, bits)
    if (!d) return null
    const shard = await loadShard(d)
    if (!shard || signal?.aborted || purged() || epoch !== loadEpoch || status !== 'READY') return null
    const entry = shard.entries.get(node.nodeId)?.find((e) => e.kind === kind) ?? null
    if (!entry) return null
    if (!previewProfileBounds(entry.profile, entry.kind) || !DERIVATIVE_MIMES.includes(entry.mime)) { count('entry.UNSUPPORTED'); return null }
    const current = mainIndex?.nodes?.get?.(node.nodeId)
    if (!current || current.kind !== 'file' || current.blobRef?.formatVersion !== node.blobRef.formatVersion || String(current.blobRef?.id) !== String(node.blobRef.id) || effectiveState(mainIndex, node.nodeId) !== 'active' || entry.sourceBlobRef.formatVersion !== current.blobRef.formatVersion || String(entry.sourceBlobRef.id) !== String(current.blobRef.id)) { count('entry.STALE_SOURCE'); return null }
    return entry
  }

  return {
    load, lookup, clear, prefetchEnvelopes,
    /** envelope of a derivative blob (cached, batched) — for vaultDerivativeRead */
    envelopeOf: (blobRef, { signal } = {}) => (purged() ? Promise.resolve(null) : envelopeFor(String(blobRef.id), signal)),
    snapshot: () => ({ head, root }),
    stats: () => ({ status, shards: shards.size, envelopes: envelopes.size, ciphertextBytes, inflight: controllers.size }),
    /** tests only: the decoded shard for a prefix of the loaded root (null when missing or invalid) */
    shardForPrefixForTests: (prefix) => { const d = root?.shards.find((s) => s.prefix === prefix); return d ? loadShard(d) : Promise.resolve(null) },
  }
}
