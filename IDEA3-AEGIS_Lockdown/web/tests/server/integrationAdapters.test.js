import { describe, expect, it, vi } from 'vitest'
import { fetchJsonDocument } from '../../server/providers/httpJsonClient.js'
import { fetchIdea1Events } from '../../server/providers/idea1Adapter.js'
import { fetchIdea2Events } from '../../server/providers/idea2Adapter.js'

const IDEA1_TOKEN = 'idea1-integration-credential-value'
const IDEA2_TOKEN = 'idea2-integration-credential-value'
const clock = () => new Date('2026-09-08T08:00:00.000Z')

const adapterConfig = Object.freeze({
  adapterTimeoutMs: 2_500,
  maxEvidenceAgeMs: 120_000,
  adapters: Object.freeze({
    idea1Url: 'https://idea1.internal/api/integration/events',
    idea2Url: 'https://idea2.internal/api/integration/events',
    idea1Token: IDEA1_TOKEN,
    idea2Token: IDEA2_TOKEN,
  }),
})

function config(overrides = {}) {
  return { ...adapterConfig, ...overrides, adapters: { ...adapterConfig.adapters, ...overrides.adapters } }
}

function jsonResponse(body, { ok = true, redirected = false } = {}) {
  return { ok, redirected, status: ok ? 200 : 500, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
}

function envelope(events, generatedAt = '2026-09-08T08:00:00.000Z') {
  return { schema_version: 1, generated_at: generatedAt, events }
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

describe('shared read-only HTTP boundary', () => {
  it('issues a GET request with a JSON Accept header, the dedicated credential, no redirects, and no cookies', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])))

    await fetchJsonDocument(adapterConfig.adapters.idea1Url, { fetchImpl, timeoutMs: 2_500, token: IDEA1_TOKEN })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(adapterConfig.adapters.idea1Url)
    expect(options).toEqual(expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    }))
    expect(options.headers).toEqual({ accept: 'application/json', authorization: `Bearer ${IDEA1_TOKEN}` })
    expect(Object.keys(options.headers)).not.toContain('cookie')
  })

  it('omits the Authorization header entirely when no credential is configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])))

    await fetchJsonDocument(adapterConfig.adapters.idea1Url, { fetchImpl, timeoutMs: 2_500, token: null })

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ accept: 'application/json' })
  })

  it.each([
    ['a redirected response', async () => jsonResponse(envelope([]), { redirected: true }), 'ADAPTER_RESPONSE_REJECTED'],
    ['a redirect rejected by fetch', async () => { throw new TypeError('unexpected redirect') }, 'ADAPTER_UNAVAILABLE'],
    ['a non-2xx response', async () => jsonResponse(envelope([]), { ok: false }), 'ADAPTER_RESPONSE_REJECTED'],
    ['an aborted request', async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 'ADAPTER_TIMEOUT'],
    ['a body over 256 KiB', async () => jsonResponse('x'.repeat(256 * 1024 + 1)), 'ADAPTER_RESPONSE_REJECTED'],
    ['a body that is not JSON', async () => jsonResponse('not-json'), 'MALFORMED_RESPONSE'],
  ])('fails closed on %s', async (_case, fetchImpl, code) => {
    const result = await fetchJsonDocument(adapterConfig.adapters.idea1Url, { fetchImpl, timeoutMs: 2_500, token: IDEA1_TOKEN })

    expect(result).toEqual({ ok: false, code, data: null })
  })

  it.each([null, '', 'ftp://idea1.internal/events', 'file:///etc/passwd', 'not-a-url'])('rejects the unusable URL %j without calling fetch', async (url) => {
    const fetchImpl = vi.fn()

    const result = await fetchJsonDocument(url, { fetchImpl, timeoutMs: 2_500, token: IDEA1_TOKEN })

    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never returns the credential value in a success or failure result', async () => {
    const success = await fetchJsonDocument(adapterConfig.adapters.idea1Url, {
      fetchImpl: async () => jsonResponse(envelope([])), timeoutMs: 2_500, token: IDEA1_TOKEN,
    })
    const failure = await fetchJsonDocument(adapterConfig.adapters.idea1Url, {
      fetchImpl: async () => { throw new Error(`connect failed using ${IDEA1_TOKEN}`) }, timeoutMs: 2_500, token: IDEA1_TOKEN,
    })

    expect(JSON.stringify(success)).not.toContain(IDEA1_TOKEN)
    expect(JSON.stringify(failure)).not.toContain(IDEA1_TOKEN)
  })
})

