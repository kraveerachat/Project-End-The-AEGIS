import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { StatusBadge } from '../../src/components/StatusBadge.jsx'
import { dashboardIssues, recommendedActions } from '../../src/lib/dashboard.js'
import { DashboardPage } from '../../src/pages/DashboardPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('Dashboard mission control', () => {
  it('keeps the mission summary compact and separates environment, API, runtime, and freshness', () => {
    render(<DashboardPage snapshot={snapshot} apiConnected={false} />)

    const runtime = screen.getByRole('region', { name: 'สถานะระบบส่วนกลาง' })
    expect(runtime.querySelectorAll('.global-fact')).toHaveLength(4)
    expect(within(runtime).getByText('DEMO')).toBeVisible()
    expect(within(runtime).getByText('ขาดการเชื่อมต่อ')).toBeVisible()
    expect(within(runtime).getByText('สถานะ Core/runtime')).toBeVisible()
    expect(within(runtime).getByText('ความสดของข้อมูล')).toBeVisible()
    expect(within(runtime).queryByText('กลไกเชื่อมโยงเหตุการณ์')).not.toBeInTheDocument()
    expect(within(runtime).queryByText('สถานะการตอบสนอง/การกักกัน')).not.toBeInTheDocument()

    const idea3 = screen.getByTestId('idea3-status-card')
    expect(within(idea3).getByText('MQTT')).toBeVisible()
    expect(within(idea3).getByText('สัญญาณ ESP32')).toBeVisible()
    expect(within(idea3).getByText('สถานะรีเลย์จริง')).toBeVisible()
  })

  it('prioritizes only active incidents and high or critical alerts in the KPI row', () => {
    render(<DashboardPage snapshot={snapshot} />)

    const summary = screen.getByRole('region', { name: 'สรุปสถานะ' })
    expect(summary.querySelectorAll('.metric-card')).toHaveLength(2)
    expect(within(summary).getByText('Incident ที่กำลังดำเนินการ')).toBeVisible()
    expect(within(summary).getByText('การแจ้งเตือนระดับสูง')).toBeVisible()
    expect(within(summary).queryByText('สถานะระบบโดยรวม')).not.toBeInTheDocument()
    expect(within(summary).queryByText('หลักฐาน 24 ชั่วโมง')).not.toBeInTheDocument()
  })

  it('summarizes all IDEA domains without duplicating their detailed ledgers', () => {
    render(<DashboardPage snapshot={snapshot} />)

    expect(screen.getByText('IDEA1 — ความปลอดภัยการเข้าถึง')).toBeVisible()
    expect(screen.getByText('หลักฐานแบบอ่านอย่างเดียว')).toBeVisible()
    expect(screen.getByText('IDEA2 — หลักฐานการตรวจจับ')).toBeVisible()
    expect(screen.getByText('หลักฐานคุ้มครองความเป็นส่วนตัว')).toBeVisible()
    expect(screen.getByText('IDEA3 — การแยกเครือข่าย')).toBeVisible()

    const idea3 = screen.getByTestId('idea3-status-card')
    expect(within(idea3).getByText('คำสั่งที่ร้องขอ')).toBeVisible()
    expect(within(idea3).getByText('เปิด')).toBeVisible()
    expect(within(idea3).getByText('สถานะรีเลย์จริง')).toBeVisible()
    expect(within(idea3).getByText('ยังไม่ได้ยืนยัน')).toBeVisible()
  })

  it('top-aligns all three IDEA summaries so shorter cards do not stretch', () => {
    render(<DashboardPage snapshot={snapshot} />)

    const summaries = screen.getByRole('region', { name: 'สถานะ IDEA' })
    expect(summaries).toHaveAttribute('data-layout', 'content-height')
    expect(within(summaries).getByTestId('idea1-status-card')).toBeVisible()
    expect(within(summaries).getByTestId('idea2-status-card')).toBeVisible()
    expect(within(summaries).getByTestId('idea3-status-card')).toBeVisible()
  })

  it('routes operational actions through the application navigation callback', () => {
    const onNavigate = vi.fn()
    render(<DashboardPage snapshot={snapshot} onNavigate={onNavigate} />)

    fireEvent.click(screen.getByRole('link', { name: 'ดูรายละเอียด IDEA1' }))
    fireEvent.click(screen.getByRole('link', { name: 'เปิด Incident demo-inc-001' }))

    expect(onNavigate).toHaveBeenNthCalledWith(1, 'idea1')
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'incidents')
  })

  it('renders a truthful empty incident state and limits consolidated attention items to three', () => {
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
    expect(screen.getAllByTestId('attention-item')).toHaveLength(3)
    expect(screen.queryByRole('heading', { name: 'สิ่งที่แนะนำให้ทำต่อ' })).not.toBeInTheDocument()
  })

  it('keeps the Active Incidents and Latest Evidence empty states compact', () => {
    render(<DashboardPage snapshot={{ ...snapshot, incidents: [], events: [] }} />)

    const incidentEmpty = screen.getByText('ไม่มี Incident ที่กำลังดำเนินการ').closest('.empty-state')
    const evidenceEmpty = screen.getByText('ไม่มีหลักฐานในช่วงเวลานี้').closest('.empty-state')
    expect(incidentEmpty).toHaveAttribute('data-density', 'compact')
    expect(evidenceEmpty.closest('.dashboard-latest-evidence')).toHaveAttribute('data-density', 'compact')
  })

  it('removes the duplicate source matrix and keeps navigation to Overview', () => {
    const onNavigate = vi.fn()
    render(<DashboardPage snapshot={snapshot} onNavigate={onNavigate} />)

    expect(screen.queryByRole('heading', { name: 'สถานะแหล่งหลักฐาน' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'เปิดภาพรวมระบบ' }))
    expect(onNavigate).toHaveBeenCalledWith('overview')
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

    expect(within(screen.getByTestId('idea2-status-card')).getByLabelText('สถานะ: ข้อมูลล้าสมัย')).toBeVisible()
  })

  it.each([
    ['th', 'สถานะระบบส่วนกลาง', 'เชื่อมต่อแล้ว', 'เปิดภาพรวมระบบ', 'ยังไม่ได้ยืนยัน'],
    ['en', 'System status', 'Connected', 'Open system overview', 'Not verified'],
    ['zh', '系统状态', '已连接', '打开系统概览', '未验证'],
  ])('renders complete Dashboard presentation copy in %s', (language, regionLabel, connection, overviewAction, relayState) => {
    render(<DashboardPage snapshot={snapshot} language={language} />)

    expect(screen.getByRole('region', { name: regionLabel })).toBeVisible()
    expect(screen.getByText(connection)).toBeVisible()
    expect(screen.getByRole('link', { name: overviewAction })).toBeVisible()
    expect(within(screen.getByTestId('idea3-status-card')).getByText(relayState)).toBeVisible()
  })

  it('does not expose raw English status vocabulary on the Thai Dashboard', () => {
    render(<DashboardPage snapshot={snapshot} language="th" />)

    for (const rawStatus of ['HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'STALE', 'DISABLED', 'CONNECTED', 'NOT VERIFIED']) {
      expect(screen.queryByText(rawStatus)).not.toBeInTheDocument()
    }
  })

  it('keeps issue selectors semantic so language never changes prioritization or routes', () => {
    const issues = dashboardIssues(snapshot, { apiConnected: false })
    const actions = recommendedActions(issues)

    expect(issues[0]).toMatchObject({
      key: 'api-disconnected',
      status: 'FAILED',
      route: 'settings',
      messageKey: 'issue.apiDisconnected.title',
      detailKey: 'issue.apiDisconnected.detail',
    })
    expect(issues[0]).not.toHaveProperty('title')
    expect(actions[0]).toMatchObject({ actionKey: 'action.reviewProductionSettings', route: 'settings' })
    expect(actions[0]).not.toHaveProperty('action')
  })
})

describe('StatusBadge Dashboard vocabulary', () => {
  it('uses localized display copy without changing the raw semantic class', () => {
    render(<StatusBadge status="FAILED" label="ขัดข้อง" ariaLabel="สถานะ: ขัดข้อง" />)

    expect(screen.getByText('ขัดข้อง')).toBeVisible()
    expect(screen.getByLabelText('สถานะ: ขัดข้อง')).toHaveClass('status--failed')
  })
})
