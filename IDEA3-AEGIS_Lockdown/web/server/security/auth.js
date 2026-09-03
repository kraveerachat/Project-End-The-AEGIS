import { timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'

const SAFE_IDENTITY = Object.freeze({
  displayName: 'System Administrator',
  role: 'ADMIN',
  workspace: 'AEGIS Security Center',
})

function constantTimeTextMatch(candidate, expected) {
  const left = Buffer.from(String(candidate))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) {
    timingSafeEqual(Buffer.alloc(right.length), right)
    return false
  }
  return timingSafeEqual(left, right)
}

export async function verifyCredentials({ username, password }, config) {
  const usernameMatches = constantTimeTextMatch(username, config.auth.username)
  let passwordMatches = false

  if (config.auth.passwordHash) {
    const selectedHash = usernameMatches
      ? config.auth.passwordHash
      : '$2a$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'
    passwordMatches = await bcrypt.compare(String(password), selectedHash)
  } else if (config.auth.allowDevelopmentLogin) {
    passwordMatches = constantTimeTextMatch(password, config.auth.developmentPassword)
  }

  return usernameMatches && passwordMatches ? SAFE_IDENTITY : null
}

export function requireAdmin(req, res, next) {
  if (!req.session?.identity || req.session.identity.role !== 'ADMIN') {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'กรุณาเข้าสู่ระบบ' },
    })
  }
  next()
}
