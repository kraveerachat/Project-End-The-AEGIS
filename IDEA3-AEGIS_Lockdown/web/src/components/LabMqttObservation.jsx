import React, { useEffect, useState } from 'react'
import { Panel } from './Panel.jsx'
import { apiFetch } from '../lib/api.js'
import { formatDateTime, formatEvidenceAge } from '../lib/format.js'

const REFRESH_MS = 10_000
const UNKNOWN = 'UNKNOWN'

const freshnessLabel = { FRESH: 'FRESH', STALE: 'STALE' }

function show(value, suffix = '') {
  return value === null || value === undefined ? UNKNOWN : `${value}${suffix}`
}

function timeOk(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return UNKNOWN
}

export function LabMqttPanel({ evidence }) {
  const observed = evidence.evidenceState === 'OBSERVED'
  const rows = [
    ['ESP32 reported state', observed ? `${evidence.reportedState} (รายงานโดย ESP32 — ไม่ใช่การยืนยัน Relay)` : UNKNOWN],
    ['RSSI', show(evidence.rssi, ' dBm')],
    ['Free heap', show(evidence.freeHeap, ' bytes')],
    ['Profile', show(evidence.profile)],
    ['time_ok', timeOk(evidence.timeOk)],
    ['Last received (local clock)', evidence.lastReceivedAt ? formatDateTime(evidence.lastReceivedAt, 'th') : UNKNOWN],
    ['Evidence freshness', `${freshnessLabel[evidence.freshness] ?? UNKNOWN}${observed ? ` · ${formatEvidenceAge(evidence.ageMs)}` : ''}`],
  ]
  return (
    <Panel title="LAB MQTT Observation" description="LAB · read-only · observational — aegis/status บน loopback broker ไม่ใช่ Core safe_status_projection" className="lab-mqtt-panel" ariaLabel="LAB MQTT Observation">
      <div className="readiness-ledger">
        {rows.map(([label, value]) => <div key={label}><span>{label}</span><span className="mono">{value}</span></div>)}
      </div>
      <small>แหล่งที่มา: LAB_MQTT_OBSERVER (subscribe-only) · เวลาอ้างอิงคือเวลารับข้อความในเครื่องนี้ · reason=heartbeat เป็นเพียงเหตุผลสถานะของ ESP32 ไม่ใช่ signed Core heartbeat · ไม่ยืนยัน Core, Relay ทางกายภาพ, ACK หรือการแยก LAN</small>
    </Panel>
  )
}

/** Renders nothing until the server reports the LAB observer enabled; after that an outage shows UNKNOWN, never old data. */
export function LabMqttSection() {
  const [evidence, setEvidence] = useState(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const next = await apiFetch('/security/lab-mqtt')
        if (active) setEvidence(next)
      } catch {
        if (active) setEvidence((current) => (current?.enabled ? {
          ...current, evidenceState: UNKNOWN, freshness: UNKNOWN, reportedState: null, rssi: null, freeHeap: null, profile: null, timeOk: null, ageMs: null,
        } : null))
      }
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { active = false; clearInterval(timer) }
  }, [])

  return evidence?.enabled ? <LabMqttPanel evidence={evidence} /> : null
}
