import React, { useState } from 'react'
import { ArrowRight, FileClock, GitMerge, MessageSquareText } from 'lucide-react'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatDateTime } from '../lib/format.js'

export function IncidentsPage({ snapshot, onAddNote = () => {} }) {
  const [selectedId, setSelectedId] = useState(snapshot.incidents[0]?.id ?? null)
  const [note, setNote] = useState('')
  const incident = snapshot.incidents.find((item) => item.id === selectedId)
  return (
    <div className="incident-layout">
      <Panel className="incident-index" title="Incident queue" description="Correlation ที่ยังต้องตรวจสอบโดยผู้ดูแล">
        <div className="incident-list">{snapshot.incidents.map((item) => <button key={item.id} className={item.id === selectedId ? 'incident-list__item incident-list__item--active' : 'incident-list__item'} onClick={() => setSelectedId(item.id)}><span className={`severity severity--${item.severity.toLowerCase()}`}>{item.severity}</span><strong>{item.title}</strong><small className="mono">{item.id} · {item.sourceIp}</small><span>{item.state}<ArrowRight size={14} /></span></button>)}</div>
      </Panel>
      {incident ? <div className="incident-detail page-stack">
        <section className="incident-hero"><div><p className="kicker">{incident.id}</p><h2>{incident.title}</h2><p>{incident.summary}</p></div><span className={`severity severity--${incident.severity.toLowerCase()}`}>{incident.severity}</span></section>
        <Panel title="Evidence progression" description="แต่ละขั้นเป็นคนละข้อเท็จจริงและไม่อนุมานแทนกัน">
          <div className="stage-track">{incident.evidenceStages.map((stage, index) => <React.Fragment key={stage.stage}><article><StatusBadge status={stage.status} compact /><strong>{stage.stage}</strong><time>{formatDateTime(stage.timestamp)}</time></article>{index < incident.evidenceStages.length - 1 && <ArrowRight size={16} />}</React.Fragment>)}</div>
          {incident.evidenceStages.at(-1).status === 'UNKNOWN' && <div className="physical-warning"><GitMerge size={16} />หลักฐานทางกายภาพยังไม่ยืนยัน</div>}
        </Panel>
        <section className="incident-facts">
          <Panel title="หลักฐานสัมพันธ์"><dl className="fact-grid"><div><dt>Source IP</dt><dd>{incident.sourceIp}</dd></div><div><dt>เริ่มพบ</dt><dd>{formatDateTime(incident.firstSeen)}</dd></div><div><dt>IDEA1</dt><dd>{incident.idea1Count} records</dd></div><div><dt>IDEA2</dt><dd>{incident.idea2Count} records</dd></div></dl></Panel>
          <Panel title="บันทึกของผู้วิเคราะห์" description="สูงสุด 500 ตัวอักษรและสร้าง Audit"><form className="note-form" onSubmit={(event) => { event.preventDefault(); if (note.trim()) onAddNote(incident.id, note.trim()) }}><label htmlFor="analyst-note"><MessageSquareText size={15} />บันทึกของผู้วิเคราะห์</label><textarea id="analyst-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /><div><span className="mono">{note.length}/500</span><button className="button button--primary" type="submit" disabled={!note.trim()}><FileClock size={15} />บันทึกและสร้าง Audit</button></div></form></Panel>
        </section>
      </div> : <Panel><div className="empty-state">ไม่มี Incident</div></Panel>}
    </div>
  )
}
