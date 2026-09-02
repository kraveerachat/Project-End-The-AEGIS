import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Idea1SecurityPage } from '../../src/pages/Idea1SecurityPage.jsx'
import { Idea2DetectionPage } from '../../src/pages/Idea2DetectionPage.jsx'
import { AlertsPage } from '../../src/pages/AlertsPage.jsx'
import { IncidentsPage } from '../../src/pages/IncidentsPage.jsx'
import { AuditPage } from '../../src/pages/AuditPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('normalized IDEA evidence', () => {
  it('shows IDEA1 access outcomes and server-derived summary values', () => {
    render(<Idea1SecurityPage snapshot={snapshot} />)
    expect(screen.getAllByText('DENIED').length).toBeGreaterThan(0)
    expect(screen.getAllByText('BLOCKED').length).toBeGreaterThan(0)
    expect(screen.getByText('Source IP ที่ไม่ซ้ำ')).toBeVisible()
  })

  it('shows only normalized IDEA2 evidence fields', () => {
    render(<Idea2DetectionPage snapshot={snapshot} />)
    expect(screen.getByText('PERSON_DETECTED')).toBeVisible()
    expect(screen.getByText('CAM-02')).toBeVisible()
    expect(document.body.textContent).not.toMatch(/base64-image|face_name|private-person|must-not-pass/i)
  })
})

describe('response ledgers', () => {
  it('acknowledges an alert through the provided server action boundary', () => {
    const onAcknowledge = vi.fn()
    render(<AlertsPage snapshot={snapshot} onAcknowledge={onAcknowledge} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'รับทราบ' })[0])
    expect(onAcknowledge).toHaveBeenCalledWith('demo-alert-001')
  })

  it('separates requested, accepted, acked, executed, and physically verified stages', () => {
    render(<IncidentsPage snapshot={snapshot} onAddNote={() => {}} />)
    for (const label of ['REQUESTED', 'ACCEPTED', 'ACKED', 'EXECUTED', 'PHYSICALLY VERIFIED']) {
      expect(screen.getByText(label)).toBeVisible()
    }
    expect(screen.getByText('หลักฐานทางกายภาพยังไม่ยืนยัน')).toBeVisible()
  })

  it('submits a bounded analyst note to the server action boundary', () => {
    const onAddNote = vi.fn()
    render(<IncidentsPage snapshot={snapshot} onAddNote={onAddNote} />)
    fireEvent.change(screen.getByLabelText('บันทึกของผู้วิเคราะห์'), { target: { value: 'ตรวจสอบกล้อง CAM-02 แล้ว' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกและสร้าง Audit' }))
    expect(onAddNote).toHaveBeenCalledWith('demo-inc-001', 'ตรวจสอบกล้อง CAM-02 แล้ว')
  })

  it('shows the audit integrity state and requests a bounded export', () => {
    const onExport = vi.fn()
    render(<AuditPage snapshot={snapshot} onExport={onExport} />)
    expect(screen.getByText('Tamper evidence')).toBeVisible()
    expect(screen.getAllByText('session-admin').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'ขอส่งออกแบบจำกัด' }))
    expect(onExport).toHaveBeenCalledTimes(1)
  })
})
