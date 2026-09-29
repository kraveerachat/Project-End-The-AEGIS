// src/lib/vaultGifPreview.js — AEGIS Drive (IDEA1) · PR #157 Task 7.3 · GIF poster + bounded hover/touch motion
//
// สองขั้นของ GIF ต่อไทล์:
//   • โปสเตอร์นิ่ง = พรีวิวภาพของไบต์ GIF ผ่าน makeImageThumb (Task 7.2) — เพดานเดียวกันตาม Limits Register
//     (gifPosterDecodeBudget = imageMaxInputBytes 16 MiB + เฟรมแรก ≤ imageMaxDecodedPixels)
//   • motion (hover/กดค้าง) = ถอดทั้งไฟล์เฉพาะไฟล์ที่ plainSize ≤ limits.gifMaxFullPlayBytes และ
//     เพดานหน่วยความจำของ scheduler ยังไม่ถึง (GF-3) — ไฟล์ใหญ่กว่า = โปสเตอร์ค้างไว้ + บอกความจริงว่า
//     "ดาวน์โหลดไปดูแอนิเมชัน" ไม่มีการถอดทั้งไฟล์เพื่อ hover เด็ดขาด
// ⚠️ ไม่มี storage ใด; URL ทุกใบลงทะเบียนกับ unlockedState — ล็อก = revoke ทันที (GF-4)
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

/** ประตูความสามารถของ motion — ตัดสินก่อนดึงไบต์แม้แต่ไบต์เดียว (GF-LIMIT-PLAY) */
export function gifMotionCapability({ plainSize, limits = VAULT_TREE_CLIENT_LIMITS, schedulerMemBytes = 0 }) {
  if (schedulerMemBytes >= limits.memoryCeilingBytes) return { ok: false, unsupported: 'MEMORY_CEILING' }
  if (plainSize > limits.gifMaxFullPlayBytes) return { ok: false, unsupported: 'GIF_TOO_LARGE' }
  return { ok: true }
}

/**
 * เปิด motion: ถอดทั้ง GIF → Object URL (URL ลงทะเบียนกับ unlockedState — GF-4)
 * @returns {Promise<{ ok: true, url: string, release: () => void } | { ok: false, unsupported: 'GIF_TOO_LARGE' | 'MEMORY_CEILING' | 'INTEGRITY' | 'ABORTED' }>}
 */
export async function openGifMotion({
  plainSize, limits = VAULT_TREE_CLIENT_LIMITS, schedulerMemBytes = 0,
  readWhole, unlockedState = null, signal = null,
  createObjectUrl = (b) => URL.createObjectURL(new Blob([b], { type: 'image/gif' })),
}) {
  const cap = gifMotionCapability({ plainSize, limits, schedulerMemBytes })
  if (!cap.ok) return cap
  try {
    if (signal?.aborted) return { ok: false, unsupported: 'ABORTED' }
    const bytes = await readWhole({ signal })
    const url = createObjectUrl(bytes)
    unlockedState?.registerObjectUrl?.(url)
    let released = false
    const out = {
      ok: true, url,
      release: () => {
        if (released) return
        released = true
        unlockedState?.__hooks?.revokeObjectUrl?.(url)
        try { URL.revokeObjectURL(url) } catch { /* gone */ }
      },
    }
    return out
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return { ok: false, unsupported: 'ABORTED' }
    return { ok: false, unsupported: 'INTEGRITY' }
  }
}
