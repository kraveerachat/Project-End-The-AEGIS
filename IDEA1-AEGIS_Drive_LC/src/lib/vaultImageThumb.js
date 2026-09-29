// src/lib/vaultImageThumb.js — AEGIS Drive (IDEA1) · PR #157 Task 7.2 · client-only image thumbnails
//
// หัวใจของเส้นทางพรีวิวภาพ: อ่าน header เพื่อตัดสิน "ควรถอดเลยไหม" ก่อนใช้งานหนัก แล้วค่อย decode
// ในเครื่อง ทำโปสเตอร์ขอบสั้นไม่เกิน limits.posterMaxEdge แล้วมอบเป็น Object URL ที่ลงทะเบียนกับ
// unlockedState ทั้งหมด
// ── กติกา ────────────────────────────────────────────────────────────────────
//   • ขนาดไฟล์เกิน imageMaxInputBytes = ปฏิเสธทันที (ไม่ดึงไบต์ใด ๆ)
//   • พิกเซลเกิน imageMaxDecodedPixels = ปฏิเสธก่อน decode (V2 อ่าน header จาก chunk แรกพอ)
//   • V1 ต้องถอดทั้งไฟล์ — อนุญาตเฉพาะไฟล์ใต้เพดาน input เดียวกัน
//   • decrypt ล้ม (AAD/GCM/tamper) = unsupported 'INTEGRITY'; abort = 'ABORTED' (ไม่มี URL เกิด)
//   • ไม่มี storage ใดในไฟล์นี้; release() revoke URL + ปล่อยทุก reference
//   • decode/poster ถูกฉีด (jsdom ไม่มี createImageBitmap/canvas) — โปรดักต์จ่าย default ผ่าน feature detection
// ── PR220-R2: สองเลน ──────────────────────────────────────────────────────────
//   • normal (≤ imageNormalMaxDecodedPixels): เส้นทางเดิมที่พิสูจน์แล้ว — ถอดครั้งเดียวเป็น bitmap เต็ม
//   • reduced (ภาพกล้องความละเอียดสูง, JPEG ตาม magic bytes): chunk ที่ถอดรหัสแล้วถูกโอนทีละก้อนเข้า
//     worker ImageDecoder ที่ขอขนาดลดลง (≤ 1/8) — ไม่มี bitmap เต็มความละเอียดเกิดขึ้นเลย และไม่เก็บ
//     plaintext ทั้งไฟล์ไว้ใน main thread; ไม่มีความสามารถนี้ = HIGH_RES_TOO_LARGE ตามจริง ห้าม fallback
//     ไป createImageBitmap(เต็ม) เด็ดขาด
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'
import { sniffImageFormat, IMAGE_FORMAT_CAPABILITIES } from './vaultImageFormats.js'
import { reducedDecodePlan, estimateReducedDecodeReservation, noteReducedDecodeResult } from './vaultImageReducedDecode.js'

/** header parser: PNG (IHDR) / JPEG (SOF0-SOF15) / GIF (canvas) / WebP (VP8/VP8L/VP8X) → null เมื่อไม่รู้จัก */
export function parseImageHeader(bytes) {
  if (!bytes || bytes.length < 12) return null
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR width/height ที่ offset 16
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    if (u8.length < 24) return null
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    return { width: dv.getUint32(16), height: dv.getUint32(20), format: 'PNG' }
  }
  // JPEG: FF D8 + หา SOF marker แรก
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) { i += 1; continue }
      const marker = u8[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (u8[i + 5] << 8) | u8[i + 6], width: (u8[i + 7] << 8) | u8[i + 8], format: 'JPEG' }
      }
      const len = (u8[i + 2] << 8) | u8[i + 3]
      i += 2 + len
    }
    return null
  }
  // GIF: 'GIF87a'/'GIF89a' + canvas w/h little-endian ที่ offset 6
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    return { width: u8[6] | (u8[7] << 8), height: u8[8] | (u8[9] << 8), format: 'GIF' }
  }
  // WebP: 'RIFF????WEBP' + VP8/VP8L/VP8X dims
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
    if (u8.length < 30) return null
    const fourcc = String.fromCharCode(u8[12], u8[13], u8[14], u8[15])
    if (fourcc === 'VP8 ') return { width: (u8[26] | (u8[27] << 8)) & 0x3fff, height: (u8[28] | (u8[29] << 8)) & 0x3fff, format: 'WebP' }
    if (fourcc === 'VP8L') {
      const b = (u8[21] << 16) | (u8[22] << 8) | u8[23]
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'WebP' }
    }
    if (fourcc === 'VP8X') return { width: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)), height: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)), format: 'WebP' }
    return null
  }
  return null
}

