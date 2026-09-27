// src/lib/vaultImageReducedDecode.js — AEGIS Drive (IDEA1) · PR220-R2 · reduced-resolution decode lane (main thread)
//
// Large camera photos (26/45/61/100+ MP) never become a full-resolution RGBA bitmap here. The
// decrypted V2 chunks are transferred one by one into a dedicated worker that feeds a WebCodecs
// ImageDecoder stream with a bounded desired size, and only a ≤ posterMaxEdge poster comes back.
//   • capability, not sensor labels: Worker + ImageDecoder + OffscreenCanvas on the engine family
//     whose native memory was measured (Chromium: Edge/Chrome 154, PR220-R2). Other engines are
//     truthfully "not measured" — the tile shows the icon, the original stays downloadable.
//   • "desired" is best-effort by spec: every result is checked, and a decoder that ignored the
//     request latches the lane off for this session (no second unbounded decode).
//   • no network, no storage, no server derivative: poster bytes are returned to the caller only.
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

const MIB = 1_048_576
/** JPEG DCT scaling cannot go below 1/8 of the source edge. */
const MIN_DCT_SCALE = 1 / 8
/** Fixed worker + decoder + canvas + decrypt overhead; calibrated so every measured Edge 154
    peak (26 MP +41.9 MiB … 151 MP +166.3 MiB, 100 MP ×3 +120.7 MiB) stays below the estimate. */
const REDUCED_FIXED_OVERHEAD_BYTES = 48 * MIB
/** Encoded bytes are held by the decoder stream plus transient ciphertext/plaintext chunks. */
const REDUCED_INPUT_FACTOR = 3

let unboundedObserved = false

/**
 * The bounded decode request for a source: 1/8 DCT scale, but never smaller than the poster edge.
 * @returns {{ desiredWidth: number, desiredHeight: number, decodeBytes: number }}
 */
export function reducedDecodePlan({ width, height, posterMaxEdge = VAULT_TREE_CLIENT_LIMITS.posterMaxEdge }) {
  const longEdge = Math.max(width, height)
  const scale = Math.min(1, Math.max(MIN_DCT_SCALE, posterMaxEdge / longEdge))
  const desiredWidth = Math.max(1, Math.ceil(width * scale))
  const desiredHeight = Math.max(1, Math.ceil(height * scale))
  return { desiredWidth, desiredHeight, decodeBytes: desiredWidth * desiredHeight * 4 }
}

/**
 * Projected working set of one reduced decode, calibrated against native process-tree peaks
 * (PR220-R2 measurement table). It charges encoded input and the reduced frame — not
 * sourcePixels * 4, because no full-resolution bitmap exists on this lane.
 */
export function estimateReducedDecodeReservation({ inputBytes, decodeBytes, posterMaxEdge = VAULT_TREE_CLIENT_LIMITS.posterMaxEdge }) {
  const input = Math.max(0, Number(inputBytes) || 0)
  const decoded = Math.max(0, Number(decodeBytes) || 0)
  return REDUCED_FIXED_OVERHEAD_BYTES + input * REDUCED_INPUT_FACTOR + decoded * 2 + posterMaxEdge * posterMaxEdge * 4
}

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function detectReducedDecodeCapability(scope = globalThis) {
  if (unboundedObserved) return { ok: false, reason: 'UNBOUNDED_DECODER_OBSERVED' }
  if (typeof scope?.Worker !== 'function') return { ok: false, reason: 'NO_WORKER' }
  if (typeof scope?.ImageDecoder !== 'function') return { ok: false, reason: 'NO_IMAGE_DECODER' }
  if (typeof scope?.OffscreenCanvas !== 'function') return { ok: false, reason: 'NO_OFFSCREEN_CANVAS' }
  const brands = scope?.navigator?.userAgentData?.brands
  const measured = Array.isArray(brands) && brands.some((b) => b?.brand === 'Chromium')
  if (!measured) return { ok: false, reason: 'ENGINE_NOT_MEASURED' }
  return { ok: true }
}

/** Verify a finished decode stayed within what was requested (small slack for DCT rounding). */
export function noteReducedDecodeResult({ desiredWidth, desiredHeight, decodedWidth, decodedHeight }) {
  const allowed = (desiredWidth + 8) * (desiredHeight + 8)
  if (decodedWidth * decodedHeight > allowed) unboundedObserved = true
  return !unboundedObserved
}

export function resetReducedDecodeLatchForTests() { unboundedObserved = false }

const abortError = () => Object.assign(new Error('reduced decode aborted'), { name: 'AbortError' })

/** An ArrayBuffer the worker may own: the chunk's own buffer when it is exclusive, else a copy. */
function transferableBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer
  return bytes.slice().buffer
}

const defaultCreateWorker = () => new Worker(new URL('./vaultImageReduceWorker.js', import.meta.url), { type: 'module' })

/**
 * One reduced decode in its own worker. push() transfers each decrypted chunk (the caller's view
 * is detached afterwards — nothing is retained on the main thread), end() closes the stream.
 * @returns {{ push: (bytes: Uint8Array) => void, end: () => void, abort: () => void,
 *             result: Promise<{ bytes: Uint8Array, width: number, height: number, decodedWidth: number, decodedHeight: number }> }}
 */
export function startReducedDecodeJob({ createWorker = defaultCreateWorker, mime, desiredWidth, desiredHeight, maxEdge }) {
  const worker = createWorker()
  let finished = false
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const finish = (fn) => {
    if (finished) return
    finished = true
    worker.onmessage = null
    worker.onerror = null
    try { worker.terminate() } catch { /* already gone */ }
    fn()
  }
  worker.onmessage = (event) => {
    const msg = event.data
    if (msg?.type === 'done') {
      finish(() => settle.resolve({ bytes: new Uint8Array(msg.bytes), width: msg.width, height: msg.height, decodedWidth: msg.decodedWidth, decodedHeight: msg.decodedHeight }))
    } else {
      finish(() => settle.reject(new Error(msg?.message ?? 'reduced decode failed')))
    }
  }
  worker.onerror = () => finish(() => settle.reject(new Error('reduced decode worker failed')))
  worker.postMessage({ type: 'start', mime, desiredWidth, desiredHeight, maxEdge })
  return {
    result,
    push(bytes) {
      if (finished) return
      const buf = transferableBuffer(bytes)
      worker.postMessage({ type: 'chunk', buf }, [buf])
    },
    end() { if (!finished) worker.postMessage({ type: 'end' }) },
    abort() { finish(() => settle.reject(abortError())) },
  }
}
