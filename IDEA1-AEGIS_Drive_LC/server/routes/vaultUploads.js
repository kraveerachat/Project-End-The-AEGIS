// server/routes/vaultUploads.js — AEGIS Drive (IDEA1) · Private Vault V2 upload (LFT-V2-B)
//
// สิ่งที่เส้นทางชุดนี้แก้ (ยืนยันแล้วในซอร์สของ V1):
//   POST /api/vault/blobs รับ ciphertext "ทั้งไฟล์ในคำขอเดียว" และเบราว์เซอร์ต้อง
//   file.arrayBuffer() ทั้งไฟล์ + ถือ ciphertext ทั้งก้อนอีกชุดก่อนส่ง เพดานจริงของ
//   Vault จึงเป็น RAM ของแท็บ ไม่ใช่ความจุของ Data Lake และ MAX_VAULT_CIPHERTEXT_BYTES
//   = 64 MiB เป็นผลลัพธ์ของสถาปัตยกรรมนั้น ไม่ใช่สาเหตุ — การยกค่านั้นขึ้นจึงไม่ใช่การแก้
//
// ⚠️ Zero-Knowledge ไม่เปลี่ยนแม้แต่ข้อเดียว เส้นทางนี้ไม่เคยได้รับ:
//    passphrase / KEK / DEK ที่ยังไม่ถูกห่อ / ชื่อไฟล์ / MIME / plaintext
//    และไม่เคย decrypt, derive key, สร้าง thumbnail, transcode หรือ index อะไรทั้งสิ้น
//    สิ่งที่มันทำคือ "รับไบต์ที่อ่านไม่ออกทีละก้อน แล้วพิสูจน์ว่าไบต์นั้นยังเหมือนเดิม"
//
// ── ลำดับที่ห้ามสลับ ─────────────────────────────────────────────────────────
//   1. init session  → มีแถวสถานะ + envelope ที่ทนต่อ restart ก่อนไบต์แรกจะเดินทาง
//   2. ส่ง chunk     → หนึ่งคำขอ = หนึ่งข้อความ AES-GCM ที่สมบูรณ์ พร้อม IV ของตัวเอง
//   3. ถามสถานะ      → เซิร์ฟเวอร์บอกว่าขาด chunk ไหน (ไม่ใช่ client เดาเอง)
//   4. commit        → เซิร์ฟเวอร์ตรวจไบต์บนดิสก์ของตัวเองทีละ chunk
//   5. publish       → rename เข้า vault/ แล้วจึงเขียนแถว metadata (atomic)
//
// ⚠️ ไม่มีขั้นตอนใดสร้างแถวใน vault_v2_blobs ก่อนขั้นที่ 5 — upload ที่ค้างจึง
//    "มองไม่เห็น" ใน GET /api/vault โดยโครงสร้าง ไม่ใช่เพราะมีตัวกรองที่อาจพลาด
//
// ⚠️ ทุกเส้นทางอยู่หลัง requireAuth และผูกกับ req.user.id เสมอ — ไม่มีเส้นทางใดรับ
//    userId จาก body/params/query และของผู้ใช้อื่นต้องตอบ 404 (ไม่ใช่ 403)
// ⚠️ CSRF: router นี้ mount ใต้ app.use('/api', csrfProtection, apiRouter) เหมือนกัน
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { requireAuth } from '../middleware/requireRole.js'
import { recordAudit, sha256Hex } from '../db/connection.js'
import { requestSourceIp } from '../request/sourceIp.js'
import * as store from '../db/store.js'
import * as v2 from '../db/vaultV2Store.js'
import {
  VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES, MIN_VAULT_PLAINTEXT_CHUNK_BYTES,
  MAX_VAULT_PLAINTEXT_CHUNK_BYTES, MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES,
  expectedVaultChunkSize, vaultReserveBytesFor,
} from '../config/vaultTransferLimits.js'
import { filesystemCapacity } from '../storage/fileStore.js'
import { removeVaultCiphertext } from '../storage/vaultStore.js'
import {
  newVaultUploadId, isValidVaultUploadId, newVaultBlobId, createStagedVaultPart,
  writeStagedVaultChunk, stagedVaultPartSize, stagedVaultRangeSha256, newFinalVaultKey,
  publishStagedVaultPartTo, restoreStagedVaultPart, removeStagedVaultSession,
} from '../storage/vaultStaging.js'

