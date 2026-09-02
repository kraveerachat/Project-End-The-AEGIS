import React from 'react'
import { ArrowRight, DatabaseZap, Eye, LockKeyhole, Radar, ServerCog, ShieldCheck } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatDateTime } from '../lib/format.js'

const matrixColumns = [
  { key: 'name', label: 'Integration', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'status', label: 'Overall', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'freshness', label: 'Freshness', render: (value) => <span className="mono">{value}</span> },
  { key: 'generatedAt', label: 'Validated at', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'detail', label: 'Contract' },
]

export function OverviewPage({ snapshot }) {
  const domains = [
    { icon: ShieldCheck, eyebrow: 'IDEA1', title: 'Access Security', description: 'รับเฉพาะ timestamp, action, result และ source_ip ผ่าน sanitized endpoint', status: snapshot.idea1.status },
    { icon: Radar, eyebrow: 'IDEA2', title: 'Detection Evidence', description: 'ไม่มีภาพ วิดีโอ embedding ข้อมูลใบหน้า หรือ PII ใน Security Center', status: snapshot.idea2.status },
    { icon: ServerCog, eyebrow: 'IDEA3', title: 'Network Isolation', description: 'แยก request, ACK, execution และหลักฐานทางกายภาพออกจากกัน', status: snapshot.runtime.status },
  ]
  const pipeline = [
    { icon: Eye, label: 'Upstream evidence', detail: 'Read-only contracts' },
    { icon: LockKeyhole, label: 'Validate & normalize', detail: 'Allowlist + bounds' },
    { icon: DatabaseZap, label: 'Store & correlate', detail: 'Events ≠ Audit' },
    { icon: ShieldCheck, label: 'Admin surface', detail: 'Session + CSRF' },
  ]

  return (
    <div className="page-stack">
      <section className="domain-grid">
        {domains.map(({ icon: Icon, eyebrow, title, description, status }) => (
          <article className="domain-card" key={eyebrow}>
            <div className="domain-card__top"><span className="icon-box"><Icon size={19} /></span><StatusBadge status={status} compact /></div>
            <p className="kicker">{eyebrow}</p><h2>{title}</h2><p>{description}</p>
          </article>
        ))}
      </section>

      <Panel title="เส้นทางของหลักฐาน" description="เบราว์เซอร์เห็นเฉพาะข้อมูลที่เซิร์ฟเวอร์ตรวจสอบและอนุญาตแล้ว">
        <div className="pipeline">
          {pipeline.map(({ icon: Icon, label, detail }, index) => <React.Fragment key={label}><div className="pipeline__step"><Icon size={18} /><strong>{label}</strong><span>{detail}</span></div>{index < pipeline.length - 1 && <ArrowRight className="pipeline__arrow" size={18} />}</React.Fragment>)}
        </div>
      </Panel>

      <section className="overview-grid">
        <Panel title="Integration matrix" description="สถานะต่อแหล่งที่ตรวจสอบล่าสุด">
          <DataTable columns={matrixColumns} rows={snapshot.sources.slice(0, 3)} />
        </Panel>
        <Panel title="แหล่งที่มาของข้อมูล" description="Provenance ที่ API ประกาศ">
          <dl className="provenance-list">
            <div><dt>Provider</dt><dd className="mono">{snapshot.provenance.provider}</dd></div>
            <div><dt>Persistence</dt><dd className="mono">{snapshot.provenance.persistence}</dd></div>
            <div><dt>Live merge</dt><dd>{snapshot.provenance.liveMerged ? 'มีการรวมข้อมูล' : 'ไม่มีการรวม Demo กับ Live'}</dd></div>
          </dl>
        </Panel>
      </section>

      <Panel title="ขอบเขตความพร้อม" description="สิ่งที่หน้าจอนี้ยืนยันได้และสิ่งที่ยังไม่ควรอ้างว่าเสร็จ">
        <div className="readiness-ledger">
          {[['สัญญาข้อมูลที่ปลอดภัย', 'HEALTHY'], ['Admin RBAC และ CSRF', 'HEALTHY'], ['Demo/Live isolation', 'HEALTHY'], ['Durable production store', 'NOT_CONFIGURED'], ['Hardware control gateway', 'DISABLED'], ['Production deployment', 'NOT_CONFIGURED']].map(([label, status]) => <div key={label}><span>{label}</span><StatusBadge status={status} compact /></div>)}
        </div>
      </Panel>
    </div>
  )
}