describe('read-only IDEA1 and IDEA2 adapters', () => {
  it('normalizes a valid IDEA1 feed and reports honest envelope lifecycle metadata', async () => {
    const result = await fetchIdea1Events({
      config: adapterConfig, clock, fetchImpl: async () => jsonResponse(envelope([rawEvent('IDEA1')])),
    })

    expect(result).toEqual({
      source: 'IDEA1',
      status: 'HEALTHY',
      code: null,
      generatedAt: '2026-09-08T08:00:00.000Z',
      envelopeFreshness: 'FRESH',
      events: [expect.objectContaining({ source: 'IDEA1', event_id: 'idea1-event-1', freshness: 'FRESH', dedup_count: 1 })],
      rejectedCount: 0,
      conflicts: [],
    })
  })

  it('keeps each source credential and URL separate', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope([])))

    await fetchIdea1Events({ config: adapterConfig, clock, fetchImpl })
    await fetchIdea2Events({ config: adapterConfig, clock, fetchImpl })

    expect(fetchImpl.mock.calls[0][0]).toBe(adapterConfig.adapters.idea1Url)
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer ${IDEA1_TOKEN}`)
    expect(fetchImpl.mock.calls[1][0]).toBe(adapterConfig.adapters.idea2Url)
    expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe(`Bearer ${IDEA2_TOKEN}`)
  })

  it.each([
    ['idea1Url', fetchIdea1Events],
    ['idea2Url', fetchIdea2Events],
  ])('reports NOT_CONFIGURED and no events when %s is absent', async (key, fetchEvents) => {
    const fetchImpl = vi.fn()

    const result = await fetchEvents({ config: config({ adapters: { [key]: null } }), clock, fetchImpl })

    expect(result).toEqual(expect.objectContaining({ status: 'NOT_CONFIGURED', code: 'NOT_CONFIGURED', events: [], generatedAt: null }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['an unsupported schema version', { schema_version: 2, generated_at: '2026-09-08T08:00:00.000Z', events: [] }],
    ['a missing envelope timestamp', { schema_version: 1, events: [] }],
    ['a non-array events field', { schema_version: 1, generated_at: '2026-09-08T08:00:00.000Z', events: {} }],
    ['more events than the bounded maximum', { schema_version: 1, generated_at: '2026-09-08T08:00:00.000Z', events: new Array(501).fill(rawEvent('IDEA1')) }],
  ])('rejects the whole envelope with %s', async (_case, body) => {
    const result = await fetchIdea1Events({ config: adapterConfig, clock, fetchImpl: async () => jsonResponse(body) })

    expect(result).toEqual(expect.objectContaining({ status: 'UNKNOWN', code: 'ADAPTER_RESPONSE_REJECTED', events: [] }))
  })

  it('rejects events whose declared source does not belong to the adapter', async () => {
    const result = await fetchIdea1Events({
      config: adapterConfig, clock, fetchImpl: async () => jsonResponse(envelope([rawEvent('IDEA2'), rawEvent('IDEA1')])),
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].source).toBe('IDEA1')
    expect(result.rejectedCount).toBe(1)
  })

  it('strips biometric, media, credential, and free-text subject fields from IDEA2 evidence', async () => {
    const result = await fetchIdea2Events({
      config: adapterConfig,
      clock,
      fetchImpl: async () => jsonResponse(envelope([rawEvent('IDEA2', {
        subject: 'Alice Example',
        evidence: {
          result: 'DENIED',
          person_name: 'Alice Example',
          embedding: [0.12, 0.98],
          snapshot_path: '/var/aegis/snapshots/cam-02.jpg',
          token: 'must-not-leak',
        },
      })])),
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].subject).toBeNull()
    expect(result.events[0].evidence).toEqual({ result: 'DENIED' })
    expect(JSON.stringify(result)).not.toMatch(/Alice Example|embedding|snapshot_path|must-not-leak|person_name/i)
  })

  it('deduplicates repeated IDs and fails closed on conflicting canonical content', async () => {
    const duplicate = await fetchIdea1Events({
      config: adapterConfig, clock, fetchImpl: async () => jsonResponse(envelope([rawEvent('IDEA1'), rawEvent('IDEA1')])),
    })
    const conflicting = await fetchIdea1Events({
      config: adapterConfig,
      clock,
      fetchImpl: async () => jsonResponse(envelope([rawEvent('IDEA1'), rawEvent('IDEA1', { resource: 'Another resource' })])),
    })

    expect(duplicate.events).toEqual([expect.objectContaining({ dedup_count: 2 })])
    expect(conflicting.events).toEqual([])
    expect(conflicting.conflicts).toEqual([{ code: 'EVENT_ID_CONFLICT', source: 'IDEA1', event_id: 'idea1-event-1' }])
  })

  it('reports a stale envelope honestly instead of calling a successful fetch fresh', async () => {
    const result = await fetchIdea1Events({
      config: adapterConfig, clock, fetchImpl: async () => jsonResponse(envelope([], '2026-09-08T07:50:00.000Z')),
    })

    expect(result).toEqual(expect.objectContaining({ status: 'HEALTHY', envelopeFreshness: 'STALE' }))
  })

  it.each([
    ['a timeout', async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 'ADAPTER_TIMEOUT'],
    ['an unavailable upstream', async () => { throw new Error('ECONNREFUSED') }, 'ADAPTER_UNAVAILABLE'],
    ['a malformed body', async () => jsonResponse('not-json'), 'MALFORMED_RESPONSE'],
  ])('maps %s to an UNKNOWN source state with no events', async (_case, fetchImpl, code) => {
    const result = await fetchIdea2Events({ config: adapterConfig, clock, fetchImpl })

    expect(result).toEqual(expect.objectContaining({ source: 'IDEA2', status: 'UNKNOWN', code, events: [], generatedAt: null }))
  })
})
