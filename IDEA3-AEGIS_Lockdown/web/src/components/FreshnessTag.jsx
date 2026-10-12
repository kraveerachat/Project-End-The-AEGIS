import React from 'react'
import { StatusBadge } from './StatusBadge.jsx'

/** Per-row evidence freshness. Only FRESH reads as current; everything else is flagged with its own label. */
export function FreshnessTag({ value }) {
  if (value === 'FRESH') return <span className="freshness">FRESH</span>
  if (value === 'STALE' || value === 'FUTURE') return <StatusBadge status="STALE" compact label={value} />
  return <StatusBadge status="UNKNOWN" compact label={value || 'UNKNOWN'} />
}
