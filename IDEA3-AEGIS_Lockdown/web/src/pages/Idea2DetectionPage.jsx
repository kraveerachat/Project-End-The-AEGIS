import React, { useMemo, useState } from 'react'
import { Camera, Eye, Radar, TriangleAlert } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { SourceStatusBar } from '../components/SourceStatusBar.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { domainView, evidenceAgeAt, evidenceCount, zeroAwareStatus } from '../lib/evidence.js'
import { formatDateTime } from '../lib/format.js'

const SEVERITIES = new Set(['INFO', 'WARNING', 'HIGH', 'CRITICAL'])

function untrustedNote(status) {
  return `แหล่งข้อมูลอยู่ในสถานะ ${status} ค่า 0 หรือตารางว่างจึงไม่ได้พิสูจน์ว่าปลอดภัย — หมายถึงยังไม่มีหลักฐานที่ตรวจสอบได้`
}

function makeColumns(snapshotTimestamp) {
  return [
    { key: 'timestamp', label: 'เวลา', render: (value) => <span className="evidence-time"><span className="mono">{formatDateTime(value)}</span><small>{evidenceAgeAt(value, snapshotTimestamp)}</small></span> },
    { key: 'type', label: 'Detection', render: (value) => <strong className="table-strong">{value ?? '—'}</strong> },
    { key: 'severity', label: 'Severity', render: (value) => <span className={`severity severity--${SEVERITIES.has(value) ? value.toLowerCase() : 'info'}`}>{value ?? '—'}</span> },
    { key: 'sourceIp', label: 'Source IP', render: (value) => value ? <span className="mono">{value}</span> : <span className="not-provided">ไม่ระบุ</span> },
    { key: 'target', label: 'Camera / target', render: (value) => value ? <span className="source-tag">{value}</span> : <span className="not-provided">ไม่ระบุ</span> },
    { key: 'result', label: 'Result', render: (value) => value ?? '—' },
  ]
}

export function Idea2DetectionPage({ snapshot }) {
  const [severity, setSeverity] = useState('ALL')
  const view = domainView(snapshot.idea2)
  const events = useMemo(() => view.events.filter((event) => severity === 'ALL' || event.severity === severity), [view.events, severity])
  const { summary } = view
  const count = (value) => evidenceCount(value, view.trusted)
  const emptyLabel = !view.trusted
    ? `ไม่มีหลักฐาน IDEA2 ให้แสดง เพราะแหล่งข้อมูลอยู่ในสถานะ ${view.status}`
    : severity === 'ALL' ? 'แหล่งข้อมูลรายงานว่าไม่มี detection ในหน้าต่างเวลานี้' : 'ไม่มีหลักฐาน IDEA2 ตามตัวกรองนี้'
  return (
    <div className="page-stack">
      <section className="evidence-intro"><div><p className="kicker">PRIVACY-PRESERVING EVIDENCE</p><h2>หลักฐานการตรวจจับจาก IDEA2</h2><p>Security Center ไม่รับภาพ วิดีโอ embedding ข้อมูลใบหน้า หรือ PII</p></div><StatusBadge status={view.status} /></section>
      <SourceStatusBar label="สถานะแหล่งข้อมูล IDEA2" status={view.status} generatedAt={view.generatedAt} age={evidenceAgeAt(view.generatedAt, snapshot.generatedAt)} note={view.trusted ? undefined : untrustedNote(view.status)} />
      <section className="metric-grid metric-grid--four" aria-label="สรุปหลักฐาน IDEA2">
        <MetricCard icon={Radar} label="การตรวจจับทั้งหมด" value={count(summary.detections)} status={view.trusted ? undefined : view.status} />
        <MetricCard icon={TriangleAlert} label="ระดับ HIGH" value={count(summary.high)} status={zeroAwareStatus(summary.high, view.trusted, view.status, 'DEGRADED')} />
        <MetricCard icon={Eye} label="ระดับ CRITICAL" value={count(summary.critical)} status={zeroAwareStatus(summary.critical, view.trusted, view.status, 'FAILED')} />
        <MetricCard icon={Camera} label="แหล่งกล้อง" value={count(summary.cameras)} status={view.trusted ? undefined : view.status} />
      </section>
      <Panel title="Detection evidence ledger" description="แสดงเฉพาะข้อมูล normalize ที่ใช้วิเคราะห์เหตุการณ์" action={<label className="compact-filter">ระดับ<select aria-label="กรองระดับ IDEA2" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="ALL">ทั้งหมด</option><option value="WARNING">WARNING</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option></select></label>}>
        <DataTable columns={makeColumns(snapshot.generatedAt)} rows={events} emptyLabel={emptyLabel} ariaLabel="ตารางหลักฐาน IDEA2" />
        <p className="ledger-note">Severity และ camera/target มาจาก producer ตามที่ผ่าน allowlist — สถานะแหล่งข้อมูลด้านบนคือสถานะ adapter ไม่ใช่การยืนยันว่ากล้องทำงาน</p>
      </Panel>
      <section className="privacy-callout"><Eye size={18} aria-hidden="true" /><div><strong>Correlation candidate</strong><p>Source IP และกรอบเวลาใช้สร้าง candidate เท่านั้น ระบบไม่ระบุตัวบุคคลหรือสรุปเจตนา</p></div></section>
    </div>
  )
}
