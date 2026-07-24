// server/routes/api.js — AEGIS Monitor (IDEA2)
// /api/login · /api/logout · /api/me · /api/cameras (scoped)
// ⚠️ login รับแค่ { username, password, remember } — ห้ามรับค่า role จาก client
//    server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
// ⚠️ ไม่มี SSO — endpoint นี้ไม่อ่าน ไม่ validate และไม่ mint เซสชันจาก cookie ของแอปอื่น
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { verifyCredentials } from '../auth/login.js'
import { establishSession, currentUser, currentCsrfToken, destroySession, markPasswordReset } from '../auth/session.js'
import { checkLock, recordFailure, recordSuccess } from '../auth/rateLimit.js'
import { getMenuForRole, ROLES } from '../rbac/permissions.js'
import { requireAuth } from '../middleware/requireRole.js'
import { getVisibleCameras, canSeeCamera, getUserById, updatePasswordHash } from '../db/connection.js'

// ข้อความล้มเหลว "รูปแบบเดียว" ทุกกรณี — กัน username enumeration
const INVALID_CREDENTIALS = 'Invalid credentials'

const publicUser = (u) => ({ username: u.username, displayName: u.displayName, role: u.role, mustResetPassword: Boolean(u.mustResetPassword) })

export const apiRouter = Router()

apiRouter.post('/login', async (req, res) => {
  const { username, password, remember } = req.body ?? {}

  // rate limit ก่อนแตะ DB (ทั้งแกนบัญชีและแกน IP)
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
    console.error('[aegis-monitor] login error', err)
    return res.status(500).json({ error: 'Internal error' })
  }

  if (!user) {
    recordFailure(req, username)
    return res.status(401).json({ error: INVALID_CREDENTIALS }) // เหมือนกันทุกกรณี
  }

  recordSuccess(req, username)
  try {
    await establishSession(req, user, Boolean(remember)) // regenerate — กัน session fixation
  } catch (err) {
    console.error('[aegis-monitor] session error', err)
    return res.status(500).json({ error: 'Internal error' })
  }

  // เมนู/วิวถูก filter ตาม role ฝั่งเซิร์ฟเวอร์ — CCTV-Operator ไม่ได้รับ
  // 'detection' / 'alerts' ใน payload เลย จึงไม่มีวันอยู่ใน DOM
  return res.json({
    user: publicUser(user),
    menu: getMenuForRole(user.role),
    csrfToken: currentCsrfToken(req),
  })
})

apiRouter.post('/logout', async (req, res) => {
  await destroySession(req, res) // invalidate ฝั่งเซิร์ฟเวอร์เสมอ
  res.json({ ok: true })
})

apiRouter.get('/me', (req, res) => {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  res.json({
    user: publicUser(user),
    menu: getMenuForRole(user.role),
    csrfToken: currentCsrfToken(req),
  })
})

