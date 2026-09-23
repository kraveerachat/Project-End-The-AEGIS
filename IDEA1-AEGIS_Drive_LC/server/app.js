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
import { requireAuth } from './middleware/requireRole.js'
import { apiRouter } from './routes/api.js'
import { shareRouter } from './routes/share.js'
import { integrationRouter } from './routes/integration.js'
import { checkDb } from './db/connection.js'
import { checkStorage } from './storage/fileStore.js'
import { trustedProxyFromEnv } from './config/trustedProxy.js'
import { publicShareConfigFromEnv } from './config/publicShare.js'
import { mediaLimitsFromEnv } from './config/mediaLimits.js'
import { vaultTreeConfigFromEnv } from './config/vaultTreeLimits.js'
import { disabledMediaService } from './media/disabledService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

// ⚠️ media derivative subsystem มาทาง injection เท่านั้น (spec §10.4): index.js ประกอบ service จริง
//    จาก capabilities ที่ probe แล้วก่อนเรียก createApp; ชุดทดสอบ inject stub ของตัวเอง; ค่าเริ่มต้น
//    คือ service ที่ "ปิด" อย่างซื่อสัตย์ — ไม่มีวันมีวัตถุที่แกล้งว่ามี media แล้วค่อยอัปเกรดทีหลัง
//    app.js ไม่ import derivatives.js โดยเจตนา (ไม่มีการประกอบ service ที่นี่)
export function createApp({
  env = process.env,
  mediaLimits = mediaLimitsFromEnv(env),
  mediaService = disabledMediaService(mediaLimits),
  vaultTreeConfig = vaultTreeConfigFromEnv(env),
} = {}) {
  const app = express()
  app.set('mediaLimits', mediaLimits)
  app.set('mediaService', mediaService)
  // Private Vault encrypted hierarchy (PR #157): flag ทั้งหกปิดโดยปริยายและเป็นโซ่ fail-closed;
  // แช่แข็งครั้งเดียวที่นี่เช่นเดียวกับ publicShareConfig — route อ่านวัตถุเดียวกัน ไม่อ่าน process.env
  app.set('vaultTreeConfig', vaultTreeConfig)

  // Trust only the deployment-defined HUB→Drive proxy CIDR. Development/test
  // default to no proxy; production fails closed when the boundary is absent.
  // req.ip remains Express-owned — routes never parse forwarding headers.
  app.set('trust proxy', trustedProxyFromEnv(env))
  // Public Share backend contract (PUBLIC-SHARE-2): parsed and frozen ONCE here
  // so routes read one immutable object instead of process.env per request —
  // tests inject env through createApp({ env }), and a per-request global read
  // would make behaviour depend on whatever the process last set. A malformed
  // value throws here, before the app can serve anything.
  app.set('publicShareConfig', publicShareConfigFromEnv(env))
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
    // media เป็นบล็อกเพิ่ม (additive) และไม่มีผลต่อ ok: thumbnail ที่ลดระดับไม่ใช่ Drive ที่ป่วย
    res.status(db.ok ? 200 : 503).json({
      service: 'aegis-drive',
      ok: db.ok,
      db: db.mode,
      layers: { application, metadata, storage },
      media: mediaService.health(),
      // additive (PR #157): เปิดเผยเฉพาะ flag ที่ operator ต้องเห็น ไม่มีผลต่อ ok
      vaultTree: {
        schemaAvailable: vaultTreeConfig.flags.schemaAvailable,
        protocolEnabled: vaultTreeConfig.flags.protocolEnabled,
        destructivePurgeEnabled: vaultTreeConfig.flags.destructivePurgeEnabled,
      },
    })
  })

  // Share revoke has an explicit 401 unauthenticated contract. Authenticate
  // this route before CSRF so a caller with no session is classified correctly;
  // authenticated callers still continue through the normal CSRF gate below.
  // This pre-gate is route-specific and grants no role or owner exception.
  app.delete('/api/shares/:id', requireAuth)

  // Protected Trash mutations also promise an explicit 401 to callers without
  // a session. Authenticated callers continue through the shared CSRF boundary;
  // these pre-gates do not grant access or weaken owner checks in apiRouter.
  app.post('/api/trash/unlock', requireAuth)
  app.post('/api/trash/lock', requireAuth)
  app.post('/api/trash/empty', requireAuth)
  app.post('/api/trash/:id/restore', requireAuth)
  app.delete('/api/trash/:id', requireAuth)

  // IDEA3 cross-IDEA visibility feed (service-to-service, read-only): mounted
  // before the CSRF+session /api chain, same reasoning as shareRouter — this
  // caller has no browser, no cookie, and no CSRF token; its own dedicated
  // credential (requireIdea3IntegrationKey) is the entire auth boundary.
  app.use(integrationRouter)

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
