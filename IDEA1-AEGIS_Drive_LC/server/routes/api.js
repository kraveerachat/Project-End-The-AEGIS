// server/routes/api.js — AEGIS Drive (IDEA1)
// /api/login · /api/logout · /api/me · /api/audit (Admin)
// ⚠️ login รับแค่ { username, password, remember } — ห้ามรับค่า role จาก client
//    server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { verifyCredentials } from '../auth/login.js'
import { establishSession, currentUser, currentCsrfToken, destroySession, markPasswordReset } from '../auth/session.js'
import { checkLock, recordFailure, recordSuccess } from '../auth/rateLimit.js'
import { getNavForRole } from '../rbac/permissions.js'
import { requireAuth, requireRole } from '../middleware/requireRole.js'
import {
  recordAudit, readAudit, sha256Hex,
  getUserById, createUserWithTempPassword, updatePasswordHash, listUsers,
} from '../db/connection.js'
import { ROLES } from '../rbac/permissions.js'
import * as store from '../db/store.js'
// Storage Layer — ไฟล์ดิบอยู่บน filesystem (Docker volume) ไม่ใช่ใน Postgres
import {
  uploadMiddleware, keyForUploaded, resolveKey, sizeOfFile, sha256OfFile,
  keyExists, openReadStream, removeKey, discardUploaded,
} from '../storage/fileStore.js'
// Storage Layer ของ Vault — แยกโฟลเดอร์จาก uploads/ และเก็บ "ciphertext ล้วน" เท่านั้น
import {
  vaultUploadMiddleware, keyForUploadedVaultBlob,
  openVaultCiphertext, vaultCiphertextSize, removeVaultCiphertext,
} from '../storage/vaultStore.js'

// ข้อความล้มเหลว "รูปแบบเดียว" ทุกกรณี — user ผิด / รหัสผิด / ไม่กรอก → เหมือนกันหมด
// ข้อความ error เหมือนกันทุกกรณี และใช้เวลาประมวลผลเท่ากัน เพื่อป้องกัน username enumeration
const INVALID_CREDENTIALS = 'Invalid credentials'

// สิ่งที่ client เห็นได้ — role เปิดเผยเพื่อ "แสดงผล" แต่ client ตั้งค่ามันไม่ได้
// mustResetPassword เป็น boolean ล้วน (ไม่รั่ว hash/รหัสผ่าน) — ใช้แค่พา client ไปหน้ารีเซ็ต
const publicUser = (u) => ({ username: u.username, displayName: u.displayName, role: u.role, mustResetPassword: Boolean(u.mustResetPassword) })

export const apiRouter = Router()

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
    recordAudit({
      actorLabel: 'unknown', action: 'LOGIN', targetHash: sha256Hex(String(username)),
      result: 'DENIED', sourceIp: req.ip,
    })
    if (accountLockMs || ipLockMs) {
      recordAudit({
        actorLabel: 'system', action: 'LOGIN_LOCKOUT', targetHash: sha256Hex(String(username)),
        result: 'BLOCKED', sourceIp: req.ip,
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

  recordAudit({
    actorId: user.id, actorLabel: user.username, role: user.role,
    action: 'LOGIN', result: 'OK', sourceIp: req.ip,
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
    recordAudit({
      actorId: user.id, actorLabel: user.username, role: user.role,
      action: 'LOGOUT', result: 'OK', sourceIp: req.ip,
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

// ── Audit (Admin เท่านั้น — ตรวจ role ฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนเมนู) ──────
apiRouter.get('/audit', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    const rows = await readAudit(200)
    res.json({ events: rows })
  } catch (err) {
    next(err)
  }
})

// ════ Data endpoints (Phase 2) ═══════════════════════════════════════
// ทุกตัวผ่าน requireAuth/requireRole เสมอ — การกรองเมนูฝั่ง UI ไม่ใช่ control
// การกระทำที่เปลี่ยนสถานะทุกครั้งลง audit โดยเก็บชื่อไฟล์เป็น hash (privacy-preserving)

const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(target) : null, result, sourceIp: req.ip,
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
    // สถานะความปลอดภัยรวม: จำนวนเหตุการณ์ DENIED/BLOCKED ล่าสุด (0 = all clear)
    const securityAlerts = audit.filter((e) => e.result !== 'OK').length
    const shares = await store.listShares()
    res.json({
      ...(await store.dashboard()),
      loginHistory: myLogins,
      securityAlerts,
      shares: shares.slice(0, 4), // ลิงก์แชร์ที่เปิดอยู่ (สเปกของจอ Dashboard)
    })
  } catch (err) {
    next(err)
  }
})

// ── Files ────────────────────────────────────────────────────────────
apiRouter.get('/files', requireAuth, async (req, res, next) => {
  try {
    res.json({ files: await store.listFiles() })
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
    auditAct(req, 'FOLDER_CREATE', name)
    res.status(201).json({ file: row })
  } catch (err) {
    next(err)
  }
})

// ── Upload — Storage Layer (bytes) + Metadata Layer (แถวใน files) ────────────
// ⚠️ ลำดับสำคัญ: เขียน bytes ลงดิสก์ให้เสร็จก่อน แล้วค่อย INSERT metadata — ถ้าสลับกัน
//    แล้วดิสก์ล้มเหลว จะเหลือแถวที่ชี้ไปยังไฟล์ที่ไม่มีอยู่จริง (metadata โกหก)
//    ถ้า INSERT ล้มเหลวทีหลัง เราลบ bytes ทิ้ง (discardUploaded) — ไม่เหลือไฟล์กำพร้า
// ⚠️ size และ sha256 มาจาก "ไฟล์บนดิสก์จริง" ที่เซิร์ฟเวอร์อ่านเอง ไม่ใช่ค่าที่ client แจ้ง
//    client แจ้ง sha256 มาได้ แต่ใช้แค่ "เทียบ" เพื่อจับ corruption ระหว่างทางเท่านั้น
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
        auditAct(req, 'FILE_UPLOAD', name, 'DENIED')
        return res.status(422).json({ error: 'Checksum mismatch' })
      }

      let row
      try {
        row = await store.recordUpload({ name, storageKey, size, sha256, user: req.user })
      } catch (dbErr) {
        await discardUploaded(req.file) // metadata ไม่ผ่าน = ต้องไม่เหลือ bytes กำพร้า
        throw dbErr
      }

      auditAct(req, 'FILE_UPLOAD', name)
      res.status(201).json({ file: row })
    } catch (err) {
      next(err)
    }
  })
})

