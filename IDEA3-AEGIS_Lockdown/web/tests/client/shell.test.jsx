import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/components/AppShell.jsx'
import { DemoBanner } from '../../src/components/DemoBanner.jsx'
import { StatusBadge } from '../../src/components/StatusBadge.jsx'

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
