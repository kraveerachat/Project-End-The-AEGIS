// src/lib/chunkedUpload.js — AEGIS Drive (IDEA1) · Resumable chunked upload ฝั่งเบราว์เซอร์
//
// ⚠️ เหตุผลที่ไฟล์นี้มีอยู่ — ปัญหาที่ยืนยันแล้วใน production:
//    เส้นทางเดิมเรียก `file.arrayBuffer()` เพื่อคำนวณ SHA-256 ทั้งไฟล์ก่อนอัปโหลด
//    นั่นคือการดึง "ทั้งไฟล์" เข้า RAM ของแท็บ ไฟล์ 2 GB = RAM 2 GB (แล้วยังต้องมีที่
//    สำหรับ FormData อีก) เพดานที่แท้จริงจึงเป็นหน่วยความจำของเบราว์เซอร์ ไม่ใช่ความจุ
//    ของ Data Lake — และการหลุดกลางทางแปลว่าต้องเริ่มใหม่ตั้งแต่ไบต์แรกเสมอ
//
// ⚠️ กติกาของไฟล์นี้ (มีชุดทดสอบตรึงไว้ทั้งสองข้อ):
//    1. **ห้ามเรียก `file.arrayBuffer()` หรืออ่านทั้งไฟล์เข้าหน่วยความจำในที่ใดทั้งสิ้น**
//       ทุกการอ่านต้องผ่าน `file.slice(start, end)` ที่มีขอบเขต
//    2. หน่วยความจำสูงสุดที่โมดูลนี้ถือไว้พร้อมกันคือ O(ขนาด chunk) ไม่ใช่ O(ขนาดไฟล์)
//       — slice ที่อ่านแล้วถูกปล่อยก่อนอ่านก้อนถัดไปเสมอ
//
// ⚠️ ใช้ createSHA256 ของ hash-wasm (dependency ที่มีอยู่แล้วเพราะ Argon2id ของ Private
//    Vault) แทน crypto.subtle.digest เพราะ WebCrypto ไม่มี streaming digest API:
//    subtle.digest รับได้แต่ buffer ทั้งก้อน ซึ่งคือปัญหาที่กำลังแก้พอดี
//    CSP ปัจจุบันมี 'wasm-unsafe-eval' อยู่แล้วสำหรับ Argon2id จึงไม่ต้องขยายสิทธิ์ใด ๆ
//
// ⚠️ SHA-256 ที่คำนวณที่นี่คือ "ค่าที่ client อ้าง" เท่านั้น เซิร์ฟเวอร์คำนวณเองจากไบต์ที่
//    ประกอบได้บนดิสก์แล้วเทียบ (ดู POST /api/files/uploads/:id/commit) ไม่ตรง = ปฏิเสธ
import { createSHA256 } from 'hash-wasm'
import { apiFetch, apiUpload } from './api.js'

/** ขนาด slice ที่ใช้ตอนแฮช — เล็กกว่า chunk ของการส่งได้ ไม่ต้องเท่ากัน */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024

/** จำนวนครั้งที่ลองส่ง chunk เดิมซ้ำก่อนจะหยุดและเปิดให้ผู้ใช้กด Resume */
const CHUNK_ATTEMPTS = 3

/** ระยะหน่วงก่อนลองใหม่ — เพิ่มขึ้นตามครั้งที่ลอง (เน็ตสะดุดชั่วครู่มักหายเองใน 1–2 วินาที) */
const retryDelayMs = (attempt) => 500 * 2 ** (attempt - 1)

const toHex = (value) => String(value).toLowerCase()

/**
 * SHA-256 ของไฟล์ทั้งก้อน โดยอ่านทีละ slice — RAM ที่ใช้เป็น O(sliceBytes)
 *
 * @param {File|Blob} file
 * @param {{ sliceBytes?: number, onProgress?: (p: { hashedBytes: number, totalBytes: number }) => void,
 *           signal?: AbortSignal }} [options]
 * @returns {Promise<string>} hex 64 ตัว
 */
export async function incrementalSha256(file, { sliceBytes = HASH_SLICE_BYTES, onProgress, signal } = {}) {
  const hasher = await createSHA256()
  hasher.init()

  const total = file.size
  for (let start = 0; start < total; start += sliceBytes) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const end = Math.min(start + sliceBytes, total)
    // ⚠️ slice() คืน Blob ที่ "ยังไม่ถูกอ่าน" — arrayBuffer() ตรงนี้จึงอ่านเฉพาะช่วงนี้
    //    ไม่ใช่ทั้งไฟล์ และตัวแปรถูกปล่อยเมื่อจบรอบก่อนอ่านก้อนถัดไป
    const buffer = await file.slice(start, end).arrayBuffer()
    hasher.update(new Uint8Array(buffer))
    onProgress?.({ hashedBytes: end, totalBytes: total })
  }
  // ไฟล์ว่างยังต้องได้แฮชของสตริงว่าง ไม่ใช่ error — เส้นทาง V1 ก็รับไฟล์ 0 ไบต์ได้
  return toHex(hasher.digest('hex'))
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

