import React from 'react'
import { formatDateTime } from '../lib/format.js'
import { StatusBadge } from './StatusBadge.jsx'

export function Timeline({ items = [] }) {
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={item.id || `${item.title}-${item.timestamp}`}>
          <span className={`timeline__marker timeline__marker--${String(item.status || 'UNKNOWN').toLowerCase()}`} aria-hidden="true" />
          <div className="timeline__content">
            <div className="timeline__title"><strong>{item.title}</strong><StatusBadge status={item.status} compact /></div>
            <p>{item.detail}</p>
            <time dateTime={Number.isNaN(Date.parse(item.timestamp)) ? undefined : new Date(item.timestamp).toISOString()}>{formatDateTime(item.timestamp)}</time>
          </div>
        </li>
      ))}
    </ol>
  )
}
