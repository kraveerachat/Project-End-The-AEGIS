import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { DashboardPage } from '../../src/pages/DashboardPage.jsx'
import { DevicesPage } from '../../src/pages/DevicesPage.jsx'
import { Idea1SecurityPage } from '../../src/pages/Idea1SecurityPage.jsx'
import { Idea2DetectionPage } from '../../src/pages/Idea2DetectionPage.jsx'
import { OverviewPage } from '../../src/pages/OverviewPage.jsx'
import { LockdownPage } from '../../src/pages/LockdownPage.jsx'
import { RecoveryPage } from '../../src/pages/RecoveryPage.jsx'
import { responseChain } from '../../src/lib/chain.js'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

// Shape of the current Live adapter output: placeholder zero summaries, no rows, no devices.
function liveLike(base) {
  return {
    ...base,
    mode: 'LIVE',
    overall: { status: 'UNKNOWN', evidenceAgeMs: null, eventCount: 0, activeIncidents: 0, highAlerts: 0 },
    events: [],
    idea1: { status: 'UNKNOWN', freshness: 'ABSENT', generatedAt: base.generatedAt, summary: { denied: 0, blocked: 0, uniqueSourceIps: 0, repeated: 0, escalated: 0 }, events: [] },
    idea2: { status: 'UNKNOWN', freshness: 'ABSENT', generatedAt: base.generatedAt, summary: { detections: 0, high: 0, critical: 0, cameras: 0 }, events: [] },
    incidents: [],
    devices: [],
    runtime: { ...base.runtime, timeline: [], readiness: [], issues: [] },
    recovery: { gatewayStatus: 'DISABLED', liveHardware: false, authorization: 'DISABLED', incidentState: 'NONE', preconditions: [], runbook: [], history: [] },
  }
}

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('response chain', () => {
  const boundary = (overrides = {}) => ({ command_requested: true, command_published: false, acknowledged: false, executed: false, physical_evidence: false, ...overrides })
  const byId = (chain) => Object.fromEntries(chain.map((stage) => [stage.id, stage]))

  it('keeps six distinct stages and never lets an ACK imply execution or physical proof', () => {
    const chain = byId(responseChain({ dispatch: { state: 'CORE_CLAIMED', boundary: boundary({ command_published: true, acknowledged: true }) } }))
    expect(Object.keys(chain)).toEqual(['requested', 'accepted', 'dispatch', 'ack', 'execution', 'physical'])
    expect(chain.ack.observed).toBe(true)
    expect(chain.execution.observed).toBe(false)
    expect(chain.physical.observed).toBe(false)
    expect(chain.physical.status).toBe('NOT_VERIFIED')
  })

  it('treats a pending dispatch as pending rather than claimed or published', () => {
    const chain = byId(responseChain({ dispatch: { state: 'PENDING_DISPATCH', boundary: boundary() } }))
    expect(chain.dispatch.observed).toBe(false)
    expect(chain.dispatch.key).toBe('PENDING_DISPATCH')
    expect(chain.ack.observed).toBe(false)
  })

  it('reads the demo evidence stages without inventing a dispatch record', () => {
    const chain = byId(responseChain(snapshot.incidents[0]))
    expect(chain.requested.observed).toBe(true)
    expect(chain.ack.observed).toBe(true)
    expect(chain.dispatch.observed).toBe(false)
    expect(chain.execution.observed).toBe(false)
    expect(chain.physical.observed).toBe(false)
  })

  it('reports every stage as not observed when there is no incident', () => {
    expect(responseChain(undefined).every((stage) => !stage.observed)).toBe(true)
  })
})

describe('IDEA1 page truthfulness', () => {
  it('does not present placeholder Live zeros as proof of safety', () => {
    const { container } = render(<Idea1SecurityPage snapshot={liveLike(snapshot)} />)
    const cards = container.querySelectorAll('.metric-card')
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.querySelector('.metric-card__value strong').textContent).toBe('—')
      expect(card.querySelector('[data-status="HEALTHY"]')).toBeNull()
    }
    expect(screen.getByText(/ไม่ได้พิสูจน์ว่าปลอดภัย/)).toBeVisible()
  })

  it('renders when the IDEA1 domain is missing after an adapter failure', () => {
    const { idea1, ...rest } = snapshot
    render(<Idea1SecurityPage snapshot={rest} />)
    expect(screen.getByLabelText('สถานะ UNKNOWN', { selector: '.source-bar *' })).toBeVisible()
  })

  it('shows a missing source IP as not provided instead of an empty cell', () => {
    const event = { ...snapshot.idea1.events[0], sourceIp: undefined }
    render(<Idea1SecurityPage snapshot={{ ...snapshot, idea1: { ...snapshot.idea1, events: [event] } }} />)
    expect(screen.getByText('ไม่ระบุ')).toBeVisible()
  })

  it('shows evidence age and the derived-severity note for a healthy demo source', () => {
    render(<Idea1SecurityPage snapshot={snapshot} />)
    expect(screen.getByText(/อายุหลักฐาน/)).toBeVisible()
    expect(screen.getByText(/Security Center คำนวณ severity/)).toBeVisible()
  })
})