export const vaultUploadsRouter = Router({ mergeParams: true })

// ⚠️ audit ของ Vault บันทึกได้แค่ actor/เวลา/ชนิดการกระทำ + hash ของ id ที่เซิร์ฟเวอร์
//    ตั้งเอง — ไม่มีชื่อไฟล์ให้บันทึกอยู่แล้วโดยโครงสร้าง และห้ามบันทึกกุญแจ/envelope/path
const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(target) : null, result, sourceIp: requestSourceIp(req),
  })

/**
 * ความจุที่วัดได้จริงของ mount ที่ Data Lake อยู่ + ส่วนสำรอง
 * ⚠️ statfs อ่านไม่ได้ = "ไม่รู้" ไม่ใช่ "ศูนย์" และไม่ใช่ "พอ" (ดู concepts/Honest_Telemetry)
 */
async function capacitySnapshot() {
  const capacity = await filesystemCapacity()
  if (!capacity) return { measured: false, totalBytes: null, freeBytes: null, reserveBytes: null, usableBytes: null }
  const reserveBytes = vaultReserveBytesFor(capacity.totalBytes)
  return {
    measured: true,
    totalBytes: capacity.totalBytes,
    freeBytes: capacity.freeBytes,
    reserveBytes,
    usableBytes: Math.max(0, capacity.freeBytes - reserveBytes),
  }
}

/**
 * รูปทรงเดียวที่ทุก endpoint ของ session ใช้ตอบ
 * ⚠️ ไม่มี storage key, ไม่มี envelope, ไม่มีอะไรที่มาจาก plaintext — client ถือ envelope
 *    ของตัวเองอยู่แล้ว การส่งกลับไปอีกรอบมีแต่จะขยายพื้นที่ที่ต้องตรวจว่าไม่รั่ว
 */
function sessionView(session, chunks) {
  const received = chunks.filter((c) => c.state === 'received').map((c) => c.index)
  const receivedSet = new Set(received)
  const missing = []
  for (let index = 0; index < session.chunkCount; index += 1) {
    if (!receivedSet.has(index)) missing.push(index)
  }
  return {
    uploadId: session.uploadId,
    formatVersion: session.formatVersion,
    contentIdB64: session.contentIdB64,
    ciphertextSize: session.ciphertextSize,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    status: session.status,
    expiresAt: session.expiresAt,
    received,
    missing,
    receivedBytes: chunks
      .filter((c) => c.state === 'received')
      .reduce((sum, c) => sum + (c.size ?? 0), 0),
  }
}

/** โหลด session ของผู้เรียก — ไม่พบ/ไม่ใช่ของเขา/id ผิดรูปแบบ ล้วนเป็น 404 เหมือนกันหมด */
async function loadOwnSession(req, res) {
  const uploadId = String(req.params.uploadId ?? '')
  if (!isValidVaultUploadId(uploadId)) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  const session = await v2.findVaultV2Session(uploadId, req.user.id)
  if (!session) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  return session
}

