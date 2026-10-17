import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeRuntimeStatus } from '../../server/domain/normalize.js'

// TEST_ONLY matrix recorded by tests/test_live_status_consistency.py from synthetic Core documents. It compares what the Web
// adapter shows with what the Python Desktop reader accepted for the same document. It is not cross-host Production evidence.
const matrix = JSON.parse(readFileSync(path.resolve(process.cwd(), 'tests', 'fixtures', 'status-consistency-matrix.json'), 'utf8'))
const NOW = new Date(matrix.now * 1000)
const SEVERITY = { HEALTHY: 0, DEGRADED: 1, FAILED: 2, UNKNOWN: 2 }
const MAPPED = {
  broker: { CONNECTED: 'HEALTHY', DISCONNECTED: 'FAILED', UNKNOWN: 'UNKNOWN' },
  esp32: { ONLINE: 'HEALTHY', OFFLINE: 'FAILED', UNKNOWN: 'UNKNOWN' },
  uplink: { NORMAL: 'HEALTHY', LOCKDOWN: 'DEGRADED', UNKNOWN: 'UNKNOWN' },
}

function webView(input) {
  const runtime = normalizeRuntimeStatus(input, { now: NOW })
  const byId = Object.fromEntries(runtime.components.map((component) => [component.id, component.status]))
  return { runtime, byId }
}

describe('Web and Desktop interpret the same synthetic Core status consistently', () => {
  const entries = Object.entries(matrix.scenarios)

  it('records every required scenario', () => {
    expect(entries.length).toBeGreaterThanOrEqual(17)
  })

  it.each(entries)('%s: the Web is never healthier than the Desktop', (name, row) => {
    const { runtime, byId } = webView(row.web_input)
    if (!row.desktop.usable) {
      // Desktop shows UNKNOWN for everything; the Web must not claim HEALTHY for any part of it.
      expect(runtime.status, name).not.toBe('HEALTHY')
      for (const id of ['relay', 'heartbeat', 'ack']) expect(byId[id]).toBe('UNKNOWN')
    }
    // Neither side promotes physical evidence.
    for (const id of ['relay', 'heartbeat', 'ack']) expect(byId[id], `${name}:${id}`).toBe('UNKNOWN')
    // A stale or future projection is never HEALTHY on the Web.
    if (['STALE', 'FUTURE', 'MALFORMED'].includes(runtime.freshness)) expect(runtime.status).toBe('UNKNOWN')
    expect(SEVERITY[runtime.status]).toBeGreaterThanOrEqual(row.desktop.usable ? 0 : 1)
  })

  it.each(entries.filter(([name, row]) => row.desktop.usable && !matrix.divergences.includes(name)))(
    '%s: usable evidence maps to the same component meaning on both sides',
    (name, row) => {
      const { runtime, byId } = webView(row.web_input)
      expect(runtime.freshness, name).toBe('FRESH')
      expect(byId.broker).toBe(MAPPED.broker[row.desktop.broker])
      expect(byId.esp32).toBe(MAPPED.esp32[row.desktop.device])
      expect(byId.uplink).toBe(MAPPED.uplink[row.desktop.uplink])
    },
  )

  it.each(entries.filter(([name, row]) => !row.desktop.usable && !matrix.divergences.includes(name)))(
    '%s: unusable evidence is UNKNOWN on both sides',
    (name, row) => {
      const { runtime, byId } = webView(row.web_input)
      expect(runtime.status, name).toBe('UNKNOWN')
      for (const id of ['runtime', 'broker', 'esp32', 'uplink']) expect(byId[id]).toBe('UNKNOWN')
      expect(row.desktop).toMatchObject({ runtime_state: 'UNKNOWN', broker: 'UNKNOWN', device: 'UNKNOWN', uplink: 'UNKNOWN' })
    },
  )

  it('overall status semantics for the key operating states', () => {
    const status = (name) => webView(matrix.scenarios[name].web_input).runtime.status
    expect(status('S01_fresh_running_healthy_uplink_normal')).toBe('HEALTHY')
    expect(status('S02_lockdown_state_uplink_lockdown')).toBe('DEGRADED')
    expect(status('S03_running_with_uplink_lockdown')).toBe('DEGRADED')
    expect(status('S04_broker_disconnected')).toBe('DEGRADED')
    expect(status('S06_device_offline')).toBe('DEGRADED')
    expect(status('S05_ap_unavailable_waiting_for_broker')).toBe('UNKNOWN')
    expect(status('S11_expired_timestamp')).toBe('UNKNOWN')
    expect(status('S12_future_timestamp')).toBe('UNKNOWN')
  })

  it('the only overall-status divergence is the documented contradictory-document case, and it is never HEALTHY', () => {
    const lenient = entries
      .filter(([, row]) => !row.desktop.usable && webView(row.web_input).runtime.status !== 'UNKNOWN')
      .map(([name, row]) => [name, webView(row.web_input).runtime.status])
    expect(lenient).toEqual([['S13_contradictory_lockdown_with_normal_uplink', 'DEGRADED']])
    for (const [name] of lenient) expect(matrix.divergences).toContain(name)
  })
})