describe('IDEA2 page truthfulness', () => {
  it('does not present placeholder Live zeros as proof of safety', () => {
    const { container } = render(<Idea2DetectionPage snapshot={liveLike(snapshot)} />)
    for (const card of container.querySelectorAll('.metric-card')) {
      expect(card.querySelector('.metric-card__value strong').textContent).toBe('—')
      expect(card.querySelector('[data-status="HEALTHY"]')).toBeNull()
    }
    expect(screen.getByText(/ไม่ได้พิสูจน์ว่าปลอดภัย/)).toBeVisible()
  })

  it('survives an event with no severity and a missing domain', () => {
    const event = { ...snapshot.idea2.events[0], severity: undefined }
    render(<Idea2DetectionPage snapshot={{ ...snapshot, idea2: { ...snapshot.idea2, events: [event] } }} />)
    expect(screen.getByText('PERSON_DETECTED')).toBeVisible()
    const { idea2, ...rest } = snapshot
    render(<Idea2DetectionPage snapshot={rest} />)
  })

  it('keeps correlation a candidate relationship and states the privacy boundary', () => {
    render(<Idea2DetectionPage snapshot={snapshot} />)
    expect(screen.getByText('Correlation candidate')).toBeVisible()
    expect(screen.getByText(/ไม่ระบุตัวบุคคลหรือสรุปเจตนา/)).toBeVisible()
  })
})

describe('Lockdown response chain', () => {
  it('renders the six stages in order and marks physical verification as not verified', () => {
    render(<LockdownPage snapshot={snapshot} />)
    const chain = screen.getByRole('region', { name: 'ลำดับหลักฐานการตอบสนอง' })
    const items = within(chain).getAllByRole('listitem')
    expect(items).toHaveLength(6)
    expect(items[3]).toHaveTextContent('ACK')
    expect(items[5]).toHaveTextContent('ยังไม่ได้ยืนยัน')
    expect(within(chain).getByText(/ACK ไม่ใช่หลักฐานว่า Relay เปลี่ยนสถานะ/)).toBeVisible()
  })

  it('renders when Live runtime has no timeline, readiness, issues, or incidents', () => {
    render(<LockdownPage snapshot={liveLike(snapshot)} />)
    expect(screen.getByText('ไม่มี incident ให้ติดตามลำดับหลักฐาน')).toBeVisible()
    expect(screen.getByRole('button', { name: 'ตัดการเชื่อมต่อเครือข่าย' })).toBeDisabled()
  })

  it('renders when the runtime domain is missing', () => {
    const { runtime, ...rest } = snapshot
    render(<LockdownPage snapshot={rest} />)
    expect(screen.getByRole('button', { name: 'ตัดการเชื่อมต่อเครือข่าย' })).toBeDisabled()
  })
})

