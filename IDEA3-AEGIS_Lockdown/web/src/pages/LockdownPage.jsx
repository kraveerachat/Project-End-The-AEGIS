import React from 'react'
import { Ban, RadioTower, ShieldAlert, TerminalSquare } from 'lucide-react'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { Timeline } from '../components/Timeline.jsx'
import { ResponseChainList } from '../components/ResponseChain.jsx'
import { formatEvidenceAge } from '../lib/format.js'

const issueGuidance = {
  COMPONENT_FAILED: 'ยังไม่มี sensor ยืนยันสถานะ Relay ทางกายภาพ ระบบจึงแสดง UNKNOWN',
  STATUS_STALE: 'หลักฐานล่าสุดเก่าเกินกำหนด ตรวจสอบ runtime status source ก่อนดำเนินการ',
  BROKER_DISCONNECTED: 'ตรวจสอบ broker จากฝั่ง runtime โดยไม่ส่ง credential มายัง Web UI',
  DEVICE_OFFLINE: 'ตรวจสอบ heartbeat และแหล่งจ่ายไฟของอุปกรณ์',
}

function ResponseChain({ incident }) {
  return (
    <section className="response-chain" aria-label="ลำดับหลักฐานการตอบสนอง">
      <header className="section-heading">
        <div>
          <h2>ลำดับหลักฐานการตอบสนอง</h2>
          <p>หกขั้นนี้เป็นคนละข้อเท็จจริง ขั้นหนึ่งไม่อนุมานขั้นถัดไป{incident ? <> · Incident <span className="mono">{incident.id}</span></> : null}</p>
        </div>
      </header>
      {incident ? (
        <ResponseChainList incident={incident} />
      ) : (
        <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>ไม่มี incident ให้ติดตามลำดับหลักฐาน</p></div>
      )}
    </section>
  )
}

function EmptyNote({ children }) {
  return <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>{children}</p></div>
}

export function LockdownPage({ snapshot }) {
  const runtime = snapshot.runtime ?? {}
  const modeFlags = runtime.modes ?? {}
  const components = runtime.components ?? []
  const timeline = runtime.timeline ?? []
  const readiness = runtime.readiness ?? []
  const issues = runtime.issues ?? []
  const stale = runtime.freshness === 'STALE'
  const modes = [
    ['MONITOR ONLY', modeFlags.monitorOnly], ['DRY RUN', modeFlags.dryRun],
    ['ARMED', modeFlags.armed], ['AUTO CONTAIN', modeFlags.autoContain],
    ['RECOVERY AUTH', modeFlags.recoveryAuthorized],
  ]

  return (
    <div className="page-stack">
      <section className="runtime-hero">
        <div><p className="kicker">CYBER-PHYSICAL EVIDENCE CHAIN</p><h2>หลักฐานก่อนคำสั่งเสมอ</h2><p>สถานะรวม <StatusBadge status={runtime.status} compact /> · {formatEvidenceAge(runtime.evidenceAgeMs)}</p></div>
        <div className="mode-strip" role="list" aria-label="โหมด runtime ที่ร้องขอ">{modes.map(([label, enabled]) => <span role="listitem" key={label} className={enabled === true ? 'mode-chip mode-chip--on' : 'mode-chip'}><i aria-hidden="true" />{label}<span className="sr-only">{enabled === true ? ': เปิด' : enabled === false ? ': ปิด' : ': ไม่ทราบ'}</span></span>)}</div>
      </section>

      {stale && <div className="stale-callout" role="status"><ShieldAlert size={18} aria-hidden="true" /><div><strong>หลักฐานล่าสุดเก่าเกินกำหนด</strong><p>ทุก component ถูกลดสถานะเป็น UNKNOWN จนกว่าจะได้รับหลักฐานใหม่ที่ตรวจสอบได้</p></div></div>}

      <ResponseChain incident={snapshot.incidents?.[0]} />

      <section aria-label="องค์ประกอบ runtime">
        {components.length ? (
          <div className="component-grid">
            {components.map((component) => <article className="component-card" key={component.id}><span className="component-card__icon"><RadioTower size={17} aria-hidden="true" /></span><div><p>{component.name}</p><small className="mono">{component.id}</small></div><StatusBadge status={component.status} compact /></article>)}
          </div>
        ) : <EmptyNote>runtime ไม่ได้รายงาน component ใด — สถานะแต่ละส่วนจึงเป็น UNKNOWN</EmptyNote>}
      </section>

      <section className="lockdown-grid">
        <Panel title="ลำดับหลักฐาน Runtime" description="เหตุการณ์จากแหล่ง safe runtime status">
          {timeline.length ? <Timeline items={timeline} /> : <EmptyNote>ยังไม่มีเหตุการณ์จาก runtime — ไม่ได้แปลว่าไม่มีเหตุการณ์เกิดขึ้น</EmptyNote>}
        </Panel>
        <Panel title="ความพร้อมด้านการตอบสนอง" description="แต่ละเงื่อนไขมีสถานะของตัวเอง">
          {readiness.length ? <div className="readiness-ledger">{readiness.map((item) => <div key={item.label}><span>{item.label}</span><StatusBadge status={item.status} compact /></div>)}</div> : <EmptyNote>runtime ไม่ได้รายงานความพร้อมของเงื่อนไขใด</EmptyNote>}
        </Panel>
      </section>

      <section className="lockdown-grid">
        <Panel title="ประเด็นจากหลักฐาน" description="ไม่มี raw runtime text ในหน้าจอ">
          {issues.length
            ? <div className="issue-list">{issues.map((issue) => <article key={`${issue.code}-${issue.component}`}><StatusBadge status={issue.severity === 'CRITICAL' ? 'FAILED' : 'DEGRADED'} compact /><div><strong>{issue.code}</strong><p>{issueGuidance[issue.code] || 'ตรวจสอบแหล่งหลักฐานจากระบบที่รับผิดชอบ'}</p></div><span className="mono">×{issue.count ?? 1}</span></article>)}</div>
            : <EmptyNote>runtime ไม่ได้รายงานประเด็น — ไม่ได้แปลว่าไม่มีปัญหา</EmptyNote>}
        </Panel>
        <Panel title="Command boundary" description="ออกแบบให้ไม่มีเส้นทางควบคุมจริงใน milestone นี้">
          <div className="command-boundary">
            <span className="command-boundary__icon"><Ban aria-hidden="true" /></span>
            <div><strong>Live hardware control ถูกปิด</strong><p>ไม่มี command endpoint ใน milestone นี้ เบราว์เซอร์จึงไม่สามารถส่ง MQTT, GPIO หรือเปลี่ยน Relay ได้</p></div>
            <button className="button button--danger" disabled aria-describedby="command-disabled-reason"><TerminalSquare size={16} aria-hidden="true" />ตัดการเชื่อมต่อเครือข่าย</button>
            <small id="command-disabled-reason">ต้องผ่าน security review, device ACK และ physical verification ก่อน</small>
          </div>
        </Panel>
      </section>
    </div>
  )
}
