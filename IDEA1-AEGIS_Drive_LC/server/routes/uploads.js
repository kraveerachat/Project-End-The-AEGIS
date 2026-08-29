// server/routes/uploads.js — AEGIS Drive (IDEA1) · Resumable chunked upload (LFT-V2-A)
//
// สิ่งที่เส้นทางชุดนี้แก้ (ปัญหาที่ยืนยันแล้วใน production):
//   เส้นทางเดิม POST /api/files/upload ส่ง "ทั้งไฟล์ในคำขอ HTTP เดียว" และเบราว์เซอร์
//   ต้อง file.arrayBuffer() ทั้งไฟล์เข้า RAM ก่อนเพื่อคำนวณ SHA-256 → เพดานที่แท้จริง
//   ของขนาดไฟล์จึงเป็น RAM ของแท็บ + เพดานของหนึ่งคำขอ (multer 1 GiB, nginx 512m)
//   ไม่ใช่ความจุของ Data Lake และการหลุดกลางทางแปลว่าต้องเริ่มใหม่ทั้งไฟล์
//
// V2 แยกสองสิ่งนี้ออกจากกันอย่างถาวร:
//   - หนึ่งคำขอ HTTP = หนึ่ง chunk ที่มีขอบเขตเสมอ (ค่าเริ่มต้น 16 MiB, ปรับได้ 8–64 MiB)
//   - หนึ่งไฟล์เชิงตรรกะ = หลาย chunk ที่ประกอบกันบนดิสก์ฝั่งเซิร์ฟเวอร์
//   เพดานของไฟล์จึงมาจาก "ความจุ/โควตา/การตั้งค่า deployment" (config/transferLimits.js)
//
// ⚠️ ข้อความที่อนุญาตให้อ้างได้: ไฟล์ถูกส่งเป็น chunk ที่มีขอบเขตและทำต่อจากที่ค้างได้
//    **ห้ามอ้างว่า "ไม่จำกัดขนาดไฟล์"** ที่ใดทั้งสิ้น
//
// ── ลำดับที่ห้ามสลับ ─────────────────────────────────────────────────────────
//   1. init session  → มีแถวสถานะที่ทนต่อ restart ก่อนไบต์แรกจะเดินทาง
//   2. ส่ง chunk     → เขียนตามตำแหน่งลงไฟล์ part เดียว (idempotent เมื่อส่งซ้ำ)
//   3. ถามสถานะ      → เซิร์ฟเวอร์บอกว่าขาด chunk ไหนบ้าง (ไม่ใช่ client เดาเอง)
//   4. commit        → เซิร์ฟเวอร์ตรวจ "จำนวนไบต์ + SHA-256 จากไบต์บนดิสก์ของตัวเอง"
//   5. publish       → rename เข้า uploads/ แล้วจึงเขียนแถวใน files (atomic)
//
// ⚠️ ไม่มีขั้นตอนใดสร้างแถวใน `files` ก่อนขั้นที่ 5 — ไฟล์ที่อัปโหลดค้างจึง "มองไม่เห็น"
//    ใน GET /api/files โดยโครงสร้าง ไม่ใช่เพราะมีตัวกรองที่อาจพลาด
//
// ⚠️ ทุกเส้นทางอยู่หลัง requireAuth และผูกกับ req.user.id เสมอ — ไม่มีเส้นทางใดรับ
//    userId จาก body/params/query และ session ของผู้ใช้อื่นต้องตอบ 404 (ไม่ใช่ 403)
//    เพื่อไม่ยืนยันว่า id นั้นมีอยู่จริง (แบบแผนเดียวกับ GET /api/files/:id/download)
//
// ⚠️ CSRF: router นี้ถูก mount ใต้ app.use('/api', csrfProtection, apiRouter) เหมือนกัน
//    ทุกเส้นทาง PUT/POST/DELETE ที่นี่จึงผ่านด่าน synchronizer token เหมือน endpoint อื่น
import { Router } from 'express'
import { requireAuth } from '../middleware/requireRole.js'
import { recordAudit, sha256Hex } from '../db/connection.js'
import { requestSourceIp } from '../request/sourceIp.js'
import * as store from '../db/store.js'
import {
  MAX_SUPPORTED_LOGICAL_FILE_BYTES,
  TRANSFER_LIMITS, chunkCountFor, expectedChunkSize, reserveBytesFor,
} from '../config/transferLimits.js'
import { filesystemCapacity, removeKey } from '../storage/fileStore.js'
import {
  newUploadId, isValidUploadId, createStagedPart, writeStagedChunk,
  stagedPartSize, stagedPartSha256, newFinalStorageKey, publishStagedPartTo,
  restoreStagedPart, removeStagedSession,
} from '../storage/uploadStaging.js'

