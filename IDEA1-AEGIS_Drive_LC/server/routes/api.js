// server/routes/api.js — AEGIS Drive (IDEA1)
// /api/login · /api/logout · /api/me · /api/audit (Admin)
// ⚠️ login รับแค่ { username, password, remember } — ห้ามรับค่า role จาก client
//    server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { verifyCredentials } from '../auth/login.js'
import {
  establishSession, currentUser, currentCsrfToken, destroySession, markPasswordReset,
  setSessionDisplayName, listSessionsForUser, countSessionsByUser, revokeSessionByRef, sessionRef,
  setSessionPreferences,
  unlockTrashSession, lockTrashSession, trashAuthorization,
} from '../auth/session.js'
import { checkLock, recordFailure, recordSuccess } from '../auth/rateLimit.js'
import { requestSourceIp } from '../request/sourceIp.js'
import { getNavForRole } from '../rbac/permissions.js'
import { requireAuth, requireRole } from '../middleware/requireRole.js'
import {
  recordAudit, readAudit, sha256Hex,
  getUserById, createUserWithTempPassword, updatePasswordHash, listUsers,
  updateProfileName, updateAvatar, getAvatar, effectiveDisplayName,
  updateUserPreferences, DEFAULT_USER_PREFERENCES,
} from '../db/connection.js'
import { ROLES } from '../rbac/permissions.js'
import * as store from '../db/store.js'
// Resumable chunked upload (LFT-V2-A) — เส้นทาง V2 ของการโอนไฟล์ใหญ่ แยกไฟล์เพราะเป็น
// โปรโตคอลของตัวเอง (session → chunk → status → commit) ไม่ใช่ endpoint เดี่ยว ๆ
import { uploadsRouter } from './uploads.js'
// Private Vault V2 (LFT-V2-B) — โปรโตคอลของตัวเองเช่นกัน และ "ไม่ใช้ตารางร่วม" กับ
// เส้นทางด้านบน เพราะ upload_sessions มีคอลัมน์ name เป็น plaintext ซึ่ง Vault ห้ามมี
import { vaultUploadsRouter, publicVaultV2Blob } from './vaultUploads.js'
import * as vaultV2 from '../db/vaultV2Store.js'
import { isValidVaultBlobId } from '../storage/vaultStaging.js'
// Server Telemetry — ประกอบจาก host agent (Unix socket) + ค่าที่ Drive วัดเองได้
import { buildTelemetry } from '../telemetry/index.js'
// Storage & Backup — capacity (Drive), physical disk health (host agent, validated),
// backup state/risk (backup agent, validated), RAID (declared not configured).
import { buildStorageReport } from '../storage/storageReport.js'
// Backup administration — Drive never runs a backup; it forwards allowlisted
// commands to the host backup agent and holds the write-freeze it asks for.
import { BACKUP_ROUTES, adminBackupView, backupCommand, backupMaintenance } from '../backup/index.js'
// Storage Layer — ไฟล์ดิบอยู่บน filesystem (Docker volume) ไม่ใช่ใน Postgres
import {
  uploadMiddleware, keyForUploaded, resolveKey, sizeOfFile, sha256OfFile,
  keyExists, openReadStream, discardUploaded,
  moveToVersions, restoreFromVersions,
} from '../storage/fileStore.js'
// Storage Layer ของ Vault — แยกโฟลเดอร์จาก uploads/ และเก็บ "ciphertext ล้วน" เท่านั้น
import {
  vaultUploadMiddleware, keyForUploadedVaultBlob,
  openVaultCiphertext, openVaultCiphertextRange, vaultCiphertextSize, removeVaultCiphertext,
} from '../storage/vaultStore.js'
// Storage Layer ของรูปโปรไฟล์ — โฟลเดอร์แยก + ตรวจชนิดจากไบต์จริง + ถอด EXIF ก่อนเขียน
import {
  avatarUploadMiddleware, sanitizeAvatar, writeAvatar,
  openAvatar, avatarSize, removeAvatar,
} from '../storage/avatarStore.js'
import { purgeTrashRecord, withTrashFileLock } from '../storage/trashCleanup.js'

// ข้อความล้มเหลว "รูปแบบเดียว" ทุกกรณี — user ผิด / รหัสผิด / ไม่กรอก → เหมือนกันหมด
// ข้อความ error เหมือนกันทุกกรณี และใช้เวลาประมวลผลเท่ากัน เพื่อป้องกัน username enumeration
const INVALID_CREDENTIALS = 'Invalid credentials'

// สิ่งที่ client เห็นได้ — role เปิดเผยเพื่อ "แสดงผล" แต่ client ตั้งค่ามันไม่ได้
// mustResetPassword เป็น boolean ล้วน (ไม่รั่ว hash/รหัสผ่าน) — ใช้แค่พา client ไปหน้ารีเซ็ต
// id ถูกเปิดเผยเพื่อประกอบ URL ของรูปโปรไฟล์ (GET /api/users/:id/avatar) เท่านั้น —
// มันไม่ใช่ความลับ (audit เห็นอยู่แล้ว) และ "ไม่ใช่" credential: ทุก endpoint ยังตัดสิน
// สิทธิ์จาก req.user.id ที่มาจาก session เสมอ ไม่เคยจาก id ที่ client ส่งกลับมา
// accountName = ชื่อที่ Admin ตั้ง (display_name) แสดงคู่กับชื่อโปรไฟล์เมื่อไม่ตรงกัน
const publicUser = (u) => ({
  id: String(u.id),
  username: u.username,
  displayName: u.displayName,
  accountName: u.accountName ?? u.displayName,
  role: u.role,
  mustResetPassword: Boolean(u.mustResetPassword),
  preferences: u.preferences ?? { ...DEFAULT_USER_PREFERENCES },
})

export const apiRouter = Router()

// ── Backup write-freeze gate ────────────────────────────────────────────
// While the host backup agent holds a bounded lease, destructive mutations
// (delete, same-name replace, version restore, vault delete/commit) answer
// 503 BACKUP_MAINTENANCE so the metadata dump and the byte snapshot describe
// the same state. Reads, downloads, shares and un-committed uploads continue.
// Applied only to a request that already carries a session: an anonymous
// caller keeps getting the route's own 401 and learns nothing about a job.
// (Consistency model: shared/host-backup-agent/src/job.js · server/backup/maintenance.js)
apiRouter.use((req, res, next) => (currentUser(req) ? backupMaintenance.middleware(req, res, next) : next()))

apiRouter.post('/login', async (req, res) => {
  // รับเฉพาะ field ที่อนุญาต — ถ้า client แนบ role มา เราไม่เคยอ่านมัน
  const { username, password, remember } = req.body ?? {}

  // rate limit ก่อนแตะ DB — ล็อกแล้วตอบ 429 ทันที (ทั้งแกนบัญชีและแกน IP)
  const lock = checkLock(req, username)
  if (lock.locked) {
    res.set('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)))
    return res.status(429).json({ error: INVALID_CREDENTIALS, lockedMs: lock.retryAfterMs })
  }

  if (!username || !password) {
    recordFailure(req, username)
    return res.status(401).json({ error: INVALID_CREDENTIALS })
  }

  let user
  try {
    user = await verifyCredentials(username, password)
  } catch (err) {
    console.error('[aegis-drive] login error', err)
    return res.status(500).json({ error: 'Internal error' })
  }

  if (!user) {
    const { accountLockMs, ipLockMs } = recordFailure(req, username)
    // ความพยายามที่ล้มเหลว + เหตุการณ์ lockout ต้องลง audit เสมอ (forensics)
    // ⚠️ username ที่พิมพ์ผิด ๆ อาจเป็นรหัสผ่านหลุดมา — จึงเก็บเป็น hash ไม่เก็บดิบ
    // ⚠️ await: ดูเหตุผลที่เส้นทาง login สำเร็จด้านล่าง — ความพยายามที่ล้มเหลวยิ่งต้องไม่หาย
    await recordAudit({
      actorLabel: 'unknown', action: 'LOGIN', targetHash: sha256Hex(String(username)),
      result: 'DENIED', sourceIp: requestSourceIp(req),
    })
    if (accountLockMs || ipLockMs) {
      await recordAudit({
        actorLabel: 'system', action: 'LOGIN_LOCKOUT', targetHash: sha256Hex(String(username)),
        result: 'BLOCKED', sourceIp: requestSourceIp(req),
      })
    }
    return res.status(401).json({ error: INVALID_CREDENTIALS }) // เหมือนกันทุกกรณี
  }

  recordSuccess(req, username)
  try {
    await establishSession(req, user, Boolean(remember)) // regenerate ข้างใน — กัน fixation
  } catch (err) {
    console.error('[aegis-drive] session error', err)
    return res.status(500).json({ error: 'Internal error' })
  }

  // ⚠️ await ก่อนตอบ 200: เหตุการณ์การยืนยันตัวตนคือหลักฐานที่ทั้ง forensics และจอ
  //    Access (lastLogin) พึ่งพา การตอบสำเร็จก่อนแถวลงจริงทำให้ (1) login ที่โปรเซสตาย
  //    ตามหลังหายจากบันทึกทั้งที่เกิดขึ้นจริง (2) จอ Access แสดงเวลาล็อกอินล่าสุดที่ช้า
  //    ไปหนึ่งครั้งเสมอในโหมด Postgres — โหมด in-memory เขียนแบบ synchronous จึงไม่เคย
  //    เห็นปัญหานี้ (แบบแผนและเหตุผลเดียวกับ /vault/unlock-attempt ด้านล่างไฟล์นี้)
  await recordAudit({
    actorId: user.id, actorLabel: user.username, role: user.role,
    action: 'LOGIN', result: 'OK', sourceIp: requestSourceIp(req),
  })

  // เมนูถูก filter ตาม role จาก DB (default-deny) + CSRF token ผูกกับเซสชันใหม่
  return res.json({
    user: publicUser(user),
    menu: getNavForRole(user.role),
    csrfToken: currentCsrfToken(req),
  })
})

apiRouter.post('/logout', async (req, res) => {
  const user = currentUser(req)
  if (user) {
    // await เช่นเดียวกับ LOGIN — เหตุการณ์เข้า/ออกระบบเป็นคู่กัน ถ้าฝั่งออกหายไป
    // บันทึกจะอ่านเหมือนเซสชันที่ยังเปิดค้างอยู่ตลอด
    await recordAudit({
      actorId: user.id, actorLabel: user.username, role: user.role,
      action: 'LOGOUT', result: 'OK', sourceIp: requestSourceIp(req),
    })
  }
  await destroySession(req, res) // invalidate ฝั่งเซิร์ฟเวอร์เสมอ ไม่ใช่แค่ลบ cookie
  res.json({ ok: true })
})

apiRouter.get('/me', (req, res) => {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  res.json({
    user: publicUser(user),
    menu: getNavForRole(user.role),
    csrfToken: currentCsrfToken(req),
  })
})

// ── การตั้งค่าหน้าจอรายบัญชี ────────────────────────────────────────────────
// userId มาจาก session เท่านั้น; field อื่นใน body (รวม userId/role) ไม่ถูกอ่าน
apiRouter.patch('/preferences', requireAuth, async (req, res, next) => {
  try {
    const preferences = await updateUserPreferences(req.user.id, {
      theme: req.body?.theme,
      language: req.body?.language,
      density: req.body?.density,
      interfaceStyle: req.body?.interfaceStyle,
    })
    if (!preferences) return res.status(400).json({ error: 'Invalid input' })

    setSessionPreferences(req, preferences)
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())))
    await auditAct(req, 'PREFERENCES_UPDATE', req.user.username)
    res.json({ preferences })
  } catch (err) {
    next(err)
  }
})

