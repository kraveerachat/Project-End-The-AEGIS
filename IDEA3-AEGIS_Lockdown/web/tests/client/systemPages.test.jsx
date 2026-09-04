import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DevicesPage } from '../../src/pages/DevicesPage.jsx'
import { RecoveryPage } from '../../src/pages/RecoveryPage.jsx'
import { SettingsPage } from '../../src/pages/SettingsPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('device evidence', () => {
  it('does not present a requested relay state as physically verified', () => {
    render(<DevicesPage snapshot={snapshot} />)
    expect(screen.getByText('คำขอ: OPEN')).toBeVisible()
    expect(screen.getByText('หลักฐานทางกายภาพ: UNKNOWN')).toBeVisible()
    expect(screen.getAllByText('ESP32-LOCK-01').length).toBeGreaterThan(0)
  })

  it('shows topology as observed relationships instead of configurable controls', () => {
    render(<DevicesPage snapshot={snapshot} />)
    expect(screen.getByText('Observed topology')).toBeVisible()
    expect(screen.queryByRole('button', { name: /เพิ่มอุปกรณ์|เชื่อมต่อ broker/i })).not.toBeInTheDocument()
  })
})

describe('safe recovery workflow', () => {
  it('runs validation only after the exact dry-run confirmation', () => {
    const onDryRun = vi.fn()
    render(<RecoveryPage snapshot={snapshot} onDryRun={onDryRun} />)
    const button = screen.getByRole('button', { name: 'ตรวจสอบความพร้อมแบบ Dry-run' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('พิมพ์ VALIDATE ONLY เพื่อยืนยัน'), { target: { value: 'VALIDATE ONLY' } })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onDryRun).toHaveBeenCalledWith('demo-inc-001', 'VALIDATE ONLY')
  })

  it('states that validation cannot publish MQTT or change the relay', () => {
    render(<RecoveryPage snapshot={snapshot} />)
    expect(screen.getByText(/ไม่ส่ง MQTT และไม่เปลี่ยนสถานะ Relay/)).toBeVisible()
    expect(screen.getByText('Recovery authorization')).toBeVisible()
  })
})

describe('safe settings', () => {
  it('toggles Demo through the server action boundary and states session scope', () => {
    const onDemoMode = vi.fn()
    render(<SettingsPage snapshot={snapshot} onDemoMode={onDemoMode} onSavePolicy={() => {}} />)
    const toggle = screen.getByRole('checkbox', { name: 'Demo Mode' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(onDemoMode).toHaveBeenCalledWith(false)
    expect(screen.getByText(/เฉพาะ session นี้/)).toBeVisible()
  })

  it('shows adapter aliases and policy without exposing credentials or command controls', () => {
    render(<SettingsPage snapshot={snapshot} onDemoMode={() => {}} onSavePolicy={() => {}} />)
    expect(screen.getByText('drive-security')).toBeVisible()
    expect(screen.getByText('CSRF')).toBeVisible()
    expect(document.body.textContent).not.toMatch(/mqttPassword|hmacSecret|CUT_UPLINK|RESTORE_UPLINK/)
  })
})