// ── เพดานที่ deployment นี้บังคับอยู่จริง ────────────────────────────────────
// ⚠️ อยู่ก่อน '/:uploadId' โดยเจตนา และชนกันไม่ได้: uploadId เป็น hex 48 ตัวเสมอ
// ⚠️ client ใช้ plaintextChunkBytes เป็นหน่วยการแบ่งไฟล์ ส่วนเซิร์ฟเวอร์ใช้
//    ciphertextChunkBytes เป็นหน่วยของตำแหน่งบนดิสก์ — คืนทั้งคู่เพื่อไม่ให้ฝั่งใด
//    ต้องคำนวณ overhead เอาเองแล้วคลาดกัน
vaultUploadsRouter.get('/limits', requireAuth, async (req, res, next) => {
  try {
    res.json({
      formatVersion: 2,
      plaintextChunkBytes: VAULT_TRANSFER_LIMITS.plaintextChunkBytes,
      ciphertextChunkBytes: VAULT_TRANSFER_LIMITS.ciphertextChunkBytes,
      gcmTagBytes: GCM_TAG_BYTES,
      // ⚠️ คำแนะนำของ deployment ไม่ใช่ข้อบังคับที่เซิร์ฟเวอร์ตรวจได้ — ดู vaultTransferLimits.js
      uploadConcurrency: VAULT_TRANSFER_LIMITS.uploadConcurrency,
      minPlaintextChunkBytes: MIN_VAULT_PLAINTEXT_CHUNK_BYTES,
      maxPlaintextChunkBytes: MAX_VAULT_PLAINTEXT_CHUNK_BYTES,
      // ⚠️ เพดานที่บังคับอยู่จริง กับ เพดานสูงสุดที่ตั้งได้ — ดูเหตุผลใน routes/uploads.js
      maxLogicalFileBytes: VAULT_TRANSFER_LIMITS.maxLogicalFileBytes,
      maxSupportedLogicalFileBytes: MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES,
      sessionTtlMs: VAULT_TRANSFER_LIMITS.sessionTtlMs,
      capacity: await capacitySnapshot(),
    })
  } catch (err) {
    next(err)
  }
})

