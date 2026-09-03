import { createHash } from 'node:crypto'

function incidentId(access, detection) {
  return `inc-${createHash('sha256')
    .update([access.id, detection.id, access.sourceIp].sort().join('|'))
    .digest('hex')
    .slice(0, 14)}`
}

function eventKey(event) {
  return [event.source, event.type, event.action ?? '', event.result, event.sourceIp, event.target].join('|')
}

export function deduplicateEvents(events, windowMs = 60_000) {
  const sorted = [...events].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  const groups = []

  for (const event of sorted) {
    const existing = groups.find((entry) => (
      eventKey(entry) === eventKey(event)
      && Date.parse(event.timestamp) - Date.parse(entry.timestamp) <= windowMs
    ))
    if (existing) {
      existing.dedupCount += 1
      existing.lastSeen = event.timestamp
    } else {
      groups.push({ ...event, dedupCount: 1, lastSeen: event.timestamp })
    }
  }

  return groups
}

export function correlateIncidents(events, windowMs = 600_000) {
  const unique = new Map(events.map((event) => [event.id, event]))
  const sourceEvents = [...unique.values()]
  const idea1 = sourceEvents.filter((event) => event.source === 'IDEA1' && ['DENIED', 'BLOCKED'].includes(event.result))
  const idea2 = sourceEvents.filter((event) => event.source === 'IDEA2')
  const incidents = new Map()

  for (const access of idea1) {
    for (const detection of idea2) {
      const delta = Math.abs(Date.parse(detection.timestamp) - Date.parse(access.timestamp))
      if (access.sourceIp !== detection.sourceIp || delta > windowMs) continue
      const id = incidentId(access, detection)
      incidents.set(id, {
        id,
        severity: detection.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        state: 'ACTIVE',
        firstSeen: access.timestamp < detection.timestamp ? access.timestamp : detection.timestamp,
        lastSeen: access.timestamp > detection.timestamp ? access.timestamp : detection.timestamp,
        sourceIp: access.sourceIp,
        idea1Count: 1,
        idea2Count: 1,
        responseState: 'NOT_REQUESTED',
        title: 'พฤติกรรมข้ามระบบจากต้นทางเดียวกัน',
        evidenceIds: [access.id, detection.id],
      })
    }
  }

  return [...incidents.values()]
}
