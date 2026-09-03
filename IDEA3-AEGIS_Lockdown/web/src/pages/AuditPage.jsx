import React from 'react'
import { Archive, Download, FileCheck2, ShieldCheck } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { formatCount, formatDateTime } from '../lib/format.js'

const columns = [
  { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'id', label: 'Audit ID', render: (value) => <span className="mono">{value}</span> },
  { key: 'category', label: 'Category', render: (value) => <span className="source-tag">{value}</span> },
  { key: 'action', label: 'Action', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'outcome', label: 'Outcome', render: (value) => <span className="severity severity--info">{value}</span> },
  { key: 'actorRef', label: 'Actor', render: (value) => <span className="mono">{value}</span> },
  { key: 'resourceId', label: 'Resource', render: (value) => <span className="mono">{value}</span> },
]

export function AuditPage({ snapshot, onExport = () => {} }) {
  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four">
        <MetricCard icon={FileCheck2} label="Audit records" value={formatCount(snapshot.audit.length)} status="HEALTHY" />
        <MetricCard icon={ShieldCheck} label="Tamper evidence" value="VERIFIED" status="HEALTHY" detail="ตรวจสอบ chain ล่าสุดสำเร็จ" />
        <MetricCard icon={Archive} label="Retention" value="180" suffix="วัน" detail="นโยบาย Demo" />
        <MetricCard icon={Download} label="Export limit" value="1,000" suffix="records" detail="ทุก export ถูก Audit" />
      </section>
      <Panel title="Security audit ledger" description="แยกจาก operational event และไม่มี token, secret หรือ raw exception" action={<button className="button button--secondary" onClick={onExport}><Download size={15} />ขอส่งออกแบบจำกัด</button>}>
        <DataTable columns={columns} rows={snapshot.audit} emptyLabel="ยังไม่มี Audit record" />
      </Panel>
      <section className="audit-note"><ShieldCheck size={17} /><span>โครงสร้างถาวรต้องผ่านการทบทวน retention, index, privacy, backup/restore และ rollback ก่อนใช้งานจริง</span></section>
    </div>
  )
}