// ── 1. เปิด session ──────────────────────────────────────────────────────────
//
// ⚠️ ต่างจาก Normal Files ตรงนี้จุดเดียวและมีเหตุผล: ที่นั่น **เซิร์ฟเวอร์กำหนด**
//    chunkSize เพราะมันเป็นคนแบ่งตำแหน่งของไบต์ดิบ ที่นี่ **client กำหนด** เพราะ
//    ciphertext ถูกแบ่งและปิดผนึกไปแล้วก่อนคำขอแรก เซิร์ฟเวอร์แบ่งใหม่ไม่ได้เลย
//    (จะต้องมีกุญแจ) สิ่งที่เซิร์ฟเวอร์ทำได้คือ "ตรวจว่าค่าที่ประกาศอยู่ในช่วงที่ยอมรับ
//    และสอดคล้องกันเอง" แล้ว **แช่แข็งค่านั้น** — หลังบรรทัดนี้ไม่มี endpoint ใดแก้ได้อีก
//    ตำแหน่งเขียนของทุก chunk จึงมาจากค่าในฐานข้อมูล ไม่ใช่จากคำขอที่ส่ง chunk มา
vaultUploadsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body ?? {}
    const formatVersion = Number(body.formatVersion)
    const contentIdB64 = body.contentIdB64
    const ciphertextSize = Number(body.ciphertextSize)
    const chunkSize = Number(body.chunkSize)
    const chunkCount = Number(body.chunkCount)
    const envelope = {
      wrappedDekB64: body.wrappedDekB64,
      wrapIvB64: body.wrapIvB64,
      metaIvB64: body.metaIvB64,
      metaB64: body.metaB64,
    }

    const invalid = () => res.status(400).json({ error: 'Invalid input' })
    if (formatVersion !== 2) return invalid()
    if (!v2.isValidContentIdB64(contentIdB64)) return invalid()
    if (!v2.validVaultV2Envelope(envelope)) return invalid()
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) return invalid()
    if (!Number.isSafeInteger(chunkSize)) return invalid()
    // ขนาด chunk ที่ยอมรับ = ช่วง plaintext ที่กำหนดไว้ + tag หนึ่งอัน
    if (chunkSize < MIN_VAULT_PLAINTEXT_CHUNK_BYTES + GCM_TAG_BYTES) return invalid()
    if (chunkSize > MAX_VAULT_PLAINTEXT_CHUNK_BYTES + GCM_TAG_BYTES) return invalid()
    if (!Number.isSafeInteger(ciphertextSize) || ciphertextSize < 1) return invalid()

    // ── ค่าทั้งสามต้องสอดคล้องกันเอง ไม่งั้นตำแหน่งบนดิสก์จะไม่มีความหมาย ─────────
    // ก้อนสุดท้ายต้องมีอย่างน้อย GCM tag (ไฟล์ว่าง = 1 chunk ที่มีแต่ tag)
    const lastChunkSize = ciphertextSize - (chunkCount - 1) * chunkSize
    if (lastChunkSize < GCM_TAG_BYTES || lastChunkSize > chunkSize) return invalid()

    // ⚠️ บันทึกไว้ตามตรง: เซิร์ฟเวอร์ derive ขนาด plaintext ได้จากตรงนี้
    //    (ciphertextSize − 16 × chunkCount) นี่คือการเปิดเผยชนิดเดียวกับที่ V1 มีอยู่แล้ว
    //    และเป็นเหตุผลที่ **ไม่มี** ฟิลด์ plainSize ให้ client ส่งมา — การเพิ่มฟิลด์นั้น
    //    จะทำให้เซิร์ฟเวอร์ "ถือ" ขนาด plaintext เป็นข้อมูลที่ผู้ใช้ให้มา แทนที่จะเป็นผล
    //    พลอยได้ของเลขคณิตที่หลบไม่ได้อยู่แล้ว
    const derivedPlainSize = ciphertextSize - chunkCount * GCM_TAG_BYTES
    if (derivedPlainSize < 0) return invalid()

    // ต้องตั้งค่า vault ก่อนถึงจะมี KEK ให้ห่อ DEK ได้
    const meta = await store.getVaultMeta(req.user.id)
    if (!meta) return res.status(409).json({ error: 'Vault not configured' })

    if (derivedPlainSize > VAULT_TRANSFER_LIMITS.maxLogicalFileBytes) {
      await auditAct(req, 'VAULT_V2_UPLOAD_START', String(req.user.id), 'DENIED')
      return res.status(413).json({
        error: 'File too large',
        code: 'LOGICAL_LIMIT_EXCEEDED',
        maxLogicalFileBytes: VAULT_TRANSFER_LIMITS.maxLogicalFileBytes,
      })
    }

    // พื้นที่ว่าง — ตรวจด้วย "ขนาด ciphertext ที่จะถูกเก็บจริง" ไม่ใช่ขนาด plaintext
    // ⚠️ วัดไม่ได้ = ไม่ปฏิเสธ แต่บอกไปตามจริงว่าไม่ได้ตรวจ (capacity.measured=false)
    const capacity = await capacitySnapshot()
    if (capacity.measured && ciphertextSize > capacity.usableBytes) {
      await auditAct(req, 'VAULT_V2_UPLOAD_START', String(req.user.id), 'DENIED')
      return res.status(507).json({
        error: 'Insufficient storage',
        code: 'INSUFFICIENT_STORAGE',
        usableBytes: capacity.usableBytes,
        reserveBytes: capacity.reserveBytes,
      })
    }

    const uploadId = newVaultUploadId()
    // ไบต์ก่อน metadata: ถ้าสร้างพื้นที่พักไม่สำเร็จ ต้องไม่มีแถว session ที่ชี้ไปยัง
    // พื้นที่ที่ไม่มีอยู่ (แบบแผนเดียวกับทุกเส้นทางเขียนของโปรเจกต์นี้)
    await createStagedVaultPart(uploadId)

    let session
    try {
      session = await v2.createVaultV2Session({
        uploadId,
        userId: req.user.id,
        contentIdB64,
        ciphertextSize,
        chunkSize,
        chunkCount,
        envelope,
        expiresAt: Date.now() + VAULT_TRANSFER_LIMITS.sessionTtlMs,
      })
    } catch (dbErr) {
      await removeStagedVaultSession(uploadId)
      throw dbErr
    }

    await auditAct(req, 'VAULT_V2_UPLOAD_START', uploadId)
    return res.status(201).json({ upload: sessionView(session, []), capacity })
  } catch (err) {
    return next(err)
  }
})