describe('Devices evidence separation', () => {
  it('does not derive topology health from the mere existence of a device', () => {
    render(<DevicesPage snapshot={snapshot} />)
    const topology = screen.getByRole('list', { name: 'Observed topology' })
    const broker = within(topology).getByText('MQTT Broker').closest('li')
    expect(within(broker).getByText('HEALTHY')).toBeVisible()
    const unknownBroker = { ...snapshot, runtime: { ...snapshot.runtime, components: snapshot.runtime.components.map((c) => (c.id === 'broker' ? { ...c, status: 'UNKNOWN' } : c)) } }
    render(<DevicesPage snapshot={unknownBroker} />)
    const second = screen.getAllByRole('list', { name: 'Observed topology' })[1]
    expect(within(within(second).getByText('MQTT Broker').closest('li')).queryByText('HEALTHY')).toBeNull()
  })

  it('shows the requested state without a health badge next to physical evidence', () => {
    render(<DevicesPage snapshot={snapshot} />)
    const requested = screen.getByText('คำขอ: OPEN').closest('article')
    expect(requested.querySelector('[data-status="HEALTHY"]')).toBeNull()
    expect(screen.getByText(/ไม่ได้พิสูจน์ว่า Relay เปลี่ยนสถานะจริง/)).toBeVisible()
  })

  it('renders an honest empty state when no device evidence exists', () => {
    const { container } = render(<DevicesPage snapshot={liveLike(snapshot)} />)
    expect(screen.getByText('ยังไม่มีหลักฐานอุปกรณ์')).toBeVisible()
    const cards = container.querySelectorAll('.metric-card')
    for (const card of cards) expect(card.querySelector('[data-status="HEALTHY"]')).toBeNull()
  })

  it('keeps heartbeat, ACK, and relay evidence as separate columns with evidence age', () => {
    render(<DevicesPage snapshot={snapshot} />)
    const table = screen.getByRole('region', { name: 'ตารางหลักฐานอุปกรณ์' })
    for (const name of ['Heartbeat', 'ACK', 'Relay evidence', 'อายุหลักฐาน']) {
      expect(within(table).getByRole('columnheader', { name })).toBeVisible()
    }
  })
})

describe('Recovery honesty', () => {
  it('does not mark future runbook steps as completed', () => {
    const { container } = render(<RecoveryPage snapshot={snapshot} />)
    const runbook = container.querySelector('.runbook')
    expect(runbook.querySelector('[data-status="HEALTHY"]')).toBeNull()
    expect(runbook.querySelectorAll('li')).toHaveLength(snapshot.recovery.runbook.length)
  })

  it('separates dry-run validation from real recovery execution', () => {
    render(<RecoveryPage snapshot={snapshot} />)
    expect(screen.getByText('Dry-run validation')).toBeVisible()
    expect(screen.getByText('Real recovery execution')).toBeVisible()
    expect(screen.getByText(/ยังไม่เปิดใช้งาน/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /restore|กู้คืน/i })).not.toBeInTheDocument()
  })

  it('shows an unavailable read-only state when Live recovery arrays are empty', () => {
    render(<RecoveryPage snapshot={liveLike(snapshot)} />)
    expect(screen.getByText('ยังไม่มีข้อมูล precondition จาก Live')).toBeVisible()
    expect(screen.getByText('ยังไม่มี runbook จาก Live')).toBeVisible()
    expect(screen.getAllByText('DISABLED').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'ตรวจสอบความพร้อมแบบ Dry-run' })).toBeDisabled()
  })
})

describe('Dashboard truthfulness', () => {
  it('shows Core runtime and containment state as separate global facts', () => {
    render(<DashboardPage snapshot={snapshot} />)
    const region = screen.getByRole('region', { name: 'สถานะระบบส่วนกลาง' })
    expect(within(region).getByText('สถานะ Core/runtime')).toBeVisible()
    expect(within(region).getByText('สถานะการตอบสนอง/การกักกัน')).toBeVisible()
    expect(within(region).getByText(/ACK หรือคำขอไม่ใช่หลักฐานว่ากักกันสำเร็จ/)).toBeVisible()
  })

  it('does not render placeholder Live zeros as counts or HEALTHY badges', () => {
    const { container } = render(<DashboardPage snapshot={liveLike(snapshot)} />)
    const summary = container.querySelector('.metric-grid')
    for (const card of summary.querySelectorAll('.metric-card')) {
      expect(card.querySelector('[data-status="HEALTHY"]')).toBeNull()
    }
    const values = [...summary.querySelectorAll('.metric-card__value strong')].map((node) => node.textContent)
    expect(values.filter((value) => value === '0')).toHaveLength(0)
    for (const testId of ['idea1-status-card', 'idea2-status-card']) {
      const card = within(screen.getByTestId(testId))
      expect(card.queryByText('0')).toBeNull()
    }
  })

  it('renders when IDEA summaries or the runtime domain are missing', () => {
    const { idea1, idea2, runtime, ...rest } = snapshot
    render(<DashboardPage snapshot={rest} />)
    expect(screen.getByTestId('idea3-status-card')).toBeVisible()
  })
})