const isAbort = (err) => err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))

/**
 * พรีวิวภาพหนึ่งใบ: header ก่อน → ขนาด/เพดานก่อน decode → decode → โปสเตอร์ → URL
 * @param {{
 *   plainSize: number, limits?: object, variant: 1 | 2,
 *   readChunk?: (index: number, opts: { signal?: AbortSignal }) => Promise<Uint8Array>,
 *   readWhole?: (opts: { signal?: AbortSignal }) => Promise<Uint8Array>,
 *   decode?: (bytes: Uint8Array) => Promise<{ width: number, height: number, close?: () => void }>,
 *   poster?: (bitmap: object, w: number, h: number, maxEdge: number) => { bytes: Uint8Array, width: number, height: number },
 *   createObjectUrl?: (bytes: Uint8Array) => string, revokeObjectUrl?: (url: string) => void,
 *   registerObjectUrl?: (url: string) => void, signal?: AbortSignal,
 *   openChunks?: (opts: { signal?: AbortSignal }) => AsyncIterator<Uint8Array>,
 *   reduced?: { capability: { ok: boolean }, startJob: Function },
 * }} p
 * openChunks (V2 only) = decrypted chunks in order; when present the two-lane streamed path runs.
 * @returns {Promise<{ ok: true, url: string, width, height, posterBytes, release: () => void } | { ok: false, unsupported: 'IMAGE_TOO_LARGE'|'HIGH_RES_TOO_LARGE'|'UNSUPPORTED'|'INTEGRITY'|'ABORTED' }>}
 */
export async function makeImageThumb({
  plainSize, limits = VAULT_TREE_CLIENT_LIMITS, variant = 2, chunkCount = 1,
  readChunk, readWhole, decode = defaultDecode, poster = defaultPoster,
  createObjectUrl = (b) => URL.createObjectURL(new Blob([b])),
  revokeObjectUrl = (u) => { try { URL.revokeObjectURL(u) } catch { /* gone */ } },
  registerObjectUrl = null, signal = null, skipUrl = false, admission = null, fullBytesRef = null,
  openChunks = null, reduced = null,
}) {
  if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
  const out = { skipUrl, createObjectUrl, revokeObjectUrl, registerObjectUrl }
  if (variant === 2 && openChunks) {
    return streamedThumb({ plainSize, limits, openChunks, reduced, decode, poster, admission, signal, fullBytesRef, out })
  }
  if (plainSize > limits.imageMaxInputBytes) return { ok: false, unsupported: 'IMAGE_TOO_LARGE' }
  let bitmap = null
  let admissionToken = null
  let full = null
  try {
    // header: V2 อ่านเฉพาะ chunk แรก; V1 ต้องถอดทั้งไฟล์ (ไฟล์ใต้เพดานเท่านั้น — ตรวจแล้วด้านบน)
    const headBytes = variant === 2 ? await readChunk(0, { signal }) : await readWhole({ signal })
    const header = parseImageHeader(headBytes)
    if (!header) return { ok: false, unsupported: 'UNSUPPORTED' }
    const pixels = header.width * header.height
    // full-bitmap decode is bounded by the normal lane only — never by the reduced-lane envelope
    const activeCap = Math.min(limits.imageMaxDecodedPixels, limits.imageNormalMaxDecodedPixels ?? limits.imageMaxDecodedPixels)
    if (pixels > activeCap) return { ok: false, unsupported: pixels > (limits.imageNormalMaxDecodedPixels ?? activeCap) ? 'HIGH_RES_TOO_LARGE' : 'UNSUPPORTED' }
    // ประกอบไบต์เต็ม: V2 = chunk แรก + chunk ถัด ๆ ไปตามลำดับ (sequential เสมอ)
    full = headBytes
    if (variant === 2) {
      const parts = [headBytes]
      for (let i = 1; i < chunkCount; i += 1) {   // chunkCount จาก blob — ไม่มีการเดาจุดจบเอง
        if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
        const chunk = await readChunk(i, { signal })
        parts.push(chunk)
      }
      full = concatBytes(parts)
    }
    if (fullBytesRef) fullBytesRef.bytes = full
    if (admission) admissionToken = await admission.acquire({ pixels, inputBytes: plainSize, signal })
    else if (pixels > (limits.imageNormalMaxDecodedPixels ?? activeCap)) return { ok: false, unsupported: 'HIGH_RES_TOO_LARGE' }
    if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
    bitmap = await decode(full)
    if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
    const encoded = await poster(bitmap, bitmap.width, bitmap.height, limits.posterMaxEdge)
    if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
    return posterResult(encoded, out)
  } catch (err) {
    if (signal?.aborted || isAbort(err)) return { ok: false, unsupported: 'ABORTED' }
    return { ok: false, unsupported: 'INTEGRITY' }
  } finally {
    try { bitmap?.close?.() } catch { /* injected decoder may have nothing to close */ }
    admissionToken?.release?.()
    if (full) {
      try { full.fill(0) } catch { /* best-effort cleanup; JavaScript memory is not cryptographically zeroized */ }
    }
    full = null
    if (fullBytesRef) fullBytesRef.bytes = null
  }
}

