/**
 * Client-only row selector for the IDEA1 / IDEA2 pages.
 *
 * The dedicated `snapshot.idea1|idea2.events` arrays win whenever they hold
 * rows. In Live the server leaves them empty and carries the normalized feed
 * events in `snapshot.integration.events`; that array is used only as a
 * fallback and only for the requested source. Nothing is invented: the
 * normalized shape has no source IP, so none is shown, and every row keeps its
 * own freshness so STALE / FUTURE / MALFORMED evidence never reads as current.
 */
const KEY = Object.freeze({ IDEA1: 'idea1', IDEA2: 'idea2' })

function integrationRow(event) {
  return {
    id: `${event.source}:${event.event_id}`,
    timestamp: event.occurred_at,
    action: event.event_type,
    type: event.event_type,
    result: typeof event.evidence?.result === 'string' ? event.evidence.result : undefined,
    severity: event.severity,
    target: event.resource,
    dedupCount: Number.isFinite(event.dedup_count) ? event.dedup_count : 1,
    freshness: typeof event.freshness === 'string' ? event.freshness : 'UNKNOWN',
  }
}

function countWhere(rows, predicate) {
  return rows.filter((row) => row.freshness === 'FRESH' && predicate(row)).length
}

// Only figures that can be counted directly from normalized rows. Anything
// needing data the feed does not carry (unique IPs, cameras, escalations) stays undefined.
function derivedSummary(source, rows) {
  if (source === 'IDEA1') {
    return { denied: countWhere(rows, (row) => row.result === 'DENIED'), blocked: countWhere(rows, (row) => row.result === 'BLOCKED') }
  }
  return {
    detections: countWhere(rows, () => true),
    high: countWhere(rows, (row) => row.severity === 'HIGH'),
    critical: countWhere(rows, (row) => row.severity === 'CRITICAL'),
  }
}

export function ideaRows(snapshot, source) {
  const domain = snapshot?.[KEY[source]]
  if (Array.isArray(domain?.events) && domain.events.length > 0) {
    return { origin: 'DEDICATED', rows: domain.events, summary: domain.summary ?? {} }
  }
  const feed = Array.isArray(snapshot?.integration?.events) ? snapshot.integration.events : []
  const rows = feed.filter((event) => event?.source === source).map(integrationRow)
  if (rows.length === 0) return { origin: 'NONE', rows: [], summary: domain?.summary ?? {} }
  return { origin: 'INTEGRATION', rows, summary: derivedSummary(source, rows) }
}
