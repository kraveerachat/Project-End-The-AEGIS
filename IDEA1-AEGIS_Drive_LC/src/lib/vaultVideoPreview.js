// src/lib/vaultVideoPreview.js — AEGIS Drive (IDEA1) · PR #157 Task 7.4 · client-only video poster/hover/range preview
//
// ความสามารถต่อไฟล์วิดีโอ (VP-1):
//   • V2 + supported container + supportsLargeVideoPreview = RANGE_V2 — เล่นผ่าน range-decryption
//     session เดิม (seek = Range request ที่ map เฉพาะ chunk ที่ต้องใช้ ผ่าน planChunkReads เดิม)
//   • V1 = V1_DOWNLOAD_ONLY เสมอ (bounded fallback: พรีวิวไฟล์เต็มได้เฉพาะใต้เพดาน input กับ V1 ceiling —
//     ตัวจอเลือกปลายทางจริง โมดูลนี้ตัดสิน "ความสามารถ")
//   • ไม่ใช่ video/* = UNSUPPORTED
// โปสเตอร์/motion ต่อ session (VP-2/VP-3): เปิด session เดียว muted preload=metadata → seek เฟรมแรก →
// วาดโปสเตอร์ → ปิด session; hover = session ค้างไว้จน pointer ออก แล้วปิด + ลบ element
// ⚠️ เพดาน plaintext cache ของ worker คือ MAX_PREVIEW_PLAINTEXT_CACHE_BYTES เดิม — ไม่มี cache ใหม่ใด ๆ
import { PREVIEW_IMAGE_TYPES, PREVIEW_VIDEO_TYPES, normalizeMimeType } from './vaultPreview.js'
import { planChunkReads } from './vaultPreviewRange.js'

export const VIDEO_CAPABILITY = Object.freeze({ RANGE_V2: 'RANGE_V2', V1_DOWNLOAD_ONLY: 'V1_DOWNLOAD_ONLY', UNSUPPORTED: 'UNSUPPORTED' })

/** VP-1: ความสามารถพรีวิววิดีโอของไฟล์หนึ่ง */
export function videoPreviewCapability({ variant, mediaType, supportsLarge = false, plainSize = 0, maxPreviewBytes = Infinity }) {
  const mime = normalizeMimeType(mediaType)
  if (!PREVIEW_VIDEO_TYPES.includes(mime)) return { capability: VIDEO_CAPABILITY.UNSUPPORTED }
  if (variant === 2 && supportsLarge) return { capability: VIDEO_CAPABILITY.RANGE_V2 }
  // V1 (หรือ V2 ที่เบราว์เซอร์ไม่มี SW): fallback แบบ bounded — ไฟล์ใต้เพดาน = พรีวิวไฟล์เต็มได้
  if (plainSize <= maxPreviewBytes) return { capability: VIDEO_CAPABILITY.V1_DOWNLOAD_ONLY, fullPreviewAllowed: true }
  return { capability: VIDEO_CAPABILITY.V1_DOWNLOAD_ONLY, fullPreviewAllowed: false }
}

/** VP-4 re-assert: seek ใด ๆ map เป็นชุด chunk ที่ต้องใช้เท่านั้น (ตัวช่วยเดิมของ range-responder) */
export function chunkReadsForSeek({ position, totalBytes, plaintextChunkSize, maxChunks = 1 }) {
  const start = Math.max(0, Math.min(totalBytes - 1, Math.floor(position)))
  return planChunkReads(start, start, plaintextChunkSize)
}

/**
 * VP-2: โปสเตอร์วิดีโอผ่าน preview session เดียว
 * @param {object} p openSession: (opts) => Promise<{ token, url }>; closeSession: (token) => Promise<void>;
 *   attachVideo: ({ url, muted, preload, signal }) => Promise<{ element, seekTo: (t: number) => Promise<void>, cleanup: () => void }>;
 *   drawFrame: (videoEl: Element) => Uint8Array; posterAtSeconds?: number
 */
export async function openVideoPoster({
  variant, plainSize, mediaType, supportsLarge = false, maxPreviewBytes = Infinity,
  openSession, closeSession, attachVideo, drawFrame, posterAtSeconds = 0,
  createObjectUrl = (b) => URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })),
  registerObjectUrl = null, signal = null, returnBytes = false,
}) {
  const cap = videoPreviewCapability({ variant, mediaType, supportsLarge, plainSize, maxPreviewBytes })
  if (cap.capability === VIDEO_CAPABILITY.UNSUPPORTED) return { ok: false, unsupported: 'UNSUPPORTED' }
  let token = null
  try {
    if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
    const session = await openSession({ signal })
    token = session.token
    const { element, seekTo, cleanup } = await attachVideo({ url: session.url, muted: true, preload: 'metadata', signal })
    try {
      await seekTo(posterAtSeconds)
      const bytes = await drawFrame(element)
      if (returnBytes) return { ok: true, posterBytes: bytes, token }
      const url = createObjectUrl(bytes)
      registerObjectUrl?.(url)
      return { ok: true, url, token }
    } finally {
      cleanup?.()
      await closeSession(token)
      token = null
    }
  } catch (err) {
    if (token) { try { await closeSession(token) } catch { /* best effort */ } }
    if (signal?.aborted || err?.name === 'AbortError') return { ok: false, unsupported: 'ABORTED' }
    return { ok: false, unsupported: 'INTEGRITY' }
  }
}

/**
 * VP-3: motion ขณะ hover/กดค้าง — session ค้างไว้; ผู้เรียกปิดเองตอน pointer ออก
 * @returns {Promise<{ ok: true, url: string, token: string, release: () => Promise<void> } | { ok: false, unsupported: string }>}
 */
export async function openVideoMotion({
  variant, mediaType, openSession, closeSession, attachVideo, signal = null,
}) {
  try {
    if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
    const session = await openSession({ signal })
    const { element, cleanup } = await attachVideo({ url: session.url, muted: true, preload: 'metadata', signal })
    return {
      ok: true, url: session.url, token: session.token, element,
      release: async () => {
        try { cleanup?.() } finally { await closeSession(session.token) }
      },
    }
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return { ok: false, unsupported: 'ABORTED' }
    return { ok: false, unsupported: 'INTEGRITY' }
  }
}