// ── Download — stream bytes จริงจาก Storage Layer ────────────────────────────
// ⚠️ client ส่งมาแค่ id ของแถวใน Metadata Layer — path บนดิสก์มาจากคอลัมน์ใน DB
//    เท่านั้น ไม่เคยมาจาก input ของ client (ไม่มีทางขอไฟล์นอก STORAGE_ROOT)
//    resolveKey() ยังกันซ้ำอีกชั้นเผื่อค่าใน DB ถูกแก้ให้ชี้ออกนอกกรอบ
apiRouter.get('/files/:id/download', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })
    if (file.type === 'Folder') return res.status(400).json({ error: 'Not a file' })

    const abs = resolveKey(file.path)
    if (!abs || !(await keyExists(file.path))) {
      // แถว metadata มีอยู่แต่ไม่มี bytes (แถวเดโม่เก่า/ไฟล์ถูกลบนอกระบบ) — ไม่ปลอมข้อมูลคืน
      auditAct(req, 'FILE_DOWNLOAD', file.name, 'DENIED')
      return res.status(404).json({ error: 'Not found' })
    }

    auditAct(req, 'FILE_DOWNLOAD', file.name)

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
//    ทั้งแถว metadata และ bytes บนดิสก์** (ลบแล้วกู้ไม่ได้ ไม่มี trash)
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
      auditAct(req, 'FILE_DELETE', file.name, 'DENIED')
      return res.status(403).json({ error: 'Forbidden' })
    }

    await store.deleteFile(req.params.id)
    // ลบ metadata แล้วต้องลบ bytes ตามด้วยเสมอ — ไม่งั้นไฟล์ที่ผู้ใช้ "ลบแล้ว" ยังนอน
    // อยู่บนดิสก์ต่อไปโดยไม่มีใครเห็นและไม่มีใครลบได้อีก (ทั้ง privacy และพื้นที่)
    if (file.type !== 'Folder') await removeKey(file.path)
    auditAct(req, 'FILE_DELETE', file.name)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── Shares — VLAN-aware secure links ─────────────────────────────────
apiRouter.get('/shares', requireAuth, async (req, res, next) => {
  try {
    res.json({ shares: await store.listShares() })
  } catch (err) {
    next(err)
  }
})

apiRouter.post('/shares', requireAuth, async (req, res, next) => {
  try {
    const { fileId, expiry, authType, scope } = req.body ?? {}
    const row = await store.createShare({ fileId, expiry, authType, scope }, req.user)
    if (!row) return res.status(400).json({ error: 'Invalid input' })
    auditAct(req, 'SHARE_CREATE', row.fileName)
    res.status(201).json({ share: row })
  } catch (err) {
    next(err)
  }
})