// ── Audit (Admin เท่านั้น — ตรวจ role ฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนเมนู) ──────
apiRouter.get('/audit', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const rows = await readAudit(200)
    res.json({ events: rows })
  } catch (err) {
    next(err)
  }
})

// ════ Data endpoints ═════════════════════════════════════════════════
// ทุกตัวผ่าน requireAuth/requireRole เสมอ — การกรองเมนูฝั่ง UI ไม่ใช่ control
// การกระทำที่เปลี่ยนสถานะทุกครั้งลง audit โดยเก็บชื่อไฟล์เป็น hash (privacy-preserving)
//
// ⚠️ ป้าย "Phase N" ถูกถอดออกจากคอมเมนต์ทั่วโปรเจกต์: มันบอกว่างานถูกทำ "เมื่อไร"
//    ซึ่งไม่ช่วยคนอ่านโค้ด และเมื่อ phase ผ่านไปแล้วมันกลายเป็นข้อมูลที่ผิด (คอมเมนต์
//    หลายจุดยังเขียนว่าอะไร "จะทำใน Phase 3" ทั้งที่ทำเสร็จไปแล้ว) สิ่งที่ต้องเขียนคือ
//    "ตอนนี้โค้ดทำอะไรจริง และอะไรที่ยังไม่ทำ" — git log เก็บลำดับเวลาไว้ให้แล้ว

// ⚠️ ทุกจุดที่เรียก auditAct ต้อง await ก่อนตอบ response — ไม่ใช่เรื่องความเรียบร้อย
//    แต่เป็นความหมายของระบบที่มี audit: "การกระทำสำเร็จ" ต้องรวม "ถูกบันทึกแล้ว" ด้วย
//    เดิมเรียกแบบ fire-and-forget ผลคือในโหมด Postgres คำขอที่ถูก **ปฏิเสธ** ตอบ 403
//    กลับไปก่อนที่แถว DENIED จะลงจริง ถ้าโปรเซสตายในช่วงนั้น ความพยายามที่ถูกปฏิเสธ
//    จะหายไปจากบันทึก — ซึ่งเป็นแถวที่เราอยากเสียน้อยที่สุด นอกจากนั้นจอ Audit และ
//    กราฟกิจกรรมของ Dashboard ยังอ่านช้ากว่าความจริงหนึ่งเหตุการณ์เสมอ
//    (โหมด in-memory เขียน synchronous จึงไม่เคยเห็นปัญหานี้ — เจอจากเทสต์จอ Audit
//     ที่รันกับ Postgres จริง แบบแผนเดียวกับที่ /vault/unlock-attempt เคยเจอ)
const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(target) : null, result, sourceIp: requestSourceIp(req),
  })

// ── Dashboard ────────────────────────────────────────────────────────
apiRouter.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    // login history ส่วนตัว (personal security status) มาจาก audit ฝั่งเซิร์ฟเวอร์
    const audit = await readAudit(100)
    const label = (e) => e.actor_label ?? e.actorLabel
    const myLogins = audit
      .filter((e) => label(e) === req.user.username && e.action === 'LOGIN')
      .slice(0, 5)
    // ป้ายระบุขอบเขตตามจริง: นับเฉพาะ DENIED/BLOCKED ใน 100 audit rows ล่าสุด
    // ไม่เรียกว่า incident ที่ยัง active เพราะ schema ไม่มี resolved/unresolved state
    const securityAlerts = audit.filter((e) => e.result === 'DENIED' || e.result === 'BLOCKED').length
    const shares = await store.listShares(req.user.id)
    res.json({
      ...(await store.dashboard(req.user.id)),
      loginHistory: myLogins,
      securityAlerts,
      shares: shares.slice(0, 4), // ลิงก์แชร์ที่เปิดอยู่ (สเปกของจอ Dashboard)
    })
  } catch (err) {
    next(err)
  }
})

// ── Files ────────────────────────────────────────────────────────────
// ⚠️ Files คือ namespace ต่อผู้ใช้ — store.listFiles(userId) กรองด้วย uploaded_by
//    ในชั้น SQL แล้ว (ดูเหตุผลเต็มที่ db/store.js) ห้ามเปลี่ยนกลับไปเรียกแบบไม่ส่ง userId
apiRouter.get('/files', requireAuth, async (req, res, next) => {
  try {
    res.json({ files: await store.listFiles(req.user.id) })
  } catch (err) {
    next(err)
  }
})

apiRouter.post('/files/folder', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim()
    // validate input เสมอ — ชื่อว่าง/ยาวผิดปกติ = ปฏิเสธ ไม่เดาใจ
    if (!name || name.length > 120) return res.status(400).json({ error: 'Invalid input' })
    const row = await store.createFolder(name, req.user)
    await auditAct(req, 'FOLDER_CREATE', name)
    res.status(201).json({ file: row })
  } catch (err) {
    next(err)
  }
})

// ── Upload V2 — resumable chunked transfer (LFT-V2-A) ────────────────────────
// ⚠️ ต้องถูก mount "ก่อน" เส้นทาง '/files/:id/...' ด้านล่างเสมอ — Express จับคู่ตาม
//    ลำดับที่ประกาศ ถ้าอยู่หลัง '/files/:id' จะกิน '/files/uploads' ไปเป็น id เสียก่อน
apiRouter.use('/files/uploads', uploadsRouter)

// ── Upload — Storage Layer (bytes) + Metadata Layer (แถวใน files) ────────────
// ⚠️ ลำดับสำคัญ: เขียน bytes ลงดิสก์ให้เสร็จก่อน แล้วค่อย INSERT metadata — ถ้าสลับกัน
//    แล้วดิสก์ล้มเหลว จะเหลือแถวที่ชี้ไปยังไฟล์ที่ไม่มีอยู่จริง (metadata โกหก)
//    ถ้า INSERT ล้มเหลวทีหลัง เราลบ bytes ทิ้ง (discardUploaded) — ไม่เหลือไฟล์กำพร้า
// ⚠️ size และ sha256 มาจาก "ไฟล์บนดิสก์จริง" ที่เซิร์ฟเวอร์อ่านเอง ไม่ใช่ค่าที่ client แจ้ง
//    client แจ้ง sha256 มาได้ แต่ใช้แค่ "เทียบ" เพื่อจับ corruption ระหว่างทางเท่านั้น
//
// ⚠️ **LEGACY (V1) — ยังเปิดอยู่เพื่อความเข้ากันได้ ไม่ใช่เส้นทางของ UI อีกต่อไป**
//    จอ Uploads ใช้เส้นทาง V2 (/api/files/uploads/*) แล้ว endpoint นี้คงไว้เพื่อ
//    (1) ไคลเอนต์/สคริปต์ที่ยังเรียกอยู่ (2) ไฟล์เล็กที่ไม่ต้องการ session สามขั้น
//    ข้อจำกัดที่ยังเป็นจริงของมันและเป็นเหตุผลที่ V2 มีอยู่: หนึ่งคำขอ = ทั้งไฟล์
//    (เพดาน multer 1 GiB + client_max_body_size ของ nginx) และหลุดกลางทาง = เริ่มใหม่
//    การถอด endpoint นี้ออกเป็นงานแยกหลัง V2 ผ่านการยอมรับใน production แล้ว
apiRouter.post('/files/upload', requireAuth, (req, res, next) => {
  uploadMiddleware(req, res, async (uploadErr) => {
    if (uploadErr) {
      // ไฟล์เกินเพดาน/multipart พัง — ตอบ 400 แบบ generic ไม่รั่วรายละเอียดภายใน
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE'
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File too large' : 'Invalid input' })
    }
    if (!req.file) return res.status(400).json({ error: 'Invalid input' })

    try {
      // ชื่อที่ผู้ใช้ตั้ง เก็บลง Metadata Layer เท่านั้น — ไม่เคยถูกใช้เป็น path บนดิสก์
      const name = String(req.file.originalname ?? '').slice(0, 200)
      if (!name) {
        await discardUploaded(req.file)
        return res.status(400).json({ error: 'Invalid input' })
      }

      const storageKey = keyForUploaded(req.file)
      const abs = resolveKey(storageKey)
      const [size, sha256] = await Promise.all([sizeOfFile(abs), sha256OfFile(abs)])

      // client แจ้ง hash มาแล้วไม่ตรงกับ bytes ที่ถึงเซิร์ฟเวอร์ = ไฟล์เพี้ยนระหว่างทาง
      // ทิ้งทั้ง bytes และไม่เขียน metadata — ดีกว่าเก็บของที่รู้ว่าไม่ครบ
      const claimed = typeof req.body?.sha256 === 'string' ? req.body.sha256.toLowerCase() : null
      if (claimed && claimed !== sha256) {
        await discardUploaded(req.file)
        await auditAct(req, 'FILE_UPLOAD', name, 'DENIED')
        return res.status(422).json({ error: 'Checksum mismatch' })
      }

      // ── อัปโหลดชื่อเดิมทับของตัวเอง = เวอร์ชันใหม่ ไม่ใช่ไฟล์ที่สองที่ชื่อซ้ำกัน ──
      // ⚠️ ผูกกับเจ้าของเสมอ (findOwnFileByName) — ถ้าเทียบด้วยชื่อไฟล์อย่างเดียว ผู้ใช้
      //    คนหนึ่งจะเขียนทับไฟล์ของคนอื่นได้แค่ตั้งชื่อให้ตรง ซึ่งเป็นการข้ามด่าน ownership
      //    ที่ DELETE มีอยู่ ไฟล์ชื่อเดียวกันของคนละเจ้าของยังเป็นสองไฟล์แยกกันเหมือนเดิม
      const existing = await store.findOwnFileByName(name, req.user.id)

      let row
      try {
        if (existing) {
          // ไบต์ชุดเดิมย้ายไปเก็บเป็นเวอร์ชันก่อน แล้วแถวจึงชี้มาที่ไบต์ใหม่
          const archivedKey = await moveToVersions(existing.path)
          row = await store.replaceFileContents({
            file: existing,
            storageKey, size, sha256,
            previous: archivedKey
              ? { key: archivedKey, size: existing.size, sha256: existing.sha256 }
              : null,
            user: req.user,
          })
          if (!row) throw new Error('file row vanished mid-upload')
        } else {
          row = await store.recordUpload({ name, storageKey, size, sha256, user: req.user })
        }
      } catch (dbErr) {
        await discardUploaded(req.file) // metadata ไม่ผ่าน = ต้องไม่เหลือ bytes กำพร้า
        throw dbErr
      }

      await auditAct(req, existing ? 'FILE_VERSION_ADD' : 'FILE_UPLOAD', name)
      res.status(201).json({ file: row, newVersion: Boolean(existing) })
    } catch (err) {
      next(err)
    }
  })
})

