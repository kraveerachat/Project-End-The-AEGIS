import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { DashboardPage } from '../../src/pages/DashboardPage.jsx'
import { OverviewPage } from '../../src/pages/OverviewPage.jsx'
import { LockdownPage } from '../../src/pages/LockdownPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('Dashboard', () => {
  it('shows system outcome, source evidence, recent events, and active incidents', () => {
    render(<DashboardPage snapshot={snapshot} />)
    expect(screen.getByText('สถานะระบบโดยรวม')).toBeVisible()
    expect(screen.getByText('IDEA1 Access Security')).toBeVisible()
    expect(screen.getByText('PERSON_DETECTED')).toBeVisible()
    expect(screen.getByText('ตรวจพบกิจกรรมผิดปกติข้าม IDEA1 และ IDEA2')).toBeVisible()
  })

  it('labels counts as evidence-backed values', () => {
    render(<DashboardPage snapshot={snapshot} />)
    expect(screen.getByText('หลักฐาน 24 ชั่วโมง')).toBeVisible()
    expect(screen.getByText('128')).toBeVisible()
  })
})

describe('Overview', () => {
  it('explains the data path and Demo provenance without claiming Live integration', () => {
    render(<OverviewPage snapshot={snapshot} />)
    expect(screen.getByText('Upstream evidence')).toBeVisible()
    expect(screen.getByText('Validate & normalize')).toBeVisible()
    expect(screen.getByText('isolated-demo-provider')).toBeVisible()
    expect(screen.getByText('ไม่มีการรวม Demo กับ Live')).toBeVisible()
  })
})

describe('IDEA3 Lockdown', () => {
  it('does not call stale runtime evidence healthy', () => {
    const staleSnapshot = {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        status: 'UNKNOWN',
        freshness: 'STALE',
        evidenceAgeMs: 181_000,
        components: snapshot.runtime.components.map((component) => ({ ...component, status: 'UNKNOWN' })),
      },
    }
    render(<LockdownPage snapshot={staleSnapshot} />)
    expect(screen.getAllByText('UNKNOWN').length).toBeGreaterThan(1)
    expect(screen.getByText(/หลักฐานล่าสุดเก่าเกินกำหนด/)).toBeVisible()
  })

  it('explains why command controls are unavailable', () => {
    render(<LockdownPage snapshot={snapshot} />)
    expect(screen.getByRole('button', { name: 'ตัดการเชื่อมต่อเครือข่าย' })).toBeDisabled()
    expect(screen.getByText(/ไม่มี command endpoint ใน milestone นี้/)).toBeVisible()
  })

  it('shows requested operating modes separately from evidenced component state', () => {
    render(<LockdownPage snapshot={snapshot} />)
    expect(screen.getByText('MONITOR ONLY')).toBeVisible()
    expect(screen.getByText('DRY RUN')).toBeVisible()
    expect(screen.getByText('Relay')).toBeVisible()
  })
})
