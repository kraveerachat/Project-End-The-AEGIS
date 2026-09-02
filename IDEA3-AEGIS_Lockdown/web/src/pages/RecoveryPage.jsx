import React, { useState } from 'react'
import { Ban, CheckCircle2, ClipboardCheck, KeyRound, RotateCcw } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatDateTime } from '../lib/format.js'

export function RecoveryPage({ snapshot, onDryRun = () => {} }) {
  const [confirmation, setConfirmation] = useState('')
  const recovery = snapshot.recovery
  const incidentId = snapshot.incidents[0]?.id || ''
  const satisfied = recovery.preconditions.filter((item) => item.satisfied).length
  const historyColumns = [
    { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
    { key: 'id', label: 'Recovery ID', render: (value) => <span className="mono">{value}</span> },
    { key: 'stage', label: 'ขั้น', render: (value) => <strong className="table-strong">{value}</strong> },
    { key: 'outcome', label: 'ผล', render: (value) => <span className="severity severity--warning">{value}</span> },
    { key: 'detail', label: 'รายละเอียด' },
  ]

  return (
    <div className="page-stack">
      <section className="metric-grid metric-grid--four">
        <MetricCard icon={Ban} label="Recovery gateway" value={recovery.gatewayStatus} status="DISABLED" />
        <MetricCard icon={KeyRound} label="Authorization" value={recovery.authorization} status="DISABLED" />
        <MetricCard icon={ClipboardCheck} label="Preconditions" value={`${satisfied}/${recovery.preconditions.length}`} status={satisfied === recovery.preconditions.length ? 'HEALTHY' : 'DEGRADED'} />
        <MetricCard icon={RotateCcw} label="Incident state" value={recovery.incidentState} status="DEGRADED" />
      </section>

      <section className="recovery-grid">
        <Panel title="Recovery preconditions" description="ทุกข้อถูกตรวจสอบแยกกันก่อนสร้างคำขอ">
          <div className="precondition-list">{recovery.preconditions.map((item) => <div key={item.label}><span className={item.satisfied ? 'condition condition--pass' : 'condition condition--fail'}>{item.satisfied ? <CheckCircle2 /> : <Ban />}</span><strong>{item.label}</strong><span>{item.satisfied ? 'พร้อม' : 'ยังไม่พร้อม'}</span></div>)}</div>
        </Panel>
        <Panel title="Safe dry-run" description="ตรวจ schema, session และเงื่อนไขเท่านั้น">
          <form className="dry-run-form" onSubmit={(event) => { event.preventDefault(); onDryRun(incidentId, confirmation) }}>
            <span className="command-boundary__icon"><ClipboardCheck /></span>
            <h3>ตรวจสอบโดยไม่มีผลต่ออุปกรณ์</h3>
            <p>Dry-run นี้ไม่ส่ง MQTT และไม่เปลี่ยนสถานะ Relay หรือ Uplink</p>
            <label>พิมพ์ VALIDATE ONLY เพื่อยืนยัน<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
            <button className="button button--primary" type="submit" disabled={!incidentId || confirmation !== 'VALIDATE ONLY'}>ตรวจสอบความพร้อมแบบ Dry-run</button>
            <small className="mono">Incident: {incidentId || 'ไม่มี incident ที่เข้าเกณฑ์'}</small>
          </form>
        </Panel>
      </section>

      <Panel title="Recovery runbook" description="แปดขั้นจากการยืนยันเหตุการณ์ถึงการปิด Incident">
        <ol className="runbook">{recovery.runbook.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong><StatusBadge status={index < 3 ? 'HEALTHY' : 'NOT_CONFIGURED'} compact /></li>)}</ol>
      </Panel>
      <Panel title="Recovery history" description="แยก validation, ACK, execution และ physical verification">
        <DataTable columns={historyColumns} rows={recovery.history} emptyLabel="ยังไม่มีประวัติ Recovery" />
      </Panel>
    </div>
  )
}