// ── Verify checksum — อ่าน bytes ปัจจุบันจาก Storage Layer ใหม่ทุกครั้ง ───────
// ⚠️ นี่เป็นด่านตรวจความสมบูรณ์จริง ไม่ใช่การคืนค่า verified ที่จดไว้ตอนอัปโหลด:
//    metadata hash คือหลักฐานตั้งต้น ส่วน actualSha256 ต้องมาจากการอ่านไฟล์บนดิสก์
//    ณ เวลาที่ผู้ใช้กดตรวจเท่านั้น จึงจับการแก้/เสียหายหลังอัปโหลดได้
// ⚠️ ด่าน ownership — เหมือนกับ DELETE /api/files/:id (เทียบด้วย ownerId เท่านั้น ไม่มี
//    ข้อยกเว้นให้ Admin) แต่ตอบ 404 แทน 403 เพื่อไม่ยืนยันว่า id นี้มีไฟล์ของใครอยู่จริง
//    ตรงกับแบบแผนของเส้นทางเวอร์ชัน (GET /files/:id/versions ฯลฯ) ที่ cross-owner = 404
//    ต้องเช็ค "ก่อน" แตะ Storage Layer เสมอ — ห้ามอ่าน bytes ก่อนด่านนี้ผ่าน
apiRouter.post('/files/:id/verify', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })
    if (file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
      await auditAct(req, 'FILE_VERIFY', file.name, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }
    if (file.type === 'Folder' || !file.sha256) {
      return res.status(409).json({ error: 'Verification unavailable' })
    }

    const abs = resolveKey(file.path)
    if (!abs || !(await keyExists(file.path))) {
      await auditAct(req, 'FILE_VERIFY', file.name, 'DENIED')
      return res.status(409).json({ error: 'Verification unavailable' })
    }

    const actualSha256 = await sha256OfFile(abs)
    const storedSha256 = String(file.sha256).toLowerCase()
    const match = actualSha256 === storedSha256
    await auditAct(req, 'FILE_VERIFY', file.name, match ? 'OK' : 'DENIED')
    res.json({ match, storedSha256, actualSha256 })
  } catch (err) {
    next(err)
  }
})

// ── Download — stream bytes จริงจาก Storage Layer ────────────────────────────
// ⚠️ client ส่งมาแค่ id ของแถวใน Metadata Layer — path บนดิสก์มาจากคอลัมน์ใน DB
//    เท่านั้น ไม่เคยมาจาก input ของ client (ไม่มีทางขอไฟล์นอก STORAGE_ROOT)
//    resolveKey() ยังกันซ้ำอีกชั้นเผื่อค่าใน DB ถูกแก้ให้ชี้ออกนอกกรอบ
// ⚠️ ด่าน ownership — เหมือนกับ verify ด้านบนและ DELETE /api/files/:id เป๊ะ ๆ: เทียบ
//    ownerId เท่านั้น ไม่มีข้อยกเว้นให้ Admin, ตอบ 404 เพื่อไม่ยืนยันว่ามีไฟล์ของใครอยู่
//    ต้องอยู่ "ก่อน" resolveKey/keyExists/openReadStream ทุกจุด — ห้ามอ่านไบต์ใด ๆ ของ
//    ไฟล์ก่อนด่านนี้ผ่าน (บั๊กที่ยืนยันแล้วใน production: ไม่มีด่านนี้มาก่อน)
apiRouter.get('/files/:id/download', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })
    if (file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
      await auditAct(req, 'FILE_DOWNLOAD', file.name, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }
    if (file.type === 'Folder') return res.status(400).json({ error: 'Not a file' })

    const abs = resolveKey(file.path)
    if (!abs || !(await keyExists(file.path))) {
      // แถว metadata มีอยู่แต่ไม่มี bytes (แถวเดโม่เก่า/ไฟล์ถูกลบนอกระบบ) — ไม่ปลอมข้อมูลคืน
      await auditAct(req, 'FILE_DOWNLOAD', file.name, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }

    await auditAct(req, 'FILE_DOWNLOAD', file.name)

    // application/octet-stream + attachment เสมอ — ไม่ปล่อยให้เบราว์เซอร์ render
    // ไฟล์ที่ผู้ใช้อัปโหลด (ไฟล์ HTML/SVG ที่ถูก render ใน origin เดียวกัน = XSS)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(file.size))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)

    const stream = openReadStream(file.path)
    if (!stream) return res.status(404).json({ error: 'Not found' })
    stream.on('error', () => res.destroy()) // ดิสก์พังกลางคัน — ตัดการเชื่อมต่อ ไม่ส่งไฟล์ครึ่ง ๆ ที่ดูเหมือนครบ
    stream.pipe(res)
  } catch (err) {
    next(err)
  }
})

// ⚠️ ด่าน ownership — requireAuth บอกได้แค่ "เป็นใครคนหนึ่งที่ล็อกอินแล้ว" ไม่ได้บอกว่า
//    ไฟล์นี้เป็นของเขา เดิมขาดด่านนี้ไป ผลคือ **ผู้ใช้ที่ล็อกอินคนไหนก็ลบไฟล์ของคนอื่นได้
//    ทั้งแถว metadata และ bytes บนดิสก์** ก่อน Protected Trash ถูกนำมาใช้
//
//    เทียบด้วย ownerId (id ของบัญชี) เท่านั้น ห้ามเทียบด้วย uploader/display name
//    เพราะชื่อซ้ำกันได้และเปลี่ยนได้ — ดู mapFileRow ใน db/store.js
//
// ⚠️ **ไม่มีข้อยกเว้นให้ Admin โดยเจตนา** — rbac/permissions.js ระบุว่าสอง role นี้
//    "จัดการไฟล์ได้เท่ากัน" Admin ได้เพิ่มแค่จอ governance (Audit/Access) ไม่ใช่สิทธิ์
//    เหนือไฟล์ของผู้อื่น ถ้าวันหนึ่งต้องมี admin override ให้เพิ่มเป็น requireRole
//    พร้อม audit แยก action ไม่ใช่ปล่อยให้ด่านนี้อ่อนลงเงียบ ๆ
//
// ⚠️ ownerId เป็น null ได้ (`uploaded_by … ON DELETE SET NULL`) = เจ้าของถูกลบบัญชีแล้ว
//    กรณีนั้น "ไม่มีใครลบได้" ซึ่งเป็นฝั่งที่ปลอดภัยของ fail-secure — แต่ก็หมายความว่า
//    ยังไม่มีเส้นทางเก็บกวาดไฟล์กำพร้า (งานแยก ไม่ทำในคอมมิตนี้)
apiRouter.delete('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })

    if (file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
      // ลง audit เป็น DENIED เสมอ — ความพยายามลบไฟล์ของคนอื่นต้องมองเห็นได้ในจอ Audit
      // (แบบแผนเดียวกับ FILE_DOWNLOAD ที่ metadata มีแต่ bytes หาย ด้านบน)
      await auditAct(req, 'FILE_TRASH', file.name, 'DENIED')
      return res.status(403).json({ error: 'Forbidden' })
    }
    const trashed = await store.trashFile(file.id, req.user.id)
    if (!trashed) return res.status(404).json({ error: 'Not found' })
    await auditAct(req, 'FILE_TRASH', file.name)
    res.json({ ok: true, purgeAt: new Date(trashed.purgeAt).toISOString() })
  } catch (err) {
    next(err)
  }
})

// ── Protected Trash — owner-only, password step-up, normal Data Lake only ────
const trashPublicItem = (file) => ({
  id: file.id,
  name: file.name,
  type: file.type,
  ext: file.ext,
  size: file.size,
  sha256Prefix: file.sha256 ? String(file.sha256).slice(0, 12) : null,
  deletedAt: new Date(file.deletedAt).toISOString(),
  purgeAt: new Date(file.purgeAt).toISOString(),
  versionCount: file.versionCount ?? 0,
})

async function verifyTrashPassword(req, password) {
  const key = `user:${req.user.id}`
  const lock = checkLock(req, key, 'trash-step-up')
  if (lock.locked) return { ok: false, locked: true, retryAfterMs: lock.retryAfterMs }
  const account = await getUserById(req.user.id)
  const ok = Boolean(account?.passwordHash && password && await bcrypt.compare(String(password), account.passwordHash))
  if (!ok) {
    recordFailure(req, key, 'trash-step-up')
    return { ok: false, locked: false }
  }
  recordSuccess(req, key, 'trash-step-up')
  return { ok: true }
}

apiRouter.get('/trash/status', requireAuth, (req, res) => {
  res.json({ unlocked: trashAuthorization(req).unlocked })
})

apiRouter.post('/trash/unlock', requireAuth, async (req, res, next) => {
  try {
    const result = await verifyTrashPassword(req, req.body?.password)
    if (!result.ok) {
      await auditAct(req, 'TRASH_UNLOCK', String(req.user.id), result.locked ? 'BLOCKED' : 'DENIED')
      if (result.locked) {
        res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
        return res.status(429).json({ error: INVALID_CREDENTIALS })
      }
      return res.status(401).json({ error: INVALID_CREDENTIALS })
    }
    unlockTrashSession(req)
    await auditAct(req, 'TRASH_UNLOCK', String(req.user.id))
    res.json({ unlocked: true, expiresInSeconds: 300 })
  } catch (error) { next(error) }
})

apiRouter.post('/trash/lock', requireAuth, async (req, res, next) => {
  try {
    lockTrashSession(req)
    await auditAct(req, 'TRASH_LOCK', String(req.user.id))
    res.status(204).end()
  } catch (error) { next(error) }
})

apiRouter.get('/trash', requireAuth, async (req, res, next) => {
  try {
    if (!trashAuthorization(req).unlocked) return res.status(423).json({ error: 'Trash locked' })
    const items = await store.listTrash(req.user.id)
    res.json({ items: items.map(trashPublicItem) })
  } catch (error) { next(error) }
})

apiRouter.post('/trash/:id/restore', requireAuth, async (req, res, next) => {
  try {
    if (!trashAuthorization(req).unlocked) return res.status(423).json({ error: 'Trash locked' })
    const lock = await withTrashFileLock(req.params.id, async () => {
      const file = await store.findTrashedFile(req.params.id, req.user.id)
      if (!file) return { status: 404, auditTarget: req.params.id, auditResult: 'DENIED', body: { error: 'Not found' } }
      const versions = file.type === 'Folder' ? [] : await store.listFileVersions(file.id)
      if ((file.type !== 'Folder' && !(await keyExists(file.path)))
        || (await Promise.all(versions.map((version) => keyExists(version.storageKey)))).some((exists) => !exists)) {
        return {
          status: 409, auditTarget: file.name, auditResult: 'BLOCKED',
          body: { error: 'Stored bytes unavailable', code: 'STORAGE_INCOMPLETE' },
        }
      }
      const restored = await store.restoreTrashedFile(file.id, req.user.id, req.body?.name ?? null)
      if (restored?.conflict) {
        return {
          status: 409,
          body: { error: 'Name conflict', code: 'NAME_CONFLICT', suggestedName: restored.suggestedName },
        }
      }
      if (!restored?.file) return { status: 404, auditTarget: req.params.id, auditResult: 'DENIED', body: { error: 'Not found' } }
      return { status: 200, auditTarget: restored.file.name, auditResult: 'OK', body: { file: restored.file } }
    })
    if (!lock.acquired) return res.status(409).json({ error: 'Trash item is busy', code: 'TRASH_ITEM_BUSY' })
    const outcome = lock.value
    if (outcome.auditTarget) {
      await auditAct(req, 'FILE_TRASH_RESTORE', outcome.auditTarget, outcome.auditResult)
    }
    if (outcome.status !== 200) {
      return res.status(outcome.status).json(outcome.body)
    }
    res.json(outcome.body)
  } catch (error) { next(error) }
})

