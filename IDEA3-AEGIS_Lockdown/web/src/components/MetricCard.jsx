import React from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { StatusBadge } from './StatusBadge.jsx'

export function MetricCard({ icon: Icon, label, value, suffix, status, trend, detail }) {
  const TrendIcon = trend?.direction === 'down' ? ArrowDownRight : ArrowUpRight
  return (
    <article className="metric-card">
      <div className="metric-card__top">
        {Icon && <span className="icon-box"><Icon size={19} aria-hidden="true" /></span>}
        {status && <StatusBadge status={status} compact />}
      </div>
      <p className="metric-card__label">{label}</p>
      <div className="metric-card__value"><strong>{value}</strong>{suffix && <span>{suffix}</span>}</div>
      {(trend || detail) && <p className="metric-card__detail">{trend && <TrendIcon size={14} aria-hidden="true" />}{trend?.label || detail}</p>}
    </article>
  )
}