export const uploadsRouter = Router({ mergeParams: true })

const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(target) : null, result, sourceIp: requestSourceIp(req),
  })

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * ความจุที่ "วัดได้จริง" ของ mount ที่ Data Lake อยู่ + ส่วนสำรองที่กันไว้
 *
 * ⚠️ statfs อ่านไม่ได้ = "ไม่รู้" ไม่ใช่ "ศูนย์" และไม่ใช่ "พอ" — คืน measured:false
 *    แล้วปล่อยให้ผู้เรียกตัดสินใจและบอกผู้ใช้ตามจริง (ดู concepts/Honest_Telemetry)
 */
async function capacitySnapshot() {
  const capacity = await filesystemCapacity()
  if (!capacity) return { measured: false, totalBytes: null, freeBytes: null, reserveBytes: null, usableBytes: null }
  const reserveBytes = reserveBytesFor(capacity.totalBytes, TRANSFER_LIMITS)
  return {
    measured: true,
    totalBytes: capacity.totalBytes,
    freeBytes: capacity.freeBytes,
    reserveBytes,
    usableBytes: Math.max(0, capacity.freeBytes - reserveBytes),
  }
}

/** รูปทรงเดียวที่ทุก endpoint ของ session ใช้ตอบ — client อ่านที่เดียวได้ทั้ง resume และ UI */
function sessionView(session, chunks) {
  const received = chunks.map((c) => c.index)
  const receivedSet = new Set(received)
  const missing = []
  for (let index = 0; index < session.chunkCount; index += 1) {
    if (!receivedSet.has(index)) missing.push(index)
  }
  return {
    uploadId: session.uploadId,
    name: session.name,
    size: session.logicalSize,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    status: session.status,
    expiresAt: session.expiresAt,
    received,
    missing,
    receivedBytes: chunks.reduce((sum, c) => sum + c.size, 0),
  }
}

/** โหลด session ของผู้เรียก — ไม่พบ/ไม่ใช่ของเขา/id ผิดรูปแบบ ล้วนเป็น 404 เหมือนกันหมด */
async function loadOwnSession(req, res) {
  const uploadId = String(req.params.uploadId ?? '')
  if (!isValidUploadId(uploadId)) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  const session = await store.findUploadSession(uploadId, req.user.id)
  if (!session) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  return session
}

// ── เพดานที่ deployment นี้บังคับอยู่จริง — จอ Uploads แสดงค่านี้ ไม่ใช่ค่าที่ hard-code ──
// ⚠️ อยู่ก่อน '/:uploadId' โดยเจตนา และชนกันไม่ได้อยู่แล้ว: uploadId เป็น hex 48 ตัวเสมอ
uploadsRouter.get('/limits', requireAuth, async (req, res, next) => {
  try {
    res.json({
      chunkSizeBytes: TRANSFER_LIMITS.chunkSizeBytes,
      // ⚠️ สองค่านี้ต่างกันโดยเจตนาและจอต้องไม่สลับกัน:
      //    maxLogicalFileBytes = เพดานที่ "deployment นี้บังคับอยู่จริง" ณ วินาทีนี้
      //    maxSupportedLogicalFileBytes = เพดานสูงสุดที่ "ตั้งได้" ถ้าผู้ดูแลเลือกจะตั้ง
      //    การแสดงค่าที่สองเป็นเพดานของผู้ใช้คือการสัญญาสิ่งที่เซิร์ฟเวอร์จะปฏิเสธจริง
      maxLogicalFileBytes: TRANSFER_LIMITS.maxLogicalFileBytes,
      maxSupportedLogicalFileBytes: MAX_SUPPORTED_LOGICAL_FILE_BYTES,
      sessionTtlMs: TRANSFER_LIMITS.sessionTtlMs,
      capacity: await capacitySnapshot(),
    })
  } catch (err) {
    next(err)
  }
})

