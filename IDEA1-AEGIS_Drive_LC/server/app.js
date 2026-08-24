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
import { checkStorage } from './storage/fileStore.js'
import { trustedProxyFromEnv } from './config/trustedProxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

export function createApp({ env = process.env } = {}) {
  const app = express()

  // Trust only the deployment-defined HUB→Drive proxy CIDR. Development/test
  // default to no proxy; production fails closed when the boundary is absent.
  // req.ip remains Express-owned — routes never parse forwarding headers.
  app.set('trust proxy', trustedProxyFromEnv(env))
  app.disable('x-powered-by') // ไม่ประกาศว่าเป็น Express — ลด fingerprinting

  app.use(securityHeaders)                 // ทุก response มี CSP/XFO/HSTS ครบ
  app.use(express.json({ limit: '16kb' })) // จำกัดขนาด body กัน abuse
  app.use(sessionMiddleware())

  // health check — unauthenticated โดยเจตนา (docker healthcheck + deploy.sh ใช้ curl เช็ค)
  // แต่ละ layer ต้องมี probe ของตัวเอง: ห้ามเอา DB bit เดียวไปทาสีเขียวทั้ง Application/
  // Metadata/Storage อีก และ response เปิดเผยเฉพาะชนิด probe + เวลา ไม่เปิด path/error ภายใน
  app.get('/healthz', async (req, res) => {
    const applicationProbe = async () => {
      const startedAt = process.hrtime.bigint()
      await new Promise((resolve) => setImmediate(resolve))
      return {
        ok: true,
        checked: true,
        measured: true,
        latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        check: 'event-loop-turn',
      }
    }
    const [application, db, storage] = await Promise.all([
      applicationProbe(),
      checkDb(),
      checkStorage(),
    ])
    const metadata = db.mode === 'postgres'
      ? { ok: db.ok, checked: true, measured: db.measured, latencyMs: db.latencyMs, check: 'select-1' }
      : { ok: false, checked: false, measured: false, latencyMs: null, check: 'not-configured' }

    // คง top-level ok/db contract สำหรับ Docker และ placeholder gate เดิม: ok ยังหมายถึง
    // DB endpoint ติดต่อได้ ส่วนหลักฐานแยกจริงอยู่ใน layers และ UI อ่านแต่ละชั้นจากตรงนั้น
    res.status(db.ok ? 200 : 503).json({
      service: 'aegis-drive',
      ok: db.ok,
      db: db.mode,
      layers: { application, metadata, storage },
    })
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