apiRouter.delete('/trash/:id', requireAuth, async (req, res, next) => {
  try {
    let authorized = trashAuthorization(req).destructiveReauth
    if (!authorized && req.body?.password) {
      const verified = await verifyTrashPassword(req, req.body.password)
      if (!verified.ok) {
        await auditAct(req, 'FILE_TRASH_PURGE', req.params.id, verified.locked ? 'BLOCKED' : 'DENIED')
        if (verified.locked) return res.status(429).json({ error: INVALID_CREDENTIALS })
        return res.status(401).json({ error: INVALID_CREDENTIALS })
      }
      authorized = true
    }
    if (!authorized) return res.status(403).json({ error: 'Recent password verification required' })
    const file = await store.findTrashedFile(req.params.id, req.user.id)
    if (!file) {
      await auditAct(req, 'FILE_TRASH_PURGE', req.params.id, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }
    if (!(await purgeTrashRecord(file, req.user.id))) return res.status(404).json({ error: 'Not found' })
    await auditAct(req, 'FILE_TRASH_PURGE', file.name)
    res.json({ ok: true })
  } catch (error) { next(error) }
})

apiRouter.post('/trash/empty', requireAuth, async (req, res, next) => {
  try {
    if (req.body?.confirmation !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' })
    const verified = await verifyTrashPassword(req, req.body?.password)
    if (!verified.ok) {
      await auditAct(req, 'TRASH_EMPTY', String(req.user.id), verified.locked ? 'BLOCKED' : 'DENIED')
      if (verified.locked) return res.status(429).json({ error: INVALID_CREDENTIALS })
      return res.status(401).json({ error: INVALID_CREDENTIALS })
    }
    const files = await store.listTrash(req.user.id)
    let deletedCount = 0
    for (const file of files) if (await purgeTrashRecord(file, req.user.id)) deletedCount += 1
    lockTrashSession(req)
    await auditAct(req, 'TRASH_EMPTY', String(req.user.id))
    res.json({ ok: true, deletedCount })
  } catch (error) { next(error) }
})

// ── Shares — VLAN-aware secure links ─────────────────────────────────
apiRouter.get('/shares', requireAuth, async (req, res, next) => {
  try {
    res.json({ shares: await store.listShares(req.user.id) })
  } catch (err) {
    next(err)
  }
})

/**
 * สร้างลิงก์แชร์ — คืน token ดิบ "ครั้งเดียว" ในผลลัพธ์นี้เท่านั้น
 * ⚠️ ตารางเก็บแค่ sha256 ของ token (ดู schema.sql) เซิร์ฟเวอร์จึงแสดงลิงก์เดิมซ้ำไม่ได้
 *    แบบแผนเดียวกับ tempPassword ของ POST /users — ผู้ใช้ต้องคัดลอกตอนนี้
 * ⚠️ path ที่คืนไปเป็น path ฝั่งเซิร์ฟเวอร์ ('/s/<token>') — client ประกอบ URL เต็มเอง
 *    ด้วย origin + BASE_URL ของตัวเอง (แอปถูก mount ที่ /drive/ ผ่าน nginx ที่ตัด prefix
 *    ออกก่อนถึง Express — Express จึงไม่รู้ prefix ของตัวเองและไม่ควรเดา)
 */
apiRouter.post('/shares', requireAuth, async (req, res, next) => {
  try {
    const { fileId, expiry, authType, scope, password } = req.body ?? {}
    const created = await store.createShare({ fileId, expiry, authType, scope, password }, req.user)
    if (!created) return res.status(400).json({ error: 'Invalid input' })
    await auditAct(req, 'SHARE_CREATE', created.share.fileName)
    // ⚠️ ห้าม log/audit ตัว token — มันคือ credential ที่เปิดไฟล์ได้ทันที
    //    (targetHash ด้านบนเป็น hash ของ "ชื่อไฟล์" ตามแบบแผน privacy-preserving เดิม)
    res.status(201).json({ share: created.share, path: `/s/${created.token}` })
  } catch (err) {
    next(err)
  }
})

apiRouter.delete('/shares/:id', requireAuth, async (req, res, next) => {
  try {
    const ok = await store.revokeShare(req.params.id, req.user.id)
    if (!ok) {
      // Cross-owner, missing, expired, revoked and malformed targets share one
      // object-hiding response. Audit only the supplied internal id; never a
      // token, token hash, password, or another owner's file metadata.
      await auditAct(req, 'SHARE_REVOKE', req.params.id, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }
    await auditAct(req, 'SHARE_REVOKE', req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── File versions — ประวัติของไฟล์ที่กู้ได้จริง ────────────────────────
//
// ⚠️ ไม่มี /snapshots และ /snapshots/:id/rollback อีกแล้ว ทั้งคู่เป็นของปลอม: แถวถูก
//    hard-code ไว้แปดแถว และ rollback แค่ตั้งธงในหน่วยความจำโดยไม่คืนไบต์ของใครเลย
//    ทั้งที่จอรายงานว่า "restored" — เหตุผลเต็มอยู่ที่หัวหมวด File versions ใน db/store.js
// ⚠️ เส้นทางนี้จำกัด "เฉพาะเจ้าของไฟล์" ทุกเส้น (ไม่มีข้อยกเว้นให้ Admin เหมือนกับด่าน
//    DELETE /api/files/:id) — ประวัติเวอร์ชันคือเนื้อหาของไฟล์ในอดีต การให้คนอื่นอ่านได้
//    เท่ากับให้อ่านไฟล์ของเขา และการให้กู้คืนได้เท่ากับให้เขียนทับไฟล์ของเขา

/** ไฟล์ที่ผู้ใช้คนนี้เป็นเจ้าของ + มีประวัติเวอร์ชัน — ใช้เป็นรายการฝั่งซ้ายของจอ
 *  ⚠️ store.listFiles(req.user.id) กรอง ownership ให้แล้วในชั้น SQL — ที่นี่กรองแค่
 *     type !== 'Folder' ต่อ ไม่ต้องเทียบ ownerId ซ้ำอีกชั้น (เคยเป็นด่านซ้อนด่านที่
 *     พลาดดูแลง่ายเพราะดูเหมือนกันสองที่ ตอนนี้ ownership อยู่จุดเดียวคือ listFiles) */
apiRouter.get('/file-versions', requireAuth, async (req, res, next) => {
  try {
    const own = (await store.listFiles(req.user.id)).filter((f) => f.type !== 'Folder')
    const withCounts = await Promise.all(own.map(async (f) => {
      const versions = await store.listFileVersions(f.id)
      return {
        id: f.id, name: f.name, size: f.size, modified: f.modified,
        versionCount: versions.length,
        latestVersionAt: versions[0]?.createdAt ?? null,
      }
    }))
    res.json({ files: withCounts, stats: await store.fileVersionStats(req.user.id) })
  } catch (err) {
    next(err)
  }
})

/** ประวัติของไฟล์หนึ่ง — เจ้าของเท่านั้น */
apiRouter.get('/files/:id/versions', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })
    // ไม่ใช่เจ้าของ → 404 เหมือนไม่มีไฟล์ (ไม่ยืนยันว่าไฟล์ id นี้มีอยู่จริงของใคร)
    if (file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const versions = await store.listFileVersions(file.id)
    res.json({
      file: { id: file.id, name: file.name, size: file.size, modified: file.modified, sha256: file.sha256 },
      // storageKey ไม่ถูกส่งออกไป — เป็นรายละเอียดภายในของ Storage Layer
      versions: versions.map((v) => ({
        id: v.id, size: v.size, sha256: v.sha256,
        createdAt: v.createdAt, supersededByName: v.supersededByName,
      })),
    })
  } catch (err) {
    next(err)
  }
})

/** ดาวน์โหลดไบต์ของเวอร์ชันเก่า — เจ้าของเท่านั้น (ตรวจก่อนกู้คืนได้ว่าใช่ตัวที่ต้องการ) */
apiRouter.get('/files/:id/versions/:versionId/download', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file || file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const version = await store.findFileVersion(file.id, req.params.versionId)
    if (!version || !(await keyExists(version.storageKey))) {
      return res.status(404).json({ error: 'Not found' })
    }
    const stream = openReadStream(version.storageKey)
    if (!stream) return res.status(404).json({ error: 'Not found' })

    await auditAct(req, 'FILE_VERSION_DOWNLOAD', file.name)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(version.size))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  } catch (err) {
    next(err)
  }
})

/**
 * กู้คืนเวอร์ชัน — ของจริง: ไบต์ของเวอร์ชันนั้นกลายเป็นไฟล์ปัจจุบัน
 *
 * ⚠️ ไม่ทำลายอะไรเลย: ไบต์ "ปัจจุบัน" ถูกเก็บเป็นเวอร์ชันใหม่ก่อนเสมอ ผู้ใช้ที่กู้ผิดตัว
 *    จึงกู้กลับได้อีก (ต่างจาก rollback ของเดิมที่โฆษณาว่าจะ "ทำลาย snapshot ที่ใหม่กว่า")
 * ⚠️ ลำดับสำคัญ: ย้ายไบต์ปัจจุบัน → เขียน metadata → ย้ายไบต์ของเวอร์ชันมาเป็นปัจจุบัน
 *    ถ้าขั้นใดล้ม เราพยายามย้ายไบต์ปัจจุบันกลับที่เดิม (ดีกว่าเหลือแถวที่ชี้ไปยังไฟล์ที่ไม่มี)
 */
apiRouter.post('/files/:id/versions/:versionId/restore', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file || file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
      await auditAct(req, 'FILE_VERSION_RESTORE', req.params.id, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }
    const version = await store.findFileVersion(file.id, req.params.versionId)
    if (!version || !(await keyExists(version.storageKey))) {
      return res.status(404).json({ error: 'Not found' })
    }

    // 1) ไบต์ปัจจุบันกลายเป็นเวอร์ชันใหม่ (ยังไม่แตะแถว)
    const archivedKey = await moveToVersions(file.path)

    // 2) ไบต์ของเวอร์ชันเป้าหมายกลายเป็นไฟล์ปัจจุบัน
    let restoredKey = null
    try {
      restoredKey = await restoreFromVersions(version.storageKey)
      if (!restoredKey) throw new Error('version bytes vanished mid-restore')
    } catch (err) {
      // พยายามคืนสภาพ: ย้ายไบต์ปัจจุบันกลับมาเป็นไฟล์ปัจจุบันอีกครั้ง
      if (archivedKey) {
        const back = await restoreFromVersions(archivedKey).catch(() => null)
        if (back) await store.replaceFileContents({
          file, storageKey: back, size: file.size, sha256: file.sha256, previous: null, user: req.user,
        })
      }
      throw err
    }

    // 3) แถวชี้ไปที่ไบต์ที่กู้มา และไบต์เดิมถูกบันทึกเป็นเวอร์ชัน
    const row = await store.replaceFileContents({
      file,
      storageKey: restoredKey,
      size: version.size,
      sha256: version.sha256,
      previous: archivedKey ? { key: archivedKey, size: file.size, sha256: file.sha256 } : null,
      user: req.user,
    })
    // เวอร์ชันเป้าหมายไม่มีไบต์ของตัวเองอีกแล้ว (ถูกย้ายมาเป็นไฟล์ปัจจุบัน) — ลบแถวทิ้ง
    await store.deleteFileVersion(file.id, version.id)

    await auditAct(req, 'FILE_VERSION_RESTORE', file.name)
    res.json({ file: row, restoredFromVersionId: version.id })
  } catch (err) {
    next(err)
  }
})

