// src/lib/vaultPreviewIndexWriter.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · writer (PR-D)
//
// Capability VAULT_PREVIEW_INDEX_WRITE: env VAULT_PREVIEW_INDEX_WRITE_ENABLED on the server (default false), served as
// /api/vault/tree/state flags.previewIndexWriteEnabled and enforced again by every mutating server route. The client
// derives `writeAllowed` from that served flag ONLY — never from storage, the URL, a role or a build constant — and a
// change needs a fresh /state (the screen rebuilds the writer). With the capability off the writer is inert: offer()
// answers 'DISABLED' and NO request of any kind is made.
//
// One batch (≤ maxEntriesPerCas jobs, one batch at a time):
//   1. drop jobs whose node is missing/stale in the CURRENT decrypted main manifest, or that already have a valid entry;
//   2. seal each remaining thumb/poster as a V2 derivative blob (server lifecycle INDEX_STAGED);
//   3. per attempt (≤ casMaxAttempts): re-read the main head and the latest index head/root → applyUpserts (+ prune) on
//      each affected shard → planSplit → seal changed shards → rebaseRoot → seal root → independent index CAS;
//      409 → re-read and repeat; a lost response → resend the identical body + key once, then compare the head.
//   attach = applied derivatives + new shards + root; superseded = replaced shards + old root (ADVISORY_ONLY — the
//   server records bookkeeping rows; nothing is ever deleted because of them).
// Fail-soft everywhere: a dropped, overflowing, conflicting or failed job never throws to the caller and never touches
// the original file, its upload, its download or the main manifest. Blobs sealed for a job that is later dropped stay
// INDEX_STAGED (counted by the server budget, classified as reserved, never deleted — INITIAL_DESTRUCTIVE_GC=FORBIDDEN).
// Storage budget: PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED from any preview-index upload latches a per-session circuit
// breaker — queue cleared, every later offer() → 'BUDGET_EXHAUSTED' with no request until the next unlocked session.
// ⚠️ Page memory only; nothing here touches browser storage. Every buffer is copied on offer and zeroed after use.

import * as treeApi from './vaultTreeApi.js'
import { apiFetchBytes } from './api.js'
import { sniffImageFormat } from './vaultImageFormats.js'
import { previewProfileBounds } from './vaultPreviewProfiles.js'
import { imageDimensions } from './vaultDerivativeRead.js'
import { createPreviewIndexReader } from './vaultPreviewIndexReader.js'
import { sealDerivative, sealIndexObject } from './vaultPreviewIndexObject.js'
import { encodeRoot, encodeShard } from './vaultPreviewIndexCodec.js'
import { applyUpserts, planSplit, rebaseRoot } from './vaultPreviewIndexMerge.js'
import { routingBits, prefixOf, resolveShardDescriptor } from './vaultPreviewIndexRouting.js'
import {
  PREVIEW_INDEX_LIMITS, PREVIEW_INDEX_SCHEMA_VERSION, D1_WRITE_KINDS, D1_WRITE_PROFILE, DERIVATIVE_MIMES,
  INDEX_ROOT_MARKER, INDEX_SHARD_MARKER,
} from './vaultPreviewIndexConstants.js'

export const WRITER_OFFER = Object.freeze({
  QUEUED: 'QUEUED', DISABLED: 'DISABLED', REJECTED: 'REJECTED', FULL: 'FULL', BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
})

export const BUDGET_EXCEEDED_CODE = 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED'
const WRITE_DISABLED_CODE = 'PREVIEW_INDEX_WRITE_DISABLED'
/** server default VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS — PROVISIONAL; 16 jobs × (1 derivative + ≤ 2 shards) + root ≤ 49 */
const MAX_ATTACH_PER_CAS = 64
const NODE_ID_RE = /^[A-Za-z0-9_-]{22}$/

/** the writer capability, exactly as the server serves it (anything but literal `true` is off) */
export function previewIndexWriteAllowed(treeState) {
  return treeState?.flags?.previewIndexWriteEnabled === true
}

/**
 * Structural + vp1 check of a thumb/poster job from its BYTES (declared values must agree with the encoded image).
 * `mime`/`width`/`height` may be omitted (backfill): they are then taken from the bytes.
 * @returns {{ ok: true, mime: string, width: number, height: number } | { ok: false, reason: string }}
 */
