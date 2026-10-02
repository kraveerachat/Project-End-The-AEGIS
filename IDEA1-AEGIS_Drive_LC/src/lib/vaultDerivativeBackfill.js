// src/lib/vaultDerivativeBackfill.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · lazy backfill (PR-D)
//
// When a Vault tile had no index entry and rendered through the ORIGINAL path, the tile loader already holds encoded
// thumb/poster bytes made from plaintext this page already opened for display. Backfill offers exactly those bytes to the
// writer. It imports no transport, no crypto and no preview session: it cannot fetch an original, so
// NO_EXTRA_ORIGINAL_FETCH holds by construction. It never re-encodes: bytes outside vp1 (signature, MIME, edges, size)
// are skipped.
// Bounds: once per (nodeId, kind, sourceBlobRef) per unlocked session (failures are retried only after a fresh unlock),
// ≤ backfillMaxPerSession offers, ≤ backfillConcurrency (1) job in the writer at a time, deferred while `isDeferred()`
// (an interactive upload, download or modal playback). Stops for the session once the writer's storage-budget breaker
// latched. Purge (lock/logout/pagehide/unmount) zeroes and drops everything it holds.
// ⚠️ Page memory only; nothing here touches browser storage.

import { validateDerivativeJob } from './vaultPreviewIndexWriter.js'
import { PREVIEW_INDEX_LIMITS, D1_WRITE_KINDS } from './vaultPreviewIndexConstants.js'

/**
 * @param {{ writer: { offer: Function, flush: Function, stats: Function } | null, limits?: typeof PREVIEW_INDEX_LIMITS,
 *           isDeferred?: () => boolean, unlockedState?: object|null, retryMs?: number,
 *           diagnostics?: { count?: (name: string) => void } | null }} o
 * @returns {{ offerTileResult(node, kind, tileResult): 'OFFERED'|'SKIPPED', clear(): void, stats(): object }}
 */
export function createDerivativeBackfill({ writer, limits = PREVIEW_INDEX_LIMITS, isDeferred = () => false, unlockedState = null, retryMs = 1000, diagnostics = null } = {}) {
  const seen = new Set()
  const pending = []
  let offered = 0
  let skipped = 0
  let running = 0
  let cleared = false
  let timer = null
  const count = (name) => { try { diagnostics?.count?.(name) } catch { /* diagnostics never break tiles */ } }
  const dead = () => cleared || Boolean(unlockedState?.isPurged?.())
  const writerOn = () => { try { const s = writer?.stats?.(); return Boolean(writer) && s?.enabled === true && !s?.budgetExhausted } catch { return false } }
  const deferred = () => { try { return isDeferred() === true } catch { return true } }
  const drop = (job) => { try { job.bytes.fill(0) } catch { /* detached */ } job.bytes = null }
  const skip = (reason) => { skipped++; count(`backfill.skipped.${reason}`); return 'SKIPPED' }

  function clear() {
    cleared = true
    if (timer) { clearTimeout(timer); timer = null }
    for (const job of pending.splice(0)) drop(job)
  }
  try { unlockedState?.registerDisposer?.(clear) } catch { cleared = true }

  function offerTileResult(node, kind, tileResult) {
    if (dead()) return skip('PURGED')
    if (!writerOn()) return skip('WRITER_OFF')
    if (!D1_WRITE_KINDS.includes(kind) || !node || node.kind !== 'file' || !node.blobRef || !tileResult) return skip('NOT_ELIGIBLE')
    const key = `${node.nodeId}:${kind}:${node.blobRef.formatVersion}:${node.blobRef.id}`
    if (seen.has(key)) return skip('SEEN')
    if (offered >= limits.backfillMaxPerSession) return skip('SESSION_LIMIT')
    // dimensions and MIME come from the BYTES (a video tile's 640×360 is layout metadata, not the encoded size)
    const job = { nodeId: node.nodeId, kind, sourceBlobRef: { formatVersion: node.blobRef.formatVersion, id: String(node.blobRef.id) }, bytes: tileResult.bytes, mime: tileResult.mime ?? null }
    const v = validateDerivativeJob(job)
    if (!v.ok) return skip('OUT_OF_PROFILE')
    seen.add(key)
    offered++
    pending.push({ ...job, bytes: new Uint8Array(tileResult.bytes), mime: v.mime, width: v.width, height: v.height })
    count('backfill.offered')
    pump()
    return 'OFFERED'
  }

  function pump() {
    if (dead()) return
    if (!writerOn()) { for (const job of pending.splice(0)) drop(job); return }
    while (running < limits.backfillConcurrency && pending.length) {
      if (deferred()) {
        if (!timer) timer = setTimeout(() => { timer = null; pump() }, retryMs)
        return
      }
      const job = pending.shift()
      running++
      void run(job).finally(() => { running--; pump() })
    }
  }

  async function run(job) {
    try {
      const r = writer.offer(job)
      if (r !== 'QUEUED') { count(`backfill.writer.${r === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'NOT_QUEUED'}`); return }
      await writer.flush()
    } catch { /* the writer never throws; belt and braces */ } finally { drop(job) }
  }

  return { offerTileResult, clear, stats: () => ({ offered, skipped, pending: pending.length, running }) }
}
