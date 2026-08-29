// src/lib/vaultChunkedUpload.js — AEGIS Drive (IDEA1) · อัปโหลด Private Vault V2
//
// ⚠️ กติกาของไฟล์นี้ (มีชุดทดสอบตรึงไว้ทุกข้อ):
//    1. **ห้ามเรียก `file.arrayBuffer()` กับทั้งไฟล์ในที่ใดทั้งสิ้น** ทุกการอ่านต้องผ่าน
//       `file.slice(start, end)` ที่มีขอบเขต — และ V2 ต้องไม่เรียก `fileToBytes()`
//       ของ V1 ด้วย (ฟังก์ชันนั้นยังอยู่เพื่อเส้นทาง V1 เท่านั้น)
//    2. หน่วยความจำสูงสุดที่ถือพร้อมกันคือ O(ขนาด chunk) ไม่ใช่ O(ขนาดไฟล์) —
//       plaintext ของก้อนหนึ่ง + ciphertext ของก้อนเดียวกัน แล้วปล่อยทั้งคู่ก่อนก้อนถัดไป
//    3. IV ใหม่ทุกครั้งที่เข้ารหัส รวมถึงตอน retry (ดู vaultChunkCrypto.js)
//    4. ส่งได้หลายก้อนพร้อมกันแบบ **มีขอบเขต** แต่ "หนึ่ง index มีผู้เขียนที่สำเร็จได้
//       คนเดียวจาก client นี้" เสมอ — คิวแจก index ให้ worker แบบซิงโครนัส จึงไม่มี
//       index ใดถูกหยิบสองครั้งโดยโครงสร้าง ไม่ใช่เพราะจังหวะเวลาบังเอิญ
//
// ⚠️ ความพร้อมกันไม่แตะข้อ 1–3 เลย: แต่ละงานยังอ่านเฉพาะ slice ของตัวเอง ยังปล่อย
//    plaintext ทันทีที่ปิดผนึกเสร็จ และยังเข้ารหัสใหม่ด้วย IV ใหม่ทุกครั้งที่ retry
//    หน่วยความจำสูงสุดจึงเป็น O(ขนาด chunk × ความพร้อมกัน) — ค่าคงที่ที่ไม่ขึ้นกับ
//    ขนาดไฟล์เช่นเดิม ไม่ใช่ O(ขนาดไฟล์)
//
// ⚠️ ลำดับที่ห้ามสลับ และเหตุผล:
//      สร้างซอง (DEK + metadata ที่เข้ารหัสแล้ว) → เปิด session → ส่ง chunk → commit
//    ซองถูกส่งไปพร้อมคำขอเปิด session เพราะเซิร์ฟเวอร์ต้องมี "ทุกอย่างที่ไม่ใช่เนื้อไฟล์"
//    ครบตั้งแต่ก่อนไบต์แรกเดินทาง ถ้าซองมาทีหลัง (ตอน commit) การล่มกลางคันจะทิ้ง
//    ciphertext ที่ไม่มีกุญแจห่อไว้เลย = ไบต์ที่ไม่มีทางถอดได้ของจริง
//
// ⚠️ ทุกอย่างในไฟล์นี้ทำงานได้เฉพาะตอนปลดล็อกอยู่ — KEK มาจาก React state ของจอ Vault
//    และงานจะถูกยกเลิกทันทีที่ผู้ใช้กดล็อก (ผ่าน AbortSignal) ดู Vault.jsx
import { apiFetch, apiUpload } from './api.js'
import {
  VAULT_FORMAT_V2, planVaultChunks, plaintextRangeFor,
  createVaultV2Envelope, encryptVaultChunk,
} from './vaultChunkCrypto.js'

/** จำนวนครั้งที่ลองส่ง chunk เดิมซ้ำก่อนหยุดและเปิดให้ผู้ใช้กด Resume */
const CHUNK_ATTEMPTS = 3