export function validateDerivativeJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'BAD_JOB' }
  if (typeof job.nodeId !== 'string' || !NODE_ID_RE.test(job.nodeId)) return { ok: false, reason: 'BAD_JOB' }
  if (!D1_WRITE_KINDS.includes(job.kind)) return { ok: false, reason: 'BAD_KIND' }
  const src = job.sourceBlobRef
  if (!src || (src.formatVersion !== 1 && src.formatVersion !== 2) || typeof src.id !== 'string' || !src.id) return { ok: false, reason: 'BAD_JOB' }
  const bounds = previewProfileBounds(D1_WRITE_PROFILE, job.kind)
  const bytes = job.bytes
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > bounds.maxPlainSize) return { ok: false, reason: 'BOUNDS' }
  const sniffed = sniffImageFormat(bytes)?.mime ?? null
  if (!DERIVATIVE_MIMES.includes(sniffed) || (job.mime != null && job.mime !== sniffed)) return { ok: false, reason: 'SIGNATURE' }
  const dims = imageDimensions(bytes, sniffed)
  if (!dims) return { ok: false, reason: 'SIGNATURE' }
  if ((job.width != null && job.width !== dims.width) || (job.height != null && job.height !== dims.height)) return { ok: false, reason: 'BOUNDS' }
  const long = Math.max(dims.width, dims.height), short = Math.min(dims.width, dims.height)
  if (long > bounds.maxLongEdge || short > bounds.maxShortEdge) return { ok: false, reason: 'BOUNDS' }
  return { ok: true, mime: sniffed, width: dims.width, height: dims.height }
}

const sameRef = (a, b) => !!a && !!b && a.formatVersion === b.formatVersion && String(a.id) === String(b.id)
const isLiveFile = (node) => !!node && node.kind === 'file' && !!node.blobRef

function randomKey() {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') // 22 chars
}

/**
 * @param {{ kek: CryptoKey, api?: object, transport?: { fetchJson?, sendUpload?, fetchBytes? } | null, reader?: object|null,
 *           getMainHead: () => Promise<object|null>|object|null, upload?: Function, unlockedState?: object|null,
 *           writeAllowed?: () => boolean, limits?: typeof PREVIEW_INDEX_LIMITS,
 *           diagnostics?: { count?: (name: string) => void } | null, autoFlush?: boolean, now?: () => number,
 *           onBudgetExhausted?: (() => void) | null }} o
 * @returns {{ offer(job): string, flush(): Promise<{ committed, dropped, failed, budgetExhausted }>, dispose(): void, stats(): object }}
 */
