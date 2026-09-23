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
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

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
 *   poster?: (bytes: Uint8Array, w: number, h: number, maxEdge: number) => { bytes: Uint8Array, width: number, height: number },
 *   createObjectUrl?: (bytes: Uint8Array) => string, revokeObjectUrl?: (url: string) => void,
 *   registerObjectUrl?: (url: string) => void, signal?: AbortSignal,
 * }} p
 * @returns {Promise<{ ok: true, url: string, width, height, posterBytes, release: () => void } | { ok: false, unsupported: 'IMAGE_TOO_LARGE'|'UNSUPPORTED'|'INTEGRITY'|'ABORTED' }>}
 */
export async function makeImageThumb({
  plainSize, limits = VAULT_TREE_CLIENT_LIMITS, variant = 2, chunkCount = 1,
  readChunk, readWhole, decode = defaultDecode, poster = defaultPoster,
  createObjectUrl = (b) => URL.createObjectURL(new Blob([b])),
  revokeObjectUrl = (u) => { try { URL.revokeObjectURL(u) } catch { /* gone */ } },
  registerObjectUrl = null, signal = null, skipUrl = false,
}) {
  if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
  if (plainSize > limits.imageMaxInputBytes) return { ok: false, unsupported: 'IMAGE_TOO_LARGE' }
  try {
    // header: V2 อ่านเฉพาะ chunk แรก; V1 ต้องถอดทั้งไฟล์ (ไฟล์ใต้เพดานเท่านั้น — ตรวจแล้วด้านบน)
    const headBytes = variant === 2 ? await readChunk(0, { signal }) : await readWhole({ signal })
    const header = parseImageHeader(headBytes)
    if (!header || header.width * header.height > limits.imageMaxDecodedPixels) {
      return { ok: false, unsupported: 'UNSUPPORTED' }
    }
    // ประกอบไบต์เต็ม: V2 = chunk แรก + chunk ถัด ๆ ไปตามลำดับ (sequential เสมอ)
    let full = headBytes
    if (variant === 2) {
      const parts = [headBytes]
      for (let i = 1; i < chunkCount; i += 1) {   // chunkCount จาก blob — ไม่มีการเดาจุดจบเอง
        if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
        const chunk = await readChunk(i, { signal })
        parts.push(chunk)
      }
      full = concatBytes(parts)
    }
    const bitmap = await decode(full)
    const encoded = await poster(full, bitmap.width, bitmap.height, limits.posterMaxEdge)
    try { bitmap.close?.() } catch { /* injected decoder may have nothing to close */ }
    const url = skipUrl ? null : createObjectUrl(encoded.bytes)
    if (url) registerObjectUrl?.(url)
    let released = false
    const out = {
      ok: true, url, width: encoded.width, height: encoded.height, posterBytes: encoded.bytes,
      release: () => {
        if (released) return
        released = true
        revokeObjectUrl(url)
        out.posterBytes = null
      },
    }
    return out
  } catch (err) {
    if (signal?.aborted || isAbort(err)) return { ok: false, unsupported: 'ABORTED' }
    return { ok: false, unsupported: 'INTEGRITY' }
  }
}

/** ผู้เล่นจริง (โปรดักต์): decode ผ่าน createImageBitmap ที่มีอยู่ ไม่มี = บอกความจริงว่าทำไม่ได้ */
async function defaultDecode(bytes) {
  if (typeof globalThis.createImageBitmap !== 'function') throw new Error('no-decoder')
  return globalThis.createImageBitmap(new Blob([bytes]))
}

/** โปสเตอร์จริง: OffscreenCanvas/Canvas → WebP ขอบสั้นไม่เกิน maxEdge; ไม่มี canvas = โยน (จอแสดงไอคอนตามจริง) */
async function defaultPoster(bytes, w, h, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const dw = Math.max(1, Math.round(w * scale))
  const dh = Math.max(1, Math.round(h * scale))
  const bitmap = await defaultDecode(bytes)
  const canvas = new OffscreenCanvas(dw, dh)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, dw, dh)
  bitmap.close?.()
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
