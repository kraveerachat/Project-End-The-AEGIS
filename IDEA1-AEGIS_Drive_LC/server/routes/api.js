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
  getUserById, createUserWithTempPassword, updatePasswordHash,
} from '../db/connection.js'
import { ROLES } from '../rbac/permissions.js'
import * as store from '../db/store.js'

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

apiRouter.post('/files/upload', requireAuth, async (req, res, next) => {
  try {
    // Phase นี้รับเฉพาะ metadata (ชื่อ/ขนาด/sha256) — ตัว binary ผ่าน multipart ใน Phase 3
    const { name, size, sha256 } = req.body ?? {}
    if (!name || typeof name !== 'string' || name.length > 200) {
      return res.status(400).json({ error: 'Invalid input' })
    }
    const row = await store.recordUpload({ name, size, sha256, user: req.user })
    auditAct(req, 'FILE_UPLOAD', name)
    res.status(201).json({ file: row })
  } catch (err) {
    next(err)
  }
})

apiRouter.delete('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const file = await store.findFile(req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })
    await store.deleteFile(req.params.id)
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
// ⚠️ GET /users ยังอ่านจาก store.js (ชุดข้อมูลเดโม่สำหรับจอ Access — มีคอลัมน์ UI-only
//    อย่าง status/lastLogin/sessions ที่ไม่มีในตาราง users จริง) ส่วน POST ด้านล่าง
//    เขียนบัญชี "จริง" ลง Postgres (login ได้จริง ผ่าน bcrypt + force-reset) แล้วซิงก์
//    รายการเข้า store.js คู่กันเพื่อให้จอ Access เห็นทันที — รวมสองแหล่งเป็นหนึ่งเดียว
//    (ผูก GET เข้ากับตาราง users จริง) เป็นงาน Phase ถัดไป
apiRouter.get('/users', requireRole(ROLES.ADMIN), (req, res) => {
  res.json({ users: store.listUsers() })
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

    // ซิงก์เข้าชุดข้อมูลเดโม่ของจอ Access ให้เห็นแถวใหม่ทันทีโดยไม่ต้องแก้ GET (ดูหมายเหตุด้านบน)
    store.createUser({ name: created.displayName, username: created.username, role: created.role })

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
// เข้ารหัสฝั่ง client เท่านั้น — server เก็บได้แค่ ciphertext ที่อ่านไม่ออก แม้แต่ Admin ก็เปิดไม่ได้
// endpoint นี้จึง "ไม่มีทาง" รับ/คืน plaintext หรือกุญแจ — มีแค่ salt/iv/ciphertext
apiRouter.get('/vault', requireAuth, (req, res) => {
  res.json(store.vaultMeta())
})

apiRouter.post('/vault/blobs', requireAuth, (req, res) => {
  const row = store.addVaultBlob(req.body ?? {})
  if (!row) return res.status(400).json({ error: 'Invalid input' })
  // audit ไม่มีชื่อไฟล์ให้บันทึกอยู่แล้ว (server มองไม่เห็น) — บันทึกแค่ "มีการเพิ่ม blob"
  auditAct(req, 'VAULT_BLOB_ADD', row.id)
  res.status(201).json({ blob: { id: row.id, size: row.size, createdAt: row.createdAt } })
})
