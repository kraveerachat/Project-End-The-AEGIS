// server/routes/api.js — AEGIS Monitor (IDEA2)
// /api/login · /api/logout · /api/me · /api/cameras (scoped)
// ⚠️ login รับแค่ { username, password, remember } — ห้ามรับค่า role จาก client
//    server ต้องค้นจาก DB เองเท่านั้น (OWASP A01)
// ⚠️ ไม่มี SSO — endpoint นี้ไม่อ่าน ไม่ validate และไม่ mint เซสชันจาก cookie ของแอปอื่น
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { verifyCredentials } from '../auth/login.js'
import { establishSession, currentUser, currentCsrfToken, destroySession, markPasswordReset } from '../auth/session.js'
import { checkLock, recordFailure, recordSuccess } from '../auth/rateLimit.js'
import { getMenuForRole, ROLES } from '../rbac/permissions.js'
import { requireAuth } from '../middleware/requireRole.js'
import { getVisibleCameras, canSeeCamera, getUserById, updatePasswordHash } from '../db/connection.js'

// ข้อความล้มเหลว "รูปแบบเดียว" ทุกกรณี — กัน username enumeration
const INVALID_CREDENTIALS = 'Invalid credentials'

// heartbeat เก่ากว่านี้ = ถือว่า engine ไม่อยู่แล้ว ไม่ต้องพยายามต่อสตรีม
// (ตรงกับเกณฑ์ 'lost' ของ store.linkStatus — จอกับสตรีมจึงไม่ขัดกันเอง)
const STREAM_STALE_MS = 45_000

// ไม่มีไบต์จาก engine นานเกินนี้ = ถือว่าสตรีมตาย ปิดทิ้งเพื่อให้เบราว์เซอร์รู้ตัว
// ต้องมากกว่าคาบเฟรมปกติพอสมควร (12fps → ~83ms) แต่สั้นพอที่ผู้ใช้ไม่รู้สึกว่าค้าง
const STREAM_IDLE_MS = 6_000

// ตรวจซ้ำว่าเซสชันยังอยู่ และยังมีสิทธิ์เห็นกล้องนี้อยู่ไหม ระหว่างที่สตรีมเปิดค้าง
const STREAM_REVALIDATE_MS = 10_000

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

