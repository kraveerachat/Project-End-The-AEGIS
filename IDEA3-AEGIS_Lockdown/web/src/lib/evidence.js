import { formatCount, formatEvidenceAge } from './format.js'

const CANONICAL_STATUSES = new Set([
  'HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'NOT_CONFIGURED', 'STALE', 'DISABLED',
])

export const UNAVAILABLE = '—'

export function safeStatus(value, fallback = 'UNKNOWN') {
  return CANONICAL_STATUSES.has(value) ? value : fallback
}

export function safeText(value, fallback = 'UNKNOWN') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function hasValidTimestamp(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
}

/**
 * Strict evidence status. HEALTHY additionally requires FRESH freshness and a
 * parseable timestamp; STALE always wins; anything unrecognised is UNKNOWN.
 */
export function strictEvidenceStatus(value) {
  const { status, freshness, generatedAt } = value ?? {}
  const normalized = safeStatus(status)
  if (freshness === 'STALE') return 'STALE'
  if (normalized === 'HEALTHY' && (freshness !== 'FRESH' || !hasValidTimestamp(generatedAt))) return 'UNKNOWN'
  return normalized
}

/** Counts are trustworthy only when the producing source is up (HEALTHY/DEGRADED). */
export function countsTrusted(status) {
  return status === 'HEALTHY' || status === 'DEGRADED'
}

/**
 * A non-zero count is itself evidence. A zero (or missing) count is only
 * shown as a number when the source can vouch for it; otherwise a dash.
 */
export function evidenceCount(value, trusted, language) {
  if (!Number.isFinite(value)) return UNAVAILABLE
  if (value === 0 && !trusted) return UNAVAILABLE
  return formatCount(value, language)
}

/** Badge for a count: a zero never becomes HEALTHY unless the source is trusted. */
export function zeroAwareStatus(count, trusted, sourceStatus, positiveStatus) {
  if (Number.isFinite(count) && count > 0) return positiveStatus
  return trusted ? 'HEALTHY' : safeStatus(sourceStatus)
}

/** Tolerant read of an IDEA1/IDEA2 domain so an adapter failure cannot crash a page. */
export function domainView(domain) {
  const status = strictEvidenceStatus(domain)
  return {
    status,
    trusted: countsTrusted(status),
    freshness: domain?.freshness,
    generatedAt: domain?.generatedAt,
    events: Array.isArray(domain?.events) ? domain.events : [],
    summary: domain?.summary && typeof domain.summary === 'object' ? domain.summary : {},
  }
}

/** Age of a piece of evidence relative to the snapshot that carried it (never wall-clock). */
export function evidenceAgeAt(timestamp, snapshotTimestamp, language) {
  const evidenceTime = Date.parse(timestamp)
  const snapshotTime = Date.parse(snapshotTimestamp)
  if (!Number.isFinite(evidenceTime) || !Number.isFinite(snapshotTime)) return formatEvidenceAge(Number.NaN, language)
  return formatEvidenceAge(Math.max(0, snapshotTime - evidenceTime), language)
}

/** Snapshot-wide evidence trust, mirroring the Dashboard: STALE wins, no evidence age means UNKNOWN. */
export function overallEvidence(snapshot) {
  const overall = snapshot?.overall ?? {}
  const stale = (snapshot?.sources ?? []).some((source) => source.freshness === 'STALE')
  const status = stale ? 'STALE' : Number.isFinite(overall.evidenceAgeMs) ? safeStatus(overall.status) : 'UNKNOWN'
  return { status, trusted: countsTrusted(status) }
}
