// server/routes/api.js
import { Router } from 'express'
import { verifyCredentials } from '../auth/login.js'
import { establishSession, currentUser, destroySession } from '../auth/session.js'
import { checkLock, recordFailure, recordSuccess } from '../auth/rateLimit.js'
import { getMenuForRole } from '../rbac/roles.js'

const INVALID_CREDENTIALS = 'Invalid credentials'

function publicUser(user) {
  return { username: user.username, displayName: user.displayName, role: user.role }
}

export const apiRouter = Router()

apiRouter.post('/login', async (req, res) => {
  const { username, password, remember } = req.body ?? {}
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
    console.error('[aegis] login error', err)
    return res.status(500).json({ error: 'Internal error' })
  }

  if (!user) {
    recordFailure(req, username)
    return res.status(401).json({ error: INVALID_CREDENTIALS })
  }

  recordSuccess(req, username)
  try {
    await establishSession(req, user, Boolean(remember))
  } catch (err) {
    console.error('[aegis] session error', err)
    return res.status(500).json({ error: 'Internal error' })
  }

  return res.json({ user: publicUser(user), menu: getMenuForRole(user.role) })
})

apiRouter.post('/logout', async (req, res) => {
  await destroySession(req, res)
  res.json({ ok: true })
})

apiRouter.get('/me', (req, res) => {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  res.json({ user: publicUser(user), menu: getMenuForRole(user.role) })
})
