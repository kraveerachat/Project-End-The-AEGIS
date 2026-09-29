import { z } from 'zod'
import { deduplicateIntegrationEvents, normalizeIntegrationEvent } from '../domain/integrationEvents.js'
import { evaluateFreshness } from '../domain/status.js'
import { fetchJsonDocument } from './httpJsonClient.js'

export const MAX_FEED_EVENTS = 500

// Shallow, privacy-safe primitive allowlist for source-reported status detail
// (mirrors the `evidence` allowlist in domain/integrationEvents.js) — never a
// path, credential, media reference, or nested object.
const statusDetailValue = z.union([z.string().max(160), z.number().finite(), z.boolean(), z.null()])

// Optional service/daemon health block, additive to the PR7 envelope. This is
// the producer's own truthful read of its already-existing health signal
// (e.g. checkDb()/detector heartbeat age) — never fabricated, never derived
// from transport success. Absent = the producer has not upgraded to report
// it yet, and IDEA3 must keep treating that source's real status as unknown
// rather than assuming healthy.
const statusSchema = z.object({
  ok: z.boolean(),
  detail: z.record(statusDetailValue).optional(),
})

const envelopeSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().datetime({ offset: true }),
  status: statusSchema.optional(),
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
    serviceOk: null,
    serviceDetail: null,
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
    // null = the producer omitted `status` (not yet upgraded, or this cycle's
    // envelope didn't include it) — always treated as "we don't know", never
    // as "healthy". Only an explicit boolean here may drive real status.
    serviceOk: envelope.data.status?.ok ?? null,
    serviceDetail: envelope.data.status?.detail ?? null,
  }
}
