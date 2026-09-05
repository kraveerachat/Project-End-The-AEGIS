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
  it('shows global runtime truth and keeps environment, control mode, and hardware availability separate', () => {
    render(<DashboardPage snapshot={snapshot} apiConnected={false} />)

    const runtime = screen.getByRole('region', { name: 'สถานะระบบส่วนกลาง' })
    expect(within(runtime).getByText('DEMO')).toBeVisible()
    expect(within(runtime).getByText('ขาดการเชื่อมต่อ')).toBeVisible()
    expect(within(runtime).getByText('กลไกเชื่อมโยงเหตุการณ์')).toBeVisible()
    expect(within(runtime).getByText('กลไกจัดการเหตุการณ์')).toBeVisible()
    expect(within(runtime).getAllByLabelText('สถานะ: ไม่ทราบสถานะ')).toHaveLength(2)

    const idea3 = screen.getByTestId('idea3-status-card')
    expect(within(idea3).getByText('ทดลองโดยไม่สั่งงาน')).toBeVisible()
    expect(within(idea3).getByText('ฮาร์ดแวร์')).toBeVisible()
    expect(within(idea3).getByText('ปิดใช้งาน')).toBeVisible()
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

    expect(within(screen.getByTestId('idea2-status-card')).getByLabelText('สถานะ: ข้อมูลล้าสมัย')).toBeVisible()
  })

  it.each([
    ['th', 'สถานะระบบส่วนกลาง', 'เชื่อมต่อแล้ว', 'สถานะแหล่งหลักฐาน', 'ตรวจสอบอะแดปเตอร์', 'ยังไม่ได้ยืนยัน'],
    ['en', 'System status', 'Connected', 'Evidence sources', 'Review adapters', 'Not verified'],
    ['zh', '系统状态', '已连接', '证据来源状态', '检查适配器', '未验证'],
  ])('renders complete Dashboard presentation copy in %s', (language, regionLabel, connection, sourceHeading, adapterAction, relayState) => {
    render(<DashboardPage snapshot={snapshot} language={language} />)

    expect(screen.getByRole('region', { name: regionLabel })).toBeVisible()
    expect(screen.getByText(connection)).toBeVisible()
    expect(screen.getByText(sourceHeading)).toBeVisible()
    expect(screen.getByRole('link', { name: adapterAction })).toBeVisible()
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