// ── Force Password Reset ─────────────────────────────────────────────
// endpoint เดียวที่บัญชีติด must_reset_password ยังเรียกได้ (ดู RESET_EXEMPT_PATHS ใน
// requireRole.js) — ใช้กับบัญชีที่ server/cli/manage_users.py ตั้งรหัสผ่านชั่วคราวให้
apiRouter.post('/password/reset', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {}
    const pw = String(newPassword ?? '')

    // ยืนยัน currentPassword ก่อนเสมอ แม้ session จะ authenticated แล้ว — กันเปลี่ยนรหัส
    // แบบไม่รู้ตัวถ้า session ถูกใช้ชั่วขณะโดยไม่ได้รับอนุญาต
    const user = await getUserById(req.user.id)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    const ok = await bcrypt.compare(String(currentPassword ?? ''), user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

    if (pw.length < 12 || pw === currentPassword || pw.toLowerCase() === user.username.toLowerCase()) {
      return res.status(400).json({ error: 'Weak password' })
    }

    await updatePasswordHash(user.id, pw)
    markPasswordReset(req) // เคลียร์ flag ใน session ให้ตรงกับ DB ทันที ไม่ต้อง re-login
    await req.session.save()

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── Cameras — จุดสาธิต Scoped View ฝั่งเซิร์ฟเวอร์ ────────────────────────────
// กรอง camera ตาม camera_assignment ที่ฝั่ง server — ห้ามเชื่อ filter จาก client
// SOC-Responder ได้ทุกกล้อง; CCTV-Operator ได้เฉพาะกล้องที่มอบหมาย
apiRouter.get('/cameras', requireAuth, async (req, res, next) => {
  try {
    const cams = await getVisibleCameras(req.user)
    res.json({ cameras: cams })
  } catch (err) {
    next(err)
  }
})

// รายกล้อง — Operator ที่ craft request ตรงถามกล้องที่ไม่ได้รับมอบหมาย → 403
apiRouter.get('/cameras/:id', requireAuth, async (req, res, next) => {
  try {
    const ok = await canSeeCamera(req.user, req.params.id)
    if (!ok) return res.status(403).json({ error: 'Forbidden' })
    const cams = await getVisibleCameras(req.user)
    const cam = cams.find((c) => c.id === req.params.id)
    if (!cam) return res.status(403).json({ error: 'Forbidden' })
    res.json({ camera: cam })
  } catch (err) {
    next(err)
  }
})

// ════ Data endpoints (Phase 2) ═══════════════════════════════════════
// ⚠️ ทุกตัว: (1) requireAuth (2) ตรวจ role (3) สำหรับ Operator — ข้อมูลถูกกรอง
//    ผ่าน camera_assignment "ฝั่งเซิร์ฟเวอร์" เสมอ — ห้ามเชื่อ filter จาก client
import { requireRole } from '../middleware/requireRole.js'
import * as store from '../db/store.js'

/** เซ็ตกล้องที่ผู้เรียกเห็นได้ — ทุก endpoint ข้อมูลเรียกตัวนี้ก่อนเสมอ */
async function visibleIdsOf(user) {
  const cams = await getVisibleCameras(user)
  return new Set(cams.map((c) => c.id))
}

// Edge link status — ค่าจริงจาก heartbeat (dev: ตัวแทน engine ใน store)
apiRouter.get('/link', requireAuth, (req, res) => {
  res.json(store.linkStatus())
})

// demo control: จำลอง link ล่ม (แทนการดึงสาย LAN ให้ผู้ตรวจดู degraded→lost)
apiRouter.post('/link/outage', requireAuth, (req, res) => {
  res.json(store.toggleOutage())
})

apiRouter.get('/detections', requireAuth, async (req, res, next) => {
  try {
    const visible = await visibleIdsOf(req.user)
    res.json({ detections: await store.listDetections(visible) })
  } catch (err) { next(err) }
})

// Alerts — วิวของ SOC-Responder เท่านั้น (Operator ต้องไม่เห็นแม้ผ่าน API ตรง)
apiRouter.get('/alerts', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const [cams, assignments, operators] = await Promise.all([
      getVisibleCameras(req.user), store.listAssignments(), store.listOperators(),
    ])
    const visible = new Set(cams.map((c) => c.id))
    const nameOf = (id) => cams.find((c) => c.id === id)?.name ?? id
    const operatorsById = new Map(operators.map((o) => [String(o.id), o]))
    const rows = (await store.listAlerts(visible)).map((a) => ({
      ...a, camName: nameOf(a.cam), route: store.resolveRoute(a.cam, assignments, operatorsById),
    }))
    res.json({ alerts: rows })
  } catch (err) { next(err) }
})

