// server/app.js — AEGIS Drive (IDEA1) · ประกอบ Express app (ไม่เปิดพอร์ต)
//
// แยกจาก index.js เพื่อให้ชุดทดสอบ import "แอปตัวเดียวกับที่รันจริง" มาทดสอบได้
// โดยไม่ต้อง spawn process — middleware ทุกชั้น (securityHeaders / session / CSRF /
// requireAuth) จึงถูกทดสอบจริง ไม่ใช่ mock ที่อาจเพี้ยนจากของจริง
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionMiddleware } from './auth/session.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { csrfProtection } from './middleware/csrf.js'
import { errorHandler, apiNotFound } from './middleware/errorHandler.js'
import { apiRouter } from './routes/api.js'
import { shareRouter } from './routes/share.js'
import { checkDb } from './db/connection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

export function createApp() {
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

  // ── /s/:token — ไถ่ลิงก์แชร์ (ไม่ต้องล็อกอิน) ──────────────────────────────
  // ⚠️ อยู่นอก /api โดยเจตนา: ผู้รับเปิดจาก URL ในอีเมล/แชท ไม่ได้เรียกผ่าน fetch ของแอป
  //    จึงไม่มี CSRF token และไม่มีเซสชัน — ด่านทั้งหมดอยู่ในตัว router เอง (ดู routes/share.js)
  // ⚠️ ต้องมาก่อน express.static และก่อน SPA fallback ไม่งั้น '*' จะกิน /s/... ไปตอบ index.html
  //    (nginx ตัด prefix /drive ออกแล้ว — URL สาธารณะจึงเป็น <origin>/drive/s/<token>)
  app.use(shareRouter)

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
  return app
}
