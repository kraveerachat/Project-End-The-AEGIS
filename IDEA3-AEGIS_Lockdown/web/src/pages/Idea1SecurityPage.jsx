import React, { useMemo, useState } from 'react'
import { Ban, Fingerprint, ShieldX, Users } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatCount, formatDateTime } from '../lib/format.js'

const columns = [
  { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'action', label: 'Action', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'result', label: 'Result', render: (value) => <span className={`severity severity--${value === 'BLOCKED' ? 'high' : 'warning'}`}>{value}</span> },
  { key: 'sourceIp', label: 'Source IP', render: (value) => <span className="mono">{value}</span> },
  { key: 'severity', label: 'Severity' },
  { key: 'dedupCount', label: 'ซ้ำ', render: (value) => <span className="mono">×{value ?? 1}</span> },
]

export function Idea1SecurityPage({ snapshot }) {
  const [result, setResult] = useState('ALL')
  const events = useMemo(() => snapshot.idea1.events.filter((event) => result === 'ALL' || event.result === result), [snapshot, result])
  const summary = snapshot.idea1.summary
  return (
    <div className="page-stack">
      <section className="evidence-intro"><div><p className="kicker">READ-ONLY PRODUCER CONTRACT</p><h2>หลักฐานการปฏิเสธสิทธิ์จาก IDEA1</h2><p>รับเฉพาะ timestamp, action, result และ source_ip จาก sanitized endpoint</p></div><StatusBadge status={snapshot.idea1.status} /></section>
      <section className="metric-grid metric-grid--five">
        <MetricCard icon={ShieldX} label="DENIED" value={formatCount(summary.denied)} status="DEGRADED" />
        <MetricCard icon={Ban} label="BLOCKED" value={formatCount(summary.blocked)} status="DEGRADED" />
        <MetricCard icon={Fingerprint} label="Source IP ที่ไม่ซ้ำ" value={formatCount(summary.uniqueSourceIps)} />
        <MetricCard icon={Users} label="กิจกรรมซ้ำ" value={formatCount(summary.repeated)} />
        <MetricCard icon={ShieldX} label="ยกระดับ" value={formatCount(summary.escalated)} status={summary.escalated ? 'DEGRADED' : 'HEALTHY'} />
      </section>
      <Panel title="Access evidence ledger" description="ตัด raw request, token, path และข้อมูลรับรองออกก่อนจัดเก็บ" action={<label className="compact-filter">ผลลัพธ์<select aria-label="กรองผลลัพธ์ IDEA1" value={result} onChange={(event) => setResult(event.target.value)}><option value="ALL">ทั้งหมด</option><option value="DENIED">DENIED</option><option value="BLOCKED">BLOCKED</option></select></label>}>
        <DataTable columns={columns} rows={events} emptyLabel="ไม่มีหลักฐาน IDEA1 ตามตัวกรองนี้" />
      </Panel>
      <Panel title="สัญญาการเชื่อมต่อ" description="สถานะ adapter ที่รายงานจากเซิร์ฟเวอร์">
        <div className="contract-strip"><span><i />Configured by server</span><span><i />Allowlisted fields</span><span><i />Bounded response</span><span><i />No producer database access</span></div>
      </Panel>
    </div>
  )
}
