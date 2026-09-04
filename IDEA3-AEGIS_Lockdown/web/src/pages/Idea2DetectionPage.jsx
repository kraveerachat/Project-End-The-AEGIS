import React, { useMemo, useState } from 'react'
import { Camera, Eye, Radar, TriangleAlert } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatCount, formatDateTime } from '../lib/format.js'

const columns = [
  { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'type', label: 'Detection', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'severity', label: 'Severity', render: (value) => <span className={`severity severity--${value.toLowerCase()}`}>{value}</span> },
  { key: 'sourceIp', label: 'Source IP', render: (value) => <span className="mono">{value}</span> },
  { key: 'target', label: 'Camera / target', render: (value) => <span className="source-tag">{value}</span> },
  { key: 'result', label: 'Result' },
]

export function Idea2DetectionPage({ snapshot }) {
  const [severity, setSeverity] = useState('ALL')
  const events = useMemo(() => snapshot.idea2.events.filter((event) => severity === 'ALL' || event.severity === severity), [snapshot, severity])
  const summary = snapshot.idea2.summary
  return (
    <div className="page-stack">
      <section className="evidence-intro"><div><p className="kicker">PRIVACY-PRESERVING EVIDENCE</p><h2>หลักฐานการตรวจจับจาก IDEA2</h2><p>Security Center ไม่รับภาพ วิดีโอ embedding ข้อมูลใบหน้า หรือ PII</p></div><StatusBadge status={snapshot.idea2.status} /></section>
      <section className="metric-grid metric-grid--four">
        <MetricCard icon={Radar} label="การตรวจจับทั้งหมด" value={formatCount(summary.detections)} />
        <MetricCard icon={TriangleAlert} label="ระดับ HIGH" value={formatCount(summary.high)} status={summary.high ? 'DEGRADED' : 'HEALTHY'} />
        <MetricCard icon={Eye} label="ระดับ CRITICAL" value={formatCount(summary.critical)} status={summary.critical ? 'FAILED' : 'HEALTHY'} />
        <MetricCard icon={Camera} label="แหล่งกล้อง" value={formatCount(summary.cameras)} />
      </section>
      <Panel title="Detection evidence ledger" description="แสดงเฉพาะข้อมูล normalize ที่ใช้วิเคราะห์เหตุการณ์" action={<label className="compact-filter">ระดับ<select aria-label="กรองระดับ IDEA2" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="ALL">ทั้งหมด</option><option value="WARNING">WARNING</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option></select></label>}>
        <DataTable columns={columns} rows={events} emptyLabel="ไม่มีหลักฐาน IDEA2 ตามตัวกรองนี้" />
      </Panel>
      <section className="privacy-callout"><Eye size={18} /><div><strong>Correlation candidate</strong><p>Source IP และกรอบเวลาใช้สร้าง candidate เท่านั้น ระบบไม่ระบุตัวบุคคลหรือสรุปเจตนา</p></div></section>
    </div>
  )
}
