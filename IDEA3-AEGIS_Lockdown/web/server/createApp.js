import express from 'express'
import session from 'express-session'
import helmet from 'helmet'
import { createAuthRouter } from './routes/authRoutes.js'
import { createSecurityRouter } from './routes/securityRoutes.js'
import { createRateLimiter } from './security/rateLimit.js'
import { createDemoProvider } from './providers/demoProvider.js'
import { createLiveProvider } from './providers/liveProvider.js'
import { createMemoryRepository } from './repositories/memoryRepository.js'

export function createApp({
  config,
  clock = () => new Date(),
  demoProvider = createDemoProvider({ clock }),
  liveProvider = createLiveProvider({ config, clock }),
  repository = createMemoryRepository({ clock }),
}) {
  const app = express()
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
  app.use(session({
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
  }))

  const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1_000 })
  app.use('/api/auth', createAuthRouter({ config, loginLimiter }))
  app.use('/api/security', createSecurityRouter({ config, demoProvider, liveProvider, repository }))

  app.use((error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : 500
    const code = status === 413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR'
    res.status(status).json({ error: { code, message: 'ไม่สามารถดำเนินการได้' } })
  })

  return app
}
