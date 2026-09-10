import { z } from 'zod'
import { evaluateFreshness } from './status.js'

const sourceSchema = z.enum(['IDEA1', 'IDEA2'])
const severitySchema = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL', 'UNKNOWN'])
const eventTypeSchema = z.enum(['ACCESS_DENIED'])
const timestampSchema = z.string().datetime({ offset: true })
const boundedText = z.string().trim().min(1).max(160)
const boundedId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
const confidenceSchema = z.number().finite().min(0).max(100)
const evidenceSchemas = Object.freeze({
  result: boundedText,
})

const rawEventSchema = z.object({
  source: sourceSchema,
  event_id: boundedId,
  event_type: eventTypeSchema,
  severity: severitySchema,
  occurred_at: timestampSchema,
  resource: boundedText,
  subject: boundedText.nullish(),
  confidence: confidenceSchema.nullish(),
  evidence: z.record(z.unknown()).optional(),
  correlation_key: boundedId.nullish(),
}).passthrough()

function invalidEvent() {
  return { ok: false, error: { code: 'INVALID_EVENT' } }
}

function normalizeEvidence(rawEvidence) {
  if (!rawEvidence) return { evidence: {}, evidenceCompleteness: 'NONE' }

  const entries = Object.entries(rawEvidence)
  const evidence = Object.fromEntries(entries.flatMap(([key, value]) => {
    const schema = evidenceSchemas[key]
    if (!schema) return []
    const parsed = schema.safeParse(value)
    return parsed.success ? [[key, parsed.data]] : []
  }))

  return {
    evidence,
    evidenceCompleteness: Object.keys(evidence).length === entries.length ? 'COMPLETE' : 'PARTIAL',
  }
}

function normalizedTimestamp(value) {
  return new Date(value).toISOString()
}

function validReceivedAt(receivedAt) {
  return receivedAt instanceof Date && Number.isFinite(receivedAt.getTime())
}

export function normalizeIntegrationEvent(raw, { source, receivedAt, maxAgeMs } = {}) {
  const configuredSource = sourceSchema.safeParse(source)
  if (!configuredSource.success || !validReceivedAt(receivedAt) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return invalidEvent()
  }

  const parsed = rawEventSchema.safeParse(raw)
  if (!parsed.success || parsed.data.source !== configuredSource.data) return invalidEvent()

  const freshness = evaluateFreshness({
    generatedAt: parsed.data.occurred_at,
    now: receivedAt,
    maxAgeMs,
  }).freshness
  const { evidence, evidenceCompleteness } = normalizeEvidence(parsed.data.evidence)
  const containmentEligible = freshness === 'FRESH' && parsed.data.severity !== 'UNKNOWN'

  return {
    ok: true,
    event: {
      source: parsed.data.source,
      event_id: parsed.data.event_id,
      event_type: parsed.data.event_type,
      severity: parsed.data.severity,
      occurred_at: normalizedTimestamp(parsed.data.occurred_at),
      received_at: receivedAt.toISOString(),
      resource: parsed.data.resource,
      subject: null,
      confidence: parsed.data.confidence ?? null,
      evidence,
      evidence_completeness: evidenceCompleteness,
      freshness,
      correlation_key: parsed.data.correlation_key ?? null,
      containment_eligible: containmentEligible,
    },
  }
}

function eventKey(event) {
  return `${event.source}:${event.event_id}`
}

function canonicalContent(event) {
  return JSON.stringify({
    source: event.source,
    event_id: event.event_id,
    event_type: event.event_type,
    severity: event.severity,
    occurred_at: event.occurred_at,
    resource: event.resource,
    subject: event.subject,
    confidence: event.confidence,
    evidence: Object.fromEntries(Object.entries(event.evidence).sort(([left], [right]) => left.localeCompare(right))),
    correlation_key: event.correlation_key,
  })
}

function compareEvents(left, right) {
  return Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
    || eventKey(left).localeCompare(eventKey(right))
}

export function deduplicateIntegrationEvents(events) {
  const groups = new Map()
  const conflicts = new Map()

  for (const event of [...events].sort(compareEvents)) {
    const key = eventKey(event)
    if (conflicts.has(key)) continue

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { event, content: canonicalContent(event), count: 1 })
      continue
    }

    if (existing.content !== canonicalContent(event)) {
      groups.delete(key)
      conflicts.set(key, { code: 'EVENT_ID_CONFLICT', source: event.source, event_id: event.event_id })
      continue
    }

    existing.count = Math.min(existing.count + 1, 1_000_000)
  }

  return {
    events: [...groups.values()]
      .map(({ event, count }) => ({ ...event, dedup_count: count }))
      .sort(compareEvents),
    conflicts: [...conflicts.values()].sort((left, right) => eventKey(left).localeCompare(eventKey(right))),
  }
}
