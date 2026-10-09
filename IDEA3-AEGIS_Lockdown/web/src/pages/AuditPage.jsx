import React from 'react'
import { Archive, Database, Download, FileCheck2, ShieldCheck } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { safeStatus, safeText, strictEvidenceStatus } from '../lib/evidence.js'
import { formatCount, formatDateTime } from '../lib/format.js'

const BAD_OUTCOMES = new Set(['FAILURE', 'FAILED', 'DENIED', 'ERROR'])

const columns = [
  { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'id', label: 'Audit ID', render: (value) => <span className="mono">{value}</span> },
  { key: 'category', label: 'Category', render: (value) => <span className="source-tag">{value ?? '—'}</span> },
  { key: 'action', label: 'Action', render: (value) => <strong className="table-strong">{value ?? '—'}</strong> },
  { key: 'outcome', label: 'Outcome', render: (value) => <span className={`severity severity--${BAD_OUTCOMES.has(value) ? 'high' : 'info'}`}>{value ?? '—'}</span> },
  { key: 'actorRef', label: 'Actor', render: (value) => <span className="mono">{value ?? '—'}</span> },
  { key: 'resourceId', label: 'Resource', render: (value) => <span className="mono">{value ?? '—'}</span> },
]

const coreAuditColumns = [
  { key: 'eventType', label: 'Core event', render: (value) => <span className="source-tag">{value}</span> },
  { key: 'count', label: 'Count', render: (value) => <span className="mono">{formatCount(value)}</span> },
  { key: 'freshness', label: 'Freshness', render: (value) => <span className="severity severity--info">{value}</span> },
]

// The audit store is an append-oriented SQLite ledger (Live) or an unchained in-memory ledger (Demo). Neither
// verifies a tamper-evidence hash chain today, so the page must never claim one was verified.
export function AuditPage({ snapshot, onExport = () => {} }) {
  const audit = snapshot.audit ?? []
  const policy = snapshot.settings?.policy ?? {}
  const provenance = snapshot.provenance ?? {}
  const integrity = snapshot.auditIntegrity
  const integrityStatus = integrity ? strictEvidenceStatus(integrity) : 'UNKNOWN'
  const integrityVerified = integrityStatus === 'HEALTHY'
  const persistence = safeText(provenance.persistence, 'NOT_CONFIGURED')
  const durable = persistence.includes('SQLITE')
  const limit = Number.isFinite(policy.exportLimit) ? formatCount(policy.exportLimit) : '—'
  const retention = Number.isFinite(policy.auditRetentionDays) ? formatCount(policy.auditRetentionDays) : '—'
  const coreAudit = snapshot.integration?.idea3?.audit
  const coreAuditRows = Object.entries(coreAudit?.counts ?? {}).map(([eventType, count]) => ({
    id: `core-${eventType}`,
    eventType,
    count,
    freshness: coreAudit?.freshness ?? 'UNKNOWN',
  }))
  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four" aria-label="สรุป Audit">
        <MetricCard icon={FileCheck2} label="Audit records" value={formatCount(audit.length)} detail="จำนวนที่โหลดมา ไม่ใช่ความสมบูรณ์ของ ledger" />
        <MetricCard icon={ShieldCheck} label="Tamper evidence" value={integrityVerified ? 'VERIFIED' : integrityStatus === 'UNKNOWN' ? 'NOT VERIFIED' : integrityStatus} status={integrityVerified ? 'HEALTHY' : integrityStatus === 'UNKNOWN' ? 'NOT_VERIFIED' : safeStatus(integrityStatus)} detail={integrity ? 'ผลตรวจ chain ที่เซิร์ฟเวอร์รายงาน' : 'snapshot ไม่มีผลตรวจ tamper evidence'} />
        <MetricCard icon={Archive} label="Retention" value={retention} suffix={retention === '—' ? undefined : 'วัน'} detail={snapshot.mode === 'DEMO' ? 'นโยบาย Demo' : 'นโยบายจากเซิร์ฟเวอร์'} />
        <MetricCard icon={Download} label="Export limit" value={limit} suffix={limit === '—' ? undefined : 'records'} detail="ทุก export ถูก Audit" />
      </section>
      <section className="audit-provenance" aria-label="แหล่งที่มาของ Audit">
        <Database size={18} aria-hidden="true" />
        <dl>
          <div><dt>Provider</dt><dd>{safeText(provenance.provider)}</dd></div>
          <div><dt>Audit persistence</dt><dd>{persistence}</dd></div>
          <div><dt>ชนิดการเก็บ</dt><dd>{durable ? 'Durable (SQLite)' : 'ไม่ถาวร — หายเมื่อ session/process สิ้นสุด'}</dd></div>
        </dl>
      </section>
      <Panel title="Security audit ledger" description="แยกจาก operational event และไม่มี token, secret หรือ raw exception" action={<button type="button" className="button button--secondary" onClick={onExport}><Download size={15} aria-hidden="true" />ขอส่งออกแบบจำกัด</button>}>
        <DataTable columns={columns} rows={audit} emptyLabel="ยังไม่มี Audit record" ariaLabel="ตาราง Audit" />
      </Panel>
      <Panel title="IDEA3 Core audit aggregates" description="จำนวนเหตุการณ์ที่อ่านได้จาก Core SQLite แบบ allowlisted; ไม่ใช่ Web audit timeline">
        <p className="audit-note"><span>Latest Core evidence (global)</span><span className="mono">{formatDateTime(coreAudit?.latestAt)}</span></p>
        <DataTable columns={coreAuditColumns} rows={coreAuditRows} emptyLabel="ยังไม่มี Core audit aggregate" ariaLabel="ตาราง Core audit aggregate" />
      </Panel>
      <section className="audit-note"><ShieldCheck size={17} aria-hidden="true" /><span>โครงสร้างถาวรต้องผ่านการทบทวน retention, index, privacy, backup/restore และ rollback ก่อนใช้งานจริง</span></section>
    </div>
  )
}
