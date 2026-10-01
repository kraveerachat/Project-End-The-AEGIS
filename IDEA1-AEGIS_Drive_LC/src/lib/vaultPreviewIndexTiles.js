// src/lib/vaultPreviewIndexTiles.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · derivative-first tiles
//
// Glue between the Vault tile scheduler and the read-only index: tryTile() returns the same shape the scheduler's
// original-path loader returns ({ width, height, bytes, mime }) when a verified thumb/poster exists for the CURRENT
// file, and null otherwise — the screen then runs its existing original-file path unchanged. Nothing here writes,
// generates or backfills (that is PR-D, behind the default-off writer capability).
// ⚠️ Created only when the server serves previewIndexReadEnabled=true; READ=false means this module is never built.

import { createPreviewIndexReader } from './vaultPreviewIndexReader.js'
import { readDerivative } from './vaultDerivativeRead.js'
import * as treeApi from './vaultTreeApi.js'
import { apiFetchBytes } from './api.js'

/** Vault tile kind → D-1 derivative kind */
export function previewIndexKindFor(tileKind) {
  if (tileKind === 'image') return 'thumb'
  if (tileKind === 'video') return 'poster'
  return null
}

/**
 * @param {{ kek: CryptoKey, unlockedState?: object|null, api?: object, fetchBytes?: Function,
 *           diagnostics?: { count?: (name: string) => void } | null }} o
 */
export function createPreviewIndexTiles({ kek, unlockedState = null, api = treeApi, fetchBytes = apiFetchBytes, diagnostics = null }) {
  const reader = createPreviewIndexReader({ kek, api, fetchBytes, unlockedState, diagnostics })
  const count = (name) => { try { diagnostics?.count?.(name) } catch { /* diagnostics never break tiles */ } }
  let ready = Promise.resolve()

  return {
    /** (re)load the index head for this main head; tiles wait for the latest load */
    load(mainHead) {
      ready = reader.load(mainHead).catch(() => null)
      return ready
    },
    /** verified derivative tile, or null → original path */
    async tryTile(node, tileKind, { signal = null, index = null } = {}) {
      const kind = previewIndexKindFor(tileKind)
      if (!kind) return null
      await ready
      const entry = await reader.lookup(node, kind, { signal, index })
      if (!entry) return null
      const r = await readDerivative({ kek, entry, envelopeOf: reader.envelopeOf, fetchBytes, signal })
      if (!r.ok) { count(`derivative.${r.reason}`); return null }
      count('derivative.HIT')
      return { width: r.width, height: r.height, bytes: r.bytes, mime: r.mime }
    },
    clear: () => reader.clear(),
    stats: () => reader.stats(),
  }
}
