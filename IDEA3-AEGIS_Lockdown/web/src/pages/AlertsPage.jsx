import React, { useMemo, useState } from 'react'
import { BellRing, CheckCheck, Flame, TriangleAlert } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { formatCount, formatDateTime } from '../lib/format.js'

export function AlertsPage({ snapshot, onAcknowledge = () => {} }) {
  const [severity, setSeverity] = useState('ALL')
  const alerts = useMemo(() => snapshot.alerts.filter((alert) => severity === 'ALL' || alert.severity === severity), [snapshot, severity])
  const unacknowledged = snapshot.alerts.filter((alert) => alert.status === 'UNACKNOWLEDGED').length
  const columns = [
    { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
    { key: 'id', label: 'Alert ID', render: (value) => <span className="mono">{value}</span> },
    { key: 'source', label: 'Source', render: (value) => <span className="source-tag">{value}</span> },
    { key: 'type', label: 'Type', render: (value) => <strong className="table-strong">{value}</strong> },
    { key: 'severity', label: 'Severity', render: (value) => <span className={`severity severity--${value.toLowerCase()}`}>{value}</span> },
    { key: 'sourceIp', label: 'Source IP', render: (value) => <span className="mono">{value}</span> },
    { key: 'dedupCount', label: 'Dedup', render: (value) => <span className="mono">×{value}</span> },
    { key: 'status', label: 'การจัดการ', render: (value, row) => value === 'ACKNOWLEDGED' ? <span className="ack-label"><CheckCheck size={14} />รับทราบแล้ว</span> : <button className="button button--secondary button--small" onClick={() => onAcknowledge(row.id)}>รับทราบ</button> },
  ]
  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four">
        <MetricCard icon={BellRing} label="การแจ้งเตือนทั้งหมด" value={formatCount(snapshot.alerts.length)} />
        <MetricCard icon={TriangleAlert} label="ยังไม่รับทราบ" value={formatCount(unacknowledged)} status={unacknowledged ? 'DEGRADED' : 'HEALTHY'} />
        <MetricCard icon={Flame} label="HIGH" value={formatCount(snapshot.alerts.filter((item) => item.severity === 'HIGH').length)} />
        <MetricCard icon={Flame} label="CRITICAL" value={formatCount(snapshot.alerts.filter((item) => item.severity === 'CRITICAL').length)} status="FAILED" />
      </section>
      <Panel title="Alert triage" description="Severity, dedup และ escalation คำนวณจากฝั่งเซิร์ฟเวอร์" action={<label className="compact-filter">ระดับ<select aria-label="กรองระดับ Alert" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="ALL">ทั้งหมด</option><option value="WARNING">WARNING</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option></select></label>}>
        <DataTable columns={columns} rows={alerts} emptyLabel="ไม่มี Alert ตามตัวกรองนี้" />
      </Panel>
      <section className="audit-note"><CheckCheck size={17} /><span>การรับทราบทุกครั้งต้องผ่าน Admin session + CSRF และสร้าง Audit record</span></section>
    </div>
  )
}
