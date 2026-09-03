import React from 'react'
import { AlertCircle, CheckCircle2, CircleOff, CircleSlash2, HelpCircle, TriangleAlert } from 'lucide-react'

const icons = {
  HEALTHY: CheckCircle2,
  DEGRADED: TriangleAlert,
  FAILED: AlertCircle,
  UNKNOWN: HelpCircle,
  NOT_CONFIGURED: CircleSlash2,
  DISABLED: CircleOff,
}

export function StatusBadge({ status = 'UNKNOWN', compact = false }) {
  const safeStatus = icons[status] ? status : 'UNKNOWN'
  const Icon = icons[safeStatus]
  return (
    <span className={`status status--${safeStatus.toLowerCase()}${compact ? ' status--compact' : ''}`} aria-label={`สถานะ ${safeStatus}`}>
      <Icon aria-hidden="true" size={compact ? 13 : 14} />
      <span>{safeStatus}</span>
    </span>
  )
}