/** ช่วงความพร้อมกันที่รองรับ — ต้องตรงกับ server/config/vaultTransferLimits.js */
export const MIN_UPLOAD_CONCURRENCY = 1
export const MAX_UPLOAD_CONCURRENCY = 4
export const DEFAULT_UPLOAD_CONCURRENCY = 2

/**
 * ค่าความพร้อมกันที่ใช้ได้จริง
 * ⚠️ ที่นี่ **clamp** ไม่ใช่ throw ต่างจากฝั่งเซิร์ฟเวอร์โดยเจตนา: เซิร์ฟเวอร์ปฏิเสธที่จะ
 *    บูตด้วยค่าที่ตั้งผิดได้ แต่แท็บของผู้ใช้ปฏิเสธที่จะอัปโหลดเพราะเซิร์ฟเวอร์ตอบเลขแปลก
 *    ไม่ได้ — การหยุดให้บริการเพราะค่าคำแนะนำผิดรูปคือการลงโทษผู้ใช้แทนผู้ดูแล
 */
export function resolveUploadConcurrency(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < MIN_UPLOAD_CONCURRENCY) return DEFAULT_UPLOAD_CONCURRENCY
  return Math.min(MAX_UPLOAD_CONCURRENCY, n)
}

/** ระยะหน่วงก่อนลองใหม่ — เพิ่มขึ้นตามครั้งที่ลอง */
const retryDelayMs = (attempt) => 500 * 2 ** (attempt - 1)

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

/**
 * เพดานของ Vault V2 ที่ deployment นี้บังคับอยู่จริง
 * ⚠️ ล้มเหลว = คืน null ไม่ใช่ค่าที่เดาขึ้นมา จอต้องบอกว่ายังไม่รู้ ไม่ใช่โชว์ตัวเลขปลอม
 */
export async function fetchVaultTransferLimits({ signal, fetchJson = apiFetch } = {}) {
  const res = await fetchJson('/api/vault/uploads/limits', { signal })
  return res.ok ? res.data : null
}

/** แปลผลลัพธ์ของ API ให้เป็นเหตุผลที่จอแสดงได้ตรง ไม่ใช่ 'failed' ก้อนเดียว */
function failureReason(res) {
  const code = res?.data?.code
  if (code === 'LOGICAL_LIMIT_EXCEEDED') return 'tooLarge'
  if (code === 'INSUFFICIENT_STORAGE') return 'noSpace'
  if (code === 'CIPHERTEXT_INTEGRITY_FAILED') return 'integrity'
  if (code === 'SESSION_EXPIRED') return 'expired'
  if (code === 'CHUNK_WRITE_IN_PROGRESS' || code === 'CHUNK_SUPERSEDED') return 'conflict'
  if (res?.status === 409 && res?.data?.error === 'Vault not configured') return 'notConfigured'
  if (res?.errorKind === 'network' || res?.errorKind === 'timeout') return 'network'
  return 'server'
}

/**
 * อัปโหลดไฟล์หนึ่งไฟล์เข้า Private Vault ด้วยรูปแบบ V2
 *
 * เรียกครั้งแรก: ส่ง { kek, file } → สร้างซอง → เปิด session → เข้ารหัส+ส่งทีละก้อน → commit
 * เรียกซ้ำเพื่อ Resume: ส่ง { kek, file, resume } ที่ได้จากผลลัพธ์ครั้งก่อน → ถามสถานะจาก
 *   เซิร์ฟเวอร์ แล้วเข้ารหัส+ส่ง "เฉพาะก้อนที่ยังขาด" ด้วย IV ใหม่ทุกก้อน
 *
 * ⚠️ ไม่ throw ในเส้นทางปกติ — คืน { ok, stage, reason, resume } เสมอ เพื่อให้จอแสดง
 *    สถานะได้ตรงและตัดสินใจได้ว่ายัง Resume ได้ไหม
 * ⚠️ `resume` ที่คืนกลับมามี DEK เป็น CryptoKey แบบ non-extractable อยู่ในนั้น —
 *    มันอยู่ได้เฉพาะใน memory ของแท็บที่ปลดล็อกอยู่ ห้ามนำไป serialize ลง storage ใด ๆ
 *
 * @param {{ kek: CryptoKey, file: File, plaintextChunkBytes?: number,
 *           concurrency?: number,
 *           resume?: object|null,
 *           onStage?: (stage: string) => void,
 *           onProgress?: (p: object) => void,
 *           signal?: AbortSignal, fetchJson?: Function, sendUpload?: Function }} options
 */