// ── Storage & backup ─────────────────────────────────────────────────
// ⚠️ คืนเฉพาะสิ่งที่วัดได้จริง: ความจุจาก statfs + ผลรวมจากตาราง (เหมือนเดิมทุกประการ —
//    ผ่านการยอมรับใน production แล้ว) และเพิ่มสองแหล่งที่ "วัดจริง" จากโฮสต์ผ่าน agent
//    ที่แยกสิทธิ์: สุขภาพดิสก์ทางกายภาพ (SMART) กับสถานะสำรองข้อมูล — ทั้งสองถูก validate
//    เป็น input ที่ไม่น่าเชื่อถือก่อน และ "ไม่มีหลักฐาน" ตอบ UNKNOWN/NOT_CONFIGURED เสมอ
//    ไม่มีทางกลายเป็น HEALTHY (ดู storage/storageReport.js, telemetry/diskHealth.js,
//    backup/derive.js) — RAID ยังประกาศ not-configured เพราะไม่มี array ใน deployment นี้
// ⚠️ ไม่มีพารามิเตอร์ใดจาก client: socket path ของทั้งสอง agent เป็นค่าคอนฟิกฝั่งเซิร์ฟเวอร์
// ⚠️ ไม่ลง audit ต่อ poll (จอนี้รีเฟรชทุก 60 วินาที)
apiRouter.get('/storage', requireAuth, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.json(await buildStorageReport({ maintenance: backupMaintenance.snapshot }))
  } catch (err) {
    next(err)
  }
})

// ── Backup administration (Admin only) ───────────────────────────────
// Drive is a thin, authenticated front for the host backup agent. Every body
// here is an ID from an allowlist the AGENT publishes (target / schedule /
// retention) or a boolean; there is no path, host, command or credential in
// any request. The agent validates again on its side. Audit records the
// request and, separately, the agent's outcome (server/backup/maintenance.js).
const BACKUP_TARGET_HASH = 'backup-configuration'

apiRouter.get('/backup', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.json(await adminBackupView())
  } catch (err) {
    next(err)
  }
})

const ID_LIKE = /^[a-z0-9][a-z0-9:-]{0,47}$/
apiRouter.patch('/backup/policy', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const body = req.body ?? {}
    const allowedKeys = ['activeTargetId', 'scheduleId', 'retentionId', 'enabled']
    const unknown = Object.keys(body).filter((key) => !allowedKeys.includes(key))
    const policy = {}
    if ('activeTargetId' in body) policy.activeTargetId = body.activeTargetId
    if ('scheduleId' in body) policy.scheduleId = body.scheduleId
    if ('retentionId' in body) policy.retentionId = body.retentionId
    if ('enabled' in body) policy.enabled = body.enabled
    const shapeOk = unknown.length === 0
      && (policy.activeTargetId === undefined || policy.activeTargetId === null || (typeof policy.activeTargetId === 'string' && ID_LIKE.test(policy.activeTargetId)))
      && (policy.scheduleId === undefined || (typeof policy.scheduleId === 'string' && ID_LIKE.test(policy.scheduleId)))
      && (policy.retentionId === undefined || (typeof policy.retentionId === 'string' && ID_LIKE.test(policy.retentionId)))
      && (policy.enabled === undefined || typeof policy.enabled === 'boolean')
    if (!shapeOk) {
      await auditAct(req, 'BACKUP_CONFIG_UPDATE', BACKUP_TARGET_HASH, 'DENIED')
      return res.status(400).json({ error: 'Invalid backup policy' })
    }

    const result = await backupCommand(BACKUP_ROUTES.POLICY, policy)
    if (!result.ok) {
      await auditAct(req, 'BACKUP_CONFIG_UPDATE', BACKUP_TARGET_HASH, 'DENIED')
      if (result.status === 400) return res.status(400).json({ error: 'Invalid backup policy', reason: 'rejected-by-agent' })
      return res.status(503).json({ error: 'Backup agent unavailable', reason: 'agent-unreachable' })
    }
    await auditAct(req, 'BACKUP_CONFIG_UPDATE', BACKUP_TARGET_HASH)
    res.json({ ok: true, policy: result.body?.policy ?? policy })
  } catch (err) {
    next(err)
  }
})

const forwardBackupCommand = (route, action) => async (req, res, next) => {
  try {
    const result = await backupCommand(route, {})
    if (!result.ok) {
      await auditAct(req, action, BACKUP_TARGET_HASH, 'DENIED')
      if (result.status === 409) {
        return res.status(409).json({ error: 'Backup agent refused the request', reason: result.body?.reason ?? 'refused' })
      }
      return res.status(503).json({ error: 'Backup agent unavailable', reason: 'agent-unreachable' })
    }
    await auditAct(req, action, result.body?.jobId ?? BACKUP_TARGET_HASH)
    res.status(202).json({ ok: true, jobId: result.body?.jobId ?? null })
  } catch (err) {
    next(err)
  }
}
apiRouter.post('/backup/run', requireRole(ROLES.ADMIN), forwardBackupCommand(BACKUP_ROUTES.RUN, 'BACKUP_RUN_REQUEST'))
apiRouter.post('/backup/verify', requireRole(ROLES.ADMIN), forwardBackupCommand(BACKUP_ROUTES.VERIFY, 'BACKUP_VERIFY_REQUEST'))

// ── Server Telemetry ─────────────────────────────────────────────────
// ⚠️ นโยบายการมองเห็น (ตัดสินใจเชิงผลิตภัณฑ์ 2026-08-27): ผู้ใช้ Drive ที่ล็อกอินแล้ว
//    "ทุกคน" เห็นค่า host ที่อยู่ใน allowlist V1 ได้ — CPU / RAM / network throughput +
//    ชื่อ interface ที่อนุมัติไว้แล้ว / host uptime / ความจุ Data Lake / อายุโปรเซส Drive
//    ของเดิมกันไว้ให้ Admin เท่านั้นและตอบ reason=requires-admin ให้ DataLake-User —
//    ตอนนี้ไม่ทำแล้ว และไม่ได้แก้ที่หน้าจอ แต่แก้ที่นโยบายจริงฝั่งเซิร์ฟเวอร์
// ⚠️ ขอบเขตการอนุญาตเหลือชั้นเดียวคือ requireAuth และไม่ถูกลดทอน — ไม่มีเซสชัน = 401
//    เสมอ ไม่มีเส้นทางสาธารณะใหม่ใน nginx (ดูเหตุผลเต็มที่ server/telemetry/index.js)
// ⚠️ ไม่มีการเปิดฟิลด์ telemetry ใหม่แม้แต่ฟิลด์เดียว — allowlist ยังเป็น schema V1 เดิม
//    ทุกประการ ที่เปลี่ยนคือ "ใครเห็น" ไม่ใช่ "เห็นอะไร" ดังนั้น Admin กับ DataLake-User
//    ได้ response รูปร่างเดียวกันเป๊ะ ไม่ใช่ผู้ใช้ทั่วไปได้ข้อมูลเครื่องกว้างกว่าเดิม
// ⚠️ ไม่รับพารามิเตอร์ใด ๆ จาก client เลย: interface และ socket path เป็นค่าคอนฟิกฝั่ง
//    เซิร์ฟเวอร์เท่านั้น เบราว์เซอร์เลือก path/interface/agent ไม่ได้ (TELEM-11F/11G)
// ⚠️ ห้ามลง audit ต่อหนึ่ง poll — จอ Dashboard เรียกทุก ~10 วินาที ถ้าบันทึกทุกครั้ง
//    เหตุการณ์ด้านความปลอดภัยจริงจะจมหายไปในกองบรรทัดสำเร็จรูปนี้
// ⚠️ agent ล่มหรือตอบผิดรูป ไม่ใช่เหตุให้ request นี้ล้ม — คืน 200 พร้อมความจริงบางส่วน
//    (disk และ service uptime ยังวัดได้เสมอ) แทนที่จะทำให้ทั้งจอพัง
apiRouter.get('/telemetry', requireAuth, async (req, res, next) => {
  try {
    // no-store: telemetry คือค่า ณ วินาทีนั้น สำเนาที่ถูก cache คือค่าที่ไม่จริงแล้ว
    res.set('Cache-Control', 'no-store')
    res.json(await buildTelemetry())
  } catch (err) {
    next(err)
  }
})

// ── Network zones (Admin governance เท่านั้น) ──────────────────────────
// ⚠️ ไม่มี /keys และ /keys/rotate อีกแล้ว — ทั้งคู่รายงานสถานะกุญแจ master ที่ไม่มีอยู่
//    จริงในระบบนี้ (ดูเหตุผลเต็มที่หัวหมวด Network zones ใน db/store.js)
// Zone CIDR ถูก snapshot ลง restricted shares ตอนสร้างและเทียบกับ canonical req.ip
// ตอน redemption; เป็น defense in depth ไม่ใช่ตัวแทน Twingate/device/firewall policy
apiRouter.get('/zones', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    res.json({ zones: await store.listNetworkZones() })
  } catch (err) {
    next(err)
  }
})

apiRouter.post('/zones', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const { name, cidr } = req.body ?? {}
    const row = await store.addNetworkZone({ name, cidr })
    if (!row) return res.status(400).json({ error: 'Invalid input' })
    await auditAct(req, 'ZONE_CREATE', row.cidr)
    res.status(201).json({ zone: row })
  } catch (err) {
    next(err)
  }
})

apiRouter.delete('/zones/:id', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const ok = await store.removeNetworkZone(req.params.id)
    if (!ok) return res.status(404).json({ error: 'Not found' })
    await auditAct(req, 'ZONE_DELETE', req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── Access control (Admin governance เท่านั้น) ────────────────────────
// ⚠️ GET และ POST อ่าน-เขียน "ตาราง users ตารางเดียวกัน" แล้ว — จอ Access จึงแสดง
//    สถานะการเข้าถึงที่ตรงกับความจริงเสมอ ไม่ใช่ชุดข้อมูลคู่ขนานที่ค่อย ๆ เพี้ยนออกจากกัน
apiRouter.get('/users', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const [users, sessionCounts] = await Promise.all([listUsers(), countSessionsByUser(req)])
    res.json({
      users: users.map((u) => ({
        ...u,
        activeSessions: sessionCounts ? (sessionCounts.get(String(u.id)) ?? 0) : null,
      })),
      sessionScope: 'instance',
      sessionsVolatile: true,
    })
  } catch (err) {
    next(err)
  }
})

