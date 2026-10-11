import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/components/AppShell.jsx'
import { DemoBanner } from '../../src/components/DemoBanner.jsx'
import { StatusBadge } from '../../src/components/StatusBadge.jsx'
import { EvidenceState } from '../../src/components/EvidenceState.jsx'
import { DataTable } from '../../src/components/DataTable.jsx'

const identity = {
  displayName: 'System Administrator',
  role: 'ADMIN',
  workspace: 'AEGIS Security Center',
}

describe('authenticated application shell', () => {
  it('renders eleven authorized destinations and the server-resolved identity', () => {
    render(
      <AppShell identity={identity} mode="LIVE" currentRoute="dashboard">
        <p>Page content</p>
      </AppShell>,
    )

    expect(screen.getAllByRole('link')).toHaveLength(11)
    expect(screen.getByText('System Administrator')).toBeVisible()
    expect(screen.getByText('ADMIN')).toBeVisible()
    expect(screen.getByRole('main')).toHaveTextContent('Page content')
  })

  it('announces and invokes navigation without requiring a page reload', () => {
    const onNavigate = vi.fn()
    render(
      <AppShell identity={identity} mode="LIVE" currentRoute="dashboard" onNavigate={onNavigate}>
        <p>Page</p>
      </AppShell>,
    )

    fireEvent.click(screen.getByRole('link', { name: /เหตุการณ์/ }))
    expect(onNavigate).toHaveBeenCalledWith('incidents')
  })

  it('switches theme with an explicit accessible control', () => {
    const onThemeChange = vi.fn()
    render(
      <AppShell identity={identity} mode="LIVE" currentRoute="dashboard" theme="light" onThemeChange={onThemeChange}>
        <p>Page</p>
      </AppShell>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'ใช้ธีมมืด' }))
    expect(onThemeChange).toHaveBeenCalledWith('dark')
  })

  it('shows the IDEA1 and IDEA2-style language control only on Dashboard', () => {
    const onLanguageChange = vi.fn()
    const { rerender } = render(
      <AppShell identity={identity} mode="LIVE" currentRoute="dashboard" language="th" onLanguageChange={onLanguageChange}>
        <p>Page</p>
      </AppShell>,
    )

    expect(screen.getByRole('radiogroup', { name: 'ภาษา' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'ไทย' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'EN' }))
    expect(onLanguageChange).toHaveBeenCalledWith('en')
    onLanguageChange.mockClear()
    screen.getByRole('radio', { name: 'ไทย' }).focus()
    fireEvent.keyDown(screen.getByRole('radio', { name: 'ไทย' }), { key: 'ArrowRight' })
    expect(onLanguageChange).toHaveBeenCalledWith('en')
    expect(screen.getByRole('radio', { name: 'EN' })).toHaveFocus()

    rerender(
      <AppShell identity={identity} mode="LIVE" currentRoute="overview" language="en" onLanguageChange={onLanguageChange}>
        <p>Page</p>
      </AppShell>,
    )
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('describes Overview as architecture and integration readiness in the page heading', () => {
    render(
      <AppShell identity={identity} mode="DEMO" currentRoute="overview">
        <p>Page</p>
      </AppShell>,
    )

    expect(screen.getByRole('heading', { name: 'ภาพรวมระบบ', level: 1 })).toBeVisible()
    expect(screen.getByText('สถาปัตยกรรมการเชื่อมต่อ หลักฐาน และความพร้อมของ AEGIS')).toBeVisible()
  })

  it.each([
    ['en', 'Language', 'API: Ready', 'Dashboard', 'Use dark theme'],
    ['zh', '语言', 'API：可用', '安全仪表板', '使用深色主题'],
  ])('localizes Dashboard shell copy for %s', (language, groupLabel, apiLabel, pageTitle, themeLabel) => {
    render(
      <AppShell identity={identity} mode="LIVE" currentRoute="dashboard" language={language}>
        <p>Page</p>
      </AppShell>,
    )

    expect(screen.getByRole('radiogroup', { name: groupLabel })).toBeVisible()
    expect(screen.getByText(apiLabel)).toBeVisible()
    expect(screen.getByRole('heading', { name: pageTitle, level: 1 })).toBeVisible()
    expect(screen.getByRole('button', { name: themeLabel })).toBeVisible()
  })
})

describe('shared state communication', () => {
  it('shows a persistent warning for Demo evidence', () => {
    render(<DemoBanner mode="DEMO" />)
    expect(screen.getByText('ข้อมูลจำลองเพื่อสาธิต UI — ไม่ใช่สถานะระบบจริง')).toBeVisible()
  })

  it('renders canonical state as text instead of color alone', () => {
    render(<StatusBadge status="DEGRADED" />)
    expect(screen.getByText('DEGRADED')).toBeVisible()
    expect(screen.getByLabelText('สถานะ DEGRADED')).toBeVisible()
  })
})

describe('W1 shared foundation', () => {
  it.each(['CONNECTED', 'DISCONNECTED', 'NOT_VERIFIED', 'ALERT', 'UNKNOWN', 'STALE'])('renders %s as itself with its own treatment, never aliased', (status) => {
    const { container } = render(<StatusBadge status={status} />)
    expect(screen.getByText(status)).toBeVisible()
    expect(container.querySelector('.status')).toHaveAttribute('data-status', status)
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('falls back to UNKNOWN, never HEALTHY, for unrecognised values', () => {
    const { container } = render(<StatusBadge status="CONTAINED" />)
    expect(container.querySelector('.status')).toHaveAttribute('data-status', 'UNKNOWN')
  })

  it('closes the mobile drawer with Escape and restores focus to the menu button', () => {
    render(<AppShell identity={identity} mode="LIVE" currentRoute="overview"><p>x</p></AppShell>)
    const menu = screen.getByRole('button', { name: 'เปิดเมนู' })
    fireEvent.click(menu)
    expect(menu).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(menu).toHaveFocus()
  })

  it('marks Demo mode with a distinct treatment and derives initials from the server identity', () => {
    const { container } = render(<AppShell identity={identity} mode="DEMO" currentRoute="overview"><p>x</p></AppShell>)
    expect(container.querySelector('.source-chip--demo')).toHaveTextContent('Mode: DEMO')
    expect(container.querySelector('.avatar')).toHaveTextContent('SA')
  })

  it('announces loading without rendering evidence-like values', () => {
    render(<EvidenceState loading><p>real evidence</p></EvidenceState>)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('real evidence')).toBeNull()
  })

  it('makes wide evidence tables keyboard-scrollable regions', () => {
    render(<DataTable ariaLabel="Devices" columns={[{ key: 'a', label: 'A' }]} rows={[{ id: 1, a: 'v' }]} />)
    expect(screen.getByRole('region', { name: 'Devices' })).toHaveAttribute('tabindex', '0')
  })
})
