import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LabMqttPanel } from '../../src/components/LabMqttObservation.jsx'

const observed = {
  enabled: true, evidenceState: 'OBSERVED', freshness: 'FRESH', reportedState: 'LOCKDOWN', rssi: -10, freeHeap: 250196, profile: 0,
  timeOk: true, lastReceivedAt: '2026-10-17T05:00:00.000Z', ageMs: 3000,
}
const unknown = { ...observed, evidenceState: 'UNKNOWN', freshness: 'STALE', reportedState: null, rssi: null, freeHeap: null, profile: null, timeOk: null }

describe('LAB MQTT Observation panel', () => {
  it('labels observed values as ESP32-reported, observational and not Core/relay proof', () => {
    render(<LabMqttPanel evidence={observed} />)
    const panel = screen.getByRole('region', { name: 'LAB MQTT Observation' })
    expect(panel).toHaveTextContent('LOCKDOWN (รายงานโดย ESP32 — ไม่ใช่การยืนยัน Relay)')
    expect(panel).toHaveTextContent('-10 dBm')
    expect(panel).toHaveTextContent('250196 bytes')
    expect(panel).toHaveTextContent('LAB_MQTT_OBSERVER (subscribe-only)')
    expect(panel).toHaveTextContent('ไม่ใช่ signed Core heartbeat')
    expect(panel).not.toHaveTextContent(/HEALTHY/)
  })

  it('shows UNKNOWN for every field when evidence is stale or missing', () => {
    render(<LabMqttPanel evidence={unknown} />)
    const panel = screen.getByRole('region', { name: 'LAB MQTT Observation' })
    expect(panel.textContent.match(/UNKNOWN/g).length).toBeGreaterThanOrEqual(5)
    expect(panel).toHaveTextContent('STALE')
    expect(panel).not.toHaveTextContent('LOCKDOWN (')
  })
})
