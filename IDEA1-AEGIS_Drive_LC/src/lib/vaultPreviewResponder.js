// src/lib/vaultPreviewResponder.js — AEGIS Drive (IDEA1) · ตัวสร้างคำตอบของ preview (LFT-V2-E3)
//
// ⚠️ ไฟล์นี้คือ "สมอง" ของ Service Worker ทั้งหมด ส่วนตัว worker เอง
//    (src/vaultPreviewServiceWorker.js) เป็นเพียงเปลือกบาง ๆ ที่ต่อ event เข้ากับที่นี่
//
//    เหตุผลของการแยกไม่ใช่ความสวยงามของโครงสร้าง แต่เป็นเรื่องที่ตรวจสอบได้:
//    Service Worker รันใน node:test ไม่ได้ ถ้าตรรกะการถอดรหัส การแมปช่วงไบต์ และการ
//    ประกอบ header อยู่ในนั้น มันจะกลายเป็น "โค้ดความปลอดภัยที่ไม่มีชุดทดสอบ" ซึ่งเป็น
//    สิ่งเดียวกับที่ทั้งโครงการนี้พยายามไม่ให้มี ที่นี่รับ fetch เข้ามาเป็นพารามิเตอร์
//    จึงทดสอบด้วยเซิร์ฟเวอร์จำลองได้ทั้งเส้นทาง
//
// ⚠️ กติกาที่ห้ามผ่อน (มีเทสต์ตรึงทุกข้อ):
//    1. **ไม่ประกอบ plaintext ทั้งไฟล์** ไม่ว่าคำขอจะเป็นแบบใด — สตรีมทีละก้อนเสมอ
//       หน่วยความจำสูงสุดต่อหนึ่งคำขอคือ O(ขนาดก้อน) ไม่ใช่ O(ขนาดไฟล์)
//    2. **ถอดไม่ผ่าน = หยุดส่งไบต์ทันที** ไม่ข้ามก้อน ไม่เติมศูนย์ ไม่ส่งของที่เหลือ
//       วิดีโอที่ "เล่นต่อได้แต่มีก้อนที่พิสูจน์ไม่ได้" คือสิ่งที่แย่กว่าการเล่นไม่ได้
//    3. **AAD ประกอบเองในเครื่องเสมอ** จาก contentId/index/chunkCount ที่หน้าเว็บถืออยู่
//       เซิร์ฟเวอร์ไม่เคยเป็นคนบอกว่าก้อนนี้คือก้อนที่เท่าไรของไฟล์ไหน
//    4. **ไม่มี Cache API** และทุกคำตอบมี Cache-Control: no-store
import { decryptVaultChunk } from './vaultChunkCrypto.js'
import {
  parseRangeHeader, planChunkReads, planWholeFileReads,
  plaintextChunkSizeFor, buildPreviewHeaders, contentRangeValue,
  PREVIEW_RANGE_WINDOW_BYTES,
} from './vaultPreviewRange.js'
import {
  PREVIEW_FAILURE_REASON, isBenignPreviewCancellation, previewRequestCanceledError,
} from './vaultPreviewErrors.js'
import { mbPerSecond } from './vaultPreviewDiagnostics.js'

/** เหตุผลที่ทำให้ต้องหยุดกลางสตรีม — ส่งกลับไปให้หน้าเว็บแสดงผลตามจริง */
export const PREVIEW_FAILURE = Object.freeze({
  INTEGRITY: PREVIEW_FAILURE_REASON.INTEGRITY_FAILED,
  FETCH: PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED,
  MISSING_IV: PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED,
  SIZE_MISMATCH: PREVIEW_FAILURE_REASON.INTEGRITY_FAILED,
  RANGE_INVALID: PREVIEW_FAILURE_REASON.RANGE_INVALID,
})

/** ที่อยู่ของก้อน ciphertext — สร้างจาก scope ของ worker ไม่ใช่ค่าที่ฝังไว้ */
export function chunkUrlFor(base, blobId, index) {
  return `${base}api/vault/blobs/${encodeURIComponent(blobId)}/chunks/${index}`
}

/**
 * ดึงหนึ่งก้อนแล้วถอดรหัส — คืน plaintext ของก้อนนั้นทั้งก้อน
 * ⚠️ ตรวจขนาดหลังถอดด้วยเหตุผลเดียวกับ vaultChunkedDownload.js: GCM รับรอง "เนื้อของ
 *    ข้อความนี้" แต่ไม่ได้รับรองว่าผู้ส่งไม่ได้ส่งก้อนที่ถูกต้องแต่ผิดขนาดมาให้
 */
