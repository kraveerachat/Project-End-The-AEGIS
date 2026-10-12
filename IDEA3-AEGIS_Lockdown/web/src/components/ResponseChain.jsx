import React from 'react'
import { StatusBadge } from './StatusBadge.jsx'
import { responseChain } from '../lib/chain.js'
import { formatDateTime } from '../lib/format.js'

// What each stage claims, and what it explicitly does not.
export const STAGE_COPY = Object.freeze({
  requested: { title: 'REQUESTED', meaning: 'Admin ขอให้ตัด Uplink', limit: 'คำขอเท่านั้น ยังไม่ใช่การกักกัน' },
  accepted: { title: 'ACCEPTED', meaning: 'Server ยอมรับ decision และสร้าง dispatch action', limit: 'ยอมรับ ไม่ได้แปลว่าลงมือทำแล้ว' },
  dispatch: { title: 'DISPATCH', meaning: 'สถานะการส่งต่อให้ Core (รอ / Core claim / ประกาศ)', limit: 'หลักฐาน dispatch ไม่ใช่หลักฐานการกักกัน' },
  ack: { title: 'ACK / STATUS', meaning: 'อุปกรณ์ตอบรับ หรือ STATUS ที่ Core จับคู่ได้', limit: 'ACK ไม่ใช่หลักฐานว่า Relay เปลี่ยนสถานะ' },
  execution: { title: 'EXECUTION PROOF', meaning: 'หลักฐานว่าคำสั่งถูกดำเนินการจริง', limit: 'ยังไม่มีเส้นทางหลักฐานนี้ใน milestone นี้' },
  physical: { title: 'PHYSICAL VERIFICATION', meaning: 'Sensor ยืนยันสถานะ Relay / Uplink ทางกายภาพ', limit: 'ไม่มี sensor = UNKNOWN เสมอ' },
})

export const KEY_LABELS = Object.freeze({
  OBSERVED: 'พบหลักฐาน',
  NOT_OBSERVED: 'ยังไม่พบ',
  PENDING_DISPATCH: 'รอ dispatch',
  DISPATCH_PENDING: 'รอ dispatch',
  DISPATCH_UNAVAILABLE: 'dispatch ไม่พร้อม',
  CORE_CLAIMED: 'Core claim แล้ว',
  PUBLISHED: 'ประกาศแล้ว',
  DRY_RUN_ONLY: 'Dry-run เท่านั้น',
  OUTCOME_UNKNOWN: 'ไม่ทราบผล',
  FAILED: 'ล้มเหลว',
  EXPIRED: 'หมดอายุ',
  EXPIRED_AT_CORE: 'หมดอายุที่ Core',
  NOT_VERIFIED: 'ยังไม่ได้ยืนยัน',
})

/**
 * The six evidence stages of the cyber-physical chain as an ordered list. Each
 * stage is a separate fact; `titles` lets a page rename a stage without
 * changing what it claims.
 */
export function ResponseChainList({ incident, titles = {} }) {
  return (
    <ol className="response-chain__list">
      {responseChain(incident).map((stage, index) => {
        const copy = STAGE_COPY[stage.id]
        return (
          <li key={stage.id} className={`response-chain__stage response-chain__stage--${stage.observed ? 'observed' : 'open'}`}>
            <span className="response-chain__index" aria-hidden="true">{index + 1}</span>
            <strong>{titles[stage.id] ?? copy.title}</strong>
            <StatusBadge status={stage.status} compact label={KEY_LABELS[stage.key] ?? stage.key} />
            <p>{copy.meaning}</p>
            <small>{copy.limit}</small>
            {stage.timestamp && <time className="mono" dateTime={new Date(stage.timestamp).toISOString()}>{formatDateTime(stage.timestamp)}</time>}
          </li>
        )
      })}
    </ol>
  )
}
