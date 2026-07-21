// server/auth/rateLimit.js
const attempts = new Map()

export function checkLock(req, username) {
  const key = `${req.ip}_${String(username).toLowerCase()}`
  const record = attempts.get(key)
  if (!record) return { locked: false, retryAfterMs: 0 }
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: record.lockedUntil - Date.now() }
  }
  return { locked: false, retryAfterMs: 0 }
}

export function recordFailure(req, username) {
  const key = `${req.ip}_${String(username).toLowerCase()}`
  const record = attempts.get(key) || { count: 0, lockedUntil: 0 }
  record.count += 1
  if (record.count >= 5) {
    record.lockedUntil = Date.now() + 30000
    record.count = 0
  }
  attempts.set(key, record)
}

export function recordSuccess(req, username) {
  const key = `${req.ip}_${String(username).toLowerCase()}`
  attempts.delete(key)
}