function posterResult(encoded, { skipUrl, createObjectUrl, revokeObjectUrl, registerObjectUrl }) {
  const url = skipUrl ? null : createObjectUrl(encoded.bytes)
  if (url) registerObjectUrl?.(url)
  let released = false
  const res = {
    ok: true, url, width: encoded.width, height: encoded.height, posterBytes: encoded.bytes,
    release: () => {
      if (released) return
      released = true
      revokeObjectUrl(url)
      res.posterBytes = null
    },
  }
  return res
}

async function nextChunk(iter) {
  const step = await iter.next()
  return step.done ? null : step.value
}

/**
 * PR220-R2 streamed V2 path. The first decrypted chunk decides everything (header + codec by
 * magic bytes) before any heavy work; later chunks either fill the bounded normal buffer or are
 * transferred one by one into the reduced decoder and never retained here.
 */
async function streamedThumb({ plainSize, limits, openChunks, reduced, decode, poster, admission, signal, fullBytesRef, out }) {
  const reducedOk = reduced?.capability?.ok === true && typeof reduced?.startJob === 'function'
  const inputCap = reducedOk ? Math.max(limits.imageMaxInputBytes, limits.imageHighResMaxInputBytes ?? 0) : limits.imageMaxInputBytes
  if (plainSize > inputCap) return { ok: false, unsupported: 'IMAGE_TOO_LARGE' }
  const aborted = () => signal?.aborted === true
  const ABORTED = { ok: false, unsupported: 'ABORTED' }
  const iter = openChunks({ signal })
  let token = null
  let job = null
  let jobDone = false
  let bitmap = null
  let full = null
  let onAbort = null
  let decoderFailed = false
  try {
    const first = await nextChunk(iter)
    if (aborted()) return ABORTED
    const header = first ? parseImageHeader(first) : null
    const format = first ? sniffImageFormat(first) : null
    if (!header || !format) return { ok: false, unsupported: 'UNSUPPORTED' }
    const pixels = header.width * header.height
    const normalCap = Math.min(limits.imageMaxDecodedPixels, limits.imageNormalMaxDecodedPixels ?? limits.imageMaxDecodedPixels)

    if (pixels <= normalCap) {
      // normal lane — unchanged semantics: bounded plaintext buffer, one full decode ≤ 16 MP
      if (plainSize > limits.imageMaxInputBytes) return { ok: false, unsupported: 'IMAGE_TOO_LARGE' }
      const parts = [first]
      let total = first.length
      for (;;) {
        if (aborted()) return ABORTED
        const chunk = await nextChunk(iter)
        if (!chunk) break
        total += chunk.length
        if (total > limits.imageMaxInputBytes) return { ok: false, unsupported: 'IMAGE_TOO_LARGE' }
        parts.push(chunk)
      }
      full = concatBytes(parts)
      parts.length = 0
      if (fullBytesRef) fullBytesRef.bytes = full
      if (admission) token = await admission.acquire({ pixels, inputBytes: plainSize, signal })
      if (aborted()) return ABORTED
      bitmap = await decode(full)
      if (aborted()) return ABORTED
      const encoded = await poster(bitmap, bitmap.width, bitmap.height, limits.posterMaxEdge)
      if (aborted()) return ABORTED
      return posterResult(encoded, out)
    }

    // reduced lane — capability + codec + measured envelope, never a full-resolution fallback
    if (!reducedOk || !IMAGE_FORMAT_CAPABILITIES[format.format]?.reducedDecode) return { ok: false, unsupported: 'HIGH_RES_TOO_LARGE' }
    if (pixels > limits.imageHighResMaxDecodedPixels) return { ok: false, unsupported: 'HIGH_RES_TOO_LARGE' }
    if (plainSize > (limits.imageHighResMaxInputBytes ?? limits.imageMaxInputBytes)) return { ok: false, unsupported: 'IMAGE_TOO_LARGE' }
    const plan = reducedDecodePlan({ width: header.width, height: header.height, posterMaxEdge: limits.posterMaxEdge })
    const reservedBytes = estimateReducedDecodeReservation({ inputBytes: plainSize, decodeBytes: plan.decodeBytes, posterMaxEdge: limits.posterMaxEdge })
    if (reservedBytes > limits.memoryCeilingBytes) return { ok: false, unsupported: 'HIGH_RES_TOO_LARGE' }
    if (admission) token = await admission.acquire({ lane: 'high-res', reservedBytes, signal })
    if (aborted()) return ABORTED
    job = reduced.startJob({ mime: format.mime, desiredWidth: plan.desiredWidth, desiredHeight: plan.desiredHeight, maxEdge: limits.posterMaxEdge })
    onAbort = () => job?.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    job.push(first)   // transferred: the caller's view is detached, nothing is retained here
    for (;;) {
      if (aborted()) return ABORTED
      const chunk = await nextChunk(iter)
      if (!chunk) break
      job.push(chunk)
    }
    job.end()
    let result
    try { result = await job.result } catch (err) { decoderFailed = !isAbort(err); throw err } finally { jobDone = true }
    if (aborted()) return ABORTED
    noteReducedDecodeResult({ ...plan, decodedWidth: result.decodedWidth, decodedHeight: result.decodedHeight })
    return posterResult({ bytes: result.bytes, width: result.width, height: result.height }, out)
  } catch (err) {
    if (aborted() || isAbort(err)) return ABORTED
    return { ok: false, unsupported: decoderFailed ? 'UNSUPPORTED' : 'INTEGRITY' }
  } finally {
    if (onAbort) signal?.removeEventListener?.('abort', onAbort)
    if (job && !jobDone) { try { job.abort() } catch { /* already finished */ } }
    try { await iter.return?.() } catch { /* stream already closed */ }
    try { bitmap?.close?.() } catch { /* injected decoder may have nothing to close */ }
    token?.release?.()
    if (full) {
      try { full.fill(0) } catch { /* best-effort cleanup; JavaScript memory is not cryptographically zeroized */ }
    }
    full = null
    if (fullBytesRef) fullBytesRef.bytes = null
  }
}

/** ผู้เล่นจริง (โปรดักต์): decode ผ่าน createImageBitmap ที่มีอยู่ ไม่มี = บอกความจริงว่าทำไม่ได้ */
async function defaultDecode(bytes) {
  if (typeof globalThis.createImageBitmap !== 'function') throw new Error('no-decoder')
  return globalThis.createImageBitmap(new Blob([bytes]))
}

/** โปสเตอร์จริง: OffscreenCanvas/Canvas → WebP ขอบสั้นไม่เกิน maxEdge; ไม่มี canvas = โยน (จอแสดงไอคอนตามจริง) */
async function defaultPoster(bitmap, w, h, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const dw = Math.max(1, Math.round(w * scale))
  const dh = Math.max(1, Math.round(h * scale))
  const canvas = new OffscreenCanvas(dw, dh)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, dw, dh)
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: dw, height: dh }
}

function concatBytes(parts) {
  const total = parts.reduce((t, p) => t + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