/**
 * เพดานที่ deployment นี้บังคับอยู่จริง — จอ Uploads แสดงค่านี้แทนค่าคงที่ใน bundle
 * ⚠️ ล้มเหลว = คืน null ไม่ใช่ค่าที่เดาขึ้นมา จอต้องบอกว่ายังไม่รู้ ไม่ใช่โชว์ตัวเลขปลอม
 */
export async function fetchTransferLimits({ signal, fetchJson = apiFetch } = {}) {
  const res = await fetchJson('/api/files/uploads/limits', { signal })
  return res.ok ? res.data : null
}

/** แปลผลลัพธ์ของ API ให้เป็นเหตุผลที่จอแสดงได้ตรง ไม่ใช่ 'failed' ก้อนเดียว */
function failureReason(res) {
  const code = res?.data?.code
  if (code === 'LOGICAL_LIMIT_EXCEEDED') return 'tooLarge'
  if (code === 'INSUFFICIENT_STORAGE') return 'noSpace'
  if (code === 'CHECKSUM_MISMATCH') return 'checksum'
  if (code === 'SESSION_EXPIRED') return 'expired'
  if (res?.errorKind === 'network' || res?.errorKind === 'timeout') return 'network'
  return 'server'
}

/**
 * เปิด session ใหม่บนเซิร์ฟเวอร์ — คืนสถานะเริ่มต้นที่ใช้ทั้งอัปโหลดและ resume
 * ⚠️ chunkSize มาจาก response เสมอ ไม่ใช่ค่าที่ฝั่ง client เลือก — เซิร์ฟเวอร์เขียนไบต์
 *    ที่ตำแหน่ง index * chunkSize ถ้าสองฝั่งใช้คนละค่า ไฟล์จะประกอบผิดโดยไม่มีใครรู้
 */
async function createSession({ file, sha256, fetchJson, signal }) {
  const res = await fetchJson('/api/files/uploads', {
    method: 'POST',
    body: { name: file.name, size: file.size, sha256 },
    signal,
  })
  if (!res.ok) return { ok: false, reason: failureReason(res), response: res }
  return { ok: true, upload: res.data.upload, capacity: res.data.capacity ?? null }
}

/**
 * ส่ง chunk หนึ่งก้อน — คืนสถานะล่าสุดของ session ที่เซิร์ฟเวอร์รายงานกลับมา
 * ⚠️ อ่านเฉพาะช่วงของ chunk นี้ (`file.slice`) แล้วส่ง Blob ให้ XHR โดยตรง — เบราว์เซอร์
 *    เป็นคนอ่านไบต์จาก disk ทีละบล็อกระหว่างส่ง ตัวเราไม่เคยถือทั้ง chunk ไว้ใน JS heap
 */
