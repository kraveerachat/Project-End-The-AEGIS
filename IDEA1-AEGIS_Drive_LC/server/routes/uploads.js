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
  TRANSFER_LIMITS, chunkCountFor, expectedChunkSize, reserveBytesFor,
} from '../config/transferLimits.js'
import { filesystemCapacity, removeKey, moveToVersions } from '../storage/fileStore.js'
import {
  newUploadId, isValidUploadId, createStagedPart, writeStagedChunk,
  stagedPartSize, stagedPartSha256, publishStagedPart, restoreStagedPart, removeStagedSession,
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
      maxLogicalFileBytes: TRANSFER_LIMITS.maxLogicalFileBytes,
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

    // ── จองสิทธิ์ commit (open → committing) ก่อนแตะไบต์ใด ๆ ──────────────────
    // ⚠️ นี่คือจุดที่กัน "commit ซ้อนกันสองใบเผยแพร่สองแถว" และมันต้องเป็นเงื่อนไขใน
    //    SQL (UPDATE ... WHERE status = 'open') ไม่ใช่การอ่านสถานะมาเช็คใน JS
    //    การอ่านแล้วค่อยเขียนมีช่องให้คำขออีกใบอ่านค่าเดียวกันไปก่อน
    // ⚠️ ตรวจ chunk ครบ "ก่อน" จอง เพื่อไม่ให้คำขอที่ยังส่งไม่ครบไปเปลี่ยนสถานะของ
    //    session ทิ้งไว้ — สถานะ committing ต้องหมายถึง "กำลัง commit จริง" เท่านั้น
    const claimed = await store.claimUploadSessionForCommit(session.uploadId, req.user.id)
    if (!claimed) {
      // มีคำขออีกใบจองไปแล้ว (หรือ session เปลี่ยนสถานะไประหว่างทาง) — ผู้แพ้ต้องไม่
      // เผยแพร่อะไรทั้งสิ้น และต้องได้คำตอบที่อธิบายได้ ไม่ใช่ 500 จาก rename ที่ล้ม
      return res.status(409).json({ error: 'Upload session is not open', code: 'SESSION_NOT_OPEN' })
    }

    // คืนสถานะกลับเป็น open เมื่อ commit รอบนี้ไปต่อไม่ได้ แต่ยังแก้ไข/ลองใหม่ได้
    const release = () => store.setUploadSessionStatus(session.uploadId, req.user.id, 'open')

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

    // เผยแพร่: rename เข้า uploads/ (atomic บน volume เดียวกัน) แล้วจึงเขียน metadata
    const storageKey = await publishStagedPart(session.uploadId)

    // อัปโหลดชื่อเดิมทับของตัวเอง = เวอร์ชันใหม่ — แบบแผนและด่าน ownership เดียวกับ
    // POST /api/files/upload เป๊ะ ๆ (findOwnFileByName ผูกกับ uploaded_by เสมอ)
    const existing = await store.findOwnFileByName(session.name, req.user.id)
    let row
    try {
      if (existing) {
        const archivedKey = await moveToVersions(existing.path)
        row = await store.replaceFileContents({
          file: existing,
          storageKey, size: actualSize, sha256: actualSha256,
          previous: archivedKey
            ? { key: archivedKey, size: existing.size, sha256: existing.sha256 }
            : null,
          user: req.user,
        })
        if (!row) throw new Error('file row vanished mid-commit')
      } else {
        row = await store.recordUpload({
          name: session.name, storageKey, size: actualSize, sha256: actualSha256, user: req.user,
        })
      }
    } catch (dbErr) {
      // ⚠️ metadata ไม่ผ่าน = ต้องไม่เหลือไบต์กำพร้าที่ไม่มีแถวใดอ้างถึง **และ** ต้องไม่
      //    เหลือ session ที่โกหก ไบต์ถูก rename ออกจากพื้นที่พักไปแล้วตอน publish
      //    ถ้าเพียงลบมันทิ้งแล้วปลดสถานะกลับเป็น open จะได้ session ที่แถว chunk บอกว่า
      //    "รับครบแล้ว" (missing: []) แต่ไบต์หายไปจริง → commit ซ้ำได้ SIZE_MISMATCH
      //    ตลอดไปโดยไม่มีทางแก้ จึงย้ายไบต์ "กลับ" มาเป็น part ก่อนเสมอ
      const restored = await restoreStagedPart(session.uploadId, storageKey).catch(() => false)
      if (restored) {
        // ทำต่อได้จริง: ไบต์ยังครบ ผู้ใช้กด commit ซ้ำได้โดยไม่ต้องอัปโหลดใหม่ทั้งไฟล์
        await release().catch(() => {})
      } else {
        // ย้ายกลับไม่ได้ = ไบต์ชุดนั้นเชื่อถือไม่ได้แล้ว ปิด session อย่างซื่อสัตย์
        // แทนที่จะทิ้งไว้ให้ commit ซ้ำไม่รู้จบ (แบบแผนเดียวกับ checksum mismatch)
        await removeKey(storageKey).catch(() => {})
        await removeStagedSession(session.uploadId)
        await store.setUploadSessionStatus(session.uploadId, req.user.id, 'aborted').catch(() => {})
      }
      throw dbErr
    }

    await store.setUploadSessionStatus(session.uploadId, req.user.id, 'committed')
    await removeStagedSession(session.uploadId)

    await auditAct(req, existing ? 'FILE_VERSION_ADD' : 'FILE_UPLOAD', session.name)
    return res.status(201).json({ file: row, newVersion: Boolean(existing), sha256: actualSha256 })
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
