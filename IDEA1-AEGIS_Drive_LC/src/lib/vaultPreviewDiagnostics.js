const ALLOWED_FIELDS = new Set([
  'requestNumber', 'requestStart', 'requestEnd', 'responseStart', 'responseEnd',
  'chunkIndexes', 'ciphertextChunksFetched', 'cacheHits', 'cacheMisses',
  'fetchDurationMs', 'decryptDurationMs', 'queueWaitDurationMs', 'responseDurationMs',
  'plaintextBytes', 'effectivePlaintextMBps',
  'prefetchHits', 'prefetchMisses', 'activeLoadCount',
  'demandChunkIndex', 'prefetchedChunkIndex',
  'rehydrationCount', 'failureCategory',
])

/**
 * Memory-only, opt-in operational diagnostics. Callers decide how to emit the
 * already-sanitised record; the default is intentionally silent.
 */
export function createPreviewDiagnostics({ enabled = false, emit = () => {} } = {}) {
  return {
    record(event, fields = {}) {
      if (!(typeof enabled === 'function' ? enabled() : enabled)) return
      const safe = { event: String(event) }
      for (const [key, value] of Object.entries(fields)) {
        if (!ALLOWED_FIELDS.has(key)) continue
        if (key === 'chunkIndexes') {
          safe[key] = Array.isArray(value)
            ? value.filter(Number.isSafeInteger).slice(0, 8)
            : []
        } else if (key === 'failureCategory') {
          safe[key] = String(value).slice(0, 32)
        } else if (Number.isFinite(value)) {
          safe[key] = Number(value)
        }
      }
      emit(safe)
    },
  }
}

export function previewDiagnosticsEnabled(scope = globalThis) {
  return scope?.__AEGIS_VAULT_PREVIEW_DEBUG__ === true
}
