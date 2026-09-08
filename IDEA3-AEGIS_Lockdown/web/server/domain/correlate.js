import { createHash } from 'node:crypto'

const CORRELATION_WINDOW_MS = 600_000
const SEVERITY_RANK = Object.freeze({ INFO: 1, WARNING: 2, HIGH: 3, CRITICAL: 4 })
const CORRELATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/

function eventKey(event) {
  return `${event.source}:${event.event_id}`
}

function occurredAt(event) {
  return Date.parse(event.occurred_at)
}

/**
 * Only evidence the contract already marked containment-eligible participates.
 * Freshness, severity, and correlation key are re-checked here so a correlation
 * can never be produced from evidence a caller forgot to gate.
 */
function eligible(event) {
  return Boolean(event)
    && event.containment_eligible === true
    && event.freshness === 'FRESH'
    && SEVERITY_RANK[event.severity] !== undefined
    && Number.isFinite(occurredAt(event))
    && typeof event.correlation_key === 'string'
    && CORRELATION_KEY.test(event.correlation_key)
    && (event.source === 'IDEA1' || event.source === 'IDEA2')
}

function compareEvents(left, right) {
  return occurredAt(left) - occurredAt(right) || eventKey(left).localeCompare(eventKey(right))
}

function incidentId(evidenceIds, correlationKey) {
  return `inc-${createHash('sha256')
    .update([...evidenceIds].sort().join('|'))
    .update('|')
    .update(correlationKey)
    .digest('hex')
    .slice(0, 14)}`
}

function severityOf(events) {
  return events.reduce((highest, event) => (
    SEVERITY_RANK[event.severity] > SEVERITY_RANK[highest] ? event.severity : highest
  ), events[0].severity)
}

/**
 * Correlate reviewed cross-IDEA evidence into containment candidates.
 *
 * A candidate requires at least one eligible IDEA1 event and one eligible IDEA2
 * event sharing the same validated correlation key, with the whole group's
 * occurrence span inside `windowMs`. The result stops at
 * `CONTAINMENT_CANDIDATE`: nothing here requests, publishes, acknowledges, or
 * executes a command, and no physical evidence is implied.
 */
export function correlateIncidents(events, windowMs = CORRELATION_WINDOW_MS) {
  const unique = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!eligible(event)) continue
    if (!unique.has(eventKey(event))) unique.set(eventKey(event), event)
  }

  const groups = new Map()
  for (const event of [...unique.values()].sort(compareEvents)) {
    const group = groups.get(event.correlation_key) ?? []
    group.push(event)
    groups.set(event.correlation_key, group)
  }

  const incidents = []
  for (const [correlationKey, group] of groups) {
    const idea1 = group.filter((event) => event.source === 'IDEA1')
    const idea2 = group.filter((event) => event.source === 'IDEA2')
    if (idea1.length === 0 || idea2.length === 0) continue

    const timestamps = group.map(occurredAt)
    const firstSeen = Math.min(...timestamps)
    const lastSeen = Math.max(...timestamps)
    if (lastSeen - firstSeen > windowMs) continue

    const evidenceIds = group.map(eventKey).sort()
    incidents.push({
      id: incidentId(evidenceIds, correlationKey),
      state: 'CONTAINMENT_CANDIDATE',
      severity: severityOf(group),
      correlationKey,
      firstSeen: new Date(firstSeen).toISOString(),
      lastSeen: new Date(lastSeen).toISOString(),
      idea1Count: idea1.length,
      idea2Count: idea2.length,
      evidenceIds,
      responseState: 'NOT_REQUESTED',
    })
  }

  return incidents.sort((left, right) => (
    Date.parse(left.firstSeen) - Date.parse(right.firstSeen) || left.id.localeCompare(right.id)
  ))
}
