import { describe, expect, it } from 'vitest'
import { normalizeRuntimeStatus } from '../../server/domain/normalize.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import {
  labFixedNow,
  TEST_ONLY_labAbsentRaw,
  TEST_ONLY_labClaimedPhysicalExtras,
  TEST_ONLY_labLockdownRaw,
  TEST_ONLY_labRunningUplinkLockdownRaw,
} from '../fixtures/labCoreProjection.js'

const MAX_AGE = 120_000
const normalize = (raw) => normalizeRuntimeStatus(raw, { now: labFixedNow, maxAgeMs: MAX_AGE })
const componentStatus = (normalized, id) => normalized.components.find((component) => component.id === id)?.status
const at = (offsetMs) => new Date(labFixedNow.getTime() + offsetMs).toISOString()

describe('LAB read-only evidence contract (TEST_ONLY synthetic Core projections)', () => {
  it('never presents LOCKDOWN uplink as normal operation', () => {
    for (const raw of [TEST_ONLY_labLockdownRaw, TEST_ONLY_labRunningUplinkLockdownRaw]) {
      const normalized = normalize(raw)
      expect(componentStatus(normalized, 'uplink')).toBe('DEGRADED')
      expect(componentStatus(normalized, 'uplink')).not.toBe('HEALTHY')
    }
    expect(normalize(TEST_ONLY_labLockdownRaw).status).toBe('DEGRADED')
  })

  // Issue #440: a fresh Core projection that says HEALTHY while the uplink is LOCKDOWN is self-contradictory (the real Core
  // projects LOCKDOWN as DEGRADED). The Web fails safe: overall DEGRADED, component evidence stays independent.
  it('does not present overall runtime HEALTHY while uplink is LOCKDOWN (HEALTHY + LOCKDOWN contradiction)', () => {
    const normalized = normalize(TEST_ONLY_labRunningUplinkLockdownRaw)
    expect(normalized.status).toBe('DEGRADED')
    expect(componentStatus(normalized, 'uplink')).toBe('DEGRADED')
    expect(componentStatus(normalized, 'broker')).toBe('HEALTHY')
    expect(componentStatus(normalized, 'esp32')).toBe('HEALTHY')
    expect(['relay', 'heartbeat', 'ack'].map((id) => componentStatus(normalized, id))).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
  })

  it('keeps a consistent HEALTHY + NORMAL projection HEALTHY and never promotes other statuses', () => {
    const normal = { ...TEST_ONLY_labRunningUplinkLockdownRaw, components: { ...TEST_ONLY_labRunningUplinkLockdownRaw.components, uplink: 'NORMAL' } }
    expect(normalize(normal).status).toBe('HEALTHY')
    expect(componentStatus(normalize(normal), 'uplink')).toBe('HEALTHY')
    for (const status of ['DEGRADED', 'FAILED', 'UNKNOWN']) {
      expect(normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, status }).status).toBe(status)
    }
  })

  it('keeps stale, future-dated and hostile HEALTHY + LOCKDOWN documents fail-closed', () => {
    expect(normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, generatedAt: at(-MAX_AGE - 1000) }).status).toBe('UNKNOWN')
    expect(normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, generatedAt: at(600_000) }).status).toBe('UNKNOWN')
    expect(normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, status: 'healthy' }).status).toBe('UNKNOWN')
    expect(normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, components: { ...TEST_ONLY_labRunningUplinkLockdownRaw.components, uplink: '__proto__' } }).status).toBe('HEALTHY')
  })

  it('keeps the LAB profile and dry-run honest and never marks recovery authorized', () => {
    const normalized = normalize(TEST_ONLY_labLockdownRaw)
    expect(normalized.modes).toEqual(expect.objectContaining({ monitorOnly: true, dryRun: true, armed: false, recoveryAuthorized: false }))
    expect(normalized.evidenceSource).toBe('RUNTIME_STATUS_FILE')
  })

  it.each([
    ['absent projection', TEST_ONLY_labAbsentRaw],
    ['null document', null],
    ['non-object document', 'HEALTHY'],
    ['missing components', { ...TEST_ONLY_labLockdownRaw, components: undefined }],
    ['array components', { ...TEST_ONLY_labLockdownRaw, components: [] }],
    ['wrong schemaVersion', { ...TEST_ONLY_labLockdownRaw, schemaVersion: 2 }],
    ['non-string generatedAt', { ...TEST_ONLY_labLockdownRaw, generatedAt: 1760695190 }],
    ['unparseable generatedAt', { ...TEST_ONLY_labLockdownRaw, generatedAt: 'yesterday' }],
    ['non-canonical status', { ...TEST_ONLY_labLockdownRaw, status: 'OK' }],
  ])('fails closed on %s', (_name, raw) => {
    const normalized = normalize(raw)
    expect(normalized.status).toBe('UNKNOWN')
    expect(normalized.components.every((component) => component.status === 'UNKNOWN')).toBe(true)
    expect(normalized.coreEvidence.device).toBeNull()
  })

  it('treats UNKNOWN Core vocabulary as UNKNOWN, never HEALTHY', () => {
    const normalized = normalize({
      ...TEST_ONLY_labLockdownRaw,
      status: 'UNKNOWN',
      components: { broker: 'UNKNOWN', device: 'UNKNOWN', uplink: 'UNKNOWN' },
    })
    expect(normalized.status).toBe('UNKNOWN')
    expect(['broker', 'esp32', 'uplink'].map((id) => componentStatus(normalized, id))).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
  })

  describe('120-second freshness window', () => {
    it.each([
      [5_000, 'FRESH'],
      [5_001, 'FUTURE'],
      [0, 'FRESH'],
      [-MAX_AGE, 'FRESH'],
      [-(MAX_AGE + 1), 'STALE'],
    ])('generatedAt offset %i ms from now is %s', (offset, freshness) => {
      const normalized = normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, generatedAt: at(offset) })
      expect(normalized.freshness).toBe(freshness)
      if (freshness === 'FRESH') {
        expect(normalized.evidenceAgeMs).toBe(0 - offset)
        expect(componentStatus(normalized, 'broker')).toBe('HEALTHY')
      } else {
        expect(normalized.status).toBe('UNKNOWN')
        expect(normalized.components.every((component) => component.status === 'UNKNOWN')).toBe(true)
      }
    })

    it('reports the producer timestamp unchanged, not the time the Web received it', () => {
      expect(normalize(TEST_ONLY_labLockdownRaw).generatedAt).toBe(TEST_ONLY_labLockdownRaw.generatedAt)
    })
  })

  describe('physical relay state is never inferred', () => {
    it('ignores requested relay state, ACK and heartbeat claims outside the documented components', () => {
      const normalized = normalize({ ...TEST_ONLY_labRunningUplinkLockdownRaw, ...TEST_ONLY_labClaimedPhysicalExtras })
      expect(['relay', 'heartbeat', 'ack'].map((id) => componentStatus(normalized, id))).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
      expect(JSON.stringify(normalized)).not.toMatch(/ACK_OK|ALIVE|"CUT"/)
    })

    it('does not turn connected broker and online device into relay, heartbeat or ACK evidence', () => {
      const normalized = normalize(TEST_ONLY_labRunningUplinkLockdownRaw)
      expect(componentStatus(normalized, 'broker')).toBe('HEALTHY')
      expect(componentStatus(normalized, 'esp32')).toBe('HEALTHY')
      expect(['relay', 'heartbeat', 'ack'].map((id) => componentStatus(normalized, id))).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
    })

    it('does not accept non-canonical relay, heartbeat or ACK values placed in components', () => {
      const normalized = normalize({
        ...TEST_ONLY_labRunningUplinkLockdownRaw,
        components: { ...TEST_ONLY_labRunningUplinkLockdownRaw.components, relay: 'CUT', heartbeat: 'ALIVE', ack: 'ACK_OK' },
      })
      expect(['relay', 'heartbeat', 'ack'].map((id) => componentStatus(normalized, id))).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
    })

    it('keeps relay and ACK UNKNOWN in the full snapshot even with a requested state present', async () => {
      const config = Object.freeze({
        adapters: Object.freeze({ idea1Url: null, idea2Url: null, runtimeUrl: 'http://127.0.0.1:9/status' }),
        adapterTimeoutMs: 5,
        maxEvidenceAgeMs: MAX_AGE,
      })
      const provider = createLiveProvider({
        config,
        clock: () => labFixedNow,
        fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ...TEST_ONLY_labRunningUplinkLockdownRaw, ...TEST_ONLY_labClaimedPhysicalExtras }) }),
      })
      const snapshot = await provider.getSnapshot()
      const byId = Object.fromEntries(snapshot.runtime.components.map((component) => [component.id, component.status]))
      expect([byId.relay, byId.heartbeat, byId.ack]).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
      expect(snapshot.devices).toEqual([])
      expect(snapshot.mode).toBe('LIVE')
    })
  })
})