function sendChunk({ file, upload, index, sendUpload, onProgress, signal }) {
  const start = index * upload.chunkSize
  const end = Math.min(start + upload.chunkSize, file.size)
  return sendUpload(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`, {
    method: 'PUT',
    body: file.slice(start, end),
    headers: { 'Content-Type': 'application/octet-stream' },
    onProgress,
    signal,
    timeoutMs: 10 * 60_000,
  })
}

/**
 * อัปโหลดไฟล์หนึ่งไฟล์แบบ chunk ที่ทำต่อจากที่ค้างได้
 *
 * เรียกครั้งแรก: ส่ง { file } → hashing → เปิด session → ส่ง chunk → commit
 * เรียกซ้ำเพื่อ Resume: ส่ง { file, upload, sha256 } ที่ได้จากผลลัพธ์ครั้งก่อน →
 *   ข้ามการแฮชใหม่ ถามสถานะจากเซิร์ฟเวอร์ แล้วส่ง "เฉพาะ chunk ที่ยังขาด"
 *
 * ⚠️ ไม่ throw ในเส้นทางปกติ — คืน { ok, stage, reason, upload, sha256 } เสมอ เพื่อให้จอ
 *    แสดงสถานะได้ตรงและตัดสินใจได้ว่ายัง Resume ได้ไหม (upload ที่คืนมาไม่ใช่ null)
 *
 * @param {{ file: File, upload?: object|null, sha256?: string|null,
 *           onStage?: (stage: string) => void,
 *           onProgress?: (p: { transferredBytes: number, totalBytes: number, percent: number,
 *                              chunkIndex: number, chunkCount: number }) => void,
 *           onHashProgress?: (p: { hashedBytes: number, totalBytes: number }) => void,
 *           signal?: AbortSignal, fetchJson?: Function, sendUpload?: Function,
 *           hashFile?: Function }} options
 */
export async function uploadFileResumable({
  file,
  upload: existingUpload = null,
  sha256: existingSha256 = null,
  onStage,
  onProgress,
  onHashProgress,
  signal,
  fetchJson = apiFetch,
  sendUpload = apiUpload,
  hashFile = incrementalSha256,
}) {
  const stage = (name) => { onStage?.(name) }
  let upload = existingUpload
  let sha256 = existingSha256

  const aborted = () => Boolean(signal?.aborted)
  const cancelled = () => ({ ok: false, stage: 'cancelled', reason: 'cancelled', upload, sha256 })

  try {
    // ── เตรียม + แฮช ─────────────────────────────────────────────────────────
    if (!upload) {
      stage('preparing')
      if (!sha256) {
        stage('hashing')
        sha256 = await hashFile(file, { onProgress: onHashProgress, signal })
      }
      if (aborted()) return cancelled()

      const created = await createSession({ file, sha256, fetchJson, signal })
      if (!created.ok) {
        return { ok: false, stage: 'failed', reason: created.reason, upload: null, sha256, response: created.response }
      }
      upload = created.upload
    } else {
      // Resume — สถานะที่เชื่อถือได้มาจากเซิร์ฟเวอร์เท่านั้น ไม่ใช่จากที่จำไว้ในแท็บ
      stage('preparing')
      const status = await fetchJson(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}`, { signal })
      if (!status.ok) {
        return { ok: false, stage: 'failed', reason: failureReason(status), upload, sha256, response: status }
      }
      upload = status.data.upload
    }

    // ── ส่ง chunk ที่ยังขาด ──────────────────────────────────────────────────
    stage('uploading')
    const totalBytes = file.size
    const report = (chunkIndex, loadedInChunk) => {
      const doneBytes = upload.receivedBytes + loadedInChunk
      onProgress?.({
        transferredBytes: Math.min(doneBytes, totalBytes),
        totalBytes,
        percent: totalBytes === 0 ? 100 : Math.min(100, Math.round((doneBytes / totalBytes) * 1000) / 10),
        chunkIndex,
        chunkCount: upload.chunkCount,
      })
    }
    report(upload.received.length, 0)

    for (const index of [...upload.missing]) {
      if (aborted()) return cancelled()

      let sent = null
      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
        sent = await sendChunk({
          file, upload, index, sendUpload, signal,
          onProgress: ({ loadedBytes }) => report(index, loadedBytes),
        })
        if (sent.ok) break
        // 4xx ที่ไม่ใช่ปัญหาเครือข่าย = ส่งซ้ำก็ได้ผลเดิม อย่าวนลูปให้เสียเวลาผู้ใช้
        if (sent.status >= 400 && sent.status < 500 && sent.status !== 408) break
        if (aborted()) return cancelled()
        if (attempt < CHUNK_ATTEMPTS) await sleep(retryDelayMs(attempt), signal)
      }

      if (!sent?.ok) {
        if (aborted()) return cancelled()
        // ⚠️ session ยังอยู่ฝั่งเซิร์ฟเวอร์ — คืน upload กลับไปเพื่อให้จอเสนอ "ทำต่อ"
        //    ไม่ใช่ให้เริ่มไฟล์ใหม่ทั้งก้อน นั่นคือทั้งหมดที่ resume มีไว้เพื่อ
        return { ok: false, stage: 'paused', reason: failureReason(sent), upload, sha256, response: sent }
      }
      upload = sent.data.upload
    }

    if (aborted()) return cancelled()

    // ── commit ───────────────────────────────────────────────────────────────
    stage('committing')
    const committed = await fetchJson(
      `/api/files/uploads/${encodeURIComponent(upload.uploadId)}/commit`,
      { method: 'POST', signal, timeoutMs: 10 * 60_000 },
    )
    if (!committed.ok) {
      // เซิร์ฟเวอร์บอกว่ายังขาด chunk = ทำต่อได้ ไม่ใช่ความล้มเหลวถาวร
      if (committed.data?.code === 'UPLOAD_INCOMPLETE') {
        return { ok: false, stage: 'paused', reason: 'incomplete', upload: committed.data.upload, sha256 }
      }
      return { ok: false, stage: 'failed', reason: failureReason(committed), upload, sha256, response: committed }
    }

    stage('complete')
    return {
      ok: true, stage: 'complete', upload, sha256: committed.data.sha256 ?? sha256,
      file: committed.data.file, newVersion: Boolean(committed.data.newVersion),
    }
  } catch (err) {
    if (err?.name === 'AbortError' || aborted()) return cancelled()
    return { ok: false, stage: 'failed', reason: 'server', upload, sha256 }
  }
}

/** ยกเลิก session ฝั่งเซิร์ฟเวอร์ — คืนพื้นที่พักทันทีแทนที่จะรอให้หมดอายุ */
export async function cancelUploadSession(uploadId, { fetchJson = apiFetch } = {}) {
  if (!uploadId) return false
  const res = await fetchJson(`/api/files/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
  return res.ok
}
