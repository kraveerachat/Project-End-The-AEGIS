// src/lib/vaultDerivativeGenerate.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · thumb/poster generation
//
// Client-side only, from the LOCAL File the user just uploaded (the original was already encrypted and committed):
//   • image → header admission (existing pixel/input limits) BEFORE decode → createImageBitmap → long edge ≤ 512 →
//     WebP when this browser can encode it, else JPEG → ≤ 256 KiB (one lower-quality retry, then null);
//   • video → ephemeral local object URL → existing poster seek policy → JPEG frame ≤ 512 → URL revoked in `finally`.
// Every output is re-verified (magic bytes, encoded dimensions, vp1 bounds) before it is returned. Anything unsupported,
// undecodable, oversized, aborted or over the time budget → null; this module never throws and never touches the
// network — the server never sees plaintext or generates anything (SERVER_GENERATED_VAULT_DERIVATIVES=FORBIDDEN).
// ⚠️ Page memory only; nothing here touches browser storage.

import { sniffImageFormat, IMAGE_FORMAT_CAPABILITIES } from './vaultImageFormats.js'
import { parseImageHeader } from './vaultImageThumb.js'
import { imageDimensions } from './vaultDerivativeRead.js'
import { previewProfileBounds } from './vaultPreviewProfiles.js'
import { PREVIEW_VIDEO_TYPES, normalizeMimeType } from './vaultPreview.js'
import { vaultVideoPosterSeekSeconds } from './vaultVideoPreview.js'
import { attachPosterVideo, drawPosterFrame } from './vaultVideoDom.js'
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'
import { PREVIEW_INDEX_LIMITS, D1_WRITE_PROFILE } from './vaultPreviewIndexConstants.js'

/** header bytes read for admission (JPEG SOF can sit behind a large EXIF block) */
const HEAD_BYTES = 256 * 1024
const IMAGE_QUALITIES = Object.freeze([0.8, 0.6])
const POSTER_QUALITIES = Object.freeze([0.82, 0.6])

let webpProbe = null
async function defaultCanEncodeWebp() {
  if (webpProbe !== null) return webpProbe
  try {
    if (typeof OffscreenCanvas === 'function') {
      const blob = await new OffscreenCanvas(1, 1).convertToBlob({ type: 'image/webp' })
      webpProbe = blob?.type === 'image/webp'
    } else if (typeof document !== 'undefined') {
      webpProbe = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp')
    } else webpProbe = false
  } catch { webpProbe = false }
  return webpProbe
}

async function defaultEncodeImage(bitmap, { width, height, mime, quality }) {
  let blob
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    blob = await canvas.convertToBlob({ type: mime, quality })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('ENCODE'))), mime, quality))
  }
  return new Uint8Array(await blob.arrayBuffer())
}

const DEFAULT_ENV = Object.freeze({
  decodeImage: (file) => {
    if (typeof globalThis.createImageBitmap !== 'function') throw new Error('IMAGE_DECODER_UNAVAILABLE')
    return globalThis.createImageBitmap(file)
  },
  encodeImage: defaultEncodeImage,
  canEncodeWebp: defaultCanEncodeWebp,
  createObjectURL: (file) => URL.createObjectURL(file),
  revokeObjectURL: (url) => { try { URL.revokeObjectURL(url) } catch { /* already revoked */ } },
  attachVideo: attachPosterVideo,
  drawFrame: drawPosterFrame,
})

async function readHead(file, n) {
  const part = file.slice(0, n)
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer())
  return new Uint8Array(await new Response(part).arrayBuffer())
}

/** run `work(signal)` under the caller's signal and a hard time budget; null on abort/timeout/error */
async function bounded(work, { signal, budgetMs }) {
  if (signal?.aborted) return null
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let timer = null
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve(null) }, Math.max(1, budgetMs)) })
  const aborted = new Promise((resolve) => ctrl.signal.addEventListener('abort', () => resolve(null), { once: true }))
  try {
    return await Promise.race([Promise.resolve().then(() => work(ctrl.signal)).catch(() => null), expired, aborted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    if (!ctrl.signal.aborted) ctrl.abort() // releases anything still listening once we are done
  }
}

/** the encoder's bytes must really be `mime` with exactly these dimensions, inside vp1 for `kind` */
function verified(bytes, { mime, width, height, kind }) {
  const b = previewProfileBounds(D1_WRITE_PROFILE, kind)
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > b.maxPlainSize) return false
  if (sniffImageFormat(bytes)?.mime !== mime) return false
  const dims = imageDimensions(bytes, mime)
  if (!dims || (width != null && (dims.width !== width || dims.height !== height))) return false
  return Math.max(dims.width, dims.height) <= b.maxLongEdge && Math.min(dims.width, dims.height) <= b.maxShortEdge ? dims : false
}

