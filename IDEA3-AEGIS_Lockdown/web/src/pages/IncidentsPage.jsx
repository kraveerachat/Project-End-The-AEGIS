import React, { useState } from 'react'
import { ArrowRight, FileClock, GitMerge, MessageSquareText } from 'lucide-react'
import { Panel } from '../components/Panel.jsx'
import { ResponseChainList } from '../components/ResponseChain.jsx'
import { responseChain } from '../lib/chain.js'
import { formatDateTime } from '../lib/format.js'

const SEVERITIES = new Set(['INFO', 'WARNING', 'HIGH', 'CRITICAL'])
// Incident view keeps the labels operators already know; the meaning of each stage is unchanged.
const TITLES = Object.freeze({ ack: 'ACKED', execution: 'EXECUTED', physical: 'PHYSICALLY VERIFIED' })

function severityClass(value) {
  return SEVERITIES.has(value) ? value.toLowerCase() : 'info'
}

function titleOf(incident) {
  return incident.title || `Incident ${incident.id}`
}

export function IncidentsPage({ snapshot, onAddNote = () => {} }) {
  const incidents = snapshot.incidents ?? []
  const [selectedId, setSelectedId] = useState(incidents[0]?.id ?? null)
  const [note, setNote] = useState('')
  const incident = incidents.find((item) => item.id === selectedId) ?? incidents[0]
  const physicalObserved = incident ? responseChain(incident).at(-1).observed : false
  return (
    <div className="incident-layout">
      <Panel className="incident-index" title="Incident queue" description="Correlation ที่ยังต้องตรวจสอบโดยผู้ดูแล">
        {incidents.length ? (
          <div className="incident-list">{incidents.map((item) => (
            <button type="button" key={item.id} aria-current={item.id === incident?.id ? 'true' : undefined} className={item.id === incident?.id ? 'incident-list__item incident-list__item--active' : 'incident-list__item'} onClick={() => setSelectedId(item.id)}>
              <span className={`severity severity--${severityClass(item.severity)}`}>{item.severity ?? 'UNKNOWN'}</span>
              <strong>{titleOf(item)}</strong>
              <small className="mono">{item.id} · {item.sourceIp ?? 'ไม่ระบุ IP'}</small>
              <span>{item.state ?? 'UNKNOWN'}<ArrowRight size={14} aria-hidden="true" /></span>
            </button>
          ))}</div>
        ) : <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>ไม่มี Incident ที่เซิร์ฟเวอร์รายงาน — ไม่ได้พิสูจน์ว่าไม่มีเหตุ</p></div>}
      </Panel>
      {incident ? <div className="incident-detail page-stack">
        <section className="incident-hero"><div><p className="kicker">{incident.id}</p><h2>{titleOf(incident)}</h2>{incident.summary && <p>{incident.summary}</p>}</div><span className={`severity severity--${severityClass(incident.severity)}`}>{incident.severity ?? 'UNKNOWN'}</span></section>
        <Panel title="Evidence progression" description="แต่ละขั้นเป็นคนละข้อเท็จจริงและไม่อนุมานแทนกัน — ACK หรือ STATUS ไม่ใช่การกักกัน">
          <div className="response-chain"><ResponseChainList incident={incident} titles={TITLES} /></div>
          {!physicalObserved && <div className="physical-warning"><GitMerge size={16} aria-hidden="true" />หลักฐานทางกายภาพยังไม่ยืนยัน</div>}
        </Panel>
        <section className="incident-facts">
          <Panel title="หลักฐานสัมพันธ์"><dl className="fact-grid"><div><dt>Source IP</dt><dd>{incident.sourceIp ?? 'ไม่ระบุ'}</dd></div><div><dt>เริ่มพบ</dt><dd>{formatDateTime(incident.firstSeen)}</dd></div><div><dt>IDEA1</dt><dd>{incident.idea1Count ?? 0} records</dd></div><div><dt>IDEA2</dt><dd>{incident.idea2Count ?? 0} records</dd></div></dl>
            {incident.analystNote && <p className="ledger-note">บันทึกล่าสุดที่เซิร์ฟเวอร์เก็บไว้: {incident.analystNote}</p>}</Panel>
          <Panel title="บันทึกของผู้วิเคราะห์" description="สูงสุด 500 ตัวอักษรและสร้าง Audit"><form className="note-form" onSubmit={(event) => { event.preventDefault(); if (note.trim()) onAddNote(incident.id, note.trim()) }}><label htmlFor="analyst-note"><MessageSquareText size={15} aria-hidden="true" />บันทึกของผู้วิเคราะห์</label><textarea id="analyst-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /><div><span className="mono">{note.length}/500</span><button className="button button--primary" type="submit" disabled={!note.trim()}><FileClock size={15} aria-hidden="true" />บันทึกและสร้าง Audit</button></div></form></Panel>
        </section>
      </div> : null}
    </div>
  )
}
