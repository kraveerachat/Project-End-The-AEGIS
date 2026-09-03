import React from 'react'
import { Box, Cpu, RadioTower, Router, Unplug, Waves } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { Timeline } from '../components/Timeline.jsx'
import { formatDateTime, formatEvidenceAge } from '../lib/format.js'

export function DevicesPage({ snapshot }) {
  const device = snapshot.devices[0]
  const columns = [
    { key: 'id', label: 'Device ID', render: (value) => <strong className="mono">{value}</strong> },
    { key: 'type', label: 'ประเภท' },
    { key: 'status', label: 'สถานะ', render: (value) => <StatusBadge status={value} compact /> },
    { key: 'lastSeen', label: 'Last seen', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
    { key: 'heartbeat', label: 'Heartbeat', render: (value) => <StatusBadge status={value} compact /> },
    { key: 'ack', label: 'ACK', render: (value) => <StatusBadge status={value} compact /> },
    { key: 'relay', label: 'Relay evidence', render: (value) => <StatusBadge status={value} compact /> },
    { key: 'firmwareVersion', label: 'Firmware', render: (value) => <span className="mono">v{value}</span> },
  ]

  const topology = [
    { id: 'server', label: 'IDEA3 Server', detail: 'Adapter boundary', icon: Router, status: 'HEALTHY' },
    { id: 'broker', label: 'MQTT Broker', detail: 'Observed only', icon: Waves, status: 'HEALTHY' },
    { id: 'device', label: device?.id || 'ESP32', detail: 'Heartbeat + ACK', icon: Cpu, status: device?.status || 'UNKNOWN' },
    { id: 'relay', label: 'Relay', detail: 'Physical sensor absent', icon: Unplug, status: device?.relay || 'UNKNOWN' },
  ]

  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four">
        <MetricCard icon={Box} label="อุปกรณ์ที่มีหลักฐาน" value={snapshot.devices.length} status={device ? 'HEALTHY' : 'UNKNOWN'} />
        <MetricCard icon={RadioTower} label="Heartbeat" value={device?.heartbeat || 'UNKNOWN'} status={device?.heartbeat || 'UNKNOWN'} />
        <MetricCard icon={Cpu} label="ACK" value={device?.ack || 'UNKNOWN'} status={device?.ack || 'UNKNOWN'} />
        <MetricCard icon={Unplug} label="Relay evidence" value={device?.relay || 'UNKNOWN'} status={device?.relay || 'UNKNOWN'} />
      </section>

      <Panel title="Observed topology" description="แสดงความสัมพันธ์จากหลักฐาน ไม่ใช่หน้าตั้งค่า topology">
        <div className="topology-map">{topology.map(({ id, label, detail, icon: Icon, status }, index) => <React.Fragment key={id}><article className="topology-node"><span className="icon-box"><Icon size={18} /></span><strong>{label}</strong><small>{detail}</small><StatusBadge status={status} compact /></article>{index < topology.length - 1 && <div className="topology-link"><span /><em className="mono">observed</em></div>}</React.Fragment>)}</div>
      </Panel>

      <Panel title="Device inventory" description="ทุกสถานะต้องมี timestamp และ evidence age">
        <DataTable columns={columns} rows={snapshot.devices} emptyLabel="ยังไม่มีหลักฐานอุปกรณ์" />
      </Panel>

      {device && <section className="device-detail-grid">
        <Panel title="Relay evidence separation" description="คำขอไม่เท่ากับหลักฐานทางกายภาพ">
          <div className="evidence-comparison"><article><p>REQUESTED STATE</p><strong>คำขอ: {device.requestedRelayState}</strong><StatusBadge status="HEALTHY" compact /></article><div className="comparison-divider">≠</div><article><p>PHYSICAL EVIDENCE</p><strong>หลักฐานทางกายภาพ: {device.physicalRelayState}</strong><StatusBadge status={device.physicalRelayState} compact /></article></div>
        </Panel>
        <Panel title="Device evidence timeline" description={formatEvidenceAge(device.evidenceAgeMs)}>
          <Timeline items={snapshot.runtime.timeline} />
        </Panel>
      </section>}
    </div>
  )
}
