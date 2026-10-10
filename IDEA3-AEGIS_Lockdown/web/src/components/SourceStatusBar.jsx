import React from 'react'
import { StatusBadge } from './StatusBadge.jsx'
import { formatDateTime } from '../lib/format.js'

/**
 * Source state strip for an evidence page: producer state, last evidence time,
 * and evidence age. The note explains why a count on the page may not be
 * trusted; it is rendered whenever the source cannot vouch for its own zeros.
 */
export function SourceStatusBar({ label, status, generatedAt, age, note }) {
  return (
    <section className="source-bar" aria-label={label}>
      <div className="source-bar__facts">
        <div><span>สถานะแหล่งข้อมูล</span><StatusBadge status={status} compact /></div>
        <div><span>หลักฐานล่าสุด</span><strong className="mono"><time dateTime={Number.isNaN(Date.parse(generatedAt)) ? undefined : new Date(generatedAt).toISOString()}>{formatDateTime(generatedAt)}</time></strong></div>
        <div><span>อายุหลักฐาน ณ snapshot</span><strong className="mono">{age}</strong></div>
      </div>
      {note && <p className="source-bar__note">{note}</p>}
    </section>
  )
}
