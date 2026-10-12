import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AlertsPage } from '../../src/pages/AlertsPage.jsx'
import { AuditPage } from '../../src/pages/AuditPage.jsx'
import { IncidentsPage } from '../../src/pages/IncidentsPage.jsx'
import { SettingsPage } from '../../src/pages/SettingsPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

// Live incident as the correlator emits it: no title, summary, IP, or evidenceStages.
const liveIncident = {
  id: 'inc-abc', state: 'CONTAINMENT_CANDIDATE', severity: 'HIGH', correlationKey: 'k', firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-01T00:01:00.000Z', idea1Count: 1, idea2Count: 1, evidenceIds: [], responseState: 'NOT_REQUESTED',
}

describe('Alerts', () => {
  it('does not show a HEALTHY zero when no evidence age exists', () => {
    const { container } = render(<AlertsPage snapshot={{ ...snapshot, alerts: [], overall: { ...snapshot.overall, evidenceAgeMs: null, status: 'UNKNOWN' } }} />)
    for (const card of container.querySelectorAll('.metric-card')) {
      expect(card.querySelector('[data-status="HEALTHY"]')).toBeNull()
      expect(card.querySelector('.metric-card__value strong').textContent).toBe('—')
    }
    expect(screen.getByText(/จึงยังสรุปไม่ได้ว่าไม่มีเหตุ/)).toBeVisible()
  })

  it('keeps acknowledgement server-mediated: the button never flips the row by itself', () => {
    const onAcknowledge = vi.fn()
    render(<AlertsPage snapshot={snapshot} onAcknowledge={onAcknowledge} />)
    const before = screen.getAllByRole('button', { name: 'รับทราบ' }).length
    fireEvent.click(screen.getAllByRole('button', { name: 'รับทราบ' })[0])
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button', { name: 'รับทราบ' })).toHaveLength(before)
  })

  it('renders an alert with missing fields', () => {
    render(<AlertsPage snapshot={{ ...snapshot, alerts: [{ id: 'a-1', status: 'UNACKNOWLEDGED' }] }} />)
    expect(screen.getByText('a-1')).toBeVisible()
  })
})

describe('Incidents', () => {
  it('renders a Live-shaped incident without crashing and never shows it as physically verified', () => {
    render(<IncidentsPage snapshot={{ ...snapshot, incidents: [liveIncident] }} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Incident inc-abc' })).toBeVisible()
    expect(screen.getByText('หลักฐานทางกายภาพยังไม่ยืนยัน')).toBeVisible()
    expect(screen.getByText('PHYSICALLY VERIFIED').closest('li').querySelector('[data-status="NOT_VERIFIED"]')).not.toBeNull()
  })

  it('shows six separate stages and does not treat an ACK as execution', () => {
    const acked = { ...liveIncident, responseState: 'ACK_RECEIVED', dispatch: { state: 'CORE_CLAIMED', boundary: { command_requested: true, command_published: true, acknowledged: true, executed: false, physical_evidence: false } } }
    render(<IncidentsPage snapshot={{ ...snapshot, incidents: [acked] }} />)
    const items = screen.getAllByRole('listitem').filter((li) => li.classList.contains('response-chain__stage'))
    expect(items).toHaveLength(6)
    expect(within(items[3]).getByText('พบหลักฐาน')).toBeVisible()
    expect(within(items[4]).getByText('ยังไม่พบ')).toBeVisible()
    expect(within(items[5]).getByText('ยังไม่ได้ยืนยัน')).toBeVisible()
  })

  it('renders an honest empty queue', () => {
    render(<IncidentsPage snapshot={{ ...snapshot, incidents: [] }} />)
    expect(screen.getByText(/ไม่ได้พิสูจน์ว่าไม่มีเหตุ/)).toBeVisible()
  })

  it('marks the selected incident with aria-current', () => {
    render(<IncidentsPage snapshot={{ ...snapshot, incidents: [liveIncident, { ...liveIncident, id: 'inc-two' }] }} />)
    fireEvent.click(screen.getByRole('button', { name: /inc-two/ }))
    expect(screen.getByRole('button', { name: /inc-two/ })).toHaveAttribute('aria-current', 'true')
  })
})

describe('Audit', () => {
  it('does not claim tamper evidence is verified when the snapshot has no integrity result', () => {
    const { container } = render(<AuditPage snapshot={snapshot} />)
    const card = screen.getByText('Tamper evidence').closest('.metric-card')
    expect(card.querySelector('.metric-card__value strong').textContent).toBe('NOT VERIFIED')
    expect(card.querySelector('[data-status="HEALTHY"]')).toBeNull()
    expect(container.textContent).not.toMatch(/ตรวจสอบ chain ล่าสุดสำเร็จ/)
  })

  it('reports VERIFIED only from a fresh HEALTHY server integrity result', () => {
    render(<AuditPage snapshot={{ ...snapshot, auditIntegrity: { status: 'HEALTHY', freshness: 'FRESH', generatedAt: snapshot.generatedAt } }} />)
    expect(screen.getByText('VERIFIED')).toBeVisible()
  })

  it('shows audit provenance and whether persistence is durable', () => {
    render(<AuditPage snapshot={snapshot} />)
    expect(screen.getByText('SESSION_AND_MEMORY_ONLY')).toBeVisible()
    expect(screen.getByText(/ไม่ถาวร/)).toBeVisible()
  })

  it('takes retention and export limit from server policy, not constants', () => {
    render(<AuditPage snapshot={{ ...snapshot, settings: { ...snapshot.settings, policy: { auditRetentionDays: 365, exportLimit: 500 } } }} />)
    expect(screen.getByText('365')).toBeVisible()
    expect(screen.getByText('500')).toBeVisible()
  })
})

describe('Settings', () => {
  it('renders with no settings block and exposes no URL or credential fields', () => {
    const { settings, ...rest } = snapshot
    const { container } = render(<SettingsPage snapshot={rest} />)
    expect(container.querySelector('input[type="url"], input[type="password"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/https?:\/\//)
  })

  it('does not call a configured adapter healthy', () => {
    render(<SettingsPage snapshot={snapshot} />)
    expect(screen.getAllByText('CONFIGURED').length).toBeGreaterThan(0)
    expect(screen.getByText(/ไม่ได้แปลว่า producer ทำงานปกติ/)).toBeVisible()
  })

  it('shows the allowed range for every bounded policy field', () => {
    render(<SettingsPage snapshot={snapshot} />)
    expect(screen.getByText('ช่วงที่อนุญาต 10–600')).toBeVisible()
    expect(screen.getByLabelText(/Dedup window/)).toHaveAttribute('max', '600')
  })
})
