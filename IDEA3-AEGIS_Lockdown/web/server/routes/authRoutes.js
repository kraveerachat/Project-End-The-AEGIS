import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { verifyCredentials, requireAdmin } from '../security/auth.js'
import { requireCsrf, requireSameOrigin } from '../security/csrf.js'

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
}).strict()

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve())
  })
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve())
  })
}

export function createAuthRouter({ config, loginLimiter }) {
  const router = Router()

  router.get('/session', (req, res) => {
    if (!req.session?.identity) return res.json({ authenticated: false })
    return res.json({
      authenticated: true,
      identity: req.session.identity,
      demoMode: req.session.demoMode === true,
    })
  })

  router.post('/login', requireSameOrigin, async (req, res, next) => {
    try {
      const key = req.ip || 'unknown'
      if (!loginLimiter.check(key).allowed) {
        return res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'ลองใหม่ภายหลัง' },
        })
      }

      const parsed = credentialsSchema.safeParse(req.body)
      const identity = parsed.success
        ? await verifyCredentials(parsed.data, config)
        : null

      if (!identity) {
        loginLimiter.recordFailure(key)
        return res.status(401).json({
          error: { code: 'AUTH_FAILED', message: 'เข้าสู่ระบบไม่สำเร็จ' },
        })
      }

      loginLimiter.clear(key)
      await regenerateSession(req)
      req.session.identity = identity
      req.session.csrfToken = randomBytes(32).toString('hex')
      req.session.demoMode = false

      return res.json({ identity, csrfToken: req.session.csrfToken, demoMode: false })
    } catch (error) {
      next(error)
    }
  })

  router.get('/csrf', requireAdmin, (req, res) => {
    res.json({ csrfToken: req.session.csrfToken })
  })

  router.post('/logout', requireSameOrigin, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      await destroySession(req)
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  return router
}