// ── 1. เปิด session ──────────────────────────────────────────────────────────
// ⚠️ chunkSize เป็นค่าที่ "เซิร์ฟเวอร์กำหนด" เสมอ — ค่าที่ client ส่งมาไม่ถูกอ่านเลย
//    เพราะตำแหน่งที่ chunk ถูกเขียนคือ index * chunkSize ถ้า client เปลี่ยนค่านี้ได้
//    มันจะเลือกตำแหน่งเขียนของตัวเองได้ client ต้องใช้ค่าที่ response นี้คืนกลับไป
uploadsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 200)
    const size = Number(req.body?.size)
    const claimedSha256 = typeof req.body?.sha256 === 'string' ? req.body.sha256.toLowerCase() : null

    if (!name) return res.status(400).json({ error: 'Invalid input' })
    if (!Number.isSafeInteger(size) || size < 0) return res.status(400).json({ error: 'Invalid input' })
    if (claimedSha256 !== null && !SHA256_HEX.test(claimedSha256)) {
      return res.status(400).json({ error: 'Invalid input' })
    }

    // เพดานเชิงตรรกะของ deployment — บอกค่ากลับไปด้วยเพื่อให้ UI แสดงเหตุผลได้ตรง
    if (size > TRANSFER_LIMITS.maxLogicalFileBytes) {
      await auditAct(req, 'FILE_UPLOAD_SESSION', name, 'DENIED')
      return res.status(413).json({
        error: 'File too large',
        code: 'LOGICAL_LIMIT_EXCEEDED',
        maxLogicalFileBytes: TRANSFER_LIMITS.maxLogicalFileBytes,
      })
    }

    // พื้นที่ว่าง — ปฏิเสธก่อนไบต์แรกจะเดินทาง ไม่ใช่ตอนดิสก์เต็มกลางคัน
    // ⚠️ วัดไม่ได้ = ไม่ปฏิเสธ แต่บอกไปตามจริงว่าไม่ได้ตรวจ (capacity.measured=false)
    //    การปฏิเสธทุกการอัปโหลดเพราะ statfs อ่านไม่ได้จะทำให้ระบบหยุดทำงานทั้งชุดจาก
    //    ความไม่รู้ ส่วนการแกล้งบอกว่า "พอ" คือการโกหก — ทางที่เหลือคือบอกว่าไม่ได้วัด
    const capacity = await capacitySnapshot()
    if (capacity.measured && size > capacity.usableBytes) {
      await auditAct(req, 'FILE_UPLOAD_SESSION', name, 'DENIED')
      return res.status(507).json({
        error: 'Insufficient storage',
        code: 'INSUFFICIENT_STORAGE',
        usableBytes: capacity.usableBytes,
        reserveBytes: capacity.reserveBytes,
      })
    }

    const chunkSize = TRANSFER_LIMITS.chunkSizeBytes
    const uploadId = newUploadId()
    // ไบต์ก่อน metadata: ถ้าสร้างพื้นที่พักไม่สำเร็จ ต้องไม่มีแถว session ที่ชี้ไปยัง
    // พื้นที่ที่ไม่มีอยู่ (แบบแผนเดียวกับ POST /api/files/upload ที่เขียน bytes ก่อน INSERT)
    await createStagedPart(uploadId)

    let session
    try {
      session = await store.createUploadSession({
        uploadId,
        userId: req.user.id,
        name,
        logicalSize: size,
        chunkSize,
        chunkCount: chunkCountFor(size, chunkSize),
        expectedSha256: claimedSha256,
        expiresAt: Date.now() + TRANSFER_LIMITS.sessionTtlMs,
      })
    } catch (dbErr) {
      await removeStagedSession(uploadId) // metadata ไม่ผ่าน = ต้องไม่เหลือพื้นที่พักกำพร้า
      throw dbErr
    }

    await auditAct(req, 'FILE_UPLOAD_SESSION', name)
    res.status(201).json({ upload: sessionView(session, []), capacity })
  } catch (err) {
    next(err)
  }
})

// ── 3. ถามสถานะ / ทำต่อจากที่ค้าง ────────────────────────────────────────────
uploadsRouter.get('/:uploadId', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined
    const chunks = await store.listUploadChunks(session.uploadId)
    return res.json({ upload: sessionView(session, chunks) })
  } catch (err) {
    return next(err)
  }
})

