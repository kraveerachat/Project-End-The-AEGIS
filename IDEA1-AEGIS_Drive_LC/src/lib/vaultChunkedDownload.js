// src/lib/vaultChunkedDownload.js — AEGIS Drive (IDEA1) · ดาวน์โหลด Private Vault V2
//
// ⚠️ กติกาข้อเดียวที่ทั้งไฟล์นี้มีไว้เพื่อรักษา:
//    **ห้ามมี plaintext ของทั้งไฟล์อยู่ในหน่วยความจำของแท็บ ณ เวลาใดเวลาหนึ่ง**
//    วงจรคือ ขอ chunk → ประกอบ AAD เอง → ถอด → เขียนลง sink ทันที → ปล่อยหน่วยความจำ
//    → ก้อนถัดไป หน่วยความจำสูงสุดจึงเป็น O(ขนาด chunk) ไม่ใช่ O(ขนาดไฟล์)
//
// ⚠️ AAD ถูกประกอบขึ้น "ในเบราว์เซอร์" จากค่าที่เบราว์เซอร์ถืออยู่แล้ว (formatVersion,
//    contentId, index, chunkCount) — เซิร์ฟเวอร์ไม่เคยส่ง AAD มาให้ ถ้ามันเป็นคนบอก
//    เซิร์ฟเวอร์ที่ถูกยึดจะสั่งให้เบราว์เซอร์ "ยอมรับ" ก้อนที่สลับตำแหน่งหรือมาจากไฟล์อื่น
//    ได้ทันที ซึ่งทำลายจุดประสงค์ทั้งหมดของการผูก AAD
//
// ⚠️ ความล้มเหลวใด ๆ = หยุดทั้งการดาวน์โหลด และ **ห้ามส่งมอบไฟล์ที่อ้างว่าสมบูรณ์**
//    ไฟล์ปลายทางที่สร้างไว้แล้วถูกสั่ง abort() ตามที่ API ของเบราว์เซอร์รองรับ
//    ("ไฟล์ที่ถูกตัดหางแต่เปิดได้" คืออันตรายที่สุด เพราะผู้ใช้จะไม่รู้ว่ามันไม่ครบ)
import { apiFetchBytes } from './api.js'
import {
  decryptVaultChunk, unwrapVaultV2Dek, decryptVaultV2MetaWithDek, plaintextRangeFor, GCM_TAG_BYTES,
} from './vaultChunkCrypto.js'

/**
 * เพดานของ "ทางเลือกสำรองที่บัฟเฟอร์ใน RAM"
 *
 * ⚠️ 64 MiB ไม่ใช่ตัวเลขที่เลือกมาลอย ๆ: มันคือเพดานเดิมของ Vault V1 พอดี — เบราว์เซอร์
 *    ที่ไม่มี File System Access API จึงยังทำได้ "เท่าที่เคยทำได้อยู่แล้ว" ไม่มากกว่านั้น
 *    และไม่น้อยกว่านั้น การตั้งให้สูงกว่านี้เท่ากับนำปัญหาหน่วยความจำที่ V2 แก้ไป
 *    กลับเข้ามาทางประตูหลัง
 */
export const MAX_BUFFERED_PLAINTEXT_BYTES = 64 * 1024 * 1024

/** เบราว์เซอร์นี้เขียนไฟล์แบบสตรีมได้ไหม — ตรวจจากความสามารถจริง ไม่ใช่จาก user agent */
export function supportsStreamingFileSink(scope = globalThis) {
  return typeof scope?.showSaveFilePicker === 'function'
}

/**
 * ขนาด plaintext ที่ประเมินได้จากขนาด ciphertext — ใช้ตัดสินใจเรื่องเพดานเท่านั้น
 * ⚠️ ค่าจริงอยู่ใน metadata ที่เข้ารหัส (plainSize) ฟังก์ชันนี้มีไว้สำหรับจังหวะที่ยัง
 *    ไม่ได้ถอด metadata และเป็นเลขคณิตชุดเดียวกับที่เซิร์ฟเวอร์ก็ทำได้ (บันทึกไว้ตามตรง)
 */
export function estimatedPlainSize(blob) {
  return Math.max(0, Number(blob.size) - Number(blob.chunkCount) * GCM_TAG_BYTES)
}

/**
 * sink ที่เขียนลงไฟล์จริงผ่าน File System Access API
 * ⚠️ ผู้เรียกต้องเปิด showSaveFilePicker() จาก "การกดของผู้ใช้โดยตรง" เท่านั้น —
 *    เบราว์เซอร์ปฏิเสธการเปิดตัวเลือกไฟล์ที่ไม่ได้มาจาก user gesture โดยออกแบบ
 */
export function createFileSystemSink(writable) {
  return {
    kind: 'filesystem',
    async write(bytes) { await writable.write(bytes) },
    async close() { await writable.close() },
    async abort() {
      // ⚠️ abort() ของ FileSystemWritableFileStream ทิ้งไฟล์ปลายทางที่เขียนค้างไว้
      //    ถ้าเบราว์เซอร์ไม่รองรับ ก็ยังต้องไม่ประกาศว่าสำเร็จ (ผู้เรียกรายงานล้มเหลว)
      try { await writable.abort?.() } catch { /* ปลายทางอาจถูกปิดไปแล้ว */ }
    },
  }
}

