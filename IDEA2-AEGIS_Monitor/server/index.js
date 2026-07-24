// server/index.js — AEGIS Monitor (IDEA2) · แอปเดียว สองมุมมอง (Aggregate / Scoped)
// เสิร์ฟ API + ไฟล์ build จาก origin เดียวกัน → session cookie (HttpOnly) ไม่ต้องเปิด CORS
//
// ⚠️ Identity Decoupling: ระบบตัวตนของ Monitor อยู่ "ในแอปนี้" ทั้งหมด
//    - ไม่มี SSO — โค้ดเดิม (CCTV-Operator web-app) ที่รับ cookie ของ HUB แล้วไป
//      validate ที่ localhost:3001 ถูก "ทำลายทิ้ง" ตามคำตัดสินสถาปัตยกรรม:
//      HUB ห้ามออกเซสชันที่ IDEA1/IDEA2 เชื่อ — เด็ดขาด
//    - IDEA1 (AEGIS Drive) มีตาราง users + ฐานข้อมูลของตัวเองแยกต่างหาก
//    - ตาราง camera_assignment เป็นของ IDEA2 (ฐานข้อมูล aegis_monitor) เท่านั้น
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionMiddleware } from './auth/session.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { csrfProtection } from './middleware/csrf.js'
import { errorHandler, apiNotFound } from './middleware/errorHandler.js'
import { apiRouter } from './routes/api.js'
import { internalRouter } from './routes/internal.js'
import { requireDetectionEngineKey } from './middleware/requireDetectionEngineKey.js'
import { usingPostgres, checkDb } from './db/connection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = process.env.PORT || 8002 // ตรงกับผังบริการ: AEGIS Monitor = พอร์ตภายใน 8002

const app = express()

app.set('trust proxy', 1)   // req.ip เป็น IP จริงของ client (rate limit / audit)
app.disable('x-powered-by') // ลด fingerprinting

app.use(securityHeaders)
app.use(express.json({ limit: '16kb' }))
app.use(sessionMiddleware())

// health check — unauthenticated โดยเจตนา (docker healthcheck + deploy.sh)
app.get('/healthz', async (req, res) => {
  const db = await checkDb()
  res.status(db.ok ? 200 : 503).json({ service: 'aegis-monitor', ok: db.ok, db: db.mode })
})

app.use('/api', csrfProtection, apiRouter)
app.use('/api', apiNotFound)

// ── Detection Engine ingest (service-to-service) ─────────────────────────────
// mount แยกจาก /api โดยเจตนา: ไม่มี CSRF/เซสชัน (engine ไม่ใช่เบราว์เซอร์) แต่ต้อง
// ผ่านด่าน API key ก่อนถึง handler เสมอ — ดู middleware/requireDetectionEngineKey.js
// ⚠️ ชั้น gateway (nginx) บล็อก /monitor/internal/ จากภายนอกอีกชั้น (defense-in-depth)
app.use('/internal', requireDetectionEngineKey, internalRouter)

app.use(express.static(DIST))

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST, 'index.html'), (err) => {
    if (err) next()
  })
})

app.use(errorHandler) // ตัวสุดท้ายเสมอ — กัน stack trace รั่ว

app.listen(PORT, () => {
  const mode = usingPostgres ? 'PostgreSQL' : 'in-memory dev fallback'
  console.log(`[aegis-monitor] server on :${PORT} (auth store: ${mode})`)
})