// ── 2. ส่ง chunk หนึ่งก้อน ───────────────────────────────────────────────────
// ⚠️ ไบต์ไหลจาก socket ลง fd โดยตรง (stream) — ไม่มี express.json/express.raw/multer
//    มาสะสมทั้งก้อนไว้ในหน่วยความจำ RAM ของ request นี้จึงเป็น O(ขนาด buffer ของ stream)
//    ไม่ใช่ O(ขนาด chunk) และไม่ใช่ O(ขนาดไฟล์) โดยโครงสร้าง
// ⚠️ ขนาดของ chunk ถูกกำหนดโดยเซิร์ฟเวอร์ล่วงหน้าจาก (index, logicalSize, chunkSize)
//    ค่าที่ client แจ้งมาใน Content-Length ใช้ "ปฏิเสธเร็ว" เท่านั้น ด่านจริงคือจำนวนไบต์
//    ที่ไหลผ่านจริง ซึ่งถูกตัดทันทีที่เกินและถูกปฏิเสธเมื่อขาด
uploadsRouter.put('/:uploadId/chunks/:index', requireAuth, async (req, res, next) => {
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

    const expectedBytes = expectedChunkSize(index, session.logicalSize, session.chunkSize)
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength !== expectedBytes) {
      return res.status(400).json({
        error: 'Invalid chunk size', code: 'CHUNK_SIZE_INVALID', expectedBytes,
      })
    }

    let written
    try {
      written = await writeStagedChunk(session.uploadId, {
        index,
        offset: index * session.chunkSize,
        expectedBytes,
        source: req,
      })
    } catch (writeErr) {
      // ไบต์ที่เขียนไปแล้วบางส่วนไม่ถูกบันทึกเป็น "รับแล้ว" — chunk นี้ยังขาดอยู่เหมือนเดิม
      // และการส่งซ้ำจะเขียนทับตำแหน่งเดิมทั้งช่วง จึงไม่มีไบต์เก่าปนกับไบต์ใหม่
      if (writeErr.code === 'CHUNK_TOO_LONG' || writeErr.code === 'CHUNK_LENGTH_MISMATCH') {
        return res.status(400).json({
          error: 'Invalid chunk size', code: 'CHUNK_SIZE_INVALID', expectedBytes,
        })
      }
      throw writeErr
    }

    await store.recordUploadChunk(session.uploadId, {
      index, size: written.bytesWritten, sha256: written.sha256,
    })
    const chunks = await store.listUploadChunks(session.uploadId)
    return res.json({ index, size: written.bytesWritten, sha256: written.sha256, upload: sessionView(session, chunks) })
  } catch (err) {
    return next(err)
  }
})

