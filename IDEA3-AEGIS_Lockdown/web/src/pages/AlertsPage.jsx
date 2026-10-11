import React, { useMemo, useState } from 'react'
import { BellRing, CheckCheck, Flame, TriangleAlert } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { evidenceCount, overallEvidence, zeroAwareStatus } from '../lib/evidence.js'
import { formatDateTime } from '../lib/format.js'

const SEVERITIES = new Set(['INFO', 'WARNING', 'HIGH', 'CRITICAL'])

export function AlertsPage({ snapshot, onAcknowledge = () => {} }) {
  const [severity, setSeverity] = useState('ALL')
  const all = snapshot.alerts ?? []
  const trust = overallEvidence(snapshot)
  const alerts = useMemo(() => all.filter((alert) => severity === 'ALL' || alert.severity === severity), [all, severity])
  const unacknowledged = all.filter((alert) => alert.status === 'UNACKNOWLEDGED').length
  const high = all.filter((item) => item.severity === 'HIGH').length
  const critical = all.filter((item) => item.severity === 'CRITICAL').length
  const count = (value) => evidenceCount(value, trust.trusted)
  const columns = [
    { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
    { key: 'id', label: 'Alert ID', render: (value) => <span className="mono">{value}</span> },
    { key: 'source', label: 'Source', render: (value) => <span className="source-tag">{value ?? '—'}</span> },
    { key: 'type', label: 'Type', render: (value) => <strong className="table-strong">{value ?? '—'}</strong> },
    { key: 'severity', label: 'Severity', render: (value) => <span className={`severity severity--${SEVERITIES.has(value) ? value.toLowerCase() : 'info'}`}>{value ?? '—'}</span> },
    { key: 'sourceIp', label: 'Source IP', render: (value) => value ? <span className="mono">{value}</span> : <span className="not-provided">ไม่ระบุ</span> },
    { key: 'dedupCount', label: 'Dedup', render: (value) => <span className="mono">×{value ?? 1}</span> },
    { key: 'status', label: 'การจัดการ', render: (value, row) => value === 'ACKNOWLEDGED'
      ? <span className="ack-label"><CheckCheck size={14} aria-hidden="true" />รับทราบแล้ว</span>
      : <button type="button" className="button button--secondary button--small" onClick={() => onAcknowledge(row.id)}>รับทราบ</button> },
  ]
  const emptyLabel = all.length === 0 && !trust.trusted
    ? `ไม่มี Alert ที่รายงาน — หลักฐานอยู่ในสถานะ ${trust.status} จึงยังสรุปไม่ได้ว่าไม่มีเหตุ`
    : all.length === 0 ? 'ไม่มี Alert ที่เซิร์ฟเวอร์รายงาน' : 'ไม่มี Alert ตามตัวกรองนี้'
  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four" aria-label="สรุป Alert">
        <MetricCard icon={BellRing} label="การแจ้งเตือนทั้งหมด" value={count(all.length)} status={trust.trusted ? undefined : trust.status} />
        <MetricCard icon={TriangleAlert} label="ยังไม่รับทราบ" value={count(unacknowledged)} status={zeroAwareStatus(unacknowledged, trust.trusted, trust.status, 'DEGRADED')} />
        <MetricCard icon={Flame} label="HIGH" value={count(high)} status={trust.trusted ? undefined : trust.status} />
        <MetricCard icon={Flame} label="CRITICAL" value={count(critical)} status={zeroAwareStatus(critical, trust.trusted, trust.status, 'FAILED')} />
      </section>
      <Panel title="Alert triage" description="Severity, dedup และ escalation คำนวณจากฝั่งเซิร์ฟเวอร์" action={<label className="compact-filter">ระดับ<select aria-label="กรองระดับ Alert" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="ALL">ทั้งหมด</option><option value="WARNING">WARNING</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option></select></label>}>
        <DataTable columns={columns} rows={alerts} emptyLabel={emptyLabel} ariaLabel="ตาราง Alert" />
      </Panel>
      <section className="audit-note"><CheckCheck size={17} aria-hidden="true" /><span>การรับทราบทุกครั้งต้องผ่าน Admin session + CSRF และสร้าง Audit record — ปุ่มไม่เปลี่ยนสถานะเองจนกว่าเซิร์ฟเวอร์ยืนยัน</span></section>
    </div>
  )
}
