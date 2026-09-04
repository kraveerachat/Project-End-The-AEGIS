import { normalizeIdea1Event, normalizeIdea2Event, normalizeRuntimeStatus, unknownRuntime } from '../domain/normalize.js'
import { deriveOverallStatus } from '../domain/status.js'
import { correlateIncidents, deduplicateEvents } from '../domain/correlate.js'

const MAX_RESPONSE_BYTES = 256 * 1024

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  if (!url) return { configured: false, ok: false, code: 'NOT_CONFIGURED', data: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      return { configured: true, ok: false, code: 'ADAPTER_RESPONSE_REJECTED', data: null }
    }
    return { configured: true, ok: true, code: null, data: JSON.parse(text) }
  } catch (error) {
    return { configured: true, ok: false, code: error?.name === 'AbortError' ? 'ADAPTER_TIMEOUT' : 'ADAPTER_UNAVAILABLE', data: null }
  } finally {
    clearTimeout(timer)
  }
}

function sourceState(id, name, result, now) {
  const status = !result.configured ? 'NOT_CONFIGURED' : result.ok ? 'HEALTHY' : 'UNKNOWN'
  return { id, name, status, freshness: result.ok ? 'FRESH' : 'ABSENT', generatedAt: result.ok ? now.toISOString() : null, latencyMs: null, detail: result.code || 'Validated response' }
}

export function createLiveProvider({ config, fetchImpl = fetch, clock = () => new Date() }) {
  return {
    async getSnapshot({ limit = 100 } = {}) {
      const now = clock()
      const [idea1Result, idea2Result, runtimeResult] = await Promise.all([
        fetchJson(config.adapters.idea1Url, { fetchImpl, timeoutMs: config.adapterTimeoutMs }),
        fetchJson(config.adapters.idea2Url, { fetchImpl, timeoutMs: config.adapterTimeoutMs }),
        fetchJson(config.adapters.runtimeUrl, { fetchImpl, timeoutMs: config.adapterTimeoutMs }),
      ])
      const idea1Events = (Array.isArray(idea1Result.data?.events) ? idea1Result.data.events : []).map(normalizeIdea1Event).filter(Boolean)
      const idea2Events = (Array.isArray(idea2Result.data?.events) ? idea2Result.data.events : []).map(normalizeIdea2Event).filter(Boolean)
      const events = deduplicateEvents([...idea1Events, ...idea2Events]).slice(0, limit)
      const runtime = runtimeResult.ok
        ? normalizeRuntimeStatus(runtimeResult.data, { now, maxAgeMs: config.maxEvidenceAgeMs })
        : unknownRuntime(runtimeResult.configured ? 'ABSENT' : 'NOT_CONFIGURED')
      const sources = [
        sourceState('idea1', 'IDEA1 Access Security', idea1Result, now),
        sourceState('idea2', 'IDEA2 Detection', idea2Result, now),
        { ...sourceState('idea3', 'IDEA3 Runtime', runtimeResult, now), status: runtime.status, generatedAt: runtime.generatedAt },
        { id: 'events', name: 'Event Store', status: 'DEGRADED', freshness: 'FRESH', generatedAt: now.toISOString(), latencyMs: null, detail: 'In-memory repository' },
        { id: 'audit', name: 'Audit Store', status: 'DEGRADED', freshness: 'FRESH', generatedAt: now.toISOString(), latencyMs: null, detail: 'In-memory repository' },
      ]
      const incidents = correlateIncidents(events)

      return {
        schemaVersion: 1,
        mode: 'LIVE',
        generatedAt: now.toISOString(),
        overall: { status: deriveOverallStatus(sources.slice(0, 3).map((source) => source.status)), evidenceAgeMs: null, eventCount: events.length, activeIncidents: incidents.length, highAlerts: 0 },
        sources,
        events,
        idea1: { status: sources[0].status, freshness: sources[0].freshness, generatedAt: sources[0].generatedAt, summary: { denied: idea1Events.filter((event) => event.result === 'DENIED').length, blocked: idea1Events.filter((event) => event.result === 'BLOCKED').length, uniqueSourceIps: new Set(idea1Events.map((event) => event.sourceIp)).size, repeated: 0, escalated: 0 }, events: idea1Events.slice(0, limit) },
        idea2: { status: sources[1].status, freshness: sources[1].freshness, generatedAt: sources[1].generatedAt, summary: { detections: idea2Events.length, high: idea2Events.filter((event) => event.severity === 'HIGH').length, critical: idea2Events.filter((event) => event.severity === 'CRITICAL').length, cameras: new Set(idea2Events.map((event) => event.target)).size }, events: idea2Events.slice(0, limit) },
        alerts: [], incidents, audit: [], runtime: { ...runtime, timeline: [], readiness: [] }, devices: [],
        recovery: { gatewayStatus: 'DISABLED', liveHardware: false, authorization: 'DISABLED', incidentState: incidents[0]?.state ?? 'NONE', preconditions: [], runbook: [], history: [] },
        settings: { adapters: sources.slice(0, 3).map((source) => ({ id: source.id, name: source.name, enabled: source.status !== 'DISABLED', configured: source.status !== 'NOT_CONFIGURED', timeoutMs: config.adapterTimeoutMs, alias: source.id, lastValidation: source.generatedAt, lastSuccess: source.status === 'HEALTHY' ? source.generatedAt : null })), policy: {}, security: { csrf: 'ENFORCED', adminRbac: 'ENFORCED', secureCookieProduction: 'REQUIRED', productionDemo: 'DENIED', rawPayload: 'DENIED' } },
        provenance: { provider: 'live-read-only-adapters', liveMerged: false, persistence: 'MEMORY_ONLY' },
      }
    },
  }
}
