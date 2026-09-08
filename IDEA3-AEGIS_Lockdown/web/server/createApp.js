import { existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import session from 'express-session'
import helmet from 'helmet'
import { createAuthRouter } from './routes/authRoutes.js'
import { createSecurityRouter } from './routes/securityRoutes.js'
import { createRateLimiter } from './security/rateLimit.js'
import { createDemoProvider } from './providers/demoProvider.js'
import { createLiveProvider } from './providers/liveProvider.js'
import { AuditPersistenceError } from './repositories/auditRecords.js'
import { createSqliteRepository } from './repositories/sqliteRepository.js'

export function createApp({
  config,
  clock = () => new Date(),
  demoProvider = createDemoProvider({ clock }),
  liveProvider = createLiveProvider({ config, clock }),
  repository,
  sessionStore,
}) {
  const appRepository = repository ?? createSqliteRepository({ path: config.auditDbPath, clock })
  const app = express()
  let closed = false
  app.locals.close = () => {
    if (closed) return
    appRepository.close()
    closed = true
  }
  app.disable('x-powered-by')
  app.set('trust proxy', false)

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }))
  app.use((_, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.use(express.json({ limit: '32kb', strict: true }))
  const sessionOptions = {
    name: 'aegis.idea3.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.production,
      maxAge: config.sessionIdleMs,
    },
  }
  if (sessionStore) sessionOptions.store = sessionStore
  app.use(session(sessionOptions))

  const loginLimiter = createRateLimiter({
    limit: 5,
    windowMs: 15 * 60 * 1_000,
    clock: () => clock().getTime(),
  })
  const apiBase = `${config.webBasePath}/api`
  app.get(`${apiBase}/health`, (_req, res) => res.json({ status: 'ok' }))
  app.use(`${apiBase}/auth`, createAuthRouter({ config, loginLimiter, repository: appRepository }))
  app.use(`${apiBase}/security`, createSecurityRouter({ config, demoProvider, liveProvider, repository: appRepository }))
  app.use(apiBase, (_req, res) => res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'ไม่พบข้อมูลที่ร้องขอ' },
  }))

  if (config.staticDir) {
    const indexPath = path.join(config.staticDir, 'index.html')
    if (!existsSync(indexPath)) {
      throw new Error('AEGIS_WEB_STATIC_DIR does not contain index.html')
    }
    const mountPath = config.webBasePath || '/'
    app.use(mountPath, express.static(config.staticDir, {
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders(res, filePath) {
        res.setHeader(
          'Cache-Control',
          path.basename(filePath) === 'index.html'
            ? 'no-store'
            : 'public, max-age=31536000, immutable',
        )
      },
    }))
    app.use(mountPath, (req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method) || !req.accepts('html')) return next()
      res.set('Cache-Control', 'no-store')
      return res.sendFile(indexPath)
    })
  }

  app.use((error, _req, res, _next) => {
    if (error instanceof AuditPersistenceError) {
      return res.status(503).json({
        error: {
          code: 'AUDIT_PERSISTENCE_FAILURE',
          message: 'ระบบบันทึกเหตุการณ์ไม่พร้อมใช้งาน',
        },
      })
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'REQUEST_TOO_LARGE', message: 'ไม่สามารถดำเนินการได้' },
      })
    }
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'ไม่สามารถดำเนินการได้' },
    })
  })

  return app
}