/**
 * sink สำรองที่บัฟเฟอร์ใน RAM — **มีเพดานบังคับ** ไม่ใช่ "พยายามให้ได้"
 * ⚠️ เกินเพดาน = โยนทันทีตั้งแต่ก้อนที่ทำให้เกิน ไม่ใช่ปล่อยให้แท็บค้างแล้วตาย
 */
export function createBufferedSink({ limitBytes = MAX_BUFFERED_PLAINTEXT_BYTES } = {}) {
  let parts = []
  let total = 0
  return {
    kind: 'buffered',
    async write(bytes) {
      total += bytes.length
      if (total > limitBytes) {
        parts = []
        throw Object.assign(new Error('buffered sink limit exceeded'), { code: 'BUFFER_LIMIT' })
      }
      parts.push(bytes)
    },
    async close() { return parts },
    async abort() { parts = [] },
    result: () => parts,
  }
}

/**
 * ดาวน์โหลด + ถอดรหัส blob V2 ทีละ chunk ลง sink
 *
 * @param {{ kek?: CryptoKey, dek?: CryptoKey, blob: object, sink: object,
 *           onProgress?: (p: object) => void, signal?: AbortSignal,
 *           fetchBytes?: Function }} options
 * @returns {Promise<{ ok: boolean, reason?: string, chunksRead: number, bytesWritten: number,
 *                     meta?: object }>}
 */
export async function downloadVaultV2({
  kek, dek: providedDek, blob, sink, onProgress, signal, fetchBytes = apiFetchBytes,
}) {
  const aborted = () => Boolean(signal?.aborted)
  let dek = providedDek
  let meta = null
  let bytesWritten = 0
  let chunksRead = 0

  const fail = async (reason) => {
    // ⚠️ ยกเลิกปลายทางเสมอเมื่อล้มเหลว — ไฟล์ครึ่ง ๆ ที่เปิดได้คือคำโกหกที่แย่ที่สุด
    await sink.abort?.().catch?.(() => {})
    return { ok: false, reason, chunksRead, bytesWritten }
  }

  try {
    if (!dek) {
      if (!kek) return fail('no-key')
      dek = await unwrapVaultV2Dek(kek, blob)
    }
    // metadata ถูกถอดที่นี่ด้วย AAD ของมันเอง — ถ้าซองนี้ถูกสลับมาจากไฟล์อื่นจะล้มที่นี่
    meta = await decryptVaultV2MetaWithDek(dek, blob)
    const plainSize = Number(meta.plainSize ?? 0)

    for (let index = 0; index < blob.chunkCount; index += 1) {
      if (aborted()) return fail('cancelled')

      // ── ขอทีละก้อน — หนึ่งคำขอ หนึ่งข้อความ AEAD ─────────────────────────
      const res = await fetchBytes(
        `/api/vault/blobs/${encodeURIComponent(blob.id)}/chunks/${index}`, { signal },
      )
      if (!res.ok || !res.bytes) return fail(res.errorKind === 'network' ? 'network' : 'fetch')

      const ivB64 = res.headers?.get?.('X-Vault-Chunk-IV')
      if (!ivB64) return fail('missing-iv')

      // ── ประกอบ AAD เอง แล้วถอด — ล้มเหลว = หยุด ไม่ใช่ข้าม ────────────────
      let plain
      try {
        plain = await decryptVaultChunk(dek, {
          contentId: blob.contentIdB64,
          chunkIndex: index,
          chunkCount: blob.chunkCount,
          ivB64,
          ciphertext: res.bytes,
        })
      } catch {
        return fail('auth-failed')
      }

      // ขนาดของก้อนที่ถอดได้ต้องตรงกับแผนของไฟล์นี้ — GCM รับรองเนื้อ ไม่ได้รับรองว่า
      // ผู้ส่งไม่ได้ส่งก้อนที่ "ถูกต้องแต่ผิดขนาด" มาให้ (ซึ่งจะทำให้ไฟล์ผลลัพธ์เพี้ยน)
      const range = plaintextRangeFor(index, plainSize, blob.chunkSize - GCM_TAG_BYTES)
      if (plain.length !== range.end - range.start) return fail('chunk-size-mismatch')

      await sink.write(plain)
      bytesWritten += plain.length
      chunksRead += 1
      plain = null // ปล่อยทันที — ก้อนถัดไปต้องไม่ทับซ้อนกับก้อนนี้ในหน่วยความจำ

      onProgress?.({
        chunkIndex: index,
        chunkCount: blob.chunkCount,
        bytesWritten,
        totalBytes: plainSize,
        percent: plainSize === 0 ? 100 : Math.min(100, Math.round((bytesWritten / plainSize) * 1000) / 10),
      })
    }

    if (bytesWritten !== Number(meta.plainSize ?? 0)) return fail('size-mismatch')

    const result = await sink.close()
    return { ok: true, chunksRead, bytesWritten, meta, result }
  } catch (err) {
    if (err?.code === 'BUFFER_LIMIT') return fail('too-large-for-memory')
    if (err?.name === 'AbortError' || aborted()) return fail('cancelled')
    if (err?.message === 'wrong-key') return fail('wrong-key')
    return fail('failed')
  }
}
