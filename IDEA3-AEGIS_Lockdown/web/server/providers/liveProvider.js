import { normalizeRuntimeStatus, unknownRuntime } from '../domain/normalize.js'
import { deriveOverallStatus } from '../domain/status.js'
import { correlateIncidents } from '../domain/correlate.js'
import { createOperationalError, operationalErrorFingerprint } from '../domain/operationalErrors.js'
import { fetchJsonDocument } from './httpJsonClient.js'
import { fetchIdea1Events } from './idea1Adapter.js'
import { fetchIdea2Events } from './idea2Adapter.js'

const FRESH_ENVELOPE = 'FRESH'

/** Upstream evidence outside the freshness window is observable but never eligible. */
const STALE_FRESHNESS = new Set(['STALE', 'FUTURE', 'MALFORMED'])

function feedOperationalError(feed, now, component) {
  if (feed.status === 'NOT_CONFIGURED') return null
  if (feed.code) {
    return createOperationalError(
      feed.code === 'MALFORMED_RESPONSE' ? 'ADAPTER_RESPONSE_REJECTED' : feed.code,
      { occurredAt: now.toISOString(), component },
    )
  }
  if (STALE_FRESHNESS.has(feed.envelopeFreshness)) {
    return createOperationalError('ADAPTER_EVIDENCE_STALE', { occurredAt: now.toISOString(), component })
  }
  return null
}

/**
 * The single source of truth for "is this source actually healthy" — every
 * other function in this module (feedSourceState, feedSummary, the lifecycle
 * transition) MUST call this rather than re-deriving health, so they cannot
 * drift from one another or from each other's fail-closed rules.
 *
 * Transport success is not evidence freshness, and is not service health:
 *   - transport/schema failure or NOT_CONFIGURED: unchanged existing status
 *     (UNKNOWN / NOT_CONFIGURED) — serviceOk is irrelevant, it was never
 *     reached.
 *   - stale/future/malformed envelope freshness: always UNKNOWN, regardless
 *     of what the producer's own status block says — a producer cannot
 *     claim its own health is trustworthy through evidence we already know
 *     is too old or malformed to trust.
 *   - fresh envelope + serviceOk === true: HEALTHY.
 *   - fresh envelope + serviceOk === false: DEGRADED — a definite,
 *     producer-reported problem (e.g. IDEA1's DB unreachable, IDEA2's
 *     detector heartbeat lost).
 *   - fresh envelope + serviceOk === null: UNKNOWN — the producer never
 *     reported real health, so honest transport success must NOT be
 *     reported as "healthy". This is the fail-closed default and matches
 *     the binding MVP requirement that feed reachability is not proof of
 *     actual Drive/Detector health.
 */
function effectiveSourceHealth(feed) {
  if (feed.status !== 'HEALTHY') return feed.status
  if (!feed.code && STALE_FRESHNESS.has(feed.envelopeFreshness)) return 'UNKNOWN'
  if (feed.serviceOk === true) return 'HEALTHY'
  if (feed.serviceOk === false) return 'DEGRADED'
  return 'UNKNOWN'
}

function feedSourceState(id, name, feed, lifecycle) {
  const stale = !feed.code && STALE_FRESHNESS.has(feed.envelopeFreshness)
  const status = effectiveSourceHealth(feed)
  const reportedDegraded = !stale && status === 'DEGRADED'
  const reportedUnknownService = !stale && feed.status === 'HEALTHY' && status === 'UNKNOWN'
  return {
    id,
    name,
    status,
    freshness: feed.code ? 'ABSENT' : feed.envelopeFreshness,
    generatedAt: feed.generatedAt,
    latencyMs: null,
    detail: feed.code
      || (stale ? 'Validated response with stale evidence'
        : reportedDegraded ? 'Upstream reports degraded service'
          : reportedUnknownService ? 'Upstream did not report a verifiable service status'
            : 'Validated response'),
    lifecycle,
  }
}

function feedSummary(feed, lifecycle) {
  return {
    source: feed.source,
    status: effectiveSourceHealth(feed),
    code: feed.code,
    freshness: feed.code ? 'ABSENT' : feed.envelopeFreshness,
    generatedAt: feed.generatedAt,
    eventCount: feed.events.length,
    rejectedCount: feed.rejectedCount,
    conflictCount: feed.conflicts.length,
    lifecycle,
    // Real, producer-reported service/daemon status — null means the
    // producer hasn't reported it (never assumed healthy from that).
    serviceOk: feed.serviceOk,
    serviceDetail: feed.serviceDetail,
  }
}

/** One active failure period stays FAILING; the first validated cycle after it is RECOVERED. */
function nextLifecycle(previous, healthy) {
  if (!healthy) return 'FAILING'
  return previous === 'FAILING' ? 'RECOVERED' : 'STEADY'
}

function runtimeDocumentState(document) {
  return {
    configured: document.code !== 'NOT_CONFIGURED',
    ok: document.ok,
    code: document.code,
    data: document.data,
  }
}

function runtimeOperationalError(result, now) {
  if (!result.configured || result.ok) return null
  const code = result.code === 'MALFORMED_RESPONSE' ? 'MALFORMED_RUNTIME_STATUS' : result.code
  return createOperationalError(code, { occurredAt: now.toISOString(), component: 'IDEA3 Runtime Adapter' })
}

