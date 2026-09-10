import { existsSync } from 'node:fs'
import net from 'node:net'
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

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (normalized === '::1') return true
  return net.isIP(normalized) === 4 && normalized.startsWith('127.')
}

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
  if (config.production) {
    // Browsers treat localhost as a trustworthy Secure-cookie origin even over
    // HTTP. express-session does not model that exception, so tell only the
    // session middleware that a request proven to arrive over loopback is secure.
    // The server remains bound to a validated loopback address and no external
    // X-Forwarded-Proto value is trusted.
    app.use((req, _res, next) => {
      if (isLoopbackAddress(req.socket.remoteAddress)) {
        req.headers['x-forwarded-proto'] = 'https'
      }
      next()
    })
  }
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
  if (config.production) sessionOptions.proxy = true
  if (sessionStore) sessionOptions.store = sessionStore
  app.use(session(sessionOptions))

  const loginLimiter = createRateLimiter({
    limit: 5,
    windowMs: 15 * 60 * 1_000,
    clock: () => clock().getTime(),
  })
  const apiBase = `${config.webBasePath}/api`
  app.get(`${apiBase}/health`, (_req, res) => res.json({ status: 'ok' }))
  app.get(`${apiBase}/readiness`, (_req, res) => {
    try {
      const schemaVersion = appRepository.schemaVersion()
      if (schemaVersion !== 2) throw new Error('unsupported audit schema')
      return res.json({ status: 'READY', audit: 'READY', schemaVersion })
    } catch {
      return res.status(503).json({ status: 'DEGRADED', audit: 'DEGRADED' })
    }
  })
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