// ── 4–5. commit: ตรวจแล้วจึงเผยแพร่ ──────────────────────────────────────────
// ⚠️ ด่านตรวจทั้งสามชั้นเป็นของเซิร์ฟเวอร์ทั้งหมด และอ่านจาก "ไบต์บนดิสก์" เสมอ:
//      (ก) chunk ครบทุกดัชนีและขนาดแต่ละก้อนตรงกับที่คำนวณไว้
//      (ข) ขนาดไฟล์ที่ประกอบได้ = logical size ที่ประกาศไว้ตอนเปิด session
//      (ค) SHA-256 ที่เซิร์ฟเวอร์คำนวณเอง = ค่าที่ client อ้าง (ถ้ามีการอ้าง)
//    ค่าที่ client ส่งมา "ไม่เคย" ถูกใช้เป็นแหล่งความจริง — ใช้เทียบเท่านั้น
uploadsRouter.post('/:uploadId/commit', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined

    if (session.status !== 'open') {
      return res.status(409).json({ error: 'Upload session is not open', code: 'SESSION_NOT_OPEN' })
    }
    if (session.expiresAt <= Date.now()) {
      return res.status(410).json({ error: 'Upload session expired', code: 'SESSION_EXPIRED' })
    }

    // (ก) ครบทุก chunk และแต่ละก้อนมีขนาดที่ถูกต้อง
    const chunks = await store.listUploadChunks(session.uploadId)
    const view = sessionView(session, chunks)
    const wrongSize = chunks.filter(
      (c) => c.size !== expectedChunkSize(c.index, session.logicalSize, session.chunkSize),
    )
    if (view.missing.length > 0 || wrongSize.length > 0) {
      return res.status(409).json({
        error: 'Upload incomplete',
        code: 'UPLOAD_INCOMPLETE',
        upload: view,
      })
    }

    // ── จองสิทธิ์ commit พร้อม "เจตนาที่ทนต่อการตายของโปรเซส" ────────────────
    // ⚠️ key ปลายทางถูกเลือก "ก่อน" แล้วบันทึกลง commit_storage_key ในคำสั่งจองเดียวกัน
    //    เหตุผล: publish คือการ rename ไปยัง key นั้น ถ้า key มีตัวตนอยู่แค่ในตัวแปรของ
    //    โปรเซส แล้วโปรเซสตายหลัง rename ไบต์ที่ย้ายไปแล้วจะไม่มีใครรู้ว่าอยู่ที่ไหน
    //    = ของกำพร้าถาวรที่กู้ไม่ได้ ตอนนี้งานกู้คืนอ่าน key นั้นได้เสมอหลังบูตใหม่
    // ⚠️ การจองเป็นเงื่อนไขใน SQL (WHERE status = 'open') ไม่ใช่การอ่านมาเช็คใน JS
    //    จึงกัน commit สองใบพร้อมกันได้จริง และผู้แพ้ได้ 409 ที่อธิบายได้
    // ⚠️ ตรวจ chunk ครบ "ก่อน" จอง เพื่อไม่ให้คำขอที่ยังส่งไม่ครบเปลี่ยนสถานะทิ้งไว้
    const finalKey = newFinalStorageKey()
    const claimed = await store.claimUploadSessionForCommit(session.uploadId, req.user.id, finalKey)
    if (!claimed) {
      return res.status(409).json({ error: 'Upload session is not open', code: 'SESSION_NOT_OPEN' })
    }

    // คืนสถานะกลับเป็น open เมื่อ commit รอบนี้ไปต่อไม่ได้ แต่ยังแก้ไข/ลองใหม่ได้
    const release = () => store.releaseUploadSessionClaim(session.uploadId, req.user.id)

    // (ข) ขนาดจริงของไบต์ที่ประกอบได้บนดิสก์
    const actualSize = await stagedPartSize(session.uploadId)
    if (actualSize !== session.logicalSize) {
      await release()
      await auditAct(req, 'FILE_UPLOAD', session.name, 'DENIED')
      return res.status(409).json({
        error: 'Size mismatch',
        code: 'SIZE_MISMATCH',
        expectedBytes: session.logicalSize,
        actualBytes: actualSize,
      })
    }

    // (ค) SHA-256 จากไบต์ที่เซิร์ฟเวอร์อ่านเอง
    const actualSha256 = await stagedPartSha256(session.uploadId)
    if (session.expectedSha256 && session.expectedSha256 !== actualSha256) {
      // ⚠️ ไม่รู้ว่า chunk ก้อนไหนเพี้ยน จึงยกเลิกทั้ง session แล้วให้เริ่มใหม่ —
      //    การเก็บ session ที่รู้ว่าไบต์ไม่ถูกต้องไว้ให้ commit ซ้ำได้คือการเชิญให้
      //    เผยแพร่ไฟล์ที่เสียหาย ผู้ใช้เสียเวลาอัปโหลดใหม่ ดีกว่าได้ไฟล์ที่ผิดโดยไม่รู้ตัว
      await store.setUploadSessionStatus(session.uploadId, req.user.id, 'aborted')
      await removeStagedSession(session.uploadId)
      await auditAct(req, 'FILE_UPLOAD', session.name, 'DENIED')
      return res.status(422).json({
        error: 'Checksum mismatch', code: 'CHECKSUM_MISMATCH', expectedSha256: session.expectedSha256,
      })
    }

    // ── เผยแพร่: rename ไปยัง key ที่บันทึกไว้แล้ว (atomic บน volume เดียวกัน) ──
    await publishStagedPartTo(session.uploadId, finalKey)

    // ── เขียน metadata + ปิด session ใน transaction เดียว ────────────────────
    // ⚠️ แถว files, committed_file_id และ status='committed' ถูกเขียนพร้อมกันทั้งหมด
    //    ทำให้ "แถวที่ยัง committing" แปลว่า metadata ยังไม่ถูกเขียนแน่นอน — งานกู้คืน
    //    จึงไม่ต้องเดาว่าโปรเซสตายก่อนหรือหลังเขียน metadata
    // ⚠️ เส้นทางชื่อซ้ำ (เวอร์ชันใหม่) ไม่ย้ายไบต์ของไฟล์เดิมอีกต่อไป — แถว file_versions
    //    ชี้ไปยัง key เดิมตรง ๆ เดิมโค้ดเรียก moveToVersions() ก่อนเขียน metadata ซึ่ง
    //    ถ้าโปรเซสตายตรงกลาง files.path จะชี้ไปยัง key ที่ไม่มีไฟล์อยู่แล้ว = **ไฟล์เดิม
    //    ของผู้ใช้อ่านไม่ได้** ตอนนี้ช่องนั้นหายไปทั้งช่วง ไม่ใช่แค่แคบลง
    let result
    try {
      result = await store.finishUploadCommit({
        uploadId: session.uploadId,
        userId: req.user.id,
        user: req.user,
        name: session.name,
        storageKey: finalKey,
        size: actualSize,
        sha256: actualSha256,
      })
    } catch (dbErr) {
      // ⚠️ transaction ถูก ROLLBACK ไปแล้ว จึงไม่มีแถว files และ session ยังเป็น
      //    committing — เก็บกวาดในคำขอนี้ให้เรียบร้อยเพื่อไม่ต้องรองานกู้คืน แต่ถ้า
      //    โปรเซสตายตรงนี้พอดี งานกู้คืนก็ทำสิ่งเดียวกันนี้ได้เองหลังหมดสัญญาเช่า
      const restored = await restoreStagedPart(session.uploadId, finalKey).catch(() => false)
      if (restored) {
        await release().catch(() => {})
      } else {
        await removeKey(finalKey).catch(() => {})
        await removeStagedSession(session.uploadId)
        await store.setUploadSessionStatus(session.uploadId, req.user.id, 'aborted').catch(() => {})
      }
      throw dbErr
    }

    await removeStagedSession(session.uploadId)
    await auditAct(req, result.newVersion ? 'FILE_VERSION_ADD' : 'FILE_UPLOAD', session.name)
    return res.status(201).json({
      file: result.file, newVersion: result.newVersion, sha256: actualSha256,
    })
  } catch (err) {
    return next(err)
  }
})

