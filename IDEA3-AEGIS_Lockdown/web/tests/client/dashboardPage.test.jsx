import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { StatusBadge } from '../../src/components/StatusBadge.jsx'
import { DashboardPage } from '../../src/pages/DashboardPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('Dashboard mission control', () => {
  it('shows global runtime truth and keeps environment, control mode, and hardware availability separate', () => {
    render(<DashboardPage snapshot={snapshot} apiConnected={false} />)

    const runtime = screen.getByRole('region', { name: 'สถานะระบบส่วนกลาง' })
    expect(within(runtime).getByText('DEMO')).toBeVisible()
    expect(within(runtime).getByText('DISCONNECTED')).toBeVisible()
    expect(within(runtime).getByText('Correlation engine')).toBeVisible()
    expect(within(runtime).getByText('Incident engine')).toBeVisible()
    expect(within(runtime).getAllByLabelText('สถานะ UNKNOWN')).toHaveLength(2)

    const idea3 = screen.getByTestId('idea3-status-card')
    expect(within(idea3).getByText('DRY RUN')).toBeVisible()
    expect(within(idea3).getByText('Hardware')).toBeVisible()
    expect(within(idea3).getByText('DISABLED')).toBeVisible()
  })

  it('summarizes all IDEA domains without duplicating their detailed ledgers', () => {
    render(<DashboardPage snapshot={snapshot} />)

    expect(screen.getByText('IDEA1 — Access Security')).toBeVisible()
    expect(screen.getByText('Read-only evidence adapter')).toBeVisible()
    expect(screen.getByText('IDEA2 — Detection Evidence')).toBeVisible()
    expect(screen.getByText('Privacy-preserving / Read-only evidence')).toBeVisible()
    expect(screen.getByText('IDEA3 — Network Isolation / Lockdown')).toBeVisible()

    const idea3 = screen.getByTestId('idea3-status-card')
    expect(within(idea3).getByText('Requested')).toBeVisible()
    expect(within(idea3).getByText('OPEN')).toBeVisible()
    expect(within(idea3).getByText('Physical relay')).toBeVisible()
    expect(within(idea3).getByText('NOT VERIFIED')).toBeVisible()
  })

  it('routes operational actions through the application navigation callback', () => {
    const onNavigate = vi.fn()
    render(<DashboardPage snapshot={snapshot} onNavigate={onNavigate} />)

    fireEvent.click(screen.getByRole('link', { name: 'ดูรายละเอียด IDEA1' }))
    fireEvent.click(screen.getByRole('link', { name: 'เปิด Incident demo-inc-001' }))

    expect(onNavigate).toHaveBeenNthCalledWith(1, 'idea1')
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'incidents')
  })

  it('renders a truthful empty incident state and limits attention items to five', () => {
    const emptySnapshot = {
      ...snapshot,
      incidents: [],
      overall: { ...snapshot.overall, activeIncidents: 0 },
      runtime: {
        ...snapshot.runtime,
        issues: Array.from({ length: 8 }, (_, index) => ({
          code: 'ADAPTER_UNAVAILABLE',
          component: `source-${index}`,
          severity: 'WARNING',
          count: 1,
        })),
      },
    }

    render(<DashboardPage snapshot={emptySnapshot} />)

    expect(screen.getByText('ไม่มี Incident ที่กำลังดำเนินการ')).toBeVisible()
    expect(screen.getAllByTestId('attention-item')).toHaveLength(5)
  })

  it('promotes stale evidence to the visible STALE state', () => {
    const staleSnapshot = {
      ...snapshot,
      idea2: { ...snapshot.idea2, status: 'UNKNOWN', freshness: 'STALE' },
      sources: snapshot.sources.map((source) => source.id === 'idea2'
        ? { ...source, status: 'UNKNOWN', freshness: 'STALE' }
        : source),
    }

    render(<DashboardPage snapshot={staleSnapshot} />)

    expect(within(screen.getByTestId('idea2-status-card')).getByLabelText('สถานะ STALE')).toBeVisible()
  })
})

describe('StatusBadge Dashboard vocabulary', () => {
  it('renders every Dashboard evidence state without silently falling back to another status', () => {
    const statuses = ['HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'NOT_CONFIGURED', 'STALE']
    render(<div>{statuses.map((status) => <StatusBadge key={status} status={status} />)}</div>)
    statuses.forEach((status) => expect(screen.getByLabelText(`สถานะ ${status}`)).toBeVisible())
  })
})
