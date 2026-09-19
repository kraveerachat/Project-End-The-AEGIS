// scripts/measure/vault-tree/manifest-bench-browser.js — PR #157 Phase 0 Task 0.1 · browser entry
//
// ⚠️ DISPOSABLE. Loaded by manifest-bench.html, served by serve-bench.mjs with
//    COOP/COEP so performance.measureUserAgentSpecificMemory() is available where
//    the browser implements it. Where it is not, heapDeltaMB is NOT_MEASURED.
import { NODE_COUNTS, DEPTHS, NAME_BYTES, measureCell } from './bench-core.js'

// Memory probe order: (1) Chromium precise heap after a forced GC (driver passes
// --js-flags=--expose-gc --enable-precise-memory-info), (2) the standard
// performance.measureUserAgentSpecificMemory() (its randomized resolution delay makes
// a 128-cell grid impractically slow, so it is only the fallback), (3) NOT_MEASURED.
export async function memoryProbe() {
  if (typeof globalThis.gc === 'function' && performance.memory && typeof performance.memory.usedJSHeapSize === 'number') {
    return { name: 'performance.memory.usedJSHeapSize (gc-forced, precise)', read: async () => { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); return performance.memory.usedJSHeapSize } }
  }
  if (typeof performance.measureUserAgentSpecificMemory === 'function') {
    try { await performance.measureUserAgentSpecificMemory(); return { name: 'measureUserAgentSpecificMemory', read: async () => (await performance.measureUserAgentSpecificMemory()).bytes } }
    catch { return null }
  }
  return null
}

globalThis.runManifestBench = async function runManifestBench({ quick = false, maxNodes = Infinity } = {}) {
  const probe = await memoryProbe()
  const memory = probe?.read ?? null
  const rows = []
  for (const nodes of NODE_COUNTS) {
    if (quick && nodes > 10_000) continue
    if (nodes > maxNodes) continue
    for (const depth of DEPTHS) {
      for (const nameBytes of NAME_BYTES) {
        const cell = await measureCell({ nodes, depth, nameBytes, memory })
        console.log(`cell nodes=${nodes} depth=${depth} name=${nameBytes} enc=${cell.encodedBytes} d+v=${cell.decryptValidateMs} heap=${cell.heapDeltaMB}`)
        rows.push(cell)
      }
    }
  }
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    memoryApi: probe?.name ?? 'NOT_MEASURED',
    deviceMemoryGiB: navigator.deviceMemory ?? 'NOT_MEASURED',
    rows,
  }
}