// ── 3. ถามสถานะ / ทำต่อจากที่ค้าง ────────────────────────────────────────────
vaultUploadsRouter.get('/:uploadId', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined
    const chunks = await v2.listVaultV2SessionChunks(session.uploadId)
    return res.json({ upload: sessionView(session, chunks) })
  } catch (err) {
    return next(err)
  }
})

// ── 2. ส่ง ciphertext ของ chunk หนึ่งก้อน ────────────────────────────────────
//
// ⚠️ body เป็น octet-stream ดิบ ไหลจาก socket ลง fd โดยตรง — ไม่มี express.json/
//    express.raw/multer มาสะสมทั้งก้อนไว้ในหน่วยความจำ
// ⚠️ IV มาทาง header ไม่ใช่ใน body: body ต้องเป็น ciphertext ล้วนเพื่อให้ตำแหน่งบนดิสก์
//    ตรงกับที่คำนวณไว้ และ IV ไม่ใช่ความลับ (ห้ามซ้ำต่อกุญแจ ≠ ต้องปกปิด)
// ⚠️ IV ที่เก็บคือ "IV ของไบต์ชุดที่เพิ่งเขียนสำเร็จ" เท่านั้น — ถูกบันทึกในคำสั่งเดียว
//    กับสถานะ received และเฉพาะเมื่อผู้เขียนคนนี้ยังเป็นเจ้าของช่อง (writer token)
//    การส่งซ้ำด้วย ciphertext ใหม่จึงต้องมาพร้อม IV ใหม่เสมอ และคู่ (IV, ไบต์) ที่ถูก
//    บันทึกจะไม่มีวันมาจากคนละคำขอ
vaultUploadsRouter.put('/:uploadId/chunks/:index', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined

    if (session.status !== 'open') {
      return res.status(409).json({ error: 'Upload session is not open', code: 'SESSION_NOT_OPEN' })
    }
    if (session.expiresAt <= Date.now()) {
      return res.status(410).json({ error: 'Upload session expired', code: 'SESSION_EXPIRED' })
    }

    const rawIndex = String(req.params.index ?? '')
    if (!/^\d{1,9}$/.test(rawIndex)) {
      return res.status(400).json({ error: 'Invalid chunk index', code: 'CHUNK_INDEX_INVALID' })
    }
    const index = Number(rawIndex)
    if (index >= session.chunkCount) {
      return res.status(400).json({ error: 'Invalid chunk index', code: 'CHUNK_INDEX_INVALID' })
    }

    const ivB64 = req.headers['x-vault-chunk-iv']
    if (!v2.isValidIvB64(ivB64)) {
      return res.status(400).json({ error: 'Invalid chunk IV', code: 'CHUNK_IV_INVALID' })
    }

    const expectedBytes = expectedVaultChunkSize(index, session.ciphertextSize, session.chunkSize)
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength !== expectedBytes) {
      return res.status(400).json({ error: 'Invalid chunk size', code: 'CHUNK_SIZE_INVALID', expectedBytes })
    }

    // ⚠️ token ของผู้เขียนคนนี้ — ครึ่งหลังของกติกาความสอดคล้อง (ดู vaultV2Store.js)
    const writerToken = randomBytes(16).toString('hex')

    let outcome
    try {
      outcome = await v2.withVaultV2ChunkWriteLock(session.uploadId, index, async () => {
        await v2.beginVaultV2ChunkWrite(session.uploadId, index, writerToken)
        const written = await writeStagedVaultChunk(session.uploadId, {
          index,
          offset: index * session.chunkSize,
          expectedBytes,
          source: req,
        })
        const finalized = await v2.finishVaultV2ChunkWrite(session.uploadId, index, {
          writerToken, size: written.bytesWritten, sha256: written.sha256, ivB64,
        })
        return { written, finalized }
      })
    } catch (writeErr) {
      // ⚠️ ช่องนี้ยังอยู่ในสถานะ 'writing' จึง "ไม่นับว่ารับแล้ว" — commit ถูกบล็อกต่อไป
      //    และการส่งซ้ำเขียนทับทั้งช่วงได้ ไม่มีไบต์เก่าปนกับไบต์ใหม่
      if (writeErr.code === 'CHUNK_TOO_LONG' || writeErr.code === 'CHUNK_LENGTH_MISMATCH') {
        return res.status(400).json({ error: 'Invalid chunk size', code: 'CHUNK_SIZE_INVALID', expectedBytes })
      }
      throw writeErr
    }

    if (!outcome.acquired) {
      // มีคำขออีกใบกำลังเขียนช่องเดียวกันอยู่ ณ วินาทีนี้ — ให้ลองใหม่ ไม่ใช่ต่อคิว
      return res.status(409).json({ error: 'Chunk write in progress', code: 'CHUNK_WRITE_IN_PROGRESS' })
    }
    if (!outcome.value.finalized) {
      // ถูกผู้เขียนคนหลังแซงระหว่างทาง — metadata ของคำขอนี้ถูกทิ้งโดยเจตนา
      return res.status(409).json({ error: 'Chunk superseded', code: 'CHUNK_SUPERSEDED' })
    }

    const chunks = await v2.listVaultV2SessionChunks(session.uploadId)
    return res.json({
      index,
      size: outcome.value.written.bytesWritten,
      upload: sessionView(session, chunks),
    })
  } catch (err) {
    return next(err)
  }
})

