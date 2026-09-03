import React from 'react'
import {
  Activity, ArrowUpRight, BellRing, Database, Network, Radar,
  RefreshCw, ShieldAlert, ShieldCheck,
} from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import {
  activeRuntimeModes, dashboardIssues, engineState, engineStatus, evidenceStatus,
  recommendedActions, runtimeComponent,
} from '../lib/dashboard.js'
import { formatCount, formatDateTime, formatEvidenceAge } from '../lib/format.js'

function RouteLink({ route, onNavigate, children, ariaLabel, className = 'dashboard-link' }) {
  return (
    <a
      className={className}
      href={`/security/${route}`}
      aria-label={ariaLabel}
      onClick={(event) => {
        if (!onNavigate) return
        event.preventDefault()
        onNavigate(route)
      }}
    >
      <span>{children}</span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  )
}

function ageAtSnapshot(timestamp, snapshotTimestamp) {
  const evidenceTime = Date.parse(timestamp)
  const snapshotTime = Date.parse(snapshotTimestamp)
  if (!Number.isFinite(evidenceTime) || !Number.isFinite(snapshotTime)) return 'ไม่พบหลักฐานเวลา'
  return formatEvidenceAge(Math.max(0, snapshotTime - evidenceTime))
}

function SourceHealthTable({ snapshot }) {
  const rows = snapshot.sources.map((source) => ({
    ...source,
    displayStatus: evidenceStatus(source),
    age: ageAtSnapshot(source.generatedAt, snapshot.generatedAt),
  }))
  const columns = [
    { key: 'name', label: 'Source', render: (value, row) => <div className="primary-cell"><span className={`source-glyph source-glyph--${row.displayStatus.toLowerCase()}`} /><strong>{value}</strong></div> },
    { key: 'displayStatus', label: 'Status', render: (value) => <StatusBadge status={value} compact /> },
    { key: 'detail', label: 'Mode / Contract' },
    { key: 'generatedAt', label: 'Last Evidence', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
    { key: 'age', label: 'Freshness', render: (value, row) => <span className={row.displayStatus === 'STALE' ? 'freshness freshness--stale' : 'freshness'}>{row.displayStatus === 'STALE' ? `STALE — ${value}` : value}</span> },
    { key: 'latencyMs', label: 'Latency', render: (value) => <span className="mono">{Number.isFinite(value) ? `${value.toFixed(1)} ms` : 'ไม่พร้อมใช้'}</span> },
  ]

  return <DataTable columns={columns} rows={rows} emptyLabel="ยังไม่มีหลักฐานจากแหล่งข้อมูล" />
}

const eventColumns = [
  { key: 'timestamp', label: 'Time', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'source', label: 'Source', render: (value) => <span className="source-tag">{value}</span> },
  { key: 'type', label: 'Type', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'sourceIp', label: 'Source IP', render: (value) => <span className="mono">{value || '—'}</span> },
  { key: 'severity', label: 'Severity', render: (value = 'INFO') => <span className={`severity severity--${value.toLowerCase()}`}>{value}</span> },
  { key: 'result', label: 'Result', render: (value) => value || '—' },
]

function GlobalFact({ label, value, status, detail }) {
  return (
    <div className="global-fact">
      <div><span>{label}</span>{status && <StatusBadge status={status} compact />}</div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function IdeaCard({ testId, icon: Icon, title, mode, status, children, route, onNavigate }) {
  const ideaLabel = route === 'idea1' ? 'IDEA1' : route === 'idea2' ? 'IDEA2' : 'IDEA3'
  return (
    <article className="idea-status-card" data-testid={testId}>
      <header>
        <span className="idea-status-card__icon"><Icon size={19} aria-hidden="true" /></span>
        <div><h2>{title}</h2><p>{mode}</p></div>
        <StatusBadge status={status} compact />
      </header>
      <div className="idea-status-card__body">{children}</div>
      <RouteLink route={route} onNavigate={onNavigate} ariaLabel={`ดูรายละเอียด ${ideaLabel}`}>ดูรายละเอียด</RouteLink>
    </article>
  )
}

function MiniFacts({ items }) {
  return <dl className="mini-facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function IncidentSpotlight({ incident, snapshotTimestamp, onNavigate }) {
  if (!incident) return <div className="empty-state dashboard-empty"><span className="aegis-hatch" aria-hidden="true" /><p>ไม่มี Incident ที่กำลังดำเนินการ</p></div>

  const sources = [incident.idea1Count ? 'IDEA1' : null, incident.idea2Count ? 'IDEA2' : null].filter(Boolean).join(' + ') || 'UNKNOWN'
  const acknowledged = String(incident.responseState).includes('ACK') ? 'ACKNOWLEDGED' : 'NOT ACKNOWLEDGED'
  return (
    <article className="incident-focus">
      <div className="incident-focus__top">
        <span className="mono">{incident.id}</span>
        <span className={`severity severity--${incident.severity.toLowerCase()}`}>{incident.severity}</span>
      </div>
      <h3>{incident.title}</h3>
      <p>{incident.summary}</p>
      <MiniFacts items={[
        ['Source IP', incident.sourceIp || 'ไม่พร้อมใช้'],
        ['Linked sources', sources],
        ['Incident state', incident.state],
        ['Response state', incident.responseState],
        ['Started', formatDateTime(incident.firstSeen)],
        ['Age', ageAtSnapshot(incident.firstSeen, snapshotTimestamp)],
        ['Acknowledgement', acknowledged],
      ]} />
      <RouteLink route="incidents" onNavigate={onNavigate} ariaLabel={`เปิด Incident ${incident.id}`} className="button button--primary dashboard-primary-action">เปิด Incident</RouteLink>
    </article>
  )
}

export function DashboardPage({ snapshot, apiConnected = true, onNavigate, onRefresh }) {
  const incident = snapshot.incidents?.[0]
  const issues = dashboardIssues(snapshot, { apiConnected })
  const nextActions = recommendedActions(issues)
  const idea1Status = evidenceStatus(snapshot.idea1)
  const idea2Status = evidenceStatus(snapshot.idea2)
  const runtimeStatus = evidenceStatus(snapshot.runtime)
  const runtimeModes = activeRuntimeModes(snapshot.runtime)
  const device = snapshot.devices?.[0]
  const correlation = engineState(snapshot.runtime?.engines?.correlation)
  const incidentEngine = engineState(snapshot.runtime?.engines?.incident)
  const overallFreshness = snapshot.sources.some((source) => source.freshness === 'STALE') ? 'STALE'
    : Number.isFinite(snapshot.overall.evidenceAgeMs) ? snapshot.overall.status : 'UNKNOWN'
  const supervisor = runtimeComponent(snapshot.runtime, 'runtime')
  const mqtt = runtimeComponent(snapshot.runtime, 'broker')
  const heartbeat = runtimeComponent(snapshot.runtime, 'heartbeat')
  const ack = runtimeComponent(snapshot.runtime, 'ack')
  const relay = runtimeComponent(snapshot.runtime, 'relay')
  const physicalRelay = device?.physicalRelayState && device.physicalRelayState !== 'UNKNOWN' ? device.physicalRelayState : 'NOT VERIFIED'

  return (
    <div className="page-stack dashboard-page">
      <section className="mission-control" aria-label="สถานะระบบส่วนกลาง">
        <header>
          <div>
            <p>ภาพรวมการปฏิบัติการ</p>
            <h2>AEGIS Mission Control</h2>
            <span>แยกสถานะการเชื่อมต่อ ความสดของหลักฐาน และการควบคุมอุปกรณ์ออกจากกัน</span>
          </div>
          <div className="mission-control__actions">
            <StatusBadge status={snapshot.overall.status} />
            {onRefresh && <button className="button button--secondary" type="button" onClick={onRefresh}><RefreshCw size={15} />รีเฟรชสถานะ</button>}
          </div>
        </header>
        <div className="global-status-grid">
          <GlobalFact label="Environment" value={snapshot.mode} status={snapshot.mode === 'DEMO' ? 'DEGRADED' : 'HEALTHY'} detail={snapshot.mode === 'DEMO' ? 'ข้อมูลจำลอง ไม่ใช่ระบบจริง' : 'อ่านจาก Live provider'} />
          <GlobalFact label="API" value={apiConnected ? 'CONNECTED' : 'DISCONNECTED'} status={apiConnected ? 'HEALTHY' : 'FAILED'} detail={apiConnected ? 'Snapshot ล่าสุดอ่านสำเร็จ' : 'แสดง cached evidence'} />
          <GlobalFact label="Data freshness" value={formatEvidenceAge(snapshot.overall.evidenceAgeMs)} status={overallFreshness} detail="อายุหลักฐานโดยรวม" />
          <GlobalFact label="Correlation engine" value={correlation} status={engineStatus(correlation)} detail={correlation === 'UNKNOWN' ? 'ไม่มี health field ใน snapshot' : 'รายงานโดย runtime'} />
          <GlobalFact label="Incident engine" value={incidentEngine} status={engineStatus(incidentEngine)} detail={incidentEngine === 'UNKNOWN' ? 'ไม่มี health field ใน snapshot' : 'รายงานโดย runtime'} />
          <GlobalFact label="Last system update" value={formatDateTime(snapshot.generatedAt)} detail="เวลาที่ server สร้าง snapshot" />
        </div>
      </section>

      <section className="metric-grid metric-grid--four" aria-label="สรุปสถานะ">
        <MetricCard icon={ShieldAlert} label="สถานะระบบโดยรวม" value={snapshot.overall.status} status={snapshot.overall.status} detail="สรุปจากหลักฐานที่ตรวจสอบได้" />
        <MetricCard icon={Activity} label="Incident ที่กำลังดำเนินการ" value={formatCount(snapshot.overall.activeIncidents)} suffix="รายการ" status={snapshot.overall.activeIncidents ? 'DEGRADED' : 'HEALTHY'} detail={incident ? `ล่าสุด ${incident.id}` : 'ไม่มี Incident เปิดอยู่'} />
        <MetricCard icon={BellRing} label="การแจ้งเตือนระดับสูง" value={formatCount(snapshot.overall.highAlerts)} suffix="รายการ" status={snapshot.overall.highAlerts ? 'FAILED' : 'HEALTHY'} detail="HIGH และ CRITICAL ที่ต้องตรวจสอบ" />
        <MetricCard icon={Database} label="หลักฐาน 24 ชั่วโมง" value={formatCount(snapshot.overall.eventCount)} status={overallFreshness} detail={formatEvidenceAge(snapshot.overall.evidenceAgeMs)} />
      </section>

      <section className="idea-status-grid" aria-label="สถานะ IDEA">
        <IdeaCard testId="idea1-status-card" icon={ShieldCheck} title="IDEA1 — Access Security" mode="Read-only evidence adapter" status={idea1Status} route="idea1" onNavigate={onNavigate}>
          <MiniFacts items={[
            ['Denied', formatCount(snapshot.idea1.summary.denied)],
            ['Blocked', formatCount(snapshot.idea1.summary.blocked)],
            ['Repeated source IP', formatCount(snapshot.idea1.summary.repeated)],
            ['Latest evidence', formatDateTime(snapshot.idea1.generatedAt)],
            ['Freshness', ageAtSnapshot(snapshot.idea1.generatedAt, snapshot.generatedAt)],
          ]} />
        </IdeaCard>

        <IdeaCard testId="idea2-status-card" icon={Radar} title="IDEA2 — Detection Evidence" mode="Privacy-preserving / Read-only evidence" status={idea2Status} route="idea2" onNavigate={onNavigate}>
          <MiniFacts items={[
            ['Detections', formatCount(snapshot.idea2.summary.detections)],
            ['HIGH / CRITICAL', `${formatCount(snapshot.idea2.summary.high)} / ${formatCount(snapshot.idea2.summary.critical)}`],
            ['Camera / source', formatCount(snapshot.idea2.summary.cameras)],
            ['Latest detection', formatDateTime(snapshot.idea2.generatedAt)],
            ['Freshness', ageAtSnapshot(snapshot.idea2.generatedAt, snapshot.generatedAt)],
          ]} />
        </IdeaCard>

        <IdeaCard testId="idea3-status-card" icon={Network} title="IDEA3 — Network Isolation / Lockdown" mode="Runtime / control evidence" status={runtimeStatus} route="lockdown" onNavigate={onNavigate}>
          <div className="mode-row" aria-label="IDEA3 runtime mode">{runtimeModes.length ? runtimeModes.map((mode) => <span key={mode}>{mode}</span>) : <span>UNKNOWN</span>}</div>
          <MiniFacts items={[
            ['Supervisor', supervisor.status],
            ['MQTT', mqtt.status],
            ['ESP32 heartbeat', heartbeat.status],
            ['ACK', ack.status],
            ['Requested', device?.requestedRelayState || 'UNKNOWN'],
            ['Physical relay', physicalRelay],
            ['Hardware', snapshot.recovery?.liveHardware ? 'AVAILABLE' : 'DISABLED'],
            ['Last update', formatDateTime(snapshot.runtime.generatedAt)],
          ]} />
          {relay.status === 'UNKNOWN' && <p className="not-verified-note">Physical relay: UNKNOWN / NOT VERIFIED — ACK ไม่ใช่หลักฐานทางกายภาพ</p>}
        </IdeaCard>
      </section>

      <section className="dashboard-operations">
        <Panel title="เหตุการณ์ที่กำลังดำเนินการ" description="แสดงเฉพาะ Incident ที่สำคัญและล่าสุด">
          <IncidentSpotlight incident={incident} snapshotTimestamp={snapshot.generatedAt} onNavigate={onNavigate} />
        </Panel>
        <Panel title="สิ่งที่ต้องตรวจสอบ" description="สูงสุด 5 ประเด็น เรียงจากผลกระทบสูงสุด">
          {issues.length ? <div className="dashboard-issue-list">{issues.map((issue) => (
            <article key={issue.key} data-testid="attention-item">
              <StatusBadge status={issue.status} compact />
              <div><strong>{issue.title}</strong><p>{issue.detail}</p><small>{issue.component}</small></div>
              <RouteLink route={issue.route} onNavigate={onNavigate} ariaLabel={`ตรวจสอบ ${issue.component}`}><span className="sr-only">ตรวจสอบ</span></RouteLink>
            </article>
          ))}</div> : <div className="empty-state dashboard-empty"><span className="aegis-hatch" aria-hidden="true" /><p>ไม่มีประเด็นเร่งด่วนจากหลักฐานปัจจุบัน</p></div>}
        </Panel>
      </section>

      <Panel title="สถานะแหล่งหลักฐาน" description="API reachable และ security evidence fresh เป็นคนละข้อเท็จจริง" action={<RouteLink route="settings" onNavigate={onNavigate}>ตรวจสอบ adapters</RouteLink>}>
        <SourceHealthTable snapshot={snapshot} />
      </Panel>

      <section className="dashboard-operations dashboard-operations--evidence">
        <Panel title="หลักฐานล่าสุด" description="สูงสุด 6 รายการที่ normalize และตัดข้อมูลต้องห้ามแล้ว" action={<RouteLink route="alerts" onNavigate={onNavigate}>เปิดการแจ้งเตือน</RouteLink>}>
          <DataTable columns={eventColumns} rows={snapshot.events.slice(0, 6)} emptyLabel="ไม่มีหลักฐานในช่วงเวลานี้" />
        </Panel>
        <Panel title="สิ่งที่แนะนำให้ทำต่อ" description="เป็น navigation recommendation เท่านั้น ไม่มี automated remediation">
          {nextActions.length ? <ol className="next-action-list">{nextActions.map((action, index) => (
            <li key={action.key}>
              <span>{index + 1}</span>
              <div><strong>{action.action}</strong><p>{action.title}</p></div>
              <RouteLink route={action.route} onNavigate={onNavigate} ariaLabel={action.action}><span className="sr-only">เปิด</span></RouteLink>
            </li>
          ))}</ol> : <div className="empty-state dashboard-empty"><p>ยังไม่มีคำแนะนำเพิ่มเติม</p></div>}
        </Panel>
      </section>
    </div>
  )
}