apiRouter.post('/users', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const { name, username, role } = req.body ?? {}
    // เส้นทางนี้เอาไว้ provision 'DataLake-User' โดยเฉพาะ — สร้าง Admin ใหม่ผ่านจอนี้ไม่ได้
    // (แม้ Admin ที่เรียกเองก็ตาม) เพื่อลด blast radius หาก session ของ Admin ถูกยึด
    if (role !== ROLES.USER) return res.status(400).json({ error: 'Invalid input' })

    // รหัสผ่านชั่วคราวถูกสุ่มฝั่งเซิร์ฟเวอร์เท่านั้น — ไม่มีทาง accept ค่าจาก client
    // (ป้องกัน Admin ที่ถูกยึด session ตั้งรหัสที่รู้ล่วงหน้าให้บัญชีใหม่)
    const created = await createUserWithTempPassword({ username, displayName: name, role })
    if (!created) return res.status(400).json({ error: 'Invalid input or username already exists' })

    // ไม่มีการซิงก์เข้าชุดข้อมูลที่สองอีกแล้ว — GET /users อ่านตารางเดียวกับที่บรรทัดบน
    // เพิ่งเขียนลงไป แถวใหม่จึงปรากฏเพราะ "มันมีอยู่จริง" ไม่ใช่เพราะเราไปเติมให้ UI ดู
    await auditAct(req, 'USER_CREATE', created.username)
    // tempPassword ถูกส่งกลับ "ครั้งเดียว" ในผลลัพธ์นี้เท่านั้น — ไม่ถูกเก็บที่ไหนอีกเลย
    // (ไม่ลง audit, ไม่ลง log ฝั่งเซิร์ฟเวอร์) — Admin ต้องคัดลอกแล้วส่งต่อให้ user นอกช่องทางนี้
    res.status(201).json({
      user: { username: created.username, displayName: created.displayName, role: created.role },
      tempPassword: created.tempPassword,
    })
  } catch (err) {
    next(err)
  }
})

// ── Force Password Reset ─────────────────────────────────────────────
// endpoint เดียวที่บัญชีติด must_reset_password ยังเรียกได้ (ดู RESET_EXEMPT_PATHS
// ใน requireRole.js) — ใช้ได้ทั้งกรณีบังคับรีเซ็ตและกรณีผู้ใช้เปลี่ยนรหัสเองตามปกติ
apiRouter.post('/password/reset', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {}
    const pw = String(newPassword ?? '')

    // ต้องยืนยัน currentPassword ก่อนเสมอ แม้จะมี session ที่ authenticated แล้ว —
    // กันกรณี session ถูกขโมยชั่วขณะ (เช่น XSS สั้น ๆ) แล้วถูกใช้เปลี่ยนรหัสโดยไม่รู้ตัว
    const user = await getUserById(req.user.id)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    const ok = await bcrypt.compare(String(currentPassword ?? ''), user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

    // นโยบายรหัสผ่านขั้นต่ำ — ยาวพอ และต้องไม่ใช่รหัสเดิม/username ของตัวเอง
    if (pw.length < 12 || pw === currentPassword || pw.toLowerCase() === user.username.toLowerCase()) {
      return res.status(400).json({ error: 'Weak password' })
    }

    await updatePasswordHash(user.id, pw)
    markPasswordReset(req) // เคลียร์ flag ใน session ปัจจุบันให้ตรงกับ DB ทันที ไม่ต้อง re-login
    await req.session.save()

    await auditAct(req, 'PASSWORD_RESET', user.username)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── โปรไฟล์ของตัวเอง (จอ Settings → Account) ──────────────────────────
//
// ⚠️ ทุก endpoint ในหมวดนี้ทำงานกับ req.user.id จาก session เท่านั้น — ไม่มีตัวไหนรับ
//    userId จาก client ได้เลย ถ้าวันหนึ่งมีใครเพิ่ม :id เข้ามาในเส้นทางเหล่านี้
//    นั่นคือช่องให้ผู้ใช้คนหนึ่งเปลี่ยนชื่อ/รูปของคนอื่น = ปลอมตัวโดยที่จอมองไม่ออก

/** ชื่อโปรไฟล์ที่ผู้ใช้ตั้งเอง — แยกจาก username (ตัวระบุ) และจาก display_name (ชื่อที่ Admin ตั้ง) */
apiRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const result = await updateProfileName(req.user.id, req.body?.displayName)
    if (result === false) return res.status(400).json({ error: 'Invalid input' })

    // session ถือชื่อไว้เพื่อไม่ต้องยิง DB ทุก request — ต้องอัปเดตคู่กันทันที ไม่งั้น
    // ผู้ใช้เปลี่ยนชื่อแล้วยังเห็นชื่อเดิมไปจนกว่าจะ login ใหม่ (และไฟล์ที่อัปโหลด
    // ระหว่างนั้นจะถูกป้ายด้วยชื่อเก่า)
    const fresh = await getUserById(req.user.id)
    if (!fresh) return res.status(401).json({ error: 'Not authenticated' })
    const effective = effectiveDisplayName(fresh)
    setSessionDisplayName(req, effective)
    await new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())))

    // audit: บันทึกว่า "ใครเปลี่ยนชื่อตัวเอง" โดยเก็บชื่อใหม่เป็น hash — ชื่อที่ผู้ใช้
    // พิมพ์เองไม่ควรลง log ดิบ ๆ (privacy-preserving แบบเดียวกับชื่อไฟล์)
    await auditAct(req, 'PROFILE_UPDATE', effective)
    // ⚠️ accountName ต้องส่งชัด ๆ: publicUser fallback เป็น u.displayName ซึ่งเราเพิ่งเขียนทับ
    //    ด้วยชื่อโปรไฟล์ไปแล้ว — ถ้าไม่ระบุ จอ Settings จะแสดง "ชื่อที่ Admin ตั้ง" เท่ากับ
    //    ชื่อที่ผู้ใช้เพิ่งพิมพ์เอง = หายไปทั้งความสามารถในการเทียบว่าใครเป็นใคร
    res.json({
      user: publicUser({ ...fresh, displayName: effective, accountName: fresh.displayName }),
      hasAvatar: Boolean(fresh.avatarKey),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * รูปโปรไฟล์ — multipart field 'avatar'
 * ⚠️ ชนิดไฟล์ถูกตัดสินจากไบต์จริง และ metadata (EXIF/GPS/คอมเมนต์) ถูกถอดออก
 *    "ก่อน" เขียนลงดิสก์ — ดูเหตุผลและรายละเอียดใน storage/avatarStore.js
 * ⚠️ ลำดับ: sanitize → เขียนไฟล์ใหม่ → อัปเดต DB → ลบไฟล์เก่า
 *    ถ้าอัปเดต DB ล้มเหลว เราลบไฟล์ใหม่ทิ้งและคงของเดิมไว้ครบ (ไม่เหลือไฟล์กำพร้า
 *    และไม่ทำให้ผู้ใช้เสียรูปเดิมไปเพราะการอัปโหลดที่ล้มเหลว)
 */
apiRouter.post('/profile/avatar', requireAuth, (req, res, next) => {
  avatarUploadMiddleware(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE'
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File too large' : 'Invalid input' })
    }
    if (!req.file?.buffer) return res.status(400).json({ error: 'Invalid input' })

    try {
      const clean = sanitizeAvatar(req.file.buffer)
      if (!clean) {
        // ไม่ใช่ PNG/JPEG ที่ถอดภาพได้จริง — ปฏิเสธโดยไม่บอกว่าเดาชนิดอะไรได้บ้าง
        await auditAct(req, 'PROFILE_AVATAR_SET', String(req.user.id), 'DENIED')
        return res.status(415).json({ error: 'Unsupported image' })
      }

      const key = await writeAvatar(clean)
      let oldKey
      try {
        oldKey = await updateAvatar(req.user.id, { key, mime: clean.mime })
      } catch (dbErr) {
        await removeAvatar(key).catch(() => {})
        throw dbErr
      }
      // รูปเดิมไม่มีใครอ้างถึงอีกแล้ว — ลบทิ้งเสมอ ไม่ปล่อยให้ค้างบนดิสก์ต่อไปเงียบ ๆ
      if (oldKey && oldKey !== key) await removeAvatar(oldKey).catch(() => {})

      await auditAct(req, 'PROFILE_AVATAR_SET', String(req.user.id))
      res.status(201).json({ hasAvatar: true, mime: clean.mime, bytes: clean.bytes.length })
    } catch (err) {
      next(err)
    }
  })
})

apiRouter.delete('/profile/avatar', requireAuth, async (req, res, next) => {
  try {
    const current = await getAvatar(req.user.id)
    if (!current) return res.status(404).json({ error: 'Not found' })
    await updateAvatar(req.user.id, { key: null, mime: null })
    await removeAvatar(current.key).catch(() => {})
    await auditAct(req, 'PROFILE_AVATAR_CLEAR', String(req.user.id))
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/**
 * เสิร์ฟรูปโปรไฟล์ของบัญชีใดก็ได้ให้ผู้ใช้ที่ล็อกอินแล้ว (จอ Access/Files แสดงรูปคนอื่น)
 * ⚠️ Content-Type มาจากคอลัมน์ avatar_mime ที่เซิร์ฟเวอร์ sniff จากไบต์เองตอนอัปโหลด
 *    และคอลัมน์นั้นมี CHECK ให้เป็น image/png|image/jpeg เท่านั้น — จึง render inline ได้
 *    ปลอดภัย ยังใส่ nosniff กำกับไว้อีกชั้นเพื่อไม่ให้เบราว์เซอร์เดาชนิดเอง
 */
apiRouter.get('/users/:id/avatar', requireAuth, async (req, res, next) => {
  try {
    const avatar = await getAvatar(req.params.id)
    if (!avatar) return res.status(404).json({ error: 'Not found' })
    const size = await avatarSize(avatar.key)
    const stream = openAvatar(avatar.key)
    if (!stream || size === null) return res.status(404).json({ error: 'Not found' })

    res.setHeader('Content-Type', avatar.mime)
    res.setHeader('Content-Length', String(size))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=60')
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy() })
    stream.pipe(res)
  } catch (err) {
    next(err)
  }
})

// ── เซสชันของตัวเอง (จอ Settings) ─────────────────────────────────────
// ⚠️ อ่านจาก session store จริง กรองด้วย id ของผู้เรียก — ไม่ใช่แถวที่แต่งขึ้นหนึ่งแถว
//    อย่างเดิม (ของเดิมคืน { device: 'This browser', ip: '—' } คงที่เสมอ ซึ่งดูเหมือน
//    ฟีเจอร์ security ที่ตรวจอุปกรณ์ได้ แต่ไม่ได้ตรวจอะไรเลย)
apiRouter.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    res.json({ sessions: await listSessionsForUser(req), volatile: true })
  } catch (err) {
    next(err)
  }
})