apiRouter.delete('/shares/:id', requireAuth, async (req, res, next) => {
  try {
    const ok = await store.revokeShare(req.params.id)
    if (!ok) return res.status(404).json({ error: 'Not found' })
    auditAct(req, 'SHARE_REVOKE', req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── Snapshots & recovery ─────────────────────────────────────────────
apiRouter.get('/snapshots', requireAuth, (req, res) => {
  res.json({ snapshots: store.listSnapshots() })
})

apiRouter.post('/snapshots/:id/rollback', requireAuth, (req, res) => {
  // ยืนยันสองชั้นฝั่ง client (พิมพ์ id) — แต่ server ตรวจของจริงเองเสมอ
  const result = store.rollbackTo(req.params.id)
  if (!result) return res.status(404).json({ error: 'Not found' })
  auditAct(req, 'SNAPSHOT_ROLLBACK', req.params.id)
  res.json(result)
})

// ── Storage & backup ─────────────────────────────────────────────────
apiRouter.get('/storage', requireAuth, (req, res) => {
  res.json(store.storageStatus())
})

// ── Encryption keys & network zones (Admin governance เท่านั้น) ────────
apiRouter.get('/keys', requireRole(ROLES.ADMIN), (req, res) => {
  res.json(store.keysStatus())
})

apiRouter.post('/keys/rotate', requireRole(ROLES.ADMIN), (req, res) => {
  const row = store.rotateKeys()
  auditAct(req, 'KEY_ROTATE', row.keyId)
  res.json(row)
})

apiRouter.get('/zones', requireRole(ROLES.ADMIN), (req, res) => {
  res.json({ zones: store.listNetworkZones() })
})

apiRouter.post('/zones', requireRole(ROLES.ADMIN), (req, res) => {
  const { name, cidr } = req.body ?? {}
  const row = store.addNetworkZone({ name, cidr })
  if (!row) return res.status(400).json({ error: 'Invalid input' })
  auditAct(req, 'ZONE_CREATE', row.cidr)
  res.status(201).json({ zone: row })
})

apiRouter.delete('/zones/:id', requireRole(ROLES.ADMIN), (req, res) => {
  const ok = store.removeNetworkZone(req.params.id)
  if (!ok) return res.status(404).json({ error: 'Not found' })
  auditAct(req, 'ZONE_DELETE', req.params.id)
  res.json({ ok: true })
})

// ── Access control (Admin governance เท่านั้น) ────────────────────────
// ⚠️ GET และ POST อ่าน-เขียน "ตาราง users ตารางเดียวกัน" แล้ว — จอ Access จึงแสดง
//    สถานะการเข้าถึงที่ตรงกับความจริงเสมอ ไม่ใช่ชุดข้อมูลคู่ขนานที่ค่อย ๆ เพี้ยนออกจากกัน
apiRouter.get('/users', requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    res.json({ users: await listUsers() })
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
    auditAct(req, 'USER_CREATE', created.username)
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

    auditAct(req, 'PASSWORD_RESET', user.username)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── เซสชันของตัวเอง (จอ Settings) ─────────────────────────────────────
apiRouter.get('/sessions', requireAuth, (req, res) => {
  res.json({ sessions: store.listSessions(req.user.username) })
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

/** สถานะ vault + รายการ blob (metadata ciphertext) ของผู้ใช้ที่ล็อกอินอยู่ */
apiRouter.get('/vault', requireAuth, async (req, res, next) => {
  try {
    const meta = await store.getVaultMeta(req.user.id)
    if (!meta) {
      // ยังไม่เคยตั้งค่า — client เข้าสู่ setup flow (ไม่ใช่ error)
      return res.json({ configured: false, blobs: [] })
    }
    const blobs = await store.listVaultBlobs(req.user.id)
    res.json({
      configured: true,
      saltB64: meta.saltB64,
      params: meta.params,
      verifier: meta.verifier,
      // ส่ง envelope ครบเพื่อให้ client แกะ "ชื่อไฟล์" เองได้หลังปลดล็อก
      // storageKey ไม่ถูกส่งออกไป — เป็นรายละเอียดภายในของ Storage Layer
      blobs: blobs.map((b) => ({
        id: b.id, size: b.size, createdAt: b.createdAt,
        ivB64: b.ivB64, wrappedDekB64: b.wrappedDekB64, wrapIvB64: b.wrapIvB64,
        metaIvB64: b.metaIvB64, metaB64: b.metaB64,
      })),
    })
  } catch (err) {
    next(err)
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
 */
apiRouter.get('/vault/blobs/:id', requireAuth, async (req, res, next) => {
  try {
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

/** ลบ blob — metadata ก่อน แล้วค่อยลบ bytes (ลำดับกลับกับตอนเขียน) */
apiRouter.delete('/vault/blobs/:id', requireAuth, async (req, res, next) => {
  try {
    const blob = await store.findVaultBlob(req.user.id, req.params.id)
    if (!blob) return res.status(404).json({ error: 'Not found' })
    await store.deleteVaultBlob(req.user.id, blob.id)
    await removeVaultCiphertext(blob.storageKey)
    await auditAct(req, 'VAULT_BLOB_DELETE', blob.id)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
