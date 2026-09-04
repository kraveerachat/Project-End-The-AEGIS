import { timingSafeEqual } from 'node:crypto'

function safeTokenMatch(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function requireSameOrigin(req, res, next) {
  const origin = req.get('origin')
  let originHost = null

  try {
    originHost = origin ? new URL(origin).host : null
  } catch {
    originHost = null
  }

  if (!originHost || originHost !== req.get('host')) {
    return res.status(403).json({
      error: { code: 'ORIGIN_INVALID', message: 'ไม่อนุญาตคำขอข้ามต้นทาง' },
    })
  }
  next()
}

export function requireCsrf(req, res, next) {
  if (!safeTokenMatch(req.get('x-csrf-token'), req.session?.csrfToken)) {
    return res.status(403).json({
      error: { code: 'CSRF_INVALID', message: 'คำขอหมดอายุ กรุณาลองใหม่' },
    })
  }
  next()
}
