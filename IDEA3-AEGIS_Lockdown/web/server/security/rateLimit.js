export function createRateLimiter({ limit, windowMs, clock = () => Date.now() }) {
  const attempts = new Map()

  return {
    check(key) {
      const now = clock()
      const entry = attempts.get(key)
      if (!entry || now - entry.startedAt >= windowMs) {
        attempts.set(key, { count: 0, startedAt: now })
        return { allowed: true, remaining: limit }
      }
      return { allowed: entry.count < limit, remaining: Math.max(0, limit - entry.count) }
    },
    recordFailure(key) {
      const now = clock()
      const entry = attempts.get(key)
      if (!entry || now - entry.startedAt >= windowMs) {
        attempts.set(key, { count: 1, startedAt: now })
        return
      }
      entry.count += 1
    },
    clear(key) {
      attempts.delete(key)
    },
  }
}