// ── 4–5. commit: ตรวจแล้วจึงเผยแพร่ ──────────────────────────────────────────
//
// ⚠️ สิ่งที่เซิร์ฟเวอร์พิสูจน์ได้ที่นี่คือ SERVER_CIPHERTEXT_INTEGRITY เท่านั้น:
//      (ก) chunk ครบทุกดัชนีและอยู่ในสถานะ received;
//      (ข) ขนาดของแต่ละก้อนตรงกับที่คำนวณจากค่าที่แช่แข็งไว้;
//      (ค) ขนาดรวมของไบต์บนดิสก์ = ciphertext size ที่ประกาศไว้;
//      (ง) แฮชของไบต์ "ที่อ่านจากดิสก์เดี๋ยวนี้" ตรงกับแฮชที่เซิร์ฟเวอร์บันทึกตอนรับ
//    มัน **ไม่ใช่** การพิสูจน์ plaintext และห้ามถูกเรียกแบบนั้นที่ใดทั้งสิ้น —
//    เซิร์ฟเวอร์ไม่มี DEK การอ้าง SERVER_PLAINTEXT_SHA256_VERIFY จึงเป็นคำโกหก
//    ความถูกต้องของ plaintext ถูกพิสูจน์ในเบราว์เซอร์ตอนถอด (CLIENT_AEAD_PLAINTEXT_
//    AUTHENTICATION) โดย GCM tag ของทุก chunk ทีละก้อน
vaultUploadsRouter.post('/:uploadId/commit', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined

    if (session.status !== 'open') {
      return res.status(409).json({ error: 'Upload session is not open', code: 'SESSION_NOT_OPEN' })
    }
    if (session.expiresAt <= Date.now()) {
      return res.status(410).json({ error: 'Upload session expired', code: 'SESSION_EXPIRED' })
    }

    // (ก)+(ข) ครบทุก chunk และแต่ละก้อนมีขนาดที่ถูกต้อง
    const chunks = await v2.listVaultV2SessionChunks(session.uploadId)
    const view = sessionView(session, chunks)
    const received = chunks.filter((c) => c.state === 'received')
    const wrongSize = received.filter(
      (c) => c.size !== expectedVaultChunkSize(c.index, session.ciphertextSize, session.chunkSize),
    )
    if (view.missing.length > 0 || wrongSize.length > 0) {
      return res.status(409).json({ error: 'Upload incomplete', code: 'UPLOAD_INCOMPLETE', upload: view })
    }

    // ── จองสิทธิ์ commit พร้อมเจตนาที่ทนต่อการตายของโปรเซส ───────────────────
    // key ปลายทางถูกเลือกและบันทึกใน "คำสั่งเดียวกับการจอง" ก่อน rename ใด ๆ
    const finalKey = newFinalVaultKey()
    const claimed = await v2.claimVaultV2SessionForCommit(session.uploadId, req.user.id, finalKey)
    if (!claimed) {
      return res.status(409).json({ error: 'Upload session is not open', code: 'SESSION_NOT_OPEN' })
    }
    const release = () => v2.releaseVaultV2SessionClaim(session.uploadId, req.user.id)

    // (ค) ขนาดจริงของไบต์บนดิสก์
    const actualSize = await stagedVaultPartSize(session.uploadId)
    if (actualSize !== session.ciphertextSize) {
      await release()
      await auditAct(req, 'VAULT_V2_COMMIT', session.uploadId, 'DENIED')
      return res.status(409).json({
        error: 'Size mismatch', code: 'SIZE_MISMATCH',
        expectedBytes: session.ciphertextSize, actualBytes: actualSize,
      })
    }

    // (ง) แฮชของไบต์ที่อ่านจากดิสก์เดี๋ยวนี้ ทีละ chunk
    const ordered = [...received].sort((a, b) => a.index - b.index)
    for (const chunk of ordered) {
      let actualSha
      try {
        actualSha = await stagedVaultRangeSha256(session.uploadId, {
          offset: chunk.index * session.chunkSize,
          length: chunk.size,
        })
      } catch {
        actualSha = null
      }
      if (actualSha !== chunk.sha256) {
        // ⚠️ ไบต์ที่เก็บไว้ไม่ใช่ไบต์ที่รับมา — ยกเลิกทั้ง session แล้วให้เริ่มใหม่
        //    การเก็บ session ที่รู้ว่าไบต์เพี้ยนไว้ให้ commit ซ้ำได้ คือการเชิญให้เผยแพร่
        //    ciphertext ที่ถอดไม่ออก ซึ่งผู้ใช้จะรู้ก็ต่อเมื่อพยายามเปิดไฟล์วันหนึ่ง
        await v2.setVaultV2SessionStatus(session.uploadId, req.user.id, 'aborted')
        await removeStagedVaultSession(session.uploadId)
        await auditAct(req, 'VAULT_V2_COMMIT', session.uploadId, 'DENIED')
        return res.status(422).json({
          error: 'Ciphertext integrity check failed', code: 'CIPHERTEXT_INTEGRITY_FAILED', chunkIndex: chunk.index,
        })
      }
    }

    // ── เผยแพร่: rename ไปยัง key ที่บันทึกไว้แล้ว (atomic บน volume เดียวกัน) ──
    await publishStagedVaultPartTo(session.uploadId, finalKey)

    // ── เขียน metadata ทั้งชุดใน transaction เดียว ────────────────────────────
    const blobId = newVaultBlobId()
    let blob
    try {
      blob = await v2.finishVaultV2Commit({
        uploadId: session.uploadId,
        userId: req.user.id,
        blobId,
        storageKey: finalKey,
        ciphertextSize: session.ciphertextSize,
        chunkSize: session.chunkSize,
        chunkCount: session.chunkCount,
        contentIdB64: session.contentIdB64,
        envelope: {
          wrappedDekB64: session.wrappedDekB64,
          wrapIvB64: session.wrapIvB64,
          metaIvB64: session.metaIvB64,
          metaB64: session.metaB64,
        },
        chunks: ordered.map((c) => ({ index: c.index, size: c.size, sha256: c.sha256, ivB64: c.ivB64 })),
      })
    } catch (dbErr) {
      // transaction ถูก ROLLBACK ไปแล้ว จึงไม่มีแถว blob และ session ยัง committing —
      // เก็บกวาดในคำขอนี้ให้เรียบร้อย แต่ถ้าโปรเซสตายตรงนี้พอดี งานกู้คืนทำสิ่งเดียวกันได้เอง
      const restored = await restoreStagedVaultPart(session.uploadId, finalKey).catch(() => false)
      if (restored) {
        await release().catch(() => {})
      } else {
        await removeVaultCiphertext(finalKey).catch(() => {})
        await removeStagedVaultSession(session.uploadId)
        await v2.setVaultV2SessionStatus(session.uploadId, req.user.id, 'aborted').catch(() => {})
      }
      throw dbErr
    }

    await removeStagedVaultSession(session.uploadId)
    await auditAct(req, 'VAULT_V2_COMMIT', blob.id)
    return res.status(201).json({ blob: publicVaultV2Blob(blob) })
  } catch (err) {
    return next(err)
  }
})

