import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { AuditPage } from '../../src/pages/AuditPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let demo

beforeAll(async () => {
  demo = await makeDemoSnapshot()
})

describe('audit integrity claims are never invented', () => {
  it('does not claim a verified tamper-evidence chain that the audit store does not have', () => {
    render(<AuditPage snapshot={demo} />)
    expect(screen.getByText('Tamper evidence')).toBeVisible()
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument()
    expect(screen.queryByText(/ตรวจสอบ chain ล่าสุดสำเร็จ/)).not.toBeInTheDocument()
    expect(screen.getByText('NOT VERIFIED')).toBeVisible()
  })

  it('shows retention and export limits from the active policy and labels Demo policy only in Demo', () => {
    const policy = { ...demo.settings.policy, auditRetentionDays: 365, exportLimit: 250 }
    const live = { ...demo, mode: 'LIVE', settings: { ...demo.settings, policy } }
    const { rerender } = render(<AuditPage snapshot={live} />)
    expect(screen.getByText('365')).toBeVisible()
    expect(screen.getByText('250')).toBeVisible()
    expect(screen.queryByText('นโยบาย Demo')).not.toBeInTheDocument()

    rerender(<AuditPage snapshot={{ ...live, mode: 'DEMO' }} />)
    expect(screen.getByText(/นโยบาย Demo/)).toBeVisible()
  })

  it('shows an unknown value, not a made-up default, when the policy is absent', () => {
    render(<AuditPage snapshot={{ ...demo, mode: 'LIVE', settings: { ...demo.settings, policy: {} } }} />)
    expect(screen.queryByText('180')).not.toBeInTheDocument()
    expect(screen.queryByText('1,000')).not.toBeInTheDocument()
  })
})