describe('Overview evidence layers', () => {
  it('lists six layers and never presents physical evidence as verified without a sensor', () => {
    render(<OverviewPage snapshot={snapshot} />)
    const layers = within(screen.getByRole('region', { name: 'ชั้นของหลักฐาน' })).getAllByRole('listitem')
    expect(layers).toHaveLength(6)
    expect(layers[0]).toHaveTextContent('feed เข้าถึงได้ ≠ producer healthy')
    expect(layers[3]).toHaveTextContent('decision ที่ถูกยอมรับ ≠ คำสั่งถูกดำเนินการ')
    expect(layers[4]).toHaveTextContent('ACK ≠ Relay proof')
    expect(layers[5].querySelector('[data-status="NOT_VERIFIED"]')).not.toBeNull()
  })

  it('keeps missing integrations visible rather than healthy in the layers', () => {
    const missing = { ...snapshot, sources: [], settings: { ...snapshot.settings, adapters: [] } }
    render(<OverviewPage snapshot={missing} />)
    const layers = within(screen.getByRole('region', { name: 'ชั้นของหลักฐาน' })).getAllByRole('listitem')
    expect(layers[0].querySelector('[data-status="HEALTHY"]')).toBeNull()
    expect(layers[4].querySelector('[data-status="HEALTHY"]')).toBeNull()
  })
})

describe('Live IDEA1 / IDEA2 evidence routing', () => {
  const feedEvent = (overrides = {}) => ({
    source: 'IDEA1', event_id: 'e1', event_type: 'ACCESS_DENIED', severity: 'HIGH', occurred_at: snapshot.generatedAt,
    received_at: snapshot.generatedAt, resource: 'drive', subject: null, confidence: null, evidence: { result: 'DENIED' },
    evidence_completeness: 'COMPLETE', freshness: 'FRESH', correlation_key: null, containment_eligible: true, dedup_count: 3, ...overrides,
  })
  const withFeed = (events, idea1Status = 'HEALTHY') => {
    const base = liveLike(snapshot)
    return {
      ...base,
      idea1: { ...base.idea1, status: idea1Status, freshness: 'FRESH' },
      idea2: { ...base.idea2, status: 'HEALTHY', freshness: 'FRESH' },
      integration: { events },
    }
  }

  it('renders IDEA1 rows from the normalized feed and hides IDEA2 rows there', () => {
    render(<Idea1SecurityPage snapshot={withFeed([feedEvent(), feedEvent({ source: 'IDEA2', event_id: 'e9', resource: 'CAM-77' })])} />)
    const table = screen.getByRole('region', { name: 'ตารางหลักฐาน IDEA1' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).getByText('×3 · พบซ้ำ')).toBeVisible()
    expect(within(table).getByText('ไม่ระบุ')).toBeVisible()
    expect(screen.queryByText('CAM-77')).toBeNull()
  })

  it('flags STALE and FUTURE rows instead of presenting them as current', () => {
    render(<Idea1SecurityPage snapshot={withFeed([feedEvent({ freshness: 'FUTURE' }), feedEvent({ event_id: 'e2', freshness: 'STALE' })])} />)
    const table = screen.getByRole('region', { name: 'ตารางหลักฐาน IDEA1' })
    expect(within(table).getByText('FUTURE')).toBeVisible()
    expect(within(table).getByText('STALE')).toBeVisible()
    expect(within(table).queryByText('FRESH')).toBeNull()
    // stale rows are not counted as current DENIED evidence
    const denied = screen.getByText('DENIED', { selector: '.metric-card__label' }).closest('.metric-card')
    expect(denied.querySelector('.metric-card__value strong').textContent).toBe('0')
  })

  it('does not trust feed rows for the source badge when the source itself is UNKNOWN', () => {
    render(<Idea2DetectionPage snapshot={{ ...withFeed([feedEvent({ source: 'IDEA2', event_id: 'e5', resource: 'CAM-05' })]), idea2: { status: 'UNKNOWN', freshness: 'ABSENT', generatedAt: snapshot.generatedAt } }} />)
    expect(screen.getByText('CAM-05')).toBeVisible()
    expect(screen.getByLabelText('สถานะ UNKNOWN', { selector: '.source-bar *' })).toBeVisible()
  })

  it('prefers dedicated rows over the feed when both exist', () => {
    const base = withFeed([feedEvent({ resource: 'FEED-ONLY' })])
    render(<Idea2DetectionPage snapshot={{ ...base, idea2: { ...snapshot.idea2 } }} />)
    expect(screen.getByText('CAM-02')).toBeVisible()
    expect(screen.queryByText('FEED-ONLY')).toBeNull()
  })
})