// ── ยกเลิก session ที่ยังไม่ commit ──────────────────────────────────────────
// ⚠️ allow-list เดียวกับงานเก็บกวาด: committed = ไบต์กลายเป็นข้อมูลของผู้ใช้ไปแล้ว
//    (ลบผ่าน DELETE /api/vault/blobs/:id ซึ่งมีด่านของตัวเอง); committing = commit
//    กำลังอ่านไบต์ชุดนั้นอยู่ ณ วินาทีนี้
vaultUploadsRouter.delete('/:uploadId', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined
    if (session.status === 'committed') {
      return res.status(409).json({ error: 'Upload already committed', code: 'SESSION_COMMITTED' })
    }
    if (session.status === 'committing') {
      return res.status(409).json({ error: 'Upload is committing', code: 'SESSION_COMMITTING' })
    }
    await removeStagedVaultSession(session.uploadId)
    await v2.deleteVaultV2Session(session.uploadId, req.user.id)
    await auditAct(req, 'VAULT_V2_UPLOAD_CANCEL', session.uploadId)
    return res.json({ ok: true })
  } catch (err) {
    return next(err)
  }
})

/**
 * รูปทรงของ blob V2 ที่ออกไปถึงเบราว์เซอร์ได้ — จุดเดียวในระบบ
 *
 * ⚠️ storage_key **ไม่อยู่ในนี้** และห้ามใส่: มันคือ path บนดิสก์ของ Storage Layer
 *    การเปิดเผยมันไม่ช่วยผู้ใช้ทำอะไรได้เลย แต่ทำให้ทุกจุดที่รับ input ต้องกันไม่ให้ถูก
 *    ส่งกลับเข้ามาเป็น path (ดู resolveKey ใน fileStore.js)
 * ⚠️ ไม่มี plaintext ใด ๆ ในนี้เช่นกัน — ชื่อไฟล์/MIME/ขนาดจริงอยู่ใน metaB64 ที่
 *    เบราว์เซอร์ถอดเอง หลังจากปลดล็อกแล้วเท่านั้น
 */
export function publicVaultV2Blob(blob) {
  return {
    id: blob.id,
    formatVersion: 2,
    size: blob.size,
    createdAt: blob.createdAt,
    contentIdB64: blob.contentIdB64,
    chunkSize: blob.chunkSize,
    chunkCount: blob.chunkCount,
    wrappedDekB64: blob.wrappedDekB64,
    wrapIvB64: blob.wrapIvB64,
    metaIvB64: blob.metaIvB64,
    metaB64: blob.metaB64,
  }
}