export async function readPlainChunk(session, index, { fetchImpl, base, signal, onDiagnostic }) {
  const fetchStarted = Date.now()
  const res = await fetchImpl(chunkUrlFor(base, session.blob.id, index), {
    credentials: 'same-origin',
    signal,
  })
  if (!res.ok) throw Object.assign(new Error('chunk fetch failed'), { previewFailure: PREVIEW_FAILURE.FETCH })

  const ivB64 = res.headers?.get?.('X-Vault-Chunk-IV')
  if (!ivB64) throw Object.assign(new Error('missing iv'), { previewFailure: PREVIEW_FAILURE.MISSING_IV })

  const ciphertext = new Uint8Array(await res.arrayBuffer())
  const fetchedAt = Date.now()

  let plain
  try {
    plain = await decryptVaultChunk(session.dek, {
      contentId: session.blob.contentIdB64,
      chunkIndex: index,
      chunkCount: session.blob.chunkCount,
      ivB64,
      ciphertext,
    })
  } catch {
    // ⚠️ ครอบคลุมทั้งไบต์ที่ถูกแก้ ก้อนที่สลับตำแหน่ง และก้อนที่มาจากไฟล์อื่น —
    //    ทั้งสามกรณีทำให้ AAD หรือ tag ไม่ตรง และทั้งสามต้องจบเหมือนกันคือ "ไม่ส่งไบต์"
    throw Object.assign(new Error('chunk auth failed'), { previewFailure: PREVIEW_FAILURE.INTEGRITY })
  }
  const decryptedAt = Date.now()
  // ⚠️ LFT-V2-E3.3: ตัวเลขสองบรรทัดนี้คือสิ่งที่บอกได้ว่าคอขวดอยู่ที่ "ดึง" หรือ "ถอด"
  //    ซึ่งเป็นคำถามที่หลักฐานจากระบบจริงตอบไม่ได้ (CPU ของคอนเทนเนอร์ 0–8% แต่ NET
  //    ได้เพียง ~4 MB/s) การเดาผิดข้างหมายถึงการแก้ผิดที่ทั้งรอบ
  const fetchDurationMs = fetchedAt - fetchStarted
  const decryptDurationMs = decryptedAt - fetchedAt
  onDiagnostic?.('chunk-timing', {
    ciphertextChunksFetched: 1,
    ciphertextBytesFetched: ciphertext.byteLength,
    fetchDurationMs,
    decryptDurationMs,
    ciphertextMbPerSecond: mbPerSecond(ciphertext.byteLength, fetchDurationMs),
    decryptMbPerSecond: mbPerSecond(ciphertext.byteLength, decryptDurationMs),
  })

  const chunkSize = plaintextChunkSizeFor(session.blob)
  const expected = Math.min(chunkSize, Math.max(0, session.plainSize - index * chunkSize))
  if (plain.length !== expected) {
    throw Object.assign(new Error('chunk size mismatch'), { previewFailure: PREVIEW_FAILURE.SIZE_MISMATCH })
  }
  return plain
}

/**
 * สตรีมที่ปล่อยไบต์ plaintext ตามแผน ทีละก้อน
 *
 * ⚠️ ก้อนก่อนหน้าถูกปล่อยก่อนดึงก้อนถัดไปเสมอ (pull() หนึ่งครั้ง = หนึ่งก้อน) —
 *    นี่คือจุดที่ทำให้ "วิดีโอ 4 GiB" กับ "วิดีโอ 40 MiB" ใช้หน่วยความจำเท่ากัน
 */
