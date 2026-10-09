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

const coreAuditColumns = [
  { key: 'eventType', label: 'Core event', render: (value) => <span className="source-tag">{value}</span> },
  { key: 'count', label: 'Count', render: (value) => <span className="mono">{formatCount(value)}</span> },
  { key: 'freshness', label: 'Freshness', render: (value) => <span className="severity severity--info">{value}</span> },
]

// The audit store is an append-oriented SQLite ledger (Live) or an unchained in-memory ledger (Demo). Neither
// verifies a tamper-evidence hash chain today, so the page must never claim one was verified.
const policyCount = (value) => (Number.isSafeInteger(value) ? formatCount(value) : '—')

export function AuditPage({ snapshot, onExport = () => {} }) {
  const policy = snapshot.settings?.policy ?? {}
  const policyDetail = snapshot.mode === 'DEMO' ? 'นโยบาย Demo (จำลอง)' : 'นโยบายที่ตั้งไว้ในระบบ'
  const coreAudit = snapshot.integration?.idea3?.audit
  const coreAuditRows = Object.entries(coreAudit?.counts ?? {}).map(([eventType, count]) => ({
    id: `core-${eventType}`,
    eventType,
    count,
    freshness: coreAudit.freshness,
  }))
  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four">
        <MetricCard icon={FileCheck2} label="Audit records" value={formatCount(snapshot.audit.length)} status="HEALTHY" />
        <MetricCard icon={ShieldCheck} label="Tamper evidence" value="NOT VERIFIED" status="UNKNOWN" detail="ยังไม่มีการตรวจ hash-chain ของ audit store" />
        <MetricCard icon={Archive} label="Retention" value={policyCount(policy.auditRetentionDays)} suffix="วัน" detail={policyDetail} />
        <MetricCard icon={Download} label="Export limit" value={policyCount(policy.exportLimit)} suffix="records" detail="ทุก export ถูก Audit" />
      </section>
      <Panel title="Security audit ledger" description="แยกจาก operational event และไม่มี token, secret หรือ raw exception" action={<button className="button button--secondary" onClick={onExport}><Download size={15} />ขอส่งออกแบบจำกัด</button>}>
        <DataTable columns={columns} rows={snapshot.audit} emptyLabel="ยังไม่มี Audit record" />
      </Panel>
      <Panel title="IDEA3 Core audit aggregates" description="จำนวนเหตุการณ์ที่อ่านได้จาก Core SQLite แบบ allowlisted; ไม่ใช่ Web audit timeline">
        <p className="audit-note"><span>Latest Core evidence (global)</span><span className="mono">{formatDateTime(coreAudit?.latestAt)}</span></p>
        <DataTable columns={coreAuditColumns} rows={coreAuditRows} emptyLabel="ยังไม่มี Core audit aggregate" />
      </Panel>
      <section className="audit-note"><ShieldCheck size={17} /><span>โครงสร้างถาวรต้องผ่านการทบทวน retention, index, privacy, backup/restore และ rollback ก่อนใช้งานจริง</span></section>
    </div>
  )
}
