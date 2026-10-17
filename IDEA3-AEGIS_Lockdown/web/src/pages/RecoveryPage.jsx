import React, { useState } from 'react'
import { Ban, CheckCircle2, ClipboardCheck, KeyRound, Lock, RotateCcw } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { safeStatus } from '../lib/evidence.js'
import { formatDateTime } from '../lib/format.js'

const historyColumns = [
  { key: 'timestamp', label: 'เวลา', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  { key: 'id', label: 'Recovery ID', render: (value) => <span className="mono">{value}</span> },
  { key: 'stage', label: 'ขั้น', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'outcome', label: 'ผล', render: (value) => <span className={`severity severity--${value === 'DENIED' || value === 'FAILED' ? 'high' : 'warning'}`}>{value ?? '—'}</span> },
  { key: 'detail', label: 'รายละเอียด' },
]

function EmptyNote({ children }) {
  return <div className="empty-state recovery-empty"><span className="aegis-hatch" aria-hidden="true" /><p>{children}</p></div>
}

export function RecoveryPage({ snapshot, onDryRun = () => {} }) {
  const [confirmation, setConfirmation] = useState('')
  const recovery = snapshot.recovery ?? {}
  const preconditions = recovery.preconditions ?? []
  const runbook = recovery.runbook ?? []
  const history = recovery.history ?? []
  const incidentId = snapshot.incidents?.[0]?.id || ''
  const satisfied = preconditions.filter((item) => item.satisfied).length
  const gateway = safeStatus(recovery.gatewayStatus)
  const authorization = safeStatus(recovery.authorization)
  const preconditionStatus = preconditions.length === 0 ? 'UNKNOWN' : satisfied === preconditions.length ? 'HEALTHY' : 'DEGRADED'

  return (
    <div className="page-stack">
      <section className="recovery-banner recovery-banner--compact" aria-label="ขอบเขตของหน้า Recovery">
        <Lock size={16} aria-hidden="true" />
        <p><strong>หน้านี้อ่านอย่างเดียว</strong> — ใช้ได้เฉพาะ Dry-run validation ไม่มีปุ่มหรือ endpoint สำหรับ Recovery จริงในเบราว์เซอร์ และ Recovery ยังเป็นสิทธิ์ของ Core เท่านั้น</p>
      </section>

      <section className="recovery-summary" aria-label="สรุปสถานะ Recovery">
        <div><span><Ban size={13} aria-hidden="true" />Recovery gateway</span><StatusBadge status={gateway} compact label={recovery.gatewayStatus ?? 'UNKNOWN'} /></div>
        <div><span><KeyRound size={13} aria-hidden="true" />Authorization</span><StatusBadge status={authorization} compact label={recovery.authorization ?? 'UNKNOWN'} /></div>
        <div><span><ClipboardCheck size={13} aria-hidden="true" />Preconditions</span><StatusBadge status={preconditionStatus} compact label={preconditions.length ? `${satisfied}/${preconditions.length}` : '—'} /></div>
        <div><span><RotateCcw size={13} aria-hidden="true" />Incident state</span><StatusBadge status={recovery.incidentState && recovery.incidentState !== 'NONE' ? 'DEGRADED' : 'UNKNOWN'} compact label={recovery.incidentState ?? 'UNKNOWN'} /></div>
      </section>

      <section className="recovery-grid">
        <Panel title="Recovery preconditions" description="ทุกข้อถูกตรวจสอบแยกกันก่อนสร้างคำขอ">
          {preconditions.length
            ? <div className="precondition-list">{preconditions.map((item) => <div key={item.label}><span className={item.satisfied ? 'condition condition--pass' : 'condition condition--fail'}>{item.satisfied ? <CheckCircle2 aria-hidden="true" /> : <Ban aria-hidden="true" />}</span><strong>{item.label}</strong><span>{item.satisfied ? 'พร้อม' : 'ยังไม่พร้อม'}</span></div>)}</div>
            : <EmptyNote>ยังไม่มีข้อมูล precondition จาก Live</EmptyNote>}
        </Panel>

        <div className="recovery-modes">
          <Panel title="Dry-run validation" description="ตรวจ schema, session และเงื่อนไขเท่านั้น">
            <form className="dry-run-form dry-run-form--compact" onSubmit={(event) => { event.preventDefault(); onDryRun(incidentId, confirmation) }}>
              <h3>ตรวจสอบโดยไม่มีผลต่ออุปกรณ์</h3>
              <p>Dry-run นี้ไม่ส่ง MQTT และไม่เปลี่ยนสถานะ Relay หรือ Uplink</p>
              <label>พิมพ์ VALIDATE ONLY เพื่อยืนยัน<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
              <button className="button button--primary" type="submit" disabled={!incidentId || confirmation !== 'VALIDATE ONLY'}>ตรวจสอบความพร้อมแบบ Dry-run</button>
              <small className="mono">Incident: {incidentId || 'ไม่มี incident ที่เข้าเกณฑ์'}</small>
            </form>
          </Panel>
          <section className="recovery-locked-alert" aria-label="Real recovery execution">
            <Lock size={16} aria-hidden="true" />
            <div>
              <h3>Real recovery execution <StatusBadge status="DISABLED" compact label="DISABLED" /></h3>
              <p><strong>ยังไม่เปิดใช้งาน</strong> — การกู้คืนจริงไม่มีในเบราว์เซอร์ ผล Dry-run ที่ผ่านไม่ได้แปลว่า Relay หรือ Uplink ถูกเปลี่ยน</p>
              <small className="mono">Gateway: {recovery.gatewayStatus ?? 'UNKNOWN'} · Live hardware: {recovery.liveHardware === true ? 'AVAILABLE' : recovery.liveHardware === false ? 'DISABLED' : 'UNKNOWN'}</small>
            </div>
          </section>
        </div>
      </section>

      <Panel className={runbook.length ? undefined : 'recovery-panel--empty'} title="Recovery runbook" description="ขั้นตอนอ้างอิงจากการยืนยันเหตุการณ์ถึงการปิด Incident — ไม่ใช่บันทึกความคืบหน้า">
        {runbook.length
          ? <ol className="runbook">{runbook.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong><StatusBadge status="NOT_CONFIGURED" compact label="ยังไม่ดำเนินการ" /></li>)}</ol>
          : <EmptyNote>ยังไม่มี runbook จาก Live</EmptyNote>}
      </Panel>
      <Panel className={history.length ? undefined : 'recovery-panel--empty'} title="Recovery history" description="แยก validation, ACK, execution และ physical verification">
        {history.length
          ? <DataTable columns={historyColumns} rows={history} emptyLabel="ยังไม่มีประวัติ Recovery" ariaLabel="ตารางประวัติ Recovery" />
          : <EmptyNote>ยังไม่มีประวัติ Recovery</EmptyNote>}
      </Panel>
    </div>
  )
}
