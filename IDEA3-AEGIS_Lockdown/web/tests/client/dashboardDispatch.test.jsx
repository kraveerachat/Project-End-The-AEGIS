import React from 'react'
import { render, within } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { isAcknowledgedIncident } from '../../src/lib/dashboard.js'
import { DashboardPage } from '../../src/pages/DashboardPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

const RESPONSE_STATE_LABEL = 'สถานะการตอบสนอง'
const ACKNOWLEDGEMENT_LABEL = 'การรับทราบ'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

function boundary(overrides = {}) {
  return { command_requested: true, command_published: false, acknowledged: false, executed: false, physical_evidence: false, ...overrides }
}

// Render the Dashboard with one spotlight incident and read a fact row by its label.
function spotlightFacts(incidentOverrides) {
  const incident = { ...snapshot.incidents[0], ...incidentOverrides }
  const { container } = render(<DashboardPage snapshot={{ ...snapshot, incidents: [incident] }} />)
  const view = within(container.querySelector('.incident-focus'))
  return (label) => view.getByText(label).closest('div').querySelector('dd').textContent
}

describe('PR10 S2 dispatch state on the Dashboard', () => {
  it('W13: counts a correlated device STATUS as acknowledged and labels it in the selected language', () => {
    const fact = spotlightFacts({
      responseState: 'STATUS_CORRELATED',
      dispatch: { state: 'CORE_CLAIMED', humanReviewRequired: false, boundary: boundary({ command_published: true, acknowledged: true }) },
    })

    expect(fact(RESPONSE_STATE_LABEL)).toBe('สถานะอุปกรณ์สอดคล้องแล้ว')
    expect(fact(ACKNOWLEDGEMENT_LABEL)).toBe('ได้รับ ACK แล้ว')
  })

  it('W13: labels OUTCOME_UNKNOWN as needing human review while keeping the acknowledged evidence', () => {
    const fact = spotlightFacts({
      responseState: 'OUTCOME_UNKNOWN',
      dispatch: { state: 'CORE_CLAIMED', humanReviewRequired: true, boundary: boundary({ command_published: true, acknowledged: true }) },
    })

    expect(fact(RESPONSE_STATE_LABEL)).toBe('ไม่ทราบผลลัพธ์ — ต้องให้เจ้าหน้าที่ตรวจสอบ')
    expect(fact(ACKNOWLEDGEMENT_LABEL)).toBe('ได้รับ ACK แล้ว')
  })

  it('W13: labels a pending action without recent Core contact as unavailable, never as acknowledged', () => {
    const fact = spotlightFacts({
      responseState: 'DISPATCH_UNAVAILABLE',
      dispatch: { state: 'PENDING_DISPATCH', humanReviewRequired: false, boundary: boundary() },
    })

    expect(fact(RESPONSE_STATE_LABEL)).toBe('ส่งคำสั่งไม่ได้ (ไม่มีการติดต่อจาก Core ล่าสุด)')
    expect(fact(ACKNOWLEDGEMENT_LABEL)).toBe('ยังไม่ได้รับทราบ')
  })

  it('keeps the existing ACKED demo state acknowledged', () => {
    const fact = spotlightFacts({ responseState: 'ACKED', dispatch: undefined })

    expect(fact(ACKNOWLEDGEMENT_LABEL)).toBe('ได้รับ ACK แล้ว')
  })
})

describe('Dashboard acknowledgement rule', () => {
  it('W13: uses an explicit allowlist instead of matching "ACK" anywhere in the state', () => {
    for (const responseState of ['ACKED', 'ACKNOWLEDGED', 'ACK_RECEIVED', 'STATUS_CORRELATED']) {
      expect(isAcknowledgedIncident({ responseState })).toBe(true)
    }
    for (const responseState of ['ACK_TIMEOUT', 'NOT_ACKNOWLEDGED', 'NOT_REQUESTED', 'OUTCOME_UNKNOWN', 'DISPATCH_PENDING', undefined]) {
      expect(isAcknowledgedIncident({ responseState })).toBe(false)
    }
  })

  it('W13: trusts the dispatch evidence boundary when the incident has a dispatch action', () => {
    expect(isAcknowledgedIncident({ responseState: 'OUTCOME_UNKNOWN', dispatch: { boundary: boundary({ acknowledged: true }) } })).toBe(true)
    expect(isAcknowledgedIncident({ responseState: 'PUBLISHED', dispatch: { boundary: boundary() } })).toBe(false)
  })
})