export async function uploadVaultFileChunked({
  kek,
  file,
  plaintextChunkBytes,
  concurrency,
  resume = null,
  onStage,
  onProgress,
  signal,
  fetchJson = apiFetch,
  sendUpload = apiUpload,
}) {
  const stage = (name) => { onStage?.(name) }
  const aborted = () => Boolean(signal?.aborted)

  let state = resume
  const cancelled = () => ({ ok: false, stage: 'cancelled', reason: 'cancelled', resume: state })

  try {
    // ── เตรียม: แผนการแบ่ง + ซอง + session ───────────────────────────────────
    if (!state) {
      stage('preparing')

      let chunkBytes = plaintextChunkBytes
      let lanes = concurrency
      // ⚠️ ถามเซิร์ฟเวอร์ต่อเมื่อ "ยังไม่รู้ขนาด chunk" เท่านั้น — ขนาด chunk เป็นค่าที่
      //    ผิดกันไม่ได้ระหว่างสองฝั่ง (ตำแหน่งเขียนของทุกก้อนคำนวณจากมัน) ส่วนความ
      //    พร้อมกันเป็นเพียงคำแนะนำ การบังคับให้ต้องมีคำขอเพิ่มอีกใบเพียงเพื่ออ่าน
      //    คำแนะนำ จะทำให้ผู้เรียกที่รู้ขนาด chunk อยู่แล้วล้มเมื่อ endpoint นั้นล่ม
      if (!chunkBytes) {
        const limits = await fetchVaultTransferLimits({ signal, fetchJson })
        if (!limits) return { ok: false, stage: 'failed', reason: 'server', resume: null }
        chunkBytes = limits.plaintextChunkBytes
        // deployment เก่าที่ยังไม่ตอบ uploadConcurrency ต้องใช้งานได้ต่อ ไม่ใช่ล้ม
        if (lanes === undefined) lanes = limits.uploadConcurrency
      }

      const plan = planVaultChunks(file.size, chunkBytes)
      // ★ ทุกอย่างที่เป็นความลับถูกปิดผนึกตรงนี้ — บรรทัดถัดไปคือ network call แรก
      const envelope = await createVaultV2Envelope(kek, {
        name: file.name, type: file.type, size: file.size, chunkCount: plan.chunkCount,
      })
      if (aborted()) return cancelled()

      const created = await fetchJson('/api/vault/uploads', {
        method: 'POST',
        body: {
          formatVersion: VAULT_FORMAT_V2,
          contentIdB64: envelope.contentIdB64,
          ciphertextSize: plan.ciphertextSize,
          chunkSize: plan.chunkSize,
          chunkCount: plan.chunkCount,
          wrappedDekB64: envelope.wrappedDekB64,
          wrapIvB64: envelope.wrapIvB64,
          metaIvB64: envelope.metaIvB64,
          metaB64: envelope.metaB64,
        },
        signal,
        timeoutMs: 30_000,
      })
      if (!created.ok) {
        return { ok: false, stage: 'failed', reason: failureReason(created), resume: null, response: created }
      }
      state = {
        upload: created.data.upload,
        dek: envelope.dek,
        contentId: envelope.contentId,
        plan,
        concurrency: resolveUploadConcurrency(lanes),
      }
    } else {
      // Resume — สถานะที่เชื่อถือได้มาจากเซิร์ฟเวอร์เท่านั้น ไม่ใช่จากที่จำไว้ในแท็บ
      stage('preparing')
      const status = await fetchJson(
        `/api/vault/uploads/${encodeURIComponent(state.upload.uploadId)}`, { signal },
      )
      if (!status.ok) {
        return { ok: false, stage: 'failed', reason: failureReason(status), resume: state, response: status }
      }
      state = { ...state, upload: status.data.upload }
    }

    // ── เข้ารหัสและส่งหลายก้อนพร้อมกันแบบมีขอบเขต ────────────────────────────
    //
    // ⚠️ ทำไมเป็น "คิวเดียว + worker คงที่" ไม่ใช่ Promise.all เป็นชุด ๆ:
    //    การแบ่งเป็นชุดทำให้ทั้งชุดต้องรอก้อนที่ช้าที่สุดก่อนเริ่มชุดถัดไป ซึ่งคืน
    //    เวลาที่ประหยัดได้กลับไปเกือบหมดเมื่อขนาดก้อนไม่เท่ากัน (ก้อนสุดท้ายคือเศษ)
    //    worker ที่ดึงจากคิวเดียวจะมีงานทำตลอดจนกว่าคิวจะหมด
    const { plan, dek, contentId } = state
    const totalBytes = file.size
    const lanes = resolveUploadConcurrency(state.concurrency ?? concurrency)
    const doneChunks = new Set(state.upload.received)

    const plainSizeOf = (i) => {
      const r = plaintextRangeFor(i, totalBytes, plan.plaintextChunkBytes)
      return r.end - r.start
    }

    // ⚠️ ตัวนับสองตัวที่ต้องไม่ทับกันเด็ดขาด:
    //      settledBytes  = ไบต์ของก้อนที่เซิร์ฟเวอร์ "ยืนยันแล้ว"
    //      inflightBytes = ไบต์ของก้อนที่ "ยังเดินทางอยู่" ต่อ index
    //    ก้อนหนึ่งอยู่ในตัวใดตัวหนึ่งเท่านั้น ไม่เคยอยู่ทั้งสองพร้อมกัน — การย้ายจาก
    //    inflight ไป settled เกิดในบรรทัดติดกันก่อน report() เสมอ นั่นคือทั้งหมดที่
    //    กันไม่ให้แถบความคืบหน้านับก้อนเดียวซ้ำสองรอบตอนมีหลายก้อนวิ่งพร้อมกัน
    let settledBytes = 0
    for (const i of doneChunks) settledBytes += plainSizeOf(i)
    const inflightBytes = new Map()

    // สถานะที่จอแสดง: 'uploading' ทันทีที่มีก้อนใดกำลังส่ง ไม่งั้นคือ 'encrypting'
    // ⚠️ ไม่ประกาศสถานะจาก worker แต่ละตัวตรง ๆ ไม่งั้นข้อความบนจอจะสั่นไปมาระหว่าง
    //    "กำลังเข้ารหัส" กับ "กำลังอัปโหลด" ทุกเสี้ยววินาทีเมื่อมีสองก้อนวิ่งสวนกัน
    let uploadingCount = 0
    let lastStage = null
    const syncStage = () => {
      const next = uploadingCount > 0 ? 'uploading' : 'encrypting'
      if (next !== lastStage) { lastStage = next; stage(next) }
    }

    const report = (phase) => {
      let live = 0
      let lowest = null
      for (const [index, loaded] of inflightBytes) {
        live += loaded
        if (lowest === null || index < lowest) lowest = index
      }
      // ⚠️ ก้อนที่ผู้ใช้เห็นคือก้อนที่ "ต่ำที่สุดที่ยังไม่เสร็จ" ไม่ใช่ก้อนที่เพิ่งรายงานเข้ามา
      //    ไม่งั้นตัวเลข "ส่วนที่ X" จะกระโดดไปมาระหว่างสองก้อนที่วิ่งพร้อมกัน
      const chunkIndex = lowest ?? Math.min(plan.chunkCount - 1, doneChunks.size)
      const done = Math.min(totalBytes, settledBytes + live)
      onProgress?.({
        phase,
        transferredBytes: done,
        totalBytes,
        percent: totalBytes === 0 ? 100 : Math.min(100, Math.round((done / totalBytes) * 1000) / 10),
        chunkIndex,
        chunkCount: plan.chunkCount,
        inflightChunks: inflightBytes.size,
        concurrency: lanes,
      })
    }
    report('uploading')

    // คิวเดียวที่ worker ทุกตัวดึงจากมัน — cursor เพิ่มแบบซิงโครนัส ไม่มี await คั่น
    // จึงไม่มีทางที่สอง worker จะได้ index เดียวกัน (ข้อกำหนดข้อ 3 ของงานนี้)
    const queue = [...state.upload.missing]
    let cursor = 0
    /** ความล้มเหลวที่ทำให้หยุดแจกงานใหม่ — งานที่ออกไปแล้วยังจบของตัวเองได้ตามปกติ */
    let terminal = null
    let latestUpload = state.upload

    /** ส่งก้อนเดียวจนสำเร็จหรือหมดสิทธิ์ลอง — IV ใหม่ทุกครั้งที่เข้ารหัส */
    async function sendChunk(index) {
      const range = plaintextRangeFor(index, totalBytes, plan.plaintextChunkBytes)
      const plainInChunk = range.end - range.start
      let sent = null

      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
        if (aborted()) return null

        // ── เข้ารหัสก้อนนี้ (IV ใหม่ทุกครั้ง รวมถึงทุกครั้งที่ retry) ─────────
        // ⚠️ retry เริ่มนับไบต์ของก้อนนี้ใหม่จากศูนย์ ไบต์ของความพยายามที่ล้มเหลว
        //    ไม่เคยไปถึงเซิร์ฟเวอร์ การนับต่อจากของเดิมคือการนับไบต์ที่ไม่มีอยู่จริง
        inflightBytes.set(index, 0)
        syncStage()
        report('encrypting')
        // ⚠️ slice() คืน Blob ที่ยังไม่ถูกอ่าน — arrayBuffer() ตรงนี้อ่านเฉพาะช่วงนี้
        //    ไม่ใช่ทั้งไฟล์ และตัวแปรถูกปล่อยก่อนอ่านก้อนถัดไปเสมอ
        let plaintext = new Uint8Array(await file.slice(range.start, range.end).arrayBuffer())
        const encrypted = await encryptVaultChunk(dek, {
          contentId, chunkIndex: index, chunkCount: plan.chunkCount, plaintext,
        })
        plaintext = null // ปล่อย plaintext ทันทีที่ปิดผนึกเสร็จ ไม่ถือค้างระหว่างส่ง
        if (aborted()) return null

        uploadingCount += 1
        syncStage()
        try {
          sent = await sendUpload(
            `/api/vault/uploads/${encodeURIComponent(state.upload.uploadId)}/chunks/${index}`,
            {
              method: 'PUT',
              body: new Blob([encrypted.ciphertext], { type: 'application/octet-stream' }),
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-Vault-Chunk-IV': encrypted.ivB64,
              },
              onProgress: ({ loadedBytes, totalBytes: chunkTotal }) => {
                // ไบต์ที่ส่งไปเป็น ciphertext — เทียบสัดส่วนกลับเป็น plaintext เพื่อให้
                // ตัวเลขบนจอเป็นหน่วยเดียวกับขนาดไฟล์ที่ผู้ใช้เห็น
                const ratio = chunkTotal > 0 ? Math.min(1, loadedBytes / chunkTotal) : 0
                inflightBytes.set(index, Math.round(plainInChunk * ratio))
                report('uploading')
              },
              signal,
              timeoutMs: 10 * 60_000,
            },
          )
        } finally {
          uploadingCount -= 1
          syncStage()
        }

        if (sent.ok) return sent
        // 4xx ที่ไม่ใช่ปัญหาเครือข่าย/ชนกัน = ส่งซ้ำก็ได้ผลเดิม
        if (sent.status >= 400 && sent.status < 500 && sent.status !== 408 && sent.status !== 409) return sent
        if (aborted()) return null
        if (attempt < CHUNK_ATTEMPTS) await sleep(retryDelayMs(attempt), signal)
      }
      return sent
    }

    async function worker() {
      for (;;) {
        // ⚠️ เงื่อนไขหยุดถูกตรวจ "ก่อนหยิบงานใหม่" เท่านั้น — งานที่ออกไปแล้วต้องจบ
        //    ของตัวเองได้เสมอ การทิ้งคำขอที่ค้างอยู่กลางทางคือการทิ้งไบต์ที่เซิร์ฟเวอร์
        //    อาจรับไว้แล้วโดยที่ client ไม่รู้ ซึ่งทำให้ resume คำนวณผิด
        if (terminal || aborted()) return
        const index = queue[cursor]
        if (index === undefined) return
        cursor += 1

        const sent = await sendChunk(index)

        if (aborted()) { inflightBytes.delete(index); return }
        if (!sent?.ok) {
          inflightBytes.delete(index)
          terminal ??= sent ?? null
          report('uploading')
          return
        }

        // ★ ย้ายจาก inflight → settled ในสองบรรทัดติดกัน ไม่มี await คั่น
        inflightBytes.delete(index)
        if (!doneChunks.has(index)) {
          doneChunks.add(index)
          settledBytes += plainSizeOf(index)
        }
        // ⚠️ เก็บมุมมองที่ "ใหม่ที่สุด" ไว้ ไม่ใช่มุมมองของคำขอที่จบเป็นใบสุดท้าย —
        //    เมื่อมีหลายคำขอวิ่งพร้อมกัน ใบที่จบทีหลังอาจถือ received ที่เก่ากว่า
        if ((sent.data?.upload?.received?.length ?? -1) >= (latestUpload.received?.length ?? -1)) {
          latestUpload = sent.data.upload
        }
        report('uploading')
      }
    }

    await Promise.all(Array.from({ length: Math.min(lanes, Math.max(1, queue.length)) }, worker))

    state = { ...state, upload: latestUpload }

    if (aborted()) return cancelled()
    if (terminal) {
      // ⚠️ session ยังอยู่ฝั่งเซิร์ฟเวอร์ — คืน resume กลับไปเพื่อให้จอเสนอ "ทำต่อ"
      //    ไม่ใช่ให้เข้ารหัสและอัปโหลดใหม่ทั้งไฟล์ นั่นคือทั้งหมดที่ resume มีไว้เพื่อ
      //    การ resume จะไปถามสถานะจริงจากเซิร์ฟเวอร์อีกครั้ง ไม่เชื่อ latestUpload นี้
      return { ok: false, stage: 'paused', reason: failureReason(terminal), resume: state, response: terminal }
    }

    if (aborted()) return cancelled()

    // ── commit ───────────────────────────────────────────────────────────────
    stage('committing')
    const committed = await fetchJson(
      `/api/vault/uploads/${encodeURIComponent(state.upload.uploadId)}/commit`,
      { method: 'POST', signal, timeoutMs: 10 * 60_000 },
    )
    if (!committed.ok) {
      if (committed.data?.code === 'UPLOAD_INCOMPLETE') {
        return {
          ok: false, stage: 'paused', reason: 'incomplete',
          resume: { ...state, upload: committed.data.upload },
        }
      }
      return { ok: false, stage: 'failed', reason: failureReason(committed), resume: state, response: committed }
    }

    stage('complete')
    return { ok: true, stage: 'complete', blob: committed.data.blob, resume: null }
  } catch (err) {
    if (err?.name === 'AbortError' || aborted()) return cancelled()
    return { ok: false, stage: 'failed', reason: 'server', resume: state }
  }
}

/** ยกเลิก session ฝั่งเซิร์ฟเวอร์ — คืนพื้นที่พักทันทีแทนที่จะรอให้หมดอายุ */
export async function cancelVaultUploadSession(uploadId, { fetchJson = apiFetch } = {}) {
  if (!uploadId) return false
  const res = await fetchJson(`/api/vault/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
  return res.ok
}