export function createPreviewIndexWriter({
  kek, api = treeApi, transport = null, reader = null, getMainHead = null, upload = undefined,
  unlockedState = null, writeAllowed = () => false, limits = PREVIEW_INDEX_LIMITS, diagnostics = null,
  autoFlush = true, now = () => Date.now(), onBudgetExhausted = null,
} = {}) {
  const queue = []          // jobs with copied bytes
  const seen = new Set()    // `${nodeId}:${kind}:${fv}:${id}` offered this session (never re-offered)
  const controllers = new Set()
  let disposed = false
  let budgetExhausted = false
  let serverDisabled = false
  let running = null
  let ownReader = null
  const counters = { offered: 0, rejected: 0, committed: 0, failed: 0, casAttempts: 0, casConflicts: 0, dropped: {}, failedReasons: {} }

  const count = (name) => { try { diagnostics?.count?.(name) } catch { /* diagnostics never break writes */ } }
  const purged = () => Boolean(unlockedState?.isPurged?.())
  const permitted = () => { try { return writeAllowed() === true } catch { return false } }
  const allowed = () => !disposed && !purged() && !serverDisabled && permitted()
  const empty = () => ({ committed: 0, dropped: 0, failed: 0, budgetExhausted: false })
  const opts = (signal) => ({ signal, ...(transport?.fetchJson ? { fetchJson: transport.fetchJson } : {}) })
  const sealTransport = transport?.fetchJson || transport?.sendUpload ? { fetchJson: transport.fetchJson, sendUpload: transport.sendUpload } : null

  function zero(job) { try { job.bytes?.fill?.(0) } catch { /* detached */ } job.bytes = null }
  function clearQueue() { for (const j of queue.splice(0)) zero(j) }

  function dispose() {
    disposed = true
    for (const c of controllers) { try { c.abort() } catch { /* already aborted */ } }
    controllers.clear()
    clearQueue()
    try { ownReader?.clear() } catch { /* best-effort */ }
  }
  try { unlockedState?.registerDisposer?.(dispose) } catch { disposed = true }

  function getReader() {
    if (reader) return reader
    if (!ownReader) {
      const bound = {
        getPreviewIndexHead: (o) => api.getPreviewIndexHead({ ...(o ?? {}), ...opts(o?.signal) }),
        getPreviewIndexEnvelopes: (ids, o) => api.getPreviewIndexEnvelopes(ids, { ...(o ?? {}), ...opts(o?.signal) }),
      }
      ownReader = createPreviewIndexReader({ kek, api: bound, fetchBytes: transport?.fetchBytes ?? apiFetchBytes, unlockedState, limits, diagnostics })
    }
    return ownReader
  }

  function latchBudget() {
    if (budgetExhausted) return
    budgetExhausted = true
    clearQueue()
    count('writer.BUDGET_EXHAUSTED')
    try { onBudgetExhausted?.() } catch { /* listeners never break the writer */ }
  }

  function offer(job) {
    if (!allowed()) return WRITER_OFFER.DISABLED
    if (budgetExhausted) { count('writer.offer.BUDGET_EXHAUSTED'); return WRITER_OFFER.BUDGET_EXHAUSTED }
    const v = validateDerivativeJob(job)
    if (!v.ok) { counters.rejected++; count('writer.offer.REJECTED'); return WRITER_OFFER.REJECTED }
    const key = `${job.nodeId}:${job.kind}:${job.sourceBlobRef.formatVersion}:${job.sourceBlobRef.id}`
    if (seen.has(key)) { counters.rejected++; count('writer.offer.REJECTED'); return WRITER_OFFER.REJECTED }
    if (queue.length >= limits.writeQueueMax) { count('writer.offer.FULL'); return WRITER_OFFER.FULL }
    seen.add(key)
    queue.push({
      nodeId: job.nodeId, kind: job.kind, sourceBlobRef: { formatVersion: job.sourceBlobRef.formatVersion, id: String(job.sourceBlobRef.id) },
      bytes: new Uint8Array(job.bytes), mime: v.mime, width: v.width, height: v.height, entry: null,
    })
    counters.offered++
    count('writer.offer.QUEUED')
    if (autoFlush) Promise.resolve().then(() => flush()).catch(() => {})
    return WRITER_OFFER.QUEUED
  }

  function flush() {
    if (budgetExhausted) return Promise.resolve({ ...empty(), budgetExhausted: true })
    if (!allowed()) return Promise.resolve(empty())
    if (running) return running.then(() => (queue.length && allowed() ? flush() : empty()))
    running = drain().finally(() => { running = null })
    return running
  }

  async function drain() {
    const out = empty()
    while (queue.length && allowed() && !budgetExhausted) {
      const batch = queue.splice(0, limits.maxEntriesPerCas)
      let r
      try { r = await runBatch(batch) } catch { r = { committed: 0, dropped: 0, failed: batch.length }; tally('failed', 'ERROR', batch.length) } finally { for (const j of batch) zero(j) }
      out.committed += r.committed; out.dropped += r.dropped; out.failed += r.failed
    }
    if (budgetExhausted) out.budgetExhausted = true
    return out
  }

  function tally(kind, reason, n = 1) {
    if (n <= 0) return
    if (kind === 'dropped') { counters.dropped[reason] = (counters.dropped[reason] ?? 0) + n; count(`writer.dropped.${reason}`) }
    else { counters.failed += n; counters.failedReasons[reason] = (counters.failedReasons[reason] ?? 0) + n; count(`writer.failed.${reason}`) }
  }

  /** shard prefix a node goes to when the latest root has no covering descriptor (never nested with an existing one) */
  function freePrefix(root, bits) {
    for (let len = limits.initialPrefixBits; len <= limits.maxPrefixBits; len++) {
      const p = prefixOf(bits, len)
      if (!(root?.shards ?? []).some((d) => d.prefix.startsWith(p) || p.startsWith(d.prefix))) return p
    }
    return null
  }

  async function runBatch(batch) {
    const res = { committed: 0, dropped: 0, failed: 0 }
    const ctrl = new AbortController()
    controllers.add(ctrl)
    try { unlockedState?.registerAbort?.(ctrl) } catch { controllers.delete(ctrl); tally('failed', 'PURGED', batch.length); res.failed = batch.length; return res }
    const token = unlockedState?.mutationToken?.() ?? null
    const live = () => allowed() && !budgetExhausted && !ctrl.signal.aborted && (token === null || unlockedState.isMutationValid(token))
    const signal = ctrl.signal
    let pending = batch.slice()
    const drop = (job, reason) => { pending = pending.filter((j) => j !== job); res.dropped++; tally('dropped', reason) }
    const failAll = (reason) => { tally('failed', reason, pending.length); res.failed += pending.length; pending = [] }
    try {
      for (const job of pending) job.bits = await routingBits(job.nodeId)

      // 1. pre-filter on the current main manifest and the latest index (no upload for a job that cannot land)
      let mainHead = await getMainHead?.()
      if (!live()) { failAll('PURGED'); return res }
      if (!mainHead?.index?.nodes) { failAll('MAIN_HEAD'); return res }
      for (const job of [...pending]) {
        const node = mainHead.index.nodes.get(job.nodeId)
        if (!isLiveFile(node)) drop(job, 'NODE_MISSING')
        else if (!sameRef(node.blobRef, job.sourceBlobRef)) drop(job, 'STALE_SOURCE')
      }
      if (!pending.length) return res
      let snap = await loadLatest(mainHead, signal)
      if (!live()) { failAll('PURGED'); return res }
      if (!snap) { failAll('INDEX_UNREADABLE'); return res }
      for (const job of [...pending]) {
        const d = snap.root ? resolveShardDescriptor(snap.root, job.bits) : null
        if (!d) continue
        const shard = await getReader().shardOf(d.prefix)
        const existing = shard?.entries.get(job.nodeId)?.find((e) => e.kind === job.kind)
        if (existing && sameRef(existing.sourceBlobRef, mainHead.index.nodes.get(job.nodeId)?.blobRef)) drop(job, 'EXISTING_VALID')
      }
      if (!live()) { failAll('PURGED'); return res }

      // 2. derivatives
      for (const job of [...pending]) {
        if (!live()) { failAll('PURGED'); return res }
        try {
          const d = await sealDerivative({ kek, bytes: job.bytes, mime: job.mime, transport: sealTransport, upload, signal })
          job.entry = { kind: job.kind, profile: D1_WRITE_PROFILE, blobRef: d.blobRef, contentId: d.contentId, sourceBlobRef: job.sourceBlobRef, mime: job.mime, width: job.width, height: job.height, plainSize: d.plainSize, createdAtClient: Math.floor(now()) }
        } catch (e) {
          if (e?.code === BUDGET_EXCEEDED_CODE) { latchBudget(); failAll('BUDGET_EXHAUSTED'); return res }
          if (e?.code === WRITE_DISABLED_CODE) { serverDisabled = true; failAll('WRITE_DISABLED'); return res }
          if (!live()) { failAll('PURGED'); return res }
          pending = pending.filter((j) => j !== job); res.failed++; tally('failed', 'DERIVATIVE_UPLOAD')
        } finally { zero(job) }
      }
      if (!pending.length) return res

      // 3. merge → seal → CAS, bounded attempts
      const sealed = new Map() // change identity → sealed replacement (reused when the base did not move)
      for (let attempt = 1; attempt <= limits.casMaxAttempts; attempt++) {
        // always the LATEST main head (the node may have changed while derivatives uploaded) and the latest index
        if (!live()) { failAll('PURGED'); return res }
        mainHead = await getMainHead?.()
        if (!live()) { failAll('PURGED'); return res }
        if (!mainHead?.index?.nodes) { failAll('MAIN_HEAD'); return res }
        snap = await loadLatest(mainHead, signal)
        if (!live()) { failAll('PURGED'); return res }
        if (!snap) { failAll('INDEX_UNREADABLE'); return res }
        const built = await buildChanges({ snap, mainHead, jobs: pending, sealed, signal, live })
        if (built.stop) { failAll(built.stop); return res }
        for (const [job, reason] of built.dropped) { pending = pending.filter((j) => j !== job); res.dropped++; tally('dropped', reason) }
        if (!built.changes.length) return res
        const gen = snap.head?.indexGeneration ?? 0
        const rebased = rebaseRoot({ latestRoot: snap.root, changes: built.changes, treeId: mainHead.treeId, nextGeneration: gen + 1, createdAtClient: Math.floor(now()), maxShards: limits.maxShards })
        if (rebased.overflow) { for (const job of [...pending]) drop(job, 'OVERFLOW'); return res }
        if (rebased.reapply) continue
        let rootPlain
        try { rootPlain = encodeRoot(rebased.root) } catch { for (const job of [...pending]) drop(job, 'OVERFLOW'); return res }
        if (!live()) { failAll('PURGED'); return res }
        let root
        try { root = await sealIndexObject({ kek, marker: INDEX_ROOT_MARKER, plaintext: rootPlain, buckets: limits.rootPaddingBuckets, transport: sealTransport, upload, signal }) } catch (e) {
          if (e?.code === BUDGET_EXCEEDED_CODE) { latchBudget(); failAll('BUDGET_EXHAUSTED'); return res }
          if (e?.code === WRITE_DISABLED_CODE) { serverDisabled = true; failAll('WRITE_DISABLED'); return res }
          failAll(live() ? 'INDEX_UPLOAD' : 'PURGED'); return res
        } finally { rootPlain.fill(0) }
        const applied = built.applied
        const attachBlobIds = [...applied.map((j) => j.entry.blobRef.id), ...built.changes.flatMap((c) => c.replacement.map((d) => d.blobRef.id)), root.blobRef.id]
        if (attachBlobIds.length > MAX_ATTACH_PER_CAS) { failAll('ATTACH_LIMIT'); return res }
        const supersededBlobIds = [...built.changes.filter((c) => c.baseBlobId).map((c) => c.baseBlobId), ...(snap.head ? [String(snap.head.rootBlobRef.id)] : [])]
        const body = {
          expectedGeneration: gen, expectedRootBlobId: snap.head ? String(snap.head.rootBlobRef.id) : null,
          rootBlobId: root.blobRef.id, rootContentIdB64: root.contentId, attachBlobIds, supersededBlobIds, idempotencyKey: randomKey(),
        }
        const outcome = await casOnce(body, signal, live)
        if (outcome === 'COMMITTED') {
          res.committed += applied.length; counters.committed += applied.length; count('writer.committed')
          for (const job of pending.filter((j) => !applied.includes(j))) { res.dropped++; tally('dropped', 'NOT_APPLIED') }
          return res
        }
        if (outcome === 'CONFLICT') continue
        failAll(outcome); return res
      }
      failAll('CONFLICT_EXHAUSTED')
      return res
    } finally {
      controllers.delete(ctrl)
      for (const j of batch) zero(j)
    }
  }

  /** latest index head/root through the reader; null when the existing index cannot be read safely */
  async function loadLatest(mainHead, signal) {
    let st
    try { st = await getReader().load(mainHead) } catch { return null }
    if (signal.aborted) return null
    if (st?.status === 'ABSENT') return { head: null, root: null }
    if (st?.status !== 'READY') return null
    const { head, root } = getReader().snapshot()
    return head && root ? { head, root } : null
  }

  async function buildChanges({ snap, mainHead, jobs, sealed, signal, live }) {
    const nodes = mainHead.index.nodes
    const currentNodeOf = (id) => nodes.get(id) ?? null
    const groups = new Map() // basePrefix → { baseBlobId, shard|null, jobs }
    const dropped = []
    for (const job of jobs) {
      const d = snap.root ? resolveShardDescriptor(snap.root, job.bits) : null
      const prefix = d ? d.prefix : freePrefix(snap.root, job.bits)
      if (!prefix) { dropped.push([job, 'OVERFLOW']); continue }
      if (!groups.has(prefix)) groups.set(prefix, { baseBlobId: d ? String(d.blobRef.id) : null, jobs: [] })
      groups.get(prefix).jobs.push(job)
    }
    const changes = [], applied = []
    for (const [basePrefix, g] of groups) {
      let shard
      if (g.baseBlobId) {
        shard = await getReader().shardOf(basePrefix)
        if (!live()) return { stop: 'PURGED' }
        if (!shard) { for (const job of g.jobs) dropped.push([job, 'SHARD_UNREADABLE']); continue }
      } else {
        shard = { schemaVersion: PREVIEW_INDEX_SCHEMA_VERSION, treeId: mainHead.treeId, prefix: basePrefix, entries: new Map() }
      }
      const r = applyUpserts({ shard, upserts: g.jobs.map((job) => ({ nodeId: job.nodeId, entry: job.entry, job })), currentNodeOf })
      for (const { upsert, reason } of r.dropped) dropped.push([upsert.job, reason])
      if (!r.applied.length) continue
      const split = await planSplit(r.shard, { maxShardDecodedBytes: limits.maxShardDecodedBytes, maxPrefixBits: limits.maxPrefixBits })
      if (split.overflow) { for (const u of r.applied) dropped.push([u.job, 'OVERFLOW']); continue }
      const key = `${basePrefix}|${g.baseBlobId}|${r.applied.map((u) => `${u.nodeId}:${u.entry.kind}:${u.entry.contentId}`).sort().join(',')}`
      let replacement = sealed.get(key)
      if (!replacement) {
        replacement = []
        for (const s of split.shards) {
          if (!s.entries.size) continue
          if (!live()) return { stop: 'PURGED' }
          const plaintext = await encodeShard(s)
          try {
            const o = await sealIndexObject({ kek, marker: INDEX_SHARD_MARKER, plaintext, buckets: limits.shardPaddingBuckets, transport: sealTransport, upload, signal })
            replacement.push({ prefix: s.prefix, blobRef: o.blobRef, contentId: o.contentId })
          } catch (e) {
            if (e?.code === BUDGET_EXCEEDED_CODE) { latchBudget(); return { stop: 'BUDGET_EXHAUSTED' } }
            if (e?.code === WRITE_DISABLED_CODE) { serverDisabled = true; return { stop: 'WRITE_DISABLED' } }
            return { stop: live() ? 'INDEX_UPLOAD' : 'PURGED' }
          } finally { plaintext.fill(0) }
        }
        sealed.set(key, replacement)
      }
      changes.push({ basePrefix, baseBlobId: g.baseBlobId, replacement })
      for (const u of r.applied) applied.push(u.job)
    }
    return { changes, applied, dropped }
  }

  /** one CAS with the lost-response protocol → 'COMMITTED' | 'CONFLICT' | failure reason */
  async function casOnce(body, signal, live) {
    if (!live()) return 'PURGED'
    counters.casAttempts++; count('cas.attempt')
    let first
    try { await api.casPreviewIndexHead(body, opts(signal)); return 'COMMITTED' } catch (e) { first = e }
    const classify = (e) => {
      if (e?.code === 'PREVIEW_INDEX_CONFLICT') { counters.casConflicts++; count('cas.conflict'); return 'CONFLICT' }
      if (e?.code === WRITE_DISABLED_CODE) { serverDisabled = true; return 'WRITE_DISABLED' }
      return typeof e?.code === 'string' && /^[A-Z_]{1,48}$/.test(e.code) ? e.code : 'CAS_ERROR'
    }
    if (!(Number(first?.status) === 0)) return classify(first)
    // transport loss: the CAS may have applied — resend the IDENTICAL body and key once (server replays)
    if (!live()) return 'PURGED'
    count('cas.resend')
    try { await api.casPreviewIndexHead(body, opts(signal)); return 'COMMITTED' } catch (e) {
      if (Number(e?.status) !== 0) return classify(e)
    }
    if (!live()) return 'PURGED'
    try {
      const h = await api.getPreviewIndexHead(opts(signal))
      if (h && String(h.rootBlobRef?.id) === String(body.rootBlobId)) return 'COMMITTED'
    } catch { return 'TRANSPORT' }
    return 'CONFLICT'
  }

  function stats() {
    return {
      queued: queue.length, busy: Boolean(running), budgetExhausted, serverDisabled,
      offered: counters.offered, rejected: counters.rejected, committed: counters.committed, failed: counters.failed,
      casAttempts: counters.casAttempts, casConflicts: counters.casConflicts,
      dropped: { ...counters.dropped }, failedReasons: { ...counters.failedReasons },
    }
  }

  return { offer, flush, dispose, stats }
}