/** เพิกถอนเซสชันอื่นของตัวเอง — ของจริง: ทำลายแถวใน session store ทันที */
apiRouter.delete('/sessions/:ref', requireAuth, async (req, res, next) => {
  try {
    // เพิกถอนเซสชันที่กำลังใช้อยู่ผ่านเส้นนี้ไม่ได้ — ใช้ /logout (ซึ่งล้าง cookie ให้ด้วย)
    if (sessionRef(req.sessionID) === req.params.ref) {
      return res.status(400).json({ error: 'Use logout for the current session' })
    }
    const ok = await revokeSessionByRef(req, req.params.ref)
    if (!ok) return res.status(404).json({ error: 'Not found' })
    await auditAct(req, 'SESSION_REVOKE', req.params.ref)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// ── Zero-Knowledge Vault ─────────────────────────────────────────────
//
// เข้ารหัสฝั่ง client เท่านั้น — server เก็บได้แค่ ciphertext ที่อ่านไม่ออก แม้แต่ Admin ก็เปิดไม่ได้
// ทุก endpoint ในหมวดนี้ "ไม่มีทาง" รับ/คืน plaintext หรือกุญแจ — มีแค่ salt/iv/ciphertext
//
// ⚠️ กติกาที่ห้ามละเมิดในหมวดนี้ (ถ้าเห็นโค้ดขัดข้อใดข้อหนึ่ง = bug ระดับสถาปัตยกรรม):
//    1. ไม่มี route ใดรับ passphrase, KEK, DEK ที่ยังไม่ถูกห่อ หรือ plaintext ของไฟล์
//    2. ไม่มี route ใดสร้าง thumbnail/preview/ค้นหาเนื้อหา — ต้องใช้ plaintext ทั้งนั้น
//    3. userId มาจาก req.user (session) เสมอ — client ระบุ userId มาไม่ได้เลย
//    4. audit บันทึกได้แค่ actor/เวลา/ชนิดการกระทำ + hash ของ blob id ที่เซิร์ฟเวอร์
//       ตั้งเอง — ห้ามบันทึกชื่อไฟล์ (เซิร์ฟเวอร์ไม่รู้อยู่แล้ว) และห้ามบันทึกกุญแจ
//    5. ไม่มี console.log ของ req.body ในหมวดนี้ — body มี wrapped DEK อยู่

// ── Vault V2 — chunked zero-knowledge upload (LFT-V2-B) ──────────────────────
// ⚠️ ต้อง mount "ก่อน" '/vault/blobs/:id' ด้านล่าง ด้วยเหตุผลเดียวกับ '/files/uploads'
apiRouter.use('/vault/uploads', vaultUploadsRouter)

/**
 * สถานะ vault + บัญชีรายการ blob "ทั้ง V1 และ V2" ในรายการเดียว
 *
 * ⚠️ รายการเดียวโดยเจตนา: ผู้ใช้มีห้องนิรภัยห้องเดียว ไม่ใช่สองห้อง รูปแบบของ blob
 *    เป็นรายละเอียดของการเข้ารหัส ไม่ใช่หมวดหมู่ของผลิตภัณฑ์ — client แยกด้วย
 *    formatVersion เพื่อเลือกเส้นทางถอดรหัส/ดาวน์โหลดที่ถูกต้องเท่านั้น
 * ⚠️ V1 ได้ formatVersion: 1 อย่างชัดแจ้ง ไม่ปล่อยให้ client เดาจากการมี/ไม่มี ivB64
 *    ("ไม่มีฟิลด์" ตีความได้ทั้ง 'ไม่มี' และ 'ลืมส่ง' — ตัวเลขตีความได้อย่างเดียว)
 * ⚠️ ไม่มีรายการใดคืน storageKey / ชื่อไฟล์ / MIME — ขณะล็อกจอมีข้อมูลแค่ id ทึบ
 *    ขนาด ciphertext และเวลาที่แถวถูกบันทึก ซึ่งเป็นสิ่งที่เซิร์ฟเวอร์รู้อยู่แล้วทั้งหมด
 */
apiRouter.get('/vault', requireAuth, async (req, res, next) => {
  try {
    const meta = await store.getVaultMeta(req.user.id)
    if (!meta) {
      // ยังไม่เคยตั้งค่า — client เข้าสู่ setup flow (ไม่ใช่ error)
      return res.json({ configured: false, blobs: [] })
    }
    const [v1Blobs, v2Blobs] = await Promise.all([
      store.listVaultBlobs(req.user.id),
      vaultV2.listVaultV2Blobs(req.user.id),
    ])
    // ส่ง envelope ครบเพื่อให้ client แกะ "ชื่อไฟล์" เองได้หลังปลดล็อก
    // storageKey ไม่ถูกส่งออกไป — เป็นรายละเอียดภายในของ Storage Layer
    const blobs = [
      ...v1Blobs.map((b) => ({
        id: b.id, formatVersion: 1, size: b.size, createdAt: b.createdAt,
        ivB64: b.ivB64, wrappedDekB64: b.wrappedDekB64, wrapIvB64: b.wrapIvB64,
        metaIvB64: b.metaIvB64, metaB64: b.metaB64,
      })),
      ...v2Blobs.map(publicVaultV2Blob),
    ].sort((a, b) => b.createdAt - a.createdAt)

    return res.json({
      configured: true,
      saltB64: meta.saltB64,
      params: meta.params,
      verifier: meta.verifier,
      blobs,
    })
  } catch (err) {
    return next(err)
  }
})

/**
 * ตั้งค่า vault ครั้งแรก — client สร้าง salt + verifier เองทั้งหมดแล้วส่งผลลัพธ์มาเก็บ
 * ⚠️ ไม่มี endpoint สำหรับ "รีเซ็ต passphrase" และจะไม่มี: เซิร์ฟเวอร์ไม่มีชิ้นส่วนใด
 *    ที่ใช้กู้ KEK ได้เลย ลืม passphrase = ข้อมูลหายถาวร (ตรงกับคำสัญญาใน UI)
 */
apiRouter.post('/vault/setup', requireAuth, async (req, res, next) => {
  try {
    const { saltB64, params, verifier } = req.body ?? {}
    const row = await store.createVaultMeta(req.user.id, { saltB64, params, verifier })
    if (!row) {
      // ตั้งค่าไปแล้ว หรือ input ผิดรูป — แยกสองกรณีเพื่อให้ client ทำต่อถูก
      const existing = await store.getVaultMeta(req.user.id)
      if (existing) {
        await auditAct(req, 'VAULT_SETUP', String(req.user.id), 'DENIED')
        return res.status(409).json({ error: 'Vault already configured' })
      }
      return res.status(400).json({ error: 'Invalid input' })
    }
    await auditAct(req, 'VAULT_SETUP', String(req.user.id))
    res.status(201).json({ configured: true, saltB64: row.saltB64, params: row.params, verifier: row.verifier })
  } catch (err) {
    next(err)
  }
})

/**
 * บันทึกผลการพยายามปลดล็อกลง audit
 * ⚠️ การพิสูจน์ passphrase เกิดฝั่ง client ล้วน (นั่นคือจุดประสงค์ของ zero-knowledge)
 *    เซิร์ฟเวอร์จึง "ไม่มีทาง" ยืนยันผลนี้ได้เอง — entry นี้จึงเป็นหลักฐานเชิงพฤติกรรม
 *    (ใครแตะ vault เมื่อไร) ไม่ใช่หลักฐานเชิงลับ และตั้งใจให้เป็นเช่นนั้น
 *    รับแค่ boolean — ไม่รับ passphrase, ไม่รับ hash ของ passphrase, ไม่รับกุญแจ
 */
// ⚠️ await ก่อนตอบ 204: endpoint นี้ "มีอยู่เพื่อเขียน audit อย่างเดียว" การตอบสำเร็จ
//    ก่อนที่แถวจะลงจริงคือการโกหก client และในโหมด Postgres มันคือ race จริง ๆ
//    (โหมด in-memory เขียนแบบ synchronous จึงไม่เคยเห็นปัญหานี้ — ดู log 2026-07-26)
apiRouter.post('/vault/unlock-attempt', requireAuth, async (req, res, next) => {
  try {
    const ok = req.body?.ok === true
    await auditAct(req, 'VAULT_UNLOCK', String(req.user.id), ok ? 'OK' : 'DENIED')
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/**
 * อัปโหลด ciphertext ของไฟล์ (multipart) — field 'file' คือ .aegisenc ที่เข้ารหัสแล้ว
 * envelope (iv / wrapped DEK / wrap iv / metadata ciphertext) มาทาง form fields
 *
 * ⚠️ ลำดับเดียวกับ /files/upload: เขียน bytes ก่อน → INSERT metadata → ถ้า INSERT
 *    ล้มเหลวให้ลบ bytes ทิ้ง (ไม่เหลือ ciphertext กำพร้าที่ไม่มีทางถอดได้อีกเลย)
 * ⚠️ size ที่บันทึกคือขนาด ciphertext บนดิสก์ที่เซิร์ฟเวอร์วัดเอง — ขนาด plaintext จริง
 *    ถูกเข้ารหัสอยู่ใน metaB64 เซิร์ฟเวอร์จึงรู้แค่ "ประมาณเท่าไร" ไม่ใช่ค่าจริง
 */
apiRouter.post('/vault/blobs', requireAuth, (req, res, next) => {
  vaultUploadMiddleware(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE'
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File too large' : 'Invalid input' })
    }
    if (!req.file) return res.status(400).json({ error: 'Invalid input' })

    // multer เขียน ciphertext ลง vault/ ให้แล้ว — key นี้คือสิ่งที่จะบันทึกลง DB
    const storageKey = keyForUploadedVaultBlob(req.file)

    try {
      const envelope = {
        ivB64: req.body?.ivB64,
        wrappedDekB64: req.body?.wrappedDekB64,
        wrapIvB64: req.body?.wrapIvB64,
        metaIvB64: req.body?.metaIvB64,
        metaB64: req.body?.metaB64,
      }
      if (!store.validVaultEnvelope(envelope)) {
        await removeVaultCiphertext(storageKey)
        return res.status(400).json({ error: 'Invalid input' })
      }

      // ต้องตั้งค่า vault ก่อนถึงจะมี KEK ให้ห่อ DEK ได้ — ไม่มี meta = request ไม่สมเหตุผล
      const meta = await store.getVaultMeta(req.user.id)
      if (!meta) {
        await removeVaultCiphertext(storageKey)
        return res.status(409).json({ error: 'Vault not configured' })
      }

      const size = await vaultCiphertextSize(storageKey)
      if (size === null) {
        await removeVaultCiphertext(storageKey)
        return res.status(500).json({ error: 'Internal error' })
      }

      let row
      try {
        row = await store.addVaultBlob(req.user.id, { storageKey, size, envelope })
      } catch (dbErr) {
        await removeVaultCiphertext(storageKey)
        throw dbErr
      }
      if (!row) {
        await removeVaultCiphertext(storageKey)
        return res.status(400).json({ error: 'Invalid input' })
      }

      // audit: ไม่มีชื่อไฟล์ให้บันทึก (เซิร์ฟเวอร์มองไม่เห็น) — บันทึกแค่ "มีการเพิ่ม blob"
      await auditAct(req, 'VAULT_BLOB_ADD', row.id)
      res.status(201).json({
        blob: {
          id: row.id, size: row.size, createdAt: row.createdAt,
          ivB64: row.ivB64, wrappedDekB64: row.wrappedDekB64, wrapIvB64: row.wrapIvB64,
          metaIvB64: row.metaIvB64, metaB64: row.metaB64,
        },
      })
    } catch (err) {
      await removeVaultCiphertext(storageKey).catch(() => {})
      next(err)
    }
  })
})

/**
 * ดาวน์โหลด ciphertext ของ blob — stream ตรงจากดิสก์ ไม่โหลดเข้า RAM
 * ⚠️ เซิร์ฟเวอร์ส่ง "ciphertext ดิบ" เท่านั้น — การถอดรหัส/ตั้งชื่อไฟล์/แสดงตัวอย่าง
 *    เกิดฝั่งเบราว์เซอร์ทั้งหมด Content-Type จึงเป็น octet-stream เสมอ (เซิร์ฟเวอร์
 *    ไม่รู้ชนิดไฟล์จริง) และชื่อไฟล์ที่แนบไปเป็น id ทึบ ไม่ใช่ชื่อที่ผู้ใช้ตั้ง
 * ⚠️ path บนดิสก์มาจากคอลัมน์ storage_key ใน DB เท่านั้น ไม่เคยมาจาก input ของ client
 *
 * ── V1 (ทั้งไฟล์) กับ V2 (ทีละ chunk) อยู่ในหมวดนี้ด้วยกัน ────────────────────
 * V1 คือเส้นทางเดิมที่ blob ที่มีอยู่แล้วยังใช้อยู่ และมันจะไม่ถูกถอดออก
 * V2 มีเส้นทางของตัวเองด้านล่างเพราะไฟล์เดียวมีหลายข้อความ AEAD ที่ต้องขอแยกกัน
 */

/**
 * ดาวน์โหลด ciphertext ของ "หนึ่ง chunk" ของ blob V2 — หัวใจของการถอดรหัสแบบมีขอบเขต
 *
 * ⚠️ นี่คือสิ่งที่ทำให้หน่วยความจำของทั้งสองฝั่งเป็น O(ขนาด chunk) ไม่ใช่ O(ขนาดไฟล์):
 *    เซิร์ฟเวอร์อ่านเฉพาะช่วง [index × chunkSize, +ขนาดของก้อนนี้) จากไฟล์เดียวบนดิสก์
 *    ด้วย read stream ที่มีขอบเขต และเบราว์เซอร์ถอดทีละก้อนแล้วเขียนลง sink ทันที
 * ⚠️ ช่วงที่อ่านมาจาก "แถวใน DB" ทั้งหมด (chunk_size / ciphertext_size ที่แช่แข็งไว้ตอน
 *    commit) client ระบุได้แค่ index — และ index ที่เกินขอบเขตคือ 404 ไม่ใช่ช่วงที่ตัดให้
 * ⚠️ IV ของก้อนนี้ถูกส่งกลับทาง header เพราะมันคือ "ข้อมูลที่จำเป็นต่อการถอดและไม่ใช่
 *    ความลับ" ส่วน AAD **ไม่** ถูกส่ง — เบราว์เซอร์ประกอบขึ้นเองจาก (formatVersion,
 *    contentId, index, chunkCount) ที่มันถืออยู่แล้ว ถ้าเซิร์ฟเวอร์เป็นคนบอก AAD
 *    เซิร์ฟเวอร์ที่ถูกยึดจะสั่งให้เบราว์เซอร์ยอมรับ chunk ที่สลับตำแหน่งได้
 * ⚠️ ไม่มี plaintext metadata ใด ๆ ใน response นี้ — ไม่มีแม้แต่ชื่อไฟล์ทึบ
 */
apiRouter.get('/vault/blobs/:id/chunks/:index', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '')
    // id ผิดรูปแบบ / ไม่ใช่ของผู้เรียก / ไม่มีจริง → 404 เหมือนกันหมด
    if (!isValidVaultBlobId(id)) return res.status(404).json({ error: 'Not found' })
    const blob = await vaultV2.findVaultV2Blob(req.user.id, id)
    if (!blob) return res.status(404).json({ error: 'Not found' })

    const rawIndex = String(req.params.index ?? '')
    if (!/^\d{1,9}$/.test(rawIndex)) return res.status(404).json({ error: 'Not found' })
    const index = Number(rawIndex)
    if (index >= blob.chunkCount) return res.status(404).json({ error: 'Not found' })

    const chunk = await vaultV2.findVaultV2BlobChunk(blob.id, index)
    if (!chunk) return res.status(404).json({ error: 'Not found' })

    const start = index * blob.chunkSize
    const stream = openVaultCiphertextRange(blob.storageKey, { start, end: start + chunk.size - 1 })
    if (!stream) {
      await auditAct(req, 'VAULT_V2_READ', blob.id, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Not found' })
      else res.destroy()
    })

    // ⚠️ บันทึก audit เฉพาะ chunk แรกของการอ่านหนึ่งครั้ง ไม่ใช่ทุกก้อน: ไฟล์ 5 GiB
    //    ที่ chunk ละ 16 MiB คือ 320 แถวต่อการดาวน์โหลดหนึ่งครั้ง ซึ่งจะกลบเหตุการณ์
    //    อื่นทั้งหมดใน audit จนใช้สืบสวนไม่ได้ — สัญญาณที่ต้องการคือ "ใครเปิดอ่าน blob
    //    ไหนเมื่อไร" ซึ่งหนึ่งแถวตอบได้ครบแล้ว (นโยบายนี้ถูกบันทึกไว้ตามจริง: การอ่าน
    //    ที่เริ่มแล้วไม่จบ กับการอ่านที่จบครบ มีหน้าตาเหมือนกันใน audit)
    if (index === 0) await auditAct(req, 'VAULT_V2_READ', blob.id)

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(chunk.size))
    res.setHeader('X-Vault-Chunk-IV', chunk.ivB64)
    res.setHeader('X-Vault-Chunk-Index', String(index))
    // ⚠️ ต้องประกาศให้ browser อ่าน header สองตัวนี้ได้ — same-origin ก็จริง แต่ถ้า
    //    วันหนึ่งมี proxy/CORS คั่น การขาดบรรทัดนี้จะทำให้ IV หายไปเงียบ ๆ แล้วการถอด
    //    ล้มเหลวโดยดูเหมือน "ไฟล์เสีย" แทนที่จะเป็นปัญหาการตั้งค่า
    res.setHeader('Access-Control-Expose-Headers', 'X-Vault-Chunk-IV, X-Vault-Chunk-Index')
    res.setHeader('Cache-Control', 'no-store')
    return stream.pipe(res)
  } catch (err) {
    return next(err)
  }
})

