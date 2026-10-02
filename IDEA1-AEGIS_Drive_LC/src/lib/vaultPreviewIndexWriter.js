// src/lib/vaultPreviewIndexWriter.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · writer (PR-D)
//
// Capability VAULT_PREVIEW_INDEX_WRITE: env VAULT_PREVIEW_INDEX_WRITE_ENABLED on the server (default false), served as
// /api/vault/tree/state flags.previewIndexWriteEnabled and enforced again by every mutating server route. The client
// derives `writeAllowed` from that served flag ONLY — never from storage, the URL, a role or a build constant — and a
// change needs a fresh /state (the screen rebuilds the writer). With the capability off the writer is inert: offer()
// answers 'DISABLED' and NO request of any kind is made.
// ⚠️ Page memory only; nothing here touches browser storage.

import * as treeApi from './vaultTreeApi.js'
import { PREVIEW_INDEX_LIMITS } from './vaultPreviewIndexConstants.js'

export const WRITER_OFFER = Object.freeze({
  QUEUED: 'QUEUED', DISABLED: 'DISABLED', REJECTED: 'REJECTED', FULL: 'FULL', BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
})

/** the writer capability, exactly as the server serves it (anything but literal `true` is off) */
export function previewIndexWriteAllowed(treeState) {
  return treeState?.flags?.previewIndexWriteEnabled === true
}

/**
 * @param {{ kek: CryptoKey, api?: object, transport?: object|null, reader?: object, getMainHead?: Function, upload?: Function,
 *           unlockedState?: object|null, writeAllowed?: () => boolean, limits?: typeof PREVIEW_INDEX_LIMITS,
 *           diagnostics?: { count?: (name: string) => void } | null, autoFlush?: boolean }} o
 */
export function createPreviewIndexWriter({
  kek, api = treeApi, transport = null, reader = null, getMainHead = null, upload = undefined,
  unlockedState = null, writeAllowed = () => false, limits = PREVIEW_INDEX_LIMITS, diagnostics = null, autoFlush = true,
} = {}) {
  void kek; void api; void transport; void reader; void getMainHead; void upload; void diagnostics; void autoFlush
  const queue = []
  let disposed = false
  const allowed = () => { try { return !disposed && !unlockedState?.isPurged?.() && writeAllowed() === true } catch { return false } }
  const empty = () => ({ committed: 0, dropped: 0, failed: 0, budgetExhausted: false })

  function offer(job) {
    if (!allowed()) return WRITER_OFFER.DISABLED
    if (queue.length >= limits.writeQueueMax) return WRITER_OFFER.FULL
    queue.push(job)
    return WRITER_OFFER.QUEUED
  }

  async function flush() {
    if (!allowed()) return empty()
    return empty()
  }

  function dispose() {
    disposed = true
    queue.length = 0
  }

  return { offer, flush, dispose, stats: () => ({ queued: queue.length }) }
}
