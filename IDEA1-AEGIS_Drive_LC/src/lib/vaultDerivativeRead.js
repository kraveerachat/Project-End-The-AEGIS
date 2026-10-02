// src/lib/vaultDerivativeRead.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · verified derivative read
//
// A thumb/poster derivative is rendered only after ALL of these hold (otherwise { ok: false } → original path):
//   1. the envelope's contentId equals the entry's (checked before any key use or fetch);
//   2. the plaintext size is inside the entry's known vp1 profile bounds (checked before fetch);
//   3. authenticated metadata = { name: '', type: entry.mime, plainSize: entry.plainSize };
//   4. the single AES-GCM chunk authenticates (tampered/truncated data → no bytes at all);
//   5. the bytes really are JPEG/WebP of exactly that MIME (magic bytes) — never HTML, SVG or XML;
//   6. the encoded dimensions equal the entry's and stay inside the profile.
// Only the derivative chunk is fetched — never the original file (ORIGINAL_BLOB_FETCH=0 on success).
// ⚠️ Page memory only; nothing here touches browser storage.

import { apiFetchBytes } from './api.js'
import { previewProfileBounds } from './vaultPreviewProfiles.js'
import { sniffImageFormat } from './vaultImageFormats.js'
import { openSingleChunkV2 } from './vaultPreviewIndexObject.js'
import { DERIVATIVE_MIMES } from './vaultPreviewIndexConstants.js'

const u16be = (b, o) => (b[o] << 8) | b[o + 1]
const u16le = (b, o) => b[o] | (b[o + 1] << 8)
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n))
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** encoded width/height of a JPEG (first SOF segment) or WebP (VP8X/VP8/VP8L), or null when unparseable */
export function imageDimensions(bytes, mime) {
  if (!(bytes instanceof Uint8Array)) return null
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
    let o = 2
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null
      const marker = bytes[o + 1]
      if (marker === 0xd9 || marker === 0xda) return null
      if (marker === 0xff) { o += 1; continue }
      const len = u16be(bytes, o + 2)
      if (len < 2) return null
      if (SOF.has(marker)) {
        const height = u16be(bytes, o + 5), width = u16be(bytes, o + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      o += 2 + len
    }
    return null
  }
  if (mime === 'image/webp') {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
    const chunk = ascii(bytes, 12, 4)
    if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = u16le(bytes, 26) & 0x3fff, height = u16le(bytes, 28) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const v = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
    }
    return null
  }
  return null
}

/**
 * @param {{ kek: CryptoKey, entry: object, envelopeOf: (blobRef: object, o?: { signal?: AbortSignal }) => Promise<object|null>,
 *           fetchBytes?: Function, signal?: AbortSignal|null }} o
 * @returns {Promise<{ ok: true, bytes: Uint8Array, mime: string, width: number, height: number }
 *                 | { ok: false, reason: 'MISSING'|'CONTENT_ID_MISMATCH'|'META_MISMATCH'|'INTEGRITY'|'SIGNATURE'|'BOUNDS'|'ABORTED' }>}
 */
export async function readDerivative({ kek, entry, envelopeOf, fetchBytes = apiFetchBytes, signal = null, decodeImage = (blob) => {
  if (typeof globalThis.createImageBitmap !== 'function') throw new Error('IMAGE_DECODER_UNAVAILABLE')
  return globalThis.createImageBitmap(blob)
} }) {
  if (signal?.aborted) return { ok: false, reason: 'ABORTED' }
  const bounds = entry ? previewProfileBounds(entry.profile, entry.kind) : null
  if (!bounds || !DERIVATIVE_MIMES.includes(entry.mime) || !bounds.mimes.includes(entry.mime) || entry.plainSize > bounds.maxPlainSize) return { ok: false, reason: 'BOUNDS' }
  let envelope
  try { envelope = await envelopeOf(entry.blobRef, { signal }) } catch { envelope = null }
  const r = await openSingleChunkV2({
    kek, envelope, expected: { blobRef: entry.blobRef, contentId: entry.contentId }, maxPlainBytes: bounds.maxPlainSize, fetchBytes, signal,
    acceptMeta: (meta) => (meta && meta.name === '' && meta.type === entry.mime && meta.plainSize === entry.plainSize ? true : 'META_MISMATCH'),
  })
  if (!r.ok) return r
  const reject = (reason) => { r.bytes.fill(0); return { ok: false, reason } }
  if (sniffImageFormat(r.bytes)?.mime !== entry.mime) return reject('SIGNATURE')
  const dims = imageDimensions(r.bytes, entry.mime)
  if (!dims || dims.width !== entry.width || dims.height !== entry.height) return reject('BOUNDS')
  const long = Math.max(dims.width, dims.height), short = Math.min(dims.width, dims.height)
  if (long > bounds.maxLongEdge || short > bounds.maxShortEdge) return reject('BOUNDS')
  let bitmap
  try {
    bitmap = await decodeImage(new Blob([r.bytes], { type: entry.mime }))
    if (signal?.aborted) return reject('ABORTED')
    if (!bitmap || bitmap.width !== dims.width || bitmap.height !== dims.height) return reject('BOUNDS')
  } catch { return reject(signal?.aborted ? 'ABORTED' : 'SIGNATURE') }
  finally { try { bitmap?.close?.() } catch { /* decoder resource already closed */ } }
  return { ok: true, bytes: r.bytes, mime: entry.mime, width: dims.width, height: dims.height }
}