/**
 * @param {File} file the user's local file
 * @param {{ signal?: AbortSignal|null, env?: object, budgetMs?: number, limits?: { imageNormalMaxDecodedPixels: number, imageMaxInputBytes: number } }} [o]
 * @returns {Promise<{ bytes: Uint8Array, mime: 'image/webp'|'image/jpeg', width: number, height: number } | null>}
 */
export async function generateThumbFromFile(file, { signal = null, env = DEFAULT_ENV, budgetMs = PREVIEW_INDEX_LIMITS.generationBudgetMs, limits = VAULT_TREE_CLIENT_LIMITS } = {}) {
  try {
    if (!file || typeof file.slice !== 'function' || !(file.size > 0) || signal?.aborted) return null
    if (file.size > limits.imageMaxInputBytes) return null
    const e = { ...DEFAULT_ENV, ...env }
    return await bounded(async (inner) => {
      const head = await readHead(file, HEAD_BYTES)
      const fmt = sniffImageFormat(head)
      if (!fmt || !IMAGE_FORMAT_CAPABILITIES[fmt.format]?.preview) return null
      const header = parseImageHeader(head)
      if (!header || !(header.width > 0) || !(header.height > 0)) return null
      if (header.width * header.height > limits.imageNormalMaxDecodedPixels) return null
      if (inner.aborted) return null
      const bitmap = await e.decodeImage(file, { signal: inner })
      try {
        if (inner.aborted || !bitmap || !(bitmap.width > 0) || !(bitmap.height > 0)) return null
        const edge = previewProfileBounds(D1_WRITE_PROFILE, 'thumb').maxLongEdge
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))
        const mime = (await e.canEncodeWebp()) ? 'image/webp' : 'image/jpeg'
        for (const quality of IMAGE_QUALITIES) {
          if (inner.aborted) return null
          const bytes = await e.encodeImage(bitmap, { width, height, mime, quality })
          if (verified(bytes, { mime, width, height, kind: 'thumb' })) return { bytes, mime, width, height }
          if (!(bytes instanceof Uint8Array) || sniffImageFormat(bytes)?.mime !== mime) return null // wrong output is not retried
        }
        return null
      } finally { try { bitmap?.close?.() } catch { /* already closed */ } }
    }, { signal, budgetMs })
  } catch { return null }
}

/**
 * @param {File} file the user's local video file
 * @param {{ signal?: AbortSignal|null, env?: object, budgetMs?: number, registerObjectUrl?: ((url: string) => void) | null }} [o]
 * @returns {Promise<{ bytes: Uint8Array, mime: 'image/jpeg', width: number, height: number } | null>}
 */
export async function generatePosterFromFile(file, { signal = null, env = DEFAULT_ENV, budgetMs = PREVIEW_INDEX_LIMITS.generationBudgetMs, registerObjectUrl = null } = {}) {
  let url = null
  const e = { ...DEFAULT_ENV, ...env }
  let attached = null
  try {
    if (!file || !(file.size > 0) || signal?.aborted) return null
    if (!PREVIEW_VIDEO_TYPES.includes(normalizeMimeType(file.type))) return null
    url = e.createObjectURL(file)
    try { registerObjectUrl?.(url) } catch { return null }
    return await bounded(async (inner) => {
      const a = await e.attachVideo({ url, muted: true, preload: 'metadata', signal: inner })
      if (inner.aborted) { try { a?.cleanup?.() } catch { /* best-effort */ } return null } // budget ran out meanwhile
      attached = a
      await attached.seekTo(vaultVideoPosterSeekSeconds(attached.element?.duration))
      const edge = previewProfileBounds(D1_WRITE_PROFILE, 'poster').maxLongEdge
      for (const quality of POSTER_QUALITIES) {
        if (inner.aborted) return null
        const bytes = await e.drawFrame(attached.element, { maxEdge: edge, quality })
        const dims = verified(bytes, { mime: 'image/jpeg', kind: 'poster' })
        if (dims) return { bytes, mime: 'image/jpeg', width: dims.width, height: dims.height }
        if (!(bytes instanceof Uint8Array) || sniffImageFormat(bytes)?.mime !== 'image/jpeg' || !imageDimensions(bytes, 'image/jpeg')) return null
        const d = imageDimensions(bytes, 'image/jpeg')
        if (Math.max(d.width, d.height) > edge) return null // a size retry cannot fix dimensions
      }
      return null
    }, { signal, budgetMs })
  } catch { return null } finally {
    try { attached?.cleanup?.() } catch { /* best-effort */ }
    if (url) e.revokeObjectURL(url)
  }
}

