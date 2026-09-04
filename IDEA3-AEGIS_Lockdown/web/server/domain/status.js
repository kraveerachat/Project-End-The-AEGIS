import { z } from 'zod'

export const CANONICAL_STATUSES = Object.freeze([
  'HEALTHY',
  'DEGRADED',
  'FAILED',
  'UNKNOWN',
  'NOT_CONFIGURED',
  'DISABLED',
])

export const canonicalStatusSchema = z.enum(CANONICAL_STATUSES)

export function isCanonicalStatus(value) {
  return canonicalStatusSchema.safeParse(value).success
}

export function evaluateFreshness({ generatedAt, now = new Date(), maxAgeMs }) {
  const timestamp = Date.parse(generatedAt)

  if (!Number.isFinite(timestamp)) {
    return { freshness: 'MALFORMED', status: 'UNKNOWN', ageMs: null }
  }

  const ageMs = now.getTime() - timestamp
  if (ageMs < -5_000) {
    return { freshness: 'FUTURE', status: 'UNKNOWN', ageMs }
  }

  if (ageMs > maxAgeMs) {
    return { freshness: 'STALE', status: 'UNKNOWN', ageMs }
  }

  return { freshness: 'FRESH', ageMs }
}

export function deriveOverallStatus(statuses) {
  const validStatuses = statuses.filter(isCanonicalStatus)
  if (validStatuses.length === 0) return 'UNKNOWN'

  const priority = ['FAILED', 'UNKNOWN', 'DEGRADED', 'NOT_CONFIGURED', 'DISABLED', 'HEALTHY']
  return priority.find((status) => validStatuses.includes(status)) ?? 'UNKNOWN'
}
