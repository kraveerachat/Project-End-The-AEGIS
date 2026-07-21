// server/index.js — AEGIS Drive (IDEA1) · Application Layer ของ Edge Data Lake
// เสิร์ฟ API + ไฟล์ build จาก origin เดียวกัน → session cookie (HttpOnly) ทำงานโดยไม่ต้องเปิด CORS
//
// ⚠️ Identity Decoupling: ระบบตัวตนของ Drive อยู่ "ในแอปนี้" ทั้งหมด
//    - ไม่มี SSO, ไม่เชื่อ cookie จาก HUB หรือแอปอื่นใด
//    - HUB เป็นแค่ทางผ่าน (traffic router) — ไม่มีสิทธิ์ออกเซสชันแทนใคร
//    - IDEA2 (AEGIS Monitor) มีตาราง users + ฐานข้อมูลของตัวเองแยกต่างหาก
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionMiddleware } from './auth/session.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { csrfProtection } from './middleware/csrf.js'
import { errorHandler, apiNotFound } from './middleware/errorHandler.js'
import { apiRouter } from './routes/api.js'
import { usingPostgres, checkDb } from './db/connection.js'
import { bootstrapAdminIfNeeded } from './db/bootstrapAdmin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = process.env.PORT || 8001 // ตรงกับผังบริการ: AEGIS Drive = พอร์ตภายใน 8001

const app = express()

// อยู่หลัง reverse proxy — เชื่อ X-Forwarded-* เพื่อให้ req.ip เป็น IP จริงของ client
// (rate limit + audit ต้องเห็น IP จริง ไม่ใช่ IP ของ proxy) และ secure cookie ทำงานถูก
app.set('trust proxy', 1)
app.disable('x-powered-by') // ไม่ประกาศว่าเป็น Express — ลด fingerprinting

app.use(securityHeaders)                 // ทุก response มี CSP/XFO/HSTS ครบ
app.use(express.json({ limit: '16kb' })) // จำกัดขนาด body กัน abuse
app.use(sessionMiddleware())

// health check — unauthenticated โดยเจตนา (docker healthcheck + deploy.sh ใช้ curl เช็ค)
// ไม่เปิดเผยรายละเอียดภายในนอกจากสถานะ DB ติด/ไม่ติด
app.get('/healthz', async (req, res) => {
  const db = await checkDb()
  res.status(db.ok ? 200 : 503).json({ service: 'aegis-drive', ok: db.ok, db: db.mode })
})

// CSRF ครอบทุก /api ที่เปลี่ยนสถานะ — ต้องมาก่อน router
app.use('/api', csrfProtection, apiRouter)
app.use('/api', apiNotFound)

// เสิร์ฟไฟล์ build ของ frontend
app.use(express.static(DIST))

// SPA fallback — path ที่ไม่ใช่ /api คืน index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST, 'index.html'), (err) => {
    if (err) next()
  })
})

app.use(errorHandler) // ตัวสุดท้ายเสมอ — กัน stack trace รั่วออก client

// Day-0 bootstrap ก่อนเปิดพอร์ตรับ request — ถ้า ADMIN_BOOTSTRAP_* ตั้งค่าผิดรูปแบบ
// (เช่นใส่รหัสดิบแทน bcrypt hash) ต้อง crash ตั้งแต่ตรงนี้ ไม่ใช่เงียบแล้วรันต่อแบบไม่ปลอดภัย
bootstrapAdminIfNeeded()
  .then(() => {
    app.listen(PORT, () => {
      const mode = usingPostgres ? 'PostgreSQL' : 'in-memory dev fallback'
      console.log(`[aegis-drive] server on :${PORT} (auth store: ${mode})`)
    })
  })
  .catch((err) => {
    console.error('[aegis-drive] Day-0 admin bootstrap failed — refusing to start:', err.message)
    process.exit(1)
  })
