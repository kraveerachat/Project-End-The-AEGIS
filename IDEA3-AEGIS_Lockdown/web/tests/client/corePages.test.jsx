import React from 'react'
import { render, screen, within } from '@testing-library/react'
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
  it('leads with the evidence boundary and architecture flow before integration details', () => {
    render(<OverviewPage snapshot={snapshot} />)

    const boundary = screen.getByRole('region', { name: 'ขอบเขตสภาพแวดล้อมและหลักฐาน' })
    const flow = screen.getByRole('region', { name: 'เส้นทางของหลักฐาน' })
    const contracts = screen.getByRole('region', { name: 'สัญญาการเชื่อมต่อ' })
    const matrix = screen.getByRole('region', { name: 'Integration matrix' })

    expect(within(boundary).getByText('DEMO')).toBeVisible()
    expect(within(boundary).getByText('isolated-demo-provider')).toBeVisible()
    expect(within(boundary).getByText('SESSION_AND_MEMORY_ONLY')).toBeVisible()
    expect(within(boundary).getByText('NOT ALLOWED')).toBeVisible()
    expect(flow.compareDocumentPosition(contracts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(contracts.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(flow).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'IDEA1 Evidence')).toBeVisible()
    expect(within(flow).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'IDEA2 Evidence')).toBeVisible()
    expect(within(flow).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'IDEA3 Runtime')).toBeVisible()
    expect(screen.getByText('Validate & normalize')).toBeVisible()
    expect(screen.getByText('ไม่มีการรวม Demo กับ Live')).toBeVisible()
  })

  it('keeps stale evidence and physical evidence uncertainty visible instead of implying health', () => {
    const staleSnapshot = {
      ...snapshot,
      idea1: { ...snapshot.idea1, status: 'HEALTHY', freshness: 'STALE' },
    }
    render(<OverviewPage snapshot={staleSnapshot} />)

    const idea1Card = screen.getByRole('article', { name: 'IDEA1 Access Security integration' })
    const idea3Card = screen.getByRole('article', { name: 'IDEA3 Runtime integration' })
    const idea1Row = screen.getByRole('row', { name: /IDEA1 Access Security/ })
    const contractReadiness = screen.getByText('Sanitized evidence contract').closest('.readiness-ledger > div')

    expect(within(idea1Card).getByLabelText('สถานะ STALE')).toBeVisible()
    expect(within(idea1Card).getAllByText('STALE')).toHaveLength(2)
    expect(within(idea1Row).getAllByText('STALE')).toHaveLength(2)
    expect(within(contractReadiness).getByText('STALE')).toBeVisible()
    expect(within(idea3Card).getByText('MONITOR ONLY')).toBeVisible()
    expect(within(idea3Card).getByText('DRY RUN')).toBeVisible()
    expect(within(idea3Card).getByText('UNKNOWN')).toBeVisible()
  })

  it('uses honest fallback states when provider metadata or integrations are missing', () => {
    const incompleteSnapshot = {
      ...snapshot,
      provenance: { liveMerged: false },
      sources: [],
      settings: { ...snapshot.settings, adapters: [] },
    }
    render(<OverviewPage snapshot={incompleteSnapshot} />)

    const boundary = screen.getByRole('region', { name: 'ขอบเขตสภาพแวดล้อมและหลักฐาน' })
    expect(within(boundary).getByText('UNKNOWN')).toBeVisible()
    expect(within(boundary).getByText('NOT_CONFIGURED')).toBeVisible()
    expect(screen.getByText('ยังไม่มีผลการตรวจสอบ integration')).toBeVisible()
  })

  it('does not present HEALTHY when the validation timestamp is malformed', () => {
    const malformedTimestampSnapshot = {
      ...snapshot,
      idea1: {
        ...snapshot.idea1,
        status: 'HEALTHY',
        freshness: 'FRESH',
        generatedAt: 'not-a-timestamp',
      },
    }
    render(<OverviewPage snapshot={malformedTimestampSnapshot} />)

    const idea1Card = screen.getByRole('article', { name: 'IDEA1 Access Security integration' })
    const idea1Row = screen.getByRole('row', { name: /IDEA1 Access Security/ })

    expect(within(idea1Card).getByLabelText('สถานะ UNKNOWN')).toBeVisible()
    expect(within(idea1Row).getByLabelText('สถานะ UNKNOWN')).toBeVisible()
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
