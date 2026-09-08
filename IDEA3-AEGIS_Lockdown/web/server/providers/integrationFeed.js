import { z } from 'zod'
import { deduplicateIntegrationEvents, normalizeIntegrationEvent } from '../domain/integrationEvents.js'
import { evaluateFreshness } from '../domain/status.js'
import { fetchJsonDocument } from './httpJsonClient.js'

export const MAX_FEED_EVENTS = 500

const envelopeSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().datetime({ offset: true }),
  events: z.array(z.unknown()).max(MAX_FEED_EVENTS),
})

function unusableFeed(source, code) {
  return {
    source,
    status: code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'UNKNOWN',
    code,
    generatedAt: null,
    envelopeFreshness: 'ABSENT',
    events: [],
    rejectedCount: 0,
    conflicts: [],
  }
}

/**
 * Translate one upstream feed into the canonical IDEA3 event contract.
 * Transport success is never reported as evidence freshness: the envelope
 * timestamp is evaluated separately so a healthy fetch of stale evidence stays
 * visibly stale for the correlation and containment boundaries.
 */
export async function fetchIntegrationFeed({ source, url, token, config, fetchImpl = fetch, clock = () => new Date() }) {
  const document = await fetchJsonDocument(url, {
    fetchImpl,
    timeoutMs: config.adapterTimeoutMs,
    token,
  })
  if (!document.ok) return unusableFeed(source, document.code)

  const envelope = envelopeSchema.safeParse(document.data)
  if (!envelope.success) return unusableFeed(source, 'ADAPTER_RESPONSE_REJECTED')

  const receivedAt = clock()
  const normalized = envelope.data.events.map((raw) => normalizeIntegrationEvent(raw, {
    source,
    receivedAt,
    maxAgeMs: config.maxEvidenceAgeMs,
  }))
  const accepted = normalized.filter((result) => result.ok).map((result) => result.event)
  const { events, conflicts } = deduplicateIntegrationEvents(accepted)

  return {
    source,
    status: 'HEALTHY',
    code: null,
    generatedAt: new Date(envelope.data.generated_at).toISOString(),
    envelopeFreshness: evaluateFreshness({
      generatedAt: envelope.data.generated_at,
      now: receivedAt,
      maxAgeMs: config.maxEvidenceAgeMs,
    }).freshness,
    events,
    rejectedCount: normalized.length - accepted.length,
    conflicts,
  }
}
