import React, { useMemo, useState } from 'react'
import { Ban, Fingerprint, Repeat2, ShieldX, TrendingUp } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { SourceStatusBar } from '../components/SourceStatusBar.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { FreshnessTag } from '../components/FreshnessTag.jsx'
import { domainView, evidenceAgeAt, evidenceCount, zeroAwareStatus } from '../lib/evidence.js'
import { formatDateTime } from '../lib/format.js'
import { ideaRows } from '../lib/idea.js'

const SEVERITIES = new Set(['INFO', 'WARNING', 'HIGH', 'CRITICAL'])

function severityClass(value) {
  return SEVERITIES.has(value) ? value.toLowerCase() : 'info'
}

function untrustedNote(status) {
  return `แหล่งข้อมูลอยู่ในสถานะ ${status} ค่า 0 หรือตารางว่างจึงไม่ได้พิสูจน์ว่าปลอดภัย — หมายถึงยังไม่มีหลักฐานที่ตรวจสอบได้`
}

function makeColumns(snapshotTimestamp, showFreshness) {
  const columns = [
    { key: 'timestamp', label: 'เวลา', render: (value) => <span className="evidence-time"><span className="mono">{formatDateTime(value)}</span><small>{evidenceAgeAt(value, snapshotTimestamp)}</small></span> },
    { key: 'action', label: 'Action', render: (value) => <strong className="table-strong">{value ?? '—'}</strong> },
    { key: 'result', label: 'Result', render: (value) => <span className={`severity severity--${value === 'BLOCKED' ? 'high' : 'warning'}`}>{value ?? '—'}</span> },
    { key: 'sourceIp', label: 'Source IP', render: (value) => value ? <span className="mono">{value}</span> : <span className="not-provided">ไม่ระบุ</span> },
    { key: 'severity', label: 'Severity', render: (value) => <span className={`severity severity--${severityClass(value)}`}>{value ?? '—'}</span> },
    { key: 'dedupCount', label: 'ซ้ำ', render: (value) => <span className="mono">×{value ?? 1}{value > 1 ? ' · พบซ้ำ' : ''}</span> },
  ]
  return showFreshness ? [...columns, { key: 'freshness', label: 'ความสดของหลักฐาน', render: (value) => <FreshnessTag value={value} /> }] : columns
}

export function Idea1SecurityPage({ snapshot }) {
  const [result, setResult] = useState('ALL')
  const view = domainView(snapshot.idea1)
  const feed = ideaRows(snapshot, 'IDEA1')
  const events = useMemo(() => feed.rows.filter((event) => result === 'ALL' || event.result === result), [feed.rows, result])
  const { summary } = feed
  const count = (value) => evidenceCount(value, view.trusted)
  const emptyLabel = !view.trusted
    ? `ไม่มีหลักฐาน IDEA1 ให้แสดง เพราะแหล่งข้อมูลอยู่ในสถานะ ${view.status}`
    : result === 'ALL' ? 'แหล่งข้อมูลรายงานว่าไม่มี record ในหน้าต่างเวลานี้' : 'ไม่มีหลักฐาน IDEA1 ตามตัวกรองนี้'
  return (
    <div className="page-stack">
      <section className="evidence-intro"><div><p className="kicker">READ-ONLY PRODUCER CONTRACT</p><h2>หลักฐานการปฏิเสธสิทธิ์จาก IDEA1</h2><p>รับเฉพาะ timestamp, action, result และ source_ip จาก sanitized endpoint</p></div><StatusBadge status={view.status} /></section>
      <SourceStatusBar label="สถานะแหล่งข้อมูล IDEA1" status={view.status} generatedAt={view.generatedAt} age={evidenceAgeAt(view.generatedAt, snapshot.generatedAt)} note={view.trusted ? undefined : untrustedNote(view.status)} />
      <section className="metric-grid metric-grid--five" aria-label="สรุปหลักฐาน IDEA1">
        <MetricCard icon={ShieldX} label="DENIED" value={count(summary.denied)} status={zeroAwareStatus(summary.denied, view.trusted, view.status, 'DEGRADED')} />
        <MetricCard icon={Ban} label="BLOCKED" value={count(summary.blocked)} status={zeroAwareStatus(summary.blocked, view.trusted, view.status, 'DEGRADED')} />
        <MetricCard icon={Fingerprint} label="Source IP ที่ไม่ซ้ำ" value={count(summary.uniqueSourceIps)} status={view.trusted ? undefined : view.status} />
        <MetricCard icon={Repeat2} label="กิจกรรมซ้ำ" value={count(summary.repeated)} status={view.trusted ? undefined : view.status} />
        <MetricCard icon={TrendingUp} label="ยกระดับ" value={count(summary.escalated)} status={zeroAwareStatus(summary.escalated, view.trusted, view.status, 'DEGRADED')} />
      </section>
      <Panel title="Access evidence ledger" description="ตัด raw request, token, path และข้อมูลรับรองออกก่อนจัดเก็บ" action={<label className="compact-filter">ผลลัพธ์<select aria-label="กรองผลลัพธ์ IDEA1" value={result} onChange={(event) => setResult(event.target.value)}><option value="ALL">ทั้งหมด</option><option value="DENIED">DENIED</option><option value="BLOCKED">BLOCKED</option></select></label>}>
        <DataTable columns={makeColumns(snapshot.generatedAt, feed.origin === 'INTEGRATION')} rows={events} emptyLabel={emptyLabel} ariaLabel="ตารางหลักฐาน IDEA1" />
        {feed.origin === 'INTEGRATION' && <p className="ledger-note">แสดงจาก normalized feed events (ไม่มี source IP ในสัญญานี้) · ตัวเลขนับเฉพาะแถว FRESH ในหน้าต่างที่แสดง ค่าที่ feed ไม่มีข้อมูลแสดง —</p>}
        <p className="ledger-note">Security Center คำนวณ severity จาก result (BLOCKED → HIGH, DENIED → WARNING) และนับรายการซ้ำเอง — ไม่ได้มาจาก IDEA1 และไม่ระบุตัวผู้โจมตี</p>
      </Panel>
      <Panel title="สัญญาการเชื่อมต่อ" description="สถานะ adapter ที่รายงานจากเซิร์ฟเวอร์">
        <div className="contract-strip"><span><i />Configured by server</span><span><i />Allowlisted fields</span><span><i />Bounded response</span><span><i />No producer database access</span></div>
      </Panel>
    </div>
  )
}