export function createLiveProvider({ config, fetchImpl = fetch, clock = () => new Date() }) {
  const lifecycles = { IDEA1: 'STEADY', IDEA2: 'STEADY' }

  return {
    async getSnapshot({ limit = 100 } = {}) {
      const now = clock()
      const [idea1Feed, idea2Feed, runtimeDocument] = await Promise.all([
        fetchIdea1Events({ config, fetchImpl, clock }),
        fetchIdea2Events({ config, fetchImpl, clock }),
        fetchJsonDocument(config.adapters.runtimeUrl, { fetchImpl, timeoutMs: config.adapterTimeoutMs }),
      ])
      const runtimeResult = runtimeDocumentState(runtimeDocument)

      for (const feed of [idea1Feed, idea2Feed]) {
        if (feed.status === 'NOT_CONFIGURED') continue
        lifecycles[feed.source] = nextLifecycle(lifecycles[feed.source], effectiveSourceHealth(feed) === 'HEALTHY')
      }

      const integrationEvents = [...idea1Feed.events, ...idea2Feed.events]
        .sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
          || `${left.source}:${left.event_id}`.localeCompare(`${right.source}:${right.event_id}`))
        .map((event) => (STALE_FRESHNESS.has(event.freshness) ? { ...event, containment_eligible: false } : event))
        .slice(0, limit)
      const conflicts = [...idea1Feed.conflicts, ...idea2Feed.conflicts]

      const runtime = runtimeResult.ok
        ? normalizeRuntimeStatus(runtimeResult.data, { now, maxAgeMs: config.maxEvidenceAgeMs })
        : unknownRuntime(runtimeResult.configured ? 'ABSENT' : 'NOT_CONFIGURED')

      const operationalErrors = [
        ...[
          feedOperationalError(idea1Feed, now, 'IDEA1 Adapter'),
          feedOperationalError(idea2Feed, now, 'IDEA2 Adapter'),
          runtimeOperationalError(runtimeResult, now),
        ].filter(Boolean),
        ...runtime.operationalErrors,
      ].filter((error, index, errors) => errors.findIndex((candidate) => operationalErrorFingerprint(candidate) === operationalErrorFingerprint(error)) === index)

      const idea1Source = feedSourceState('idea1', 'IDEA1 Access Security', idea1Feed, lifecycles.IDEA1)
      const idea2Source = feedSourceState('idea2', 'IDEA2 Detection', idea2Feed, lifecycles.IDEA2)
      const sources = [
        idea1Source,
        idea2Source,
        {
          id: 'idea3',
          name: 'IDEA3 Runtime',
          status: runtime.status,
          freshness: runtimeResult.ok ? runtime.freshness : 'ABSENT',
          generatedAt: runtime.generatedAt,
          latencyMs: null,
          detail: runtimeResult.code || 'Validated response',
        },
        { id: 'events', name: 'Event Store', status: 'DEGRADED', freshness: 'FRESH', generatedAt: now.toISOString(), latencyMs: null, detail: 'Runtime-owned snapshot; not persisted' },
        { id: 'audit', name: 'Audit Store', status: 'HEALTHY', freshness: 'FRESH', generatedAt: now.toISOString(), latencyMs: null, detail: 'Durable SQLite audit store' },
      ]

      const incidents = correlateIncidents(integrationEvents)
      const eligibleCount = integrationEvents.filter((event) => event.containment_eligible).length

      return {
        schemaVersion: 1,
        mode: 'LIVE',
        generatedAt: now.toISOString(),
        overall: {
          status: deriveOverallStatus(sources.slice(0, 3).map((source) => source.status)),
          evidenceAgeMs: null,
          eventCount: integrationEvents.length,
          activeIncidents: incidents.length,
          highAlerts: 0,
        },
        sources,
        events: [],
        integration: {
          schemaVersion: 1,
          idea1: feedSummary(idea1Feed, lifecycles.IDEA1),
          idea2: feedSummary(idea2Feed, lifecycles.IDEA2),
          events: integrationEvents,
          conflicts,
          eligibleCount,
        },
        idea1: { status: idea1Source.status, freshness: idea1Source.freshness, generatedAt: idea1Source.generatedAt, summary: { denied: 0, blocked: 0, uniqueSourceIps: 0, repeated: 0, escalated: 0 }, events: [] },
        idea2: { status: idea2Source.status, freshness: idea2Source.freshness, generatedAt: idea2Source.generatedAt, summary: { detections: 0, high: 0, critical: 0, cameras: 0 }, events: [] },
        alerts: [], incidents, audit: [], runtime: { ...runtime, timeline: [], readiness: [] }, devices: [],
        operationalErrors,
        recovery: { gatewayStatus: 'DISABLED', liveHardware: false, authorization: 'DISABLED', incidentState: incidents[0]?.state ?? 'NONE', preconditions: [], runbook: [], history: [] },
        settings: {
          adapters: sources.slice(0, 3).map((source) => ({ id: source.id, name: source.name, enabled: source.status !== 'DISABLED', configured: source.status !== 'NOT_CONFIGURED', timeoutMs: config.adapterTimeoutMs, alias: source.id, lastValidation: source.generatedAt, lastSuccess: source.status === 'HEALTHY' ? source.generatedAt : null })),
          policy: {},
          security: { csrf: 'ENFORCED', adminRbac: 'ENFORCED', secureCookieProduction: 'REQUIRED', productionDemo: 'DENIED', rawPayload: 'DENIED' },
        },
        provenance: {
          provider: 'live-read-only-adapters',
          liveMerged: false,
          persistence: 'SQLITE_AUDIT_ONLY',
          eventPersistence: 'RUNTIME_ONLY',
        },
      }
    },
  }
}
