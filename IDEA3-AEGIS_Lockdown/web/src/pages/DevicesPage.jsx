import React from 'react'
import { Box, Cpu, RadioTower, Router, Unplug, Waves } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { Timeline } from '../components/Timeline.jsx'
import { runtimeComponent } from '../lib/dashboard.js'
import { strictEvidenceStatus } from '../lib/evidence.js'
import { formatDateTime, formatEvidenceAge } from '../lib/format.js'

const columns = [
  { key: 'id', label: 'Device ID', render: (value) => <strong className="mono">{value}</strong> },
  { key: 'type', label: 'ประเภท' },
  { key: 'status', label: 'สถานะ (รายงาน)', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'lastSeen', label: 'Last seen', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'evidenceAgeMs', label: 'อายุหลักฐาน', render: (value) => <span className="mono">{formatEvidenceAge(value)}</span> },
  { key: 'heartbeat', label: 'Heartbeat', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'ack', label: 'ACK', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'requestedRelayState', label: 'Relay ที่ร้องขอ', render: (value) => <span className="mono">{value ?? 'UNKNOWN'}</span> },
  { key: 'relay', label: 'Relay evidence', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'firmwareVersion', label: 'Firmware', render: (value) => <span className="mono">{value ? `v${value}` : '—'}</span> },
]

function EmptyNote({ children }) {
  return <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>{children}</p></div>
}

export function DevicesPage({ snapshot }) {
  const devices = snapshot.devices ?? []
  const device = devices[0]
  const timeline = snapshot.runtime?.timeline ?? []
  const physical = device?.physicalRelayState
  const physicalKnown = Boolean(physical) && physical !== 'UNKNOWN'
  const adapter = snapshot.sources?.find((source) => source.id === 'idea3')

  // Each node reports its own evidence; none inherits health from another node or from a device merely existing.
  const topology = [
    { id: 'server', label: 'IDEA3 Server', detail: 'Adapter boundary (validation ล่าสุด)', icon: Router, status: adapter ? strictEvidenceStatus({ ...adapter, generatedAt: snapshot.runtime?.generatedAt ?? adapter.generatedAt }) : 'NOT_CONFIGURED' },
    { id: 'broker', label: 'MQTT Broker', detail: 'Observed only', icon: Waves, status: runtimeComponent(snapshot.runtime, 'broker').status },
    { id: 'device', label: device?.id || 'ESP32', detail: 'Heartbeat + ACK', icon: Cpu, status: device?.status || 'UNKNOWN' },
    { id: 'relay', label: 'Relay', detail: physicalKnown ? `Physical: ${physical}` : 'ไม่มีหลักฐานทางกายภาพ', icon: Unplug, status: device?.relay || 'UNKNOWN' },
  ]

  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four" aria-label="สรุปหลักฐานอุปกรณ์">
        <MetricCard icon={Box} label="อุปกรณ์ที่มีหลักฐาน" value={devices.length} status={device ? undefined : 'UNKNOWN'} detail={device ? 'จำนวนเท่านั้น ไม่ใช่สถานะสุขภาพ' : 'ไม่มีอุปกรณ์รายงานหลักฐาน'} />
        <MetricCard icon={RadioTower} label="Heartbeat" value={device?.heartbeat || 'UNKNOWN'} status={device?.heartbeat || 'UNKNOWN'} />
        <MetricCard icon={Cpu} label="ACK" value={device?.ack || 'UNKNOWN'} status={device?.ack || 'UNKNOWN'} detail="ตอบรับคำสั่ง ไม่ใช่สถานะ Relay" />
        <MetricCard icon={Unplug} label="Relay evidence" value={device?.relay || 'UNKNOWN'} status={device?.relay || 'UNKNOWN'} />
      </section>

      <Panel title="Observed topology" description="แสดงความสัมพันธ์จากหลักฐาน ไม่ใช่หน้าตั้งค่า topology · แต่ละจุดมีสถานะของตัวเอง">
        <ol className="topology-map" aria-label="Observed topology">
          {topology.map(({ id, label, detail, icon: Icon, status }, index) => (
            <React.Fragment key={id}>
              <li className="topology-node"><span className="icon-box"><Icon size={18} aria-hidden="true" /></span><strong>{label}</strong><small>{detail}</small><StatusBadge status={status} compact /></li>
              {index < topology.length - 1 && <li className="topology-link" aria-hidden="true"><span /><em className="mono">observed</em></li>}
            </React.Fragment>
          ))}
        </ol>
      </Panel>

      {device && <section className="device-detail-grid">
        <Panel title="Relay evidence separation" description="คำขอไม่เท่ากับหลักฐานทางกายภาพ">
          <div className="evidence-comparison">
            <article><p>REQUESTED STATE</p><strong>คำขอ: {device.requestedRelayState ?? 'UNKNOWN'}</strong><small>สิ่งที่ระบบร้องขอ ไม่มีหลักฐานว่าเกิดขึ้น</small></article>
            <div className="comparison-divider" aria-hidden="true">≠</div>
            <article><p>PHYSICAL EVIDENCE</p><strong>หลักฐานทางกายภาพ: {physical ?? 'UNKNOWN'}</strong><StatusBadge status={physicalKnown ? 'CONNECTED' : 'NOT_VERIFIED'} compact label={physicalKnown ? 'มี sensor' : undefined} /></article>
          </div>
          <p className="ledger-note">Heartbeat, ACK และ Relay evidence เป็นหลักฐานคนละชนิด — ACK ไม่ได้พิสูจน์ว่า Relay เปลี่ยนสถานะจริง และสถานะ UNKNOWN คงเป็น UNKNOWN จนกว่าจะมี sensor ยืนยัน</p>
        </Panel>
        <Panel title="Device evidence timeline" description={formatEvidenceAge(device.evidenceAgeMs)}>
          {timeline.length ? <Timeline items={timeline} /> : <EmptyNote>ยังไม่มีเหตุการณ์หลักฐานจาก runtime</EmptyNote>}
        </Panel>
      </section>}

      <Panel title="Device inventory" description="ทุกสถานะต้องมี timestamp และ evidence age">
        <DataTable columns={columns} rows={devices} emptyLabel="ยังไม่มีหลักฐานอุปกรณ์" ariaLabel="ตารางหลักฐานอุปกรณ์" wide />
      </Panel>
    </div>
  )
}
