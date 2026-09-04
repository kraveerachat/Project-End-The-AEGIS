import React from 'react'
import { Activity, BellRing, Database, ShieldAlert } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatCount, formatDateTime, formatEvidenceAge } from '../lib/format.js'

const sourceColumns = [
  { key: 'name', label: 'แหล่งหลักฐาน', render: (value, row) => <div className="primary-cell"><span className={`source-glyph source-glyph--${row.status.toLowerCase()}`} /><strong>{value}</strong><small>{row.detail}</small></div> },
  { key: 'status', label: 'สถานะ', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'generatedAt', label: 'หลักฐานล่าสุด', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'latencyMs', label: 'Latency', render: (value) => <span className="mono">{Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—'}</span> },
]

const eventColumns = [
  { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'source', label: 'แหล่ง', render: (value) => <span className="source-tag">{value}</span> },
  { key: 'type', label: 'ประเภท', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'sourceIp', label: 'Source IP', render: (value) => <span className="mono">{value}</span> },
  { key: 'severity', label: 'ระดับ', render: (value) => <span className={`severity severity--${value.toLowerCase()}`}>{value}</span> },
  { key: 'result', label: 'ผลลัพธ์' },
]

const remediation = {
  COMPONENT_FAILED: 'ตรวจสอบว่ามี sensor ยืนยันสถานะทางกายภาพก่อนเปิดใช้คำสั่งจริง',
  STATUS_STALE: 'ตรวจสอบแหล่งสถานะและเวลาระบบ จากนั้นโหลดหลักฐานอีกครั้ง',
  ADAPTER_UNAVAILABLE: 'ตรวจสอบปลายทาง adapter จากฝั่งเซิร์ฟเวอร์',
}

export function DashboardPage({ snapshot }) {
  const firstIncident = snapshot.incidents[0]
  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four" aria-label="สรุปสถานะ">
        <MetricCard icon={Database} label="หลักฐาน 24 ชั่วโมง" value={formatCount(snapshot.overall.eventCount)} status={snapshot.overall.status} detail={formatEvidenceAge(snapshot.overall.evidenceAgeMs)} />
        <MetricCard icon={Activity} label="เหตุการณ์ที่กำลังดำเนินการ" value={formatCount(snapshot.overall.activeIncidents)} suffix="รายการ" status={snapshot.overall.activeIncidents ? 'DEGRADED' : 'HEALTHY'} detail="อ้างอิงจาก correlation engine" />
        <MetricCard icon={BellRing} label="การแจ้งเตือนระดับสูง" value={formatCount(snapshot.overall.highAlerts)} suffix="รายการ" status={snapshot.overall.highAlerts ? 'DEGRADED' : 'HEALTHY'} detail="HIGH และ CRITICAL ที่ยังต้องตรวจสอบ" />
        <MetricCard icon={ShieldAlert} label="สถานะระบบโดยรวม" value={snapshot.overall.status} status={snapshot.overall.status} detail="สรุปจากหลักฐานที่ตรวจสอบแล้ว" />
      </section>

      <section className="dashboard-grid">
        <Panel className="dashboard-grid__wide" title="สถานะแหล่งหลักฐาน" description="สถานะ เวลา และ latency มาจากเซิร์ฟเวอร์ ไม่ได้อนุมานจากการเปิดหน้า">
          <DataTable columns={sourceColumns} rows={snapshot.sources} emptyLabel="ยังไม่มีหลักฐานจากแหล่งข้อมูล" />
        </Panel>
        <Panel title="เหตุการณ์ที่กำลังดำเนินการ" description="เหตุการณ์สัมพันธ์ข้ามระบบล่าสุด">
          {firstIncident ? (
            <article className="incident-spotlight">
              <div className="incident-spotlight__top"><span className="mono">{firstIncident.id}</span><span className={`severity severity--${firstIncident.severity.toLowerCase()}`}>{firstIncident.severity}</span></div>
              <h3>{firstIncident.title}</h3>
              <p>{firstIncident.summary}</p>
              <dl><div><dt>Source IP</dt><dd>{firstIncident.sourceIp}</dd></div><div><dt>สถานะ</dt><dd>{firstIncident.state}</dd></div><div><dt>ตอบสนอง</dt><dd>{firstIncident.responseState}</dd></div></dl>
            </article>
          ) : <div className="empty-state"><p>ไม่มีเหตุการณ์ที่กำลังดำเนินการ</p></div>}
        </Panel>
      </section>

      <section className="dashboard-grid">
        <Panel className="dashboard-grid__wide" title="หลักฐานล่าสุด" description="รายการที่ normalize และตัดข้อมูลต้องห้ามแล้ว">
          <DataTable columns={eventColumns} rows={snapshot.events.slice(0, 6)} emptyLabel="ไม่มีเหตุการณ์ในช่วงเวลานี้" />
        </Panel>
        <Panel title="ประเด็นที่ต้องตรวจสอบ" description="คำแนะนำเป็นข้อความคงที่จาก Web application">
          <div className="issue-list">
            {snapshot.runtime.issues.map((issue) => <article key={`${issue.code}-${issue.component}`}><StatusBadge status={issue.severity === 'CRITICAL' ? 'FAILED' : 'DEGRADED'} compact /><div><strong>{issue.code}</strong><p>{remediation[issue.code] || 'ตรวจสอบแหล่งหลักฐานจากระบบที่รับผิดชอบ'}</p></div><span className="mono">×{issue.count}</span></article>)}
          </div>
        </Panel>
      </section>
    </div>
  )
}