// Acknowledge — การเขียนเดียวที่ console นี้มี (review-only console)
apiRouter.post('/alerts/:id/ack', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const a = await store.ackAlert(req.params.id, req.user)
    if (!a) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

apiRouter.get('/clips', requireAuth, async (req, res, next) => {
  try {
    const cams = await getVisibleCameras(req.user)
    const visible = new Set(cams.map((c) => c.id))
    const nameOf = (id) => cams.find((c) => c.id === id)?.name ?? id
    res.json({ clips: (await store.listClips(visible)).map((c) => ({ ...c, camName: nameOf(c.cam) })) })
  } catch (err) { next(err) }
})

// Nodes & routing — ภาพรวมทั้ง fleet = SOC เท่านั้น
apiRouter.get('/nodes', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const [cams, assignments, operators] = await Promise.all([
      getVisibleCameras(req.user), store.listAssignments(), store.listOperators(),
    ])
    const operatorsById = new Map(operators.map((o) => [String(o.id), o]))
    res.json({
      cameras: cams.map((c) => ({ ...c, route: store.resolveRoute(c.id, assignments, operatorsById) })),
      assignments,
      operators,
      link: store.linkStatus(),
    })
  } catch (err) { next(err) }
})

// Operators — UI จัดการตาราง camera_assignment ของ IDEA2 (SOC เท่านั้น)
apiRouter.get('/operators', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const [operators, assignments] = await Promise.all([store.listOperators(), store.listAssignments()])
    res.json({ operators, assignments })
  } catch (err) { next(err) }
})

// กล้องที่ "ว่าง" (ยังไม่ผูกกับ operator คนใด) — ป้อน dropdown ของฟอร์ม Add Operator
// ⚠️ ฝั่งเซิร์ฟเวอร์เป็นผู้ตัดสินว่าอะไรว่าง ไม่ใช่ client คำนวณจากข้อมูลเก่าที่ค้างอยู่
//    "ว่าง" = ไม่มีแถว หรือแถวเป็น SOC-Team route (user_id NULL) — กฎเดียวกับ provisionOperator
apiRouter.get('/operators/available-cameras', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const [cams, assignments] = await Promise.all([getVisibleCameras(req.user), store.listAssignments()])
    const available = cams
      .filter((c) => { const a = assignments[c.id]; return a == null || a === 'SOC' })
      .map((c) => ({ id: c.id, name: c.name }))
    res.json({ cameras: available })
  } catch (err) { next(err) }
})

// สร้าง operator จากในเว็บ (SOC-Responder เท่านั้น — requireRole บังคับฝั่งเซิร์ฟเวอร์)
// ใช้ store.provisionOperator ตัวเดียวกับที่เป็นแหล่งความจริงของ provisioning ทั้งหมด
// ⚠️ รหัสผ่านชั่วคราวถูกสร้างฝั่งเซิร์ฟเวอร์และส่งกลับ "ครั้งเดียว" ในบอดี้ — ไม่เคย log
apiRouter.post('/operators', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const { username, displayName, role, cameraId, cameraIds } = req.body ?? {}
    const cams = Array.isArray(cameraIds) ? cameraIds : (cameraId ? [cameraId] : [])
    const result = await store.provisionOperator({ username, displayName, role, cameraIds: cams })

    switch (result.error) {
      case 'invalid':        return res.status(400).json({ error: result.detail || 'Invalid input' })
      case 'unknown_camera': return res.status(400).json({ error: `Unknown camera: ${result.cameraId}` })
      case 'username_taken': return res.status(409).json({ error: 'Username already exists' })
      case 'camera_taken':   return res.status(409).json({ error: `Camera ${result.cameraId} is already assigned to an operator` })
      case undefined:        break // สำเร็จ
      default:               return res.status(400).json({ error: 'Invalid input' })
    }

    // ส่งรหัสชั่วคราวกลับครั้งเดียว — จงใจไม่ใส่ลง log/console ทุกกรณี
    res.status(201).json({
      operator: result.operator,
      tempPassword: result.tempPassword,
      mustResetPassword: result.mustResetPassword,
    })
  } catch (err) { next(err) }
})

apiRouter.put('/assignments', requireRole(ROLES.SOC), async (req, res, next) => {
  try {
    const { operatorId, cameraIds } = req.body ?? {}
    const ok = await store.assignCameras(operatorId, cameraIds)
    if (!ok) return res.status(400).json({ error: 'Invalid input' })
    res.json({ assignments: await store.listAssignments() })
  } catch (err) { next(err) }
})
