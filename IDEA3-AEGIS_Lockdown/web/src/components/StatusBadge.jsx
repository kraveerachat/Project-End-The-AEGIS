import React from 'react'
import { AlertCircle, CheckCircle2, CircleOff, CircleSlash2, Clock3, HelpCircle, TriangleAlert } from 'lucide-react'

const icons = {
  HEALTHY: CheckCircle2,
  DEGRADED: TriangleAlert,
  FAILED: AlertCircle,
  UNKNOWN: HelpCircle,
  NOT_CONFIGURED: CircleSlash2,
  STALE: Clock3,
  DISABLED: CircleOff,
}

export function StatusBadge({ status = 'UNKNOWN', compact = false, label, ariaLabel }) {
  const safeStatus = icons[status] ? status : 'UNKNOWN'
  const Icon = icons[safeStatus]
  const displayLabel = label || safeStatus
  return (
    <span className={`status status--${safeStatus.toLowerCase()}${compact ? ' status--compact' : ''}`} aria-label={ariaLabel || `สถานะ ${displayLabel}`}>
      <Icon aria-hidden="true" size={compact ? 13 : 14} />
      <span>{displayLabel}</span>
    </span>
  )
}