// ── Live MJPEG proxy ─────────────────────────────────────────────────────
// GET /api/cameras/:id/stream — เบราว์เซอร์ต่อมาที่ origin ของ Monitor เท่านั้น
// ไม่เคยต่อตรงไปหา Detection Engine (engine อยู่ VLAN 20 และถือ API key ที่ client
// ต้องไม่มีวันเห็น) ลำดับด่านเหมือน endpoint ข้อมูลอื่นทุกประการ:
//   1. requireAuth              — ต้องมีเซสชัน
//   2. canSeeCamera             — "ตรรกะเดียวกับ /api/cameras" (getVisibleCameras)
//                                 operator ขอกล้องที่ไม่ได้รับมอบหมาย → 403
//   3. ค่อยไปดึงต้นทางจาก camera_heartbeat.stream_url แล้ว pipe ต่อ
// ⚠️ ห้ามสลับลำดับ: การตรวจสิทธิ์ต้องจบ "ก่อน" เปิด socket ไปหา engine เสมอ
apiRouter.get('/cameras/:id/stream', requireAuth, async (req, res, next) => {
  const cameraId = req.params.id
  try {
    // ด่านเดียวกับ /api/cameras — ไม่มีทางลัด ไม่เชื่อ id จาก client
    if (!(await canSeeCamera(req.user, cameraId))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const src = await store.streamSourceFor(cameraId)
    if (!src) {
      // ไม่เคยมี engine รายงานกล้องนี้ / engine ไม่ได้เปิดสตรีม → บอกตรง ๆ
      return res.status(503).json({ error: 'No live stream for this camera' })
    }
    if (src.ageMs > STREAM_STALE_MS) {
      // heartbeat เก่าเกิน = engine น่าจะตายไปแล้ว ไม่ต้องเสียเวลา dial ให้ client รอ
      return res.status(503).json({ error: 'Detection Engine is not reporting' })
    }

    // ยกเลิก upstream ทันทีเมื่อ client ตัดการเชื่อมต่อ (ปิดแท็บ/เปลี่ยนกล้อง/logout)
    // — ถ้าไม่ทำ socket ไปหา engine จะค้างไว้ตลอดกาลและ engine จะนับ viewer ค้าง
    const ctrl = new AbortController()
    let closed = false
    const abort = () => { if (!closed) { closed = true; ctrl.abort() } }
    res.on('close', abort)

    let upstream
    try {
      upstream = await fetch(src.url, {
        signal: ctrl.signal,
        headers: { 'X-Detection-Engine-Key': process.env.DETECTION_ENGINE_API_KEY ?? '' },
      })
    } catch (err) {
      abort()
      if (res.headersSent) return
      return res.status(504).json({ error: 'Detection Engine unreachable' })
    }

    if (!upstream.ok || !upstream.body) {
      abort()
      return res.status(502).json({ error: `Upstream stream error (${upstream.status})` })
    }

    // ส่งต่อ content-type พร้อม boundary เดิม — <img> ฝั่งเบราว์เซอร์อ่านตรงนี้
    res.status(200)
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no') // ห้าม proxy ชั้นใดบัฟเฟอร์สตรีมสด
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    // ⚠️ ต้องมี idle watchdog: ถ้า engine ตายแบบ "เงียบ ๆ" (โปรเซสหาย, สาย LAN หลุด,
    //    NAT ค้าง connection ไว้) socket อาจไม่ได้ FIN/RST กลับมาเลย — การ await
    //    ตัวถัดไปจะค้างตลอดกาล ผลคือ <img> ฝั่งเบราว์เซอร์ไม่ได้ทั้ง frame ใหม่และ
    //    ไม่ได้ event 'error' → ภาพค้างนิ่งโดยไม่มีใครบอกผู้ใช้ว่ามันตายแล้ว
    //    (วัดจริงแล้ว: ฆ่า engine กลางสตรีม แล้ว client ค้างเกิน 30 วิโดยไม่มีสัญญาณ)
    //    จึงตัดเองเมื่อไม่มีไบต์เข้ามาเกิน STREAM_IDLE_MS แล้วปิด response ให้
    //    เบราว์เซอร์ยิง 'error' → LiveFeed เข้าโหมด reconnecting ตามที่ออกแบบไว้
    // ⚠️ เซสชันถูกตรวจ "ตอนเปิด" เท่านั้น แต่สตรีมหนึ่งเส้นอยู่ได้เป็นชั่วโมง —
    //    ถ้าไม่ตรวจซ้ำ ผู้ใช้ที่กด logout (หรือถูก SOC ถอนสิทธิ์กล้อง) จะยังได้ภาพสด
    //    ต่อไปจนกว่าจะปิดแท็บเอง ซึ่งขัดกับหลัก server-side enforcement ของโปรเจกต์
    //    จึง reload เซสชันจาก store เป็นระยะ และตรวจ camera_assignment ซ้ำด้วย
    //    (SOC ย้ายกล้องออกจาก operator ระหว่างที่เขาดูอยู่ = ต้องถูกตัดภายในรอบถัดไป)
    const revalidate = setInterval(() => {
      req.session?.reload((err) => {
        if (closed) return
        if (err || !req.session?.user) {
          console.warn(`[aegis-monitor] stream ${cameraId}: session ended — closing`)
          abort()
          return
        }
        canSeeCamera(req.session.user, cameraId).then((ok) => {
          if (!ok && !closed) {
            console.warn(`[aegis-monitor] stream ${cameraId}: access revoked — closing`)
            abort()
          }
        }).catch(() => { /* ตรวจไม่ได้ก็ปล่อยรอบหน้า */ })
      })
    }, STREAM_REVALIDATE_MS)

    const reader = upstream.body.getReader()
    let idleTimer = null
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        console.warn(`[aegis-monitor] stream ${cameraId}: no data for ${STREAM_IDLE_MS}ms — closing`)
        abort()
        try { reader.cancel() } catch { /* already gone */ }
      }, STREAM_IDLE_MS)
    }

    try {
      armIdle()
      for (;;) {
        const { value, done } = await reader.read()
        if (done || closed) break
        armIdle() // ได้ข้อมูลแล้ว — เริ่มจับเวลาใหม่
        // เขียนไม่ทัน (client ช้า) → รอ backpressure แทนที่จะกองใน memory
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve))
        }
      }
    } catch {
      // upstream ตายกลางคัน / ถูก watchdog ยกเลิก / client ตัดไปแล้ว
      // ทั้งหมดจบทางเดียวกัน: ปิด response เพื่อให้ฝั่งเบราว์เซอร์รู้ตัว
    } finally {
      clearTimeout(idleTimer)
      clearInterval(revalidate)
      abort()
      if (!res.writableEnded) res.end()
    }
  } catch (err) {
    if (res.headersSent) { try { res.end() } catch { /* already gone */ } return }
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

// Edge link status — คำนวณจาก camera_heartbeat จริง (อายุของ heartbeat ล่าสุด)
// ขอบเขต: เฉพาะกล้องที่ผู้เรียกเห็นได้ — operator เห็นสุขภาพของ "กล้องตัวเอง"
// ไม่ใช่ของทั้ง fleet (กรองผ่าน camera_assignment เหมือนทุก endpoint ข้อมูล)
apiRouter.get('/link', requireAuth, async (req, res, next) => {
  try {
    res.json(await store.linkStatus(await visibleIdsOf(req.user)))
  } catch (err) { next(err) }
})

// demo control: จำลอง link ล่ม (แทนการดึงสาย LAN ให้ผู้ตรวจดู degraded→lost)
// ⚠️ SOC-Responder เท่านั้น — สถานะนี้เป็น "ของทั้งระบบ" ไม่ใช่ของผู้เรียกคนเดียว
//    (store.linkStatus() เป็น state ระดับโปรเซส) เดิมเป็นแค่ requireAuth แปลว่า
//    CCTV-Operator คนใดก็ได้พลิกทั้ง console ของทุกคนไปเป็น LINK LOST 60 วินาทีได้
//    ด้วยคำขอเดียว — ปุ่ม L ในวิวของตัวเองก็ยิง endpoint นี้ การสาธิต cascade เป็น
//    อำนาจของผู้คุมระบบ ไม่ใช่ของผู้ใช้ที่ถูกจำกัดขอบเขต (default-deny เหมือนทุก endpoint)
apiRouter.post('/link/outage', requireRole(ROLES.SOC), (req, res) => {
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

// ── Clip playback — เสิร์ฟไฟล์วิดีโอจริงจากโฟลเดอร์ที่ mount ไว้แทน NAS ───────
// GET /api/clips/:id/video — ด่านเดียวกับทุก endpoint ที่แตะข้อมูลกล้อง:
//   1. requireAuth      — ต้องมีเซสชัน
//   2. canSeeCamera     — operator ขอคลิปของกล้องที่ไม่ได้รับมอบหมาย → 403
//   3. storedOnNas      — ยังไม่ verify sha256 เสร็จ (nas_sync ยังไม่ยืนยัน) → ยังไม่เสิร์ฟ
//   4. path.basename    — ตัดทุกอย่างเหลือแค่ชื่อไฟล์ ป้องกัน path traversal
//      แม้ file_path ในฐานข้อมูลจะถูก validate ตอน insertClip แล้วก็ตาม (defense in depth)
// ⚠️ Phase 1 (ยังไม่มี NAS ฮาร์ดแวร์จริง): CLIPS_STORAGE_DIR ชี้ไปโฟลเดอร์ clips ของ
//    Detection Engine ที่ถูก bind-mount เข้ามา (ดู docker-compose.yml) — เมื่อมี NAS จริง
//    ให้เปลี่ยนเป็น mount จาก NAS แทน โค้ด route นี้ไม่ต้องแก้เลย
// ⚠️ Cache-Control: no-store ต้องอยู่ "ก่อน" ทุก return ในฟังก์ชันนี้ (รวม 403/404/409)
//    ไม่ใช่แค่ตอนสำเร็จ — วัดจริงแล้ว: ถ้ากดเล่นคลิประหว่างที่ยังบันทึกไม่เสร็จ (ได้ 404
//    กลับมา) แล้ว response นั้นไม่มี header กันแคช เบราว์เซอร์จะ "จำ" 404 ตัวนั้นไว้
//    แล้วใช้ซ้ำตลอดแม้ไฟล์จะเสร็จสมบูรณ์แล้วก็ตาม ต้องกันแคชทุก branch ไม่ใช่แค่ตัวท้าย
apiRouter.get('/clips/:id/video', requireAuth, async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const clip = await store.getClipById(req.params.id)
    if (!clip) return res.status(404).json({ error: 'Not found' })

    // ด่านเดียวกับ /api/clips และ /api/cameras/:id/stream — ไม่มีทางลัด
    if (!(await canSeeCamera(req.user, clip.cam))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    if (!clip.storedOnNas) {
      return res.status(409).json({ error: 'Clip not yet verified on NAS' })
    }

    const dir = process.env.CLIPS_STORAGE_DIR
    if (!dir) return res.status(503).json({ error: 'Clip storage not configured' })

    const filename = path.basename(clip.filePath) // กัน ../ ทุกรูปแบบ
    const absPath = path.join(dir, filename)

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Clip file missing from storage' })
    }

    // res.sendFile รองรับ Range header เองอยู่แล้ว (ใช้ package `send` ข้างใน)
    // ทำให้ scrub วิดีโอได้ปกติโดยไม่ต้องเขียน streaming logic เอง
    res.sendFile(absPath)
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
      link: await store.linkStatus(new Set(cams.map((c) => c.id))),
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