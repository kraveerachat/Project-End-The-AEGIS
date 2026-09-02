import React from 'react'
import { Ban, RadioTower, ShieldAlert, TerminalSquare } from 'lucide-react'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { Timeline } from '../components/Timeline.jsx'
import { formatEvidenceAge } from '../lib/format.js'

const issueGuidance = {
  COMPONENT_FAILED: 'ยังไม่มี sensor ยืนยันสถานะ Relay ทางกายภาพ ระบบจึงแสดง UNKNOWN',
  STATUS_STALE: 'หลักฐานล่าสุดเก่าเกินกำหนด ตรวจสอบ runtime status source ก่อนดำเนินการ',
  BROKER_DISCONNECTED: 'ตรวจสอบ broker จากฝั่ง runtime โดยไม่ส่ง credential มายัง Web UI',
  DEVICE_OFFLINE: 'ตรวจสอบ heartbeat และแหล่งจ่ายไฟของอุปกรณ์',
}

export function LockdownPage({ snapshot }) {
  const runtime = snapshot.runtime
  const stale = runtime.freshness === 'STALE'
  const modes = [
    ['MONITOR ONLY', runtime.modes.monitorOnly], ['DRY RUN', runtime.modes.dryRun],
    ['ARMED', runtime.modes.armed], ['AUTO CONTAIN', runtime.modes.autoContain],
    ['RECOVERY AUTH', runtime.modes.recoveryAuthorized],
  ]

  return (
    <div className="page-stack">
      <section className="runtime-hero">
        <div><p className="kicker">CYBER-PHYSICAL EVIDENCE CHAIN</p><h2>หลักฐานก่อนคำสั่งเสมอ</h2><p>สถานะรวม <StatusBadge status={runtime.status} compact /> · {formatEvidenceAge(runtime.evidenceAgeMs)}</p></div>
        <div className="mode-strip">{modes.map(([label, enabled]) => <span key={label} className={enabled ? 'mode-chip mode-chip--on' : 'mode-chip'}><i />{label}</span>)}</div>
      </section>

      {stale && <div className="stale-callout" role="status"><ShieldAlert size={18} /><div><strong>หลักฐานล่าสุดเก่าเกินกำหนด</strong><p>ทุก component ถูกลดสถานะเป็น UNKNOWN จนกว่าจะได้รับหลักฐานใหม่ที่ตรวจสอบได้</p></div></div>}

      <section className="component-grid" aria-label="องค์ประกอบ runtime">
        {runtime.components.map((component) => <article className="component-card" key={component.id}><span className="component-card__icon"><RadioTower size={17} /></span><div><p>{component.name}</p><small className="mono">{component.id}</small></div><StatusBadge status={component.status} compact /></article>)}
      </section>

      <section className="lockdown-grid">
        <Panel title="ลำดับหลักฐาน Runtime" description="เหตุการณ์จากแหล่ง safe runtime status">
          <Timeline items={runtime.timeline} />
        </Panel>
        <Panel title="ความพร้อมด้านการตอบสนอง" description="แต่ละเงื่อนไขมีสถานะของตัวเอง">
          <div className="readiness-ledger">{runtime.readiness.map((item) => <div key={item.label}><span>{item.label}</span><StatusBadge status={item.status} compact /></div>)}</div>
        </Panel>
      </section>

      <section className="lockdown-grid">
        <Panel title="ประเด็นจากหลักฐาน" description="ไม่มี raw runtime text ในหน้าจอ">
          <div className="issue-list">{runtime.issues.map((issue) => <article key={`${issue.code}-${issue.component}`}><StatusBadge status="DEGRADED" compact /><div><strong>{issue.code}</strong><p>{issueGuidance[issue.code] || 'ตรวจสอบแหล่งหลักฐานจากระบบที่รับผิดชอบ'}</p></div><span className="mono">×{issue.count}</span></article>)}</div>
        </Panel>
        <Panel title="Command boundary" description="ออกแบบให้ไม่มีเส้นทางควบคุมจริงใน milestone นี้">
          <div className="command-boundary">
            <span className="command-boundary__icon"><Ban /></span>
            <div><strong>Live hardware control ถูกปิด</strong><p>ไม่มี command endpoint ใน milestone นี้ เบราว์เซอร์จึงไม่สามารถส่ง MQTT, GPIO หรือเปลี่ยน Relay ได้</p></div>
            <button className="button button--danger" disabled aria-describedby="command-disabled-reason"><TerminalSquare size={16} />ตัดการเชื่อมต่อเครือข่าย</button>
            <small id="command-disabled-reason">ต้องผ่าน security review, device ACK และ physical verification ก่อน</small>
          </div>
        </Panel>
      </section>
    </div>
  )
}