apiRouter.get('/vault/blobs/:id', requireAuth, async (req, res, next) => {
  try {
    // ⚠️ blob V2 ไม่มี "ทั้งไฟล์" ให้ดาวน์โหลดผ่านเส้นทางนี้โดยเจตนา: การเปิดช่องนั้น
    //    ไว้เท่ากับเชิญให้ client กลับไปโหลดทั้งก้อนเข้า RAM ซึ่งคือปัญหาที่ V2 แก้อยู่
    //    ตอบ 409 (ไม่ใช่ 404) เฉพาะเมื่อพิสูจน์แล้วว่า **เป็นของผู้เรียกจริง** — ของคน
    //    อื่นยังคงเป็น 404 เหมือนเดิม จึงไม่มีการยืนยันการมีอยู่ให้ใครที่ไม่ใช่เจ้าของ
    if (isValidVaultBlobId(String(req.params.id ?? ''))) {
      const v2Blob = await vaultV2.findVaultV2Blob(req.user.id, String(req.params.id))
      if (!v2Blob) return res.status(404).json({ error: 'Not found' })
      return res.status(409).json({
        error: 'Chunked blob', code: 'VAULT_V2_USE_CHUNK_ENDPOINT', chunkCount: v2Blob.chunkCount,
      })
    }
    const blob = await store.findVaultBlob(req.user.id, req.params.id)
    // ไม่ใช่เจ้าของ หรือไม่มีจริง → 404 เหมือนกัน (ไม่ให้เดาว่า id ไหนมีอยู่)
    if (!blob) return res.status(404).json({ error: 'Not found' })

    const stream = openVaultCiphertext(blob.storageKey)
    if (!stream) {
      await auditAct(req, 'VAULT_BLOB_READ', blob.id, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }

    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Not found' })
      else res.destroy()
    })

    await auditAct(req, 'VAULT_BLOB_READ', blob.id)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(blob.size))
    res.setHeader('Content-Disposition', `attachment; filename="${blob.id}.aegisenc"`)
    // ciphertext ที่ถอดไม่ได้ก็ยังไม่ควรถูก cache โดย proxy ระหว่างทาง
    res.setHeader('Cache-Control', 'no-store')
    stream.pipe(res)
  } catch (err) {
    next(err)
  }
})

/**
 * ลบ blob — metadata ก่อน แล้วค่อยลบ bytes (ลำดับกลับกับตอนเขียน)
 *
 * ⚠️ เส้นทางเดียวรับทั้งสองรูปแบบ เพราะผู้ใช้เห็น "ไฟล์ในห้องนิรภัย" ไม่ใช่ "blob V1/V2"
 *    การแยกเป็นสอง endpoint จะบังคับให้ UI ต้องรู้รูปแบบก่อนจะลบได้ ซึ่งเป็นความรู้ที่
 *    ไม่ควรจำเป็นต่อการลบของตัวเอง
 * ⚠️ id ของสองรูปแบบชนกันไม่ได้โดยโครงสร้าง (V1 = ตัวเลขล้วน, V2 = hex 48 ตัว) การ
 *    แยกจึงไม่ใช่การเดา และ id ที่ไม่ตรงรูปแบบไหนเลยจบที่ 404 เหมือนของคนอื่น
 * ⚠️ แถว chunk ของ V2 หายไปพร้อมแถว blob ผ่าน ON DELETE CASCADE — ไม่มีขั้นตอนแยกที่
 *    อาจถูกข้ามเมื่อคำขอถูกตัดกลางคัน และไม่มี blob อื่นถูกแตะเลย
 */
apiRouter.delete('/vault/blobs/:id', requireAuth, async (req, res, next) => {
  try {
    if (isValidVaultBlobId(String(req.params.id ?? ''))) {
      const v2Blob = await vaultV2.findVaultV2Blob(req.user.id, String(req.params.id))
      if (!v2Blob) return res.status(404).json({ error: 'Not found' })
      await vaultV2.deleteVaultV2Blob(req.user.id, v2Blob.id)
      await removeVaultCiphertext(v2Blob.storageKey)
      await auditAct(req, 'VAULT_V2_DELETE', v2Blob.id)
      return res.status(204).end()
    }
    const blob = await store.findVaultBlob(req.user.id, req.params.id)
    if (!blob) return res.status(404).json({ error: 'Not found' })
    await store.deleteVaultBlob(req.user.id, blob.id)
    await removeVaultCiphertext(blob.storageKey)
    await auditAct(req, 'VAULT_BLOB_DELETE', blob.id)
    return res.status(204).end()
  } catch (err) {
    return next(err)
  }
})