export function createPreviewStream(session, plan, {
  fetchImpl, base, onFailure, onDiagnostic,
  readChunk = readPlainChunk,
  StreamCtor = globalThis.ReadableStream,
}) {
  let cursor = 0
  // ⚠️ "This response was canceled" is request-local state, and it must be read
  //    *after* the await below, not before: a pull() already in flight when the
  //    media element supersedes this response is exactly the case that used to
  //    surface as a fatal chunk-fetch failure for the whole preview.
  let canceled = false
  const requestAbort = new AbortController()
  const streamStartedAt = Date.now()

  return new StreamCtor({
    async pull(controller) {
      if (cursor >= plan.length) {
        onDiagnostic?.('response-complete', { responseDurationMs: Date.now() - streamStartedAt })
        controller.close()
        return
      }
      const step = plan[cursor]
      cursor += 1

      let plain
      try {
        plain = await readChunk(session, step.index, {
          fetchImpl, base, signal: requestAbort.signal, onDiagnostic,
        })
      } catch (err) {
        // ★ หยุดที่นี่ ไม่มีทางอื่น — ผู้เล่นจะเห็นสตรีมขาด และหน้าเว็บได้รับเหตุผลจริง
        cursor = plan.length
        if (isBenignPreviewCancellation(err, { requestCanceled: canceled })) {
          // ⚠️ Deliberate cancellation: no onFailure, no chunk-fetch-failed, no
          //    UI network error. A stale Range the player already replaced must
          //    never mark the live preview broken. Integrity failures are
          //    excluded from this branch by contract and stay fatal below.
          try { controller.error(err) } catch { /* already canceled by the consumer */ }
          return
        }
        onFailure?.(err?.previewFailure ?? PREVIEW_FAILURE.FETCH)
        controller.error(err)
        return
      }

      // Bytes decrypted for a response the browser has already dropped are
      // simply not enqueued. The work was bounded and is now discarded.
      if (canceled) {
        cursor = plan.length
        return
      }
      try {
        controller.enqueue(plain.subarray(step.sliceStart, step.sliceEnd))
      } catch {
        cursor = plan.length
      }
    },
    cancel() {
      // ผู้เล่นกระโดดไปตำแหน่งอื่นหรือปิดวิดีโอ — เลิกดึงก้อนที่เหลือทันที
      // ⚠️ This aborts only this request's own signal. Whether that signal
      //    reaches a network fetch is the loader's decision: a shared,
      //    session-owned chunk load must survive one response being canceled
      //    (see vaultPreviewWorkerState.js), or cancelling Range A would poison
      //    Range B that is waiting on the very same chunk.
      canceled = true
      cursor = plan.length
      requestAbort.abort(previewRequestCanceledError())
    },
  })
}

/**
 * สร้างคำตอบสำหรับคำขอ preview หนึ่งใบ
 *
 * @param {object} session { dek, blob, contentType, plainSize }
 * @param {{ method?: string, rangeHeader?: string|null }} request
 * @returns {{ status: number, headers: object, plan: object[]|null, streamable: boolean }}
 *          ตัวเรียก (worker) เป็นคนประกอบ Response จริง — ที่นี่ตัดสินใจล้วน ๆ จึงทดสอบได้
 */
export function planPreviewResponse(session, { method = 'GET', rangeHeader = null } = {}) {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { 'Cache-Control': 'no-store', Allow: 'GET, HEAD' }, plan: null, streamable: false }
  }

  const total = Math.max(0, Number(session.plainSize) || 0)
  const chunkSize = plaintextChunkSizeFor(session.blob)
  const range = parseRangeHeader(rangeHeader, total)

  if (range.kind === 'unsatisfiable') {
    // ⚠️ 416 ต้องมาพร้อม Content-Range แบบ '*/total' ไม่งั้นผู้เล่นบางตัวจะวนขอซ้ำ
    return {
      status: 416,
      headers: {
        'Content-Range': `bytes */${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
      plan: null,
      streamable: false,
    }
  }

  if (range.kind === 'none') {
    // ⚠️ คำขอที่ไม่มี Range ยังต้องสตรีม ไม่ใช่ประกอบทั้งไฟล์แล้วค่อยส่ง —
    //    เบราว์เซอร์บางตัวยิงคำขอแรกแบบไม่มี Range ก่อนเสมอ
    return {
      status: 200,
      headers: buildPreviewHeaders({ contentType: session.contentType, contentLength: total }),
      plan: method === 'HEAD' ? [] : planWholeFileReads(total, chunkSize),
      streamable: method !== 'HEAD',
    }
  }

  const start = range.start
  const end = range.openEnded
    ? Math.min(range.end, start + PREVIEW_RANGE_WINDOW_BYTES - 1)
    : range.end
  return {
    status: 206,
    headers: buildPreviewHeaders({
      contentType: session.contentType,
      contentLength: end - start + 1,
      contentRange: contentRangeValue(start, end, total),
    }),
    plan: method === 'HEAD' ? [] : planChunkReads(start, end, chunkSize),
    streamable: method !== 'HEAD',
  }
}
