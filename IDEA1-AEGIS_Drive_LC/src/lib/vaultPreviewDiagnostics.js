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

// ── D-1 separate encrypted preview index (PR-D, plan Task F.5) ──────────────────────────────────────────────────
// Counters for the preview-index reader, derivative tiles, writer, CAS and backfill. ⚠️ Allow-list again: a counter
// name is accepted only if it is listed below, so no node id, blob id, contentId, routing prefix, file name or MIME can
// ever become a key — anything else increments one anonymous `unlisted` count. Values are counts and rounded
// milliseconds only. Page memory only, owned by the unlocked session: the purge clears it; nothing is persisted or sent.

const OPEN_REASONS = ['MISSING', 'CONTENT_ID_MISMATCH', 'MARKER_MISMATCH', 'INTEGRITY', 'BOUNDS', 'ABORTED']
const CODEC_CODES = ['UNKNOWN_VERSION', 'UNKNOWN_KEY', 'BAD_FIELD', 'BAD_PREFIX_SET', 'TREE_MISMATCH', 'GENERATION_MISMATCH', 'PREFIX_MISMATCH', 'LIMIT', 'DUPLICATE', 'DECODE']
const DERIVATIVE_REASONS = ['MISSING', 'CONTENT_ID_MISMATCH', 'META_MISMATCH', 'INTEGRITY', 'SIGNATURE', 'BOUNDS', 'ABORTED', 'ERROR', 'STALE_SOURCE']
const WRITER_DROPS = ['NODE_MISSING', 'STALE_SOURCE', 'EXISTING_VALID', 'BAD_KIND', 'BAD_ENTRY', 'OVERFLOW', 'SHARD_UNREADABLE', 'NOT_APPLIED']
const WRITER_FAILS = ['PURGED', 'MAIN_HEAD', 'INDEX_UNREADABLE', 'BUDGET_EXHAUSTED', 'WRITE_DISABLED', 'DERIVATIVE_UPLOAD', 'INDEX_UPLOAD', 'ATTACH_LIMIT', 'CONFLICT_EXHAUSTED', 'ERROR', 'TRANSPORT', 'CAS_ERROR', 'TREE_STATE_CONFLICT', 'PREVIEW_INDEX_BLOB_STATE_CONFLICT', 'PREVIEW_INDEX_ROOT_MISMATCH', 'PREVIEW_INDEX_IDEMPOTENCY_MISMATCH', 'INVALID_INPUT']

export const PREVIEW_INDEX_COUNTER_NAMES = Object.freeze([
  ...['ABSENT', 'READY', 'FAILED', 'DISABLED'].map((s) => `head.${s}`),
  ...['HEAD_ERROR', 'TREE_MISMATCH', 'GENERATION_REGRESSED', ...OPEN_REASONS.map((r) => `ROOT_${r}`), ...CODEC_CODES.map((r) => `ROOT_${r}`)].map((r) => `index.${r}`),
  ...[...OPEN_REASONS, ...CODEC_CODES].map((r) => `shard.${r}`),
  'entry.UNSUPPORTED', 'entry.STALE_SOURCE',
  'derivative.HIT', 'derivative.MISS', ...DERIVATIVE_REASONS.map((r) => `derivative.${r}`),
  ...['QUEUED', 'REJECTED', 'FULL', 'BUDGET_EXHAUSTED'].map((r) => `writer.offer.${r}`),
  'writer.committed', 'writer.BUDGET_EXHAUSTED',
  ...WRITER_DROPS.map((r) => `writer.dropped.${r}`),
  ...WRITER_FAILS.map((r) => `writer.failed.${r}`),
  'cas.attempt', 'cas.conflict', 'cas.resend',
  'backfill.offered', ...['PURGED', 'WRITER_OFF', 'NOT_ELIGIBLE', 'SEEN', 'SESSION_LIMIT', 'OUT_OF_PROFILE'].map((r) => `backfill.skipped.${r}`),
  'backfill.writer.BUDGET_EXHAUSTED', 'backfill.writer.NOT_QUEUED',
  ...['QUEUED', 'SKIPPED', 'NULL', 'OFFERED'].map((r) => `upload.generate.${r}`),
])
export const PREVIEW_INDEX_TIMING_NAMES = Object.freeze(['root.fetchMs', 'root.decodeMs', 'shard.fetchMs', 'shard.decodeMs'])
const COUNTER_SET = new Set(PREVIEW_INDEX_COUNTER_NAMES)
const TIMING_SET = new Set(PREVIEW_INDEX_TIMING_NAMES)

/**
 * @param {{ unlockedState?: object|null }} [o]
 * @returns {{ count(name: string): void, timing(name: string, ms: number): void, snapshot(): { counters: object, timings: object }, clear(): void }}
 */
export function createPreviewIndexCounters({ unlockedState = null } = {}) {
  let counters = new Map()
  let timings = new Map()
  const clear = () => { counters = new Map(); timings = new Map() }
  try { unlockedState?.registerDisposer?.(clear) } catch { /* purged already: stays empty */ }
  return {
    count(name) {
      const key = typeof name === 'string' && COUNTER_SET.has(name) ? name : 'unlisted'
      counters.set(key, (counters.get(key) ?? 0) + 1)
    },
    timing(name, ms) {
      if (typeof name !== 'string' || !TIMING_SET.has(name) || !Number.isFinite(ms) || ms < 0) return
      const t = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 }
      t.count += 1; t.totalMs = Math.round(t.totalMs + ms); t.maxMs = Math.max(t.maxMs, Math.round(ms))
      timings.set(name, t)
    },
    snapshot() {
      return { counters: Object.fromEntries(counters), timings: Object.fromEntries([...timings].map(([k, v]) => [k, { ...v }])) }
    },
    clear,
  }
}