// ── ยกเลิก session ที่ยังไม่ commit ──────────────────────────────────────────
// ⚠️ ยกเลิกได้เฉพาะสถานะ open และ aborted เท่านั้น — allow-list เดียวกับงานเก็บกวาด
//    (ดู CLEANABLE_STATUSES ใน db/store.js) สองสถานะที่เหลือมีเหตุผลคนละข้อ:
//    committed = ไบต์กลายเป็นไฟล์ของผู้ใช้ในตาราง files ไปแล้ว การลบไฟล์เป็นงานของ
//    DELETE /api/files/:id ซึ่งมีด่านของตัวเอง; committing = commit กำลังอ่านไบต์ชุด
//    นั้นอยู่ ณ วินาทีนี้
uploadsRouter.delete('/:uploadId', requireAuth, async (req, res, next) => {
  try {
    const session = await loadOwnSession(req, res)
    if (!session) return undefined
    if (session.status === 'committed') {
      return res.status(409).json({ error: 'Upload already committed', code: 'SESSION_COMMITTED' })
    }
    // ⚠️ ยกเลิกระหว่างที่ commit กำลังทำงานอยู่ไม่ได้ — การลบพื้นที่พักตอนนั้นจะดึงไบต์
    //    ออกจากใต้ commit ที่กำลังอ่าน/rename อยู่พอดี (เหตุผลเดียวกับที่งานเก็บกวาด
    //    ไม่แตะสถานะ committing) ผู้ใช้กดยกเลิกซ้ำได้หลัง commit จบและปลดสถานะแล้ว
    if (session.status === 'committing') {
      return res.status(409).json({ error: 'Upload is committing', code: 'SESSION_COMMITTING' })
    }
    await removeStagedSession(session.uploadId)
    await store.deleteUploadSession(session.uploadId, req.user.id)
    await auditAct(req, 'FILE_UPLOAD_CANCEL', session.name)
    return res.json({ ok: true })
  } catch (err) {
    return next(err)
  }
})
