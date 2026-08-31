// ⚠️ Allow-list, never a deny-list. A record is built field by field from this
//    set, so a field nobody vetted cannot reach the console by accident. What is
//    absent is the point: no KEK, no DEK, no passphrase, no plaintext, no
//    filename, no decrypted metadata, no cookie, no Authorization header — those
//    values have no name here and therefore no path out.
const ALLOWED_FIELDS = new Set([
  'requestNumber', 'requestStart', 'requestEnd', 'responseStart', 'responseEnd',
  'chunkIndexes', 'ciphertextChunksFetched', 'cacheHits', 'cacheMisses',
  'fetchDurationMs', 'decryptDurationMs', 'responseDurationMs',
  'rehydrationCount', 'failureCategory',
  // ── LFT-V2-E3.3 · throughput and read-ahead ───────────────────────────────
  // Sizes, counts and durations only: they describe how fast the pipeline moved
  // bytes, never which bytes moved.
  'ciphertextBytesFetched', 'ciphertextMbPerSecond', 'decryptMbPerSecond',
  'foregroundChunkIndex', 'prefetchIndexes', 'inFlightLoads',
  'prefetchHits', 'prefetchMisses', 'discardedSpeculativeChunks',
  'retainedPlaintextBytes',
])

/** Index arrays are the only non-scalar shape allowed, and they stay bounded. */
const INDEX_ARRAY_FIELDS = new Set(['chunkIndexes', 'prefetchIndexes'])

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
        if (INDEX_ARRAY_FIELDS.has(key)) {
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

/**
 * MB/s ที่วัดได้จริงของงานหนึ่งชิ้น — ใช้ MB แบบ 1,000,000 ให้ตรงกับตัวเลขที่ผู้ดูแล
 * ระบบอ่านจากกราฟ NET ของคอนเทนเนอร์
 * ⚠️ ระยะเวลา 0 ms เกิดขึ้นได้จริงกับก้อนที่มาจากแคช คืน null แทนที่จะคืน Infinity:
 *    ตัวเลขที่แปลผลไม่ได้ในบันทึกประสิทธิภาพแย่กว่าการไม่มีตัวเลข
 */
export function mbPerSecond(bytes, durationMs) {
  const size = Number(bytes)
  const ms = Number(durationMs)
  if (!Number.isFinite(size) || size <= 0) return null
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round((size / 1e6) / (ms / 1000) * 100) / 100
}
