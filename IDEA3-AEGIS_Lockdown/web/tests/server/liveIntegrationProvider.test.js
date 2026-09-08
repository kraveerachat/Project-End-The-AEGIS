import { describe, expect, it, vi } from 'vitest'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { healthyRuntimeRaw } from '../fixtures/evidence.js'

const NOW = new Date('2026-09-08T08:00:00.000Z')

const liveConfig = Object.freeze({
  adapterTimeoutMs: 2_500,
  maxEvidenceAgeMs: 120_000,
  adapters: Object.freeze({
    idea1Url: 'https://idea1.internal/api/integration/events',
    idea2Url: 'https://idea2.internal/api/integration/events',
    runtimeUrl: 'https://idea3.internal/api/runtime/status',
    idea1Token: 'idea1-integration-credential',
    idea2Token: 'idea2-integration-credential',
  }),
})

function jsonResponse(body, { ok = true } = {}) {
  return { ok, redirected: false, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
}

function rawEvent(source, overrides = {}) {
  return {
    source,
    event_id: `${source.toLowerCase()}-event-1`,
    event_type: 'ACCESS_DENIED',
    severity: 'WARNING',
    occurred_at: '2026-09-08T07:59:55.000Z',
    resource: source === 'IDEA1' ? 'AEGIS Drive' : 'CAM-02',
    evidence: { result: 'DENIED' },
    correlation_key: 'zone-a-incident-42',
    ...overrides,
  }
}

function feed(events, generatedAt = '2026-09-08T08:00:00.000Z') {
  return { schema_version: 1, generated_at: generatedAt, events }
}

function providerWith({ idea1, idea2, runtime = () => jsonResponse({ ...healthyRuntimeRaw, generatedAt: NOW.toISOString() }) }) {
  const fetchImpl = vi.fn(async (url) => {
    if (url === liveConfig.adapters.idea1Url) return idea1()
    if (url === liveConfig.adapters.idea2Url) return idea2()
    return runtime()
  })
  return { provider: createLiveProvider({ config: liveConfig, clock: () => NOW, fetchImpl }), fetchImpl }
}

function sourceById(snapshot, id) {
  return snapshot.sources.find((source) => source.id === id)
}

describe('live integration provider failure and freshness semantics', () => {
  it('reports fresh upstream evidence only when the envelope itself is fresh', async () => {
    const { provider } = providerWith({
      idea1: () => jsonResponse(feed([rawEvent('IDEA1')])),
      idea2: () => jsonResponse(feed([rawEvent('IDEA2')])),
    })

    const snapshot = await provider.getSnapshot()

    expect(sourceById(snapshot, 'idea1')).toEqual(expect.objectContaining({ status: 'HEALTHY', freshness: 'FRESH' }))
    expect(snapshot.integration.events).toHaveLength(2)
    expect(snapshot.integration.eligibleCount).toBe(2)
  })

  it('never marks an event feed fresh merely because the HTTP request succeeded', async () => {
    const { provider } = providerWith({
      idea1: () => jsonResponse(feed([rawEvent('IDEA1', { occurred_at: '2026-09-08T07:50:00.000Z' })], '2026-09-08T07:50:00.000Z')),
      idea2: () => jsonResponse(feed([])),
    })

    const snapshot = await provider.getSnapshot()
    const idea1 = sourceById(snapshot, 'idea1')

    expect(idea1.freshness).toBe('STALE')
    expect(idea1.status).toBe('UNKNOWN')
    expect(snapshot.integration.events[0]).toEqual(expect.objectContaining({ freshness: 'STALE', containment_eligible: false }))
    expect(snapshot.integration.eligibleCount).toBe(0)
    expect(snapshot.operationalErrors).toContainEqual(expect.objectContaining({
      code: 'ADAPTER_EVIDENCE_STALE', component: 'IDEA1 Adapter',
    }))
  })

  it('keeps future upstream evidence observable but containment-ineligible', async () => {
    const { provider } = providerWith({
      idea1: () => jsonResponse(feed([rawEvent('IDEA1', { occurred_at: '2026-09-08T08:00:30.000Z' })])),
      idea2: () => jsonResponse(feed([])),
    })

    const snapshot = await provider.getSnapshot()

    expect(snapshot.integration.events[0]).toEqual(expect.objectContaining({ freshness: 'FUTURE', containment_eligible: false }))
    expect(snapshot.integration.eligibleCount).toBe(0)
    // A fresh envelope carrying future evidence stays a fresh envelope; only the
    // event itself is future, and per-event freshness is what gates containment.
    expect(sourceById(snapshot, 'idea1').freshness).toBe('FRESH')
  })

  it.each([
    ['a timeout', () => { const error = new Error('token=private'); error.name = 'AbortError'; throw error }, 'ADAPTER_TIMEOUT'],
    ['an unavailable upstream', () => { throw new Error('password=private') }, 'ADAPTER_UNAVAILABLE'],
    ['a rejected response', () => jsonResponse(feed([]), { ok: false }), 'ADAPTER_RESPONSE_REJECTED'],
    ['a malformed body', () => jsonResponse('{not-json'), 'MALFORMED_RESPONSE'],
    ['an unsupported envelope version', () => jsonResponse({ schema_version: 2, generated_at: NOW.toISOString(), events: [] }), 'ADAPTER_RESPONSE_REJECTED'],
  ])('fails closed with a safe error and no events on %s', async (_case, idea1, code) => {
    const { provider } = providerWith({ idea1, idea2: () => jsonResponse(feed([])) })

    const snapshot = await provider.getSnapshot()

    expect(sourceById(snapshot, 'idea1')).toEqual(expect.objectContaining({ status: 'UNKNOWN', freshness: 'ABSENT', generatedAt: null }))
    expect(snapshot.integration.events).toEqual([])
    expect(snapshot.operationalErrors.map((error) => error.code)).toContain(code === 'MALFORMED_RESPONSE' ? 'ADAPTER_RESPONSE_REJECTED' : code)
    expect(JSON.stringify(snapshot)).not.toMatch(/private|idea1-integration-credential/)
  })

  it('keeps a partial cycle honest when only one source is usable', async () => {
    const { provider } = providerWith({
      idea1: () => jsonResponse(feed([rawEvent('IDEA1')])),
      idea2: () => { throw new Error('offline') },
    })

    const snapshot = await provider.getSnapshot()

    expect(sourceById(snapshot, 'idea1').status).toBe('HEALTHY')
    expect(sourceById(snapshot, 'idea2').status).toBe('UNKNOWN')
    expect(snapshot.integration.events).toHaveLength(1)
    expect(snapshot.integration.idea2).toEqual(expect.objectContaining({ status: 'UNKNOWN', code: 'ADAPTER_UNAVAILABLE' }))
  })

  it('reports NOT_CONFIGURED without contacting any upstream when no feed is provisioned', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const provider = createLiveProvider({
      config: { ...liveConfig, adapters: { ...liveConfig.adapters, idea1Url: null, idea2Url: null, runtimeUrl: null } },
      clock: () => NOW,
      fetchImpl,
    })

    const snapshot = await provider.getSnapshot()

    expect(sourceById(snapshot, 'idea1').status).toBe('NOT_CONFIGURED')
    expect(sourceById(snapshot, 'idea2').status).toBe('NOT_CONFIGURED')
    expect(snapshot.integration.events).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('recovers to healthy on the first validated cycle after a failure and can fail again', async () => {
    const responses = [
      () => { throw new Error('offline') },
      () => jsonResponse(feed([rawEvent('IDEA1')])),
      () => { throw new Error('offline again') },
    ]
    let call = 0
    const provider = createLiveProvider({
      config: liveConfig,
      clock: () => NOW,
      fetchImpl: async (url) => (url === liveConfig.adapters.idea1Url ? responses[call++]() : jsonResponse(feed([]))),
    })

    const failed = await provider.getSnapshot()
    const recovered = await provider.getSnapshot()
    const failedAgain = await provider.getSnapshot()

    expect(failed.integration.idea1).toEqual(expect.objectContaining({ status: 'UNKNOWN', lifecycle: 'FAILING' }))
    expect(recovered.integration.idea1).toEqual(expect.objectContaining({ status: 'HEALTHY', lifecycle: 'RECOVERED' }))
    expect(failedAgain.integration.idea1).toEqual(expect.objectContaining({ status: 'UNKNOWN', lifecycle: 'FAILING' }))
  })

  it('keeps a healthy cycle after recovery reported as steady rather than a repeated recovery', async () => {
    let call = 0
    const provider = createLiveProvider({
      config: liveConfig,
      clock: () => NOW,
      fetchImpl: async (url) => {
        if (url !== liveConfig.adapters.idea1Url) return jsonResponse(feed([]))
        call += 1
        if (call === 1) throw new Error('offline')
        return jsonResponse(feed([rawEvent('IDEA1')]))
      },
    })

    await provider.getSnapshot()
    expect((await provider.getSnapshot()).integration.idea1.lifecycle).toBe('RECOVERED')
    expect((await provider.getSnapshot()).integration.idea1.lifecycle).toBe('STEADY')
  })

  it('produces the same ordered result for out-of-order upstream evidence', async () => {
    const ordered = providerWith({
      idea1: () => jsonResponse(feed([
        rawEvent('IDEA1', { event_id: 'a', occurred_at: '2026-09-08T07:59:50.000Z' }),
        rawEvent('IDEA1', { event_id: 'b', occurred_at: '2026-09-08T07:59:55.000Z' }),
      ])),
      idea2: () => jsonResponse(feed([])),
    })
    const shuffled = providerWith({
      idea1: () => jsonResponse(feed([
        rawEvent('IDEA1', { event_id: 'b', occurred_at: '2026-09-08T07:59:55.000Z' }),
        rawEvent('IDEA1', { event_id: 'a', occurred_at: '2026-09-08T07:59:50.000Z' }),
      ])),
      idea2: () => jsonResponse(feed([])),
    })

    const [first, second] = await Promise.all([ordered.provider.getSnapshot(), shuffled.provider.getSnapshot()])

    expect(second.integration.events).toEqual(first.integration.events)
    expect(first.integration.events.map((event) => event.event_id)).toEqual(['a', 'b'])
  })

  it('surfaces rejected and conflicting upstream evidence as counts without raw payloads', async () => {
    const { provider } = providerWith({
      idea1: () => jsonResponse(feed([
        rawEvent('IDEA1', { event_type: 'CAMERA_TAMPER' }),
        rawEvent('IDEA1', { event_id: 'dupe' }),
        rawEvent('IDEA1', { event_id: 'dupe', resource: 'Another resource' }),
      ])),
      idea2: () => jsonResponse(feed([])),
    })

    const snapshot = await provider.getSnapshot()

    expect(snapshot.integration.idea1.rejectedCount).toBe(1)
    expect(snapshot.integration.conflicts).toEqual([{ code: 'EVENT_ID_CONFLICT', source: 'IDEA1', event_id: 'dupe' }])
    expect(snapshot.integration.events).toEqual([])
    expect(JSON.stringify(snapshot.integration)).not.toMatch(/CAMERA_TAMPER|Another resource/)
  })

  it('declares durable SQLite audit provenance while the event snapshot store stays runtime-owned', async () => {
    const { provider } = providerWith({ idea1: () => jsonResponse(feed([])), idea2: () => jsonResponse(feed([])) })

    const snapshot = await provider.getSnapshot()

    expect(sourceById(snapshot, 'audit')).toEqual(expect.objectContaining({ status: 'HEALTHY', detail: 'Durable SQLite audit store' }))
    expect(sourceById(snapshot, 'events')).toEqual(expect.objectContaining({ status: 'DEGRADED', detail: 'Runtime-owned snapshot; not persisted' }))
    expect(snapshot.provenance).toEqual({
      provider: 'live-read-only-adapters',
      liveMerged: false,
      persistence: 'SQLITE_AUDIT_ONLY',
      eventPersistence: 'RUNTIME_ONLY',
    })
  })

  it('sends the dedicated per-source credential and never returns it in the snapshot', async () => {
    const { provider, fetchImpl } = providerWith({ idea1: () => jsonResponse(feed([])), idea2: () => jsonResponse(feed([])) })

    const snapshot = await provider.getSnapshot()
    const idea1Call = fetchImpl.mock.calls.find(([url]) => url === liveConfig.adapters.idea1Url)

    expect(idea1Call[1].headers.authorization).toBe('Bearer idea1-integration-credential')
    expect(JSON.stringify(snapshot)).not.toContain('idea1-integration-credential')
    expect(JSON.stringify(snapshot)).not.toContain('idea2-integration-credential')
  })
})