/**
 * Post-upload derivative queue (plan Task F.2). The screen calls afterUpload() only after the ORIGINAL upload returned
 * ok AND the manifest/inventory reconcile resolved; the call is synchronous and never awaited by the upload flow, so the
 * drawer's result and announcement are exactly what they were before D-1. Bounded: ≤ backfillConcurrency generation
 * jobs, ≤ writeQueueMax pending files, paused while `isDeferred()` (an interactive upload is running). Anything that
 * fails is simply not offered; the writer decides persistence. Purge (lock/logout/pagehide/unmount) aborts and drops all.
 * @param {{ writer: { offer: Function, stats: Function } | null, isDeferred?: () => boolean, unlockedState?: object|null,
 *           limits?: typeof PREVIEW_INDEX_LIMITS, generateThumb?: Function, generatePoster?: Function, retryMs?: number,
 *           diagnostics?: { count?: (name: string) => void } | null }} o
 */
export function createUploadDerivativeQueue({
  writer, isDeferred = () => false, unlockedState = null, limits = PREVIEW_INDEX_LIMITS,
  generateThumb = generateThumbFromFile, generatePoster = generatePosterFromFile, retryMs = 1000, diagnostics = null,
} = {}) {
  const pending = []
  const controllers = new Set()
  let running = 0
  let cleared = false
  let timer = null
  const count = (name) => { try { diagnostics?.count?.(name) } catch { /* diagnostics never break uploads */ } }
  const dead = () => cleared || Boolean(unlockedState?.isPurged?.())
  const writerBlocked = () => { try { const s = writer?.stats?.(); return !writer || Boolean(s?.budgetExhausted || s?.serverDisabled) } catch { return true } }
  const deferred = () => { try { return isDeferred() === true } catch { return true } }

  function clear() {
    cleared = true
    if (timer) { clearTimeout(timer); timer = null }
    for (const c of controllers) { try { c.abort() } catch { /* already aborted */ } }
    controllers.clear()
    pending.length = 0
  }
  try { unlockedState?.registerDisposer?.(clear) } catch { cleared = true }

  function afterUpload({ file, nodeId, sourceBlobRef, kind } = {}) {
    if (dead() || writerBlocked() || !file || typeof nodeId !== 'string' || !sourceBlobRef?.id || (kind !== 'thumb' && kind !== 'poster') || pending.length >= limits.writeQueueMax) {
      count('upload.generate.SKIPPED')
      return 'SKIPPED'
    }
    pending.push({ file, nodeId, kind, sourceBlobRef: { formatVersion: sourceBlobRef.formatVersion, id: String(sourceBlobRef.id) } })
    count('upload.generate.QUEUED')
    pump()
    return 'QUEUED'
  }

  function pump() {
    if (dead()) return
    while (running < limits.backfillConcurrency && pending.length) {
      if (writerBlocked()) { pending.length = 0; return }
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
    const ctrl = new AbortController()
    try { unlockedState?.registerAbort?.(ctrl) } catch { return }
    controllers.add(ctrl)
    let r = null
    try {
      const gen = job.kind === 'thumb' ? generateThumb : generatePoster
      r = await gen(job.file, { signal: ctrl.signal, registerObjectUrl: (url) => unlockedState?.registerObjectUrl?.(url) })
    } catch { r = null } finally { controllers.delete(ctrl) }
    job.file = null
    if (!r || dead() || ctrl.signal.aborted) { try { r?.bytes?.fill?.(0) } catch { /* detached */ } count('upload.generate.NULL'); return }
    try {
      writer.offer({ nodeId: job.nodeId, kind: job.kind, sourceBlobRef: job.sourceBlobRef, bytes: r.bytes, mime: r.mime, width: r.width, height: r.height })
      count('upload.generate.OFFERED')
    } catch { /* the writer never throws; belt and braces */ } finally { try { r.bytes.fill(0) } catch { /* detached */ } }
  }

  return { afterUpload, resume: pump, clear, stats: () => ({ pending: pending.length, running }) }
}
