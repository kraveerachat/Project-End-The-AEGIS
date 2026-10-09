import React from 'react'
import { AlertCircle, BellRing, CheckCircle2, CircleOff, CircleSlash2, Clock3, HelpCircle, Link2, Link2Off, ShieldQuestion, TriangleAlert } from 'lucide-react'

// Canonical backend values only. Each value keeps its own icon and shape so a
// state is never conveyed by colour alone, and no value is aliased to another
// (UNKNOWN is never rendered as HEALTHY, NOT_VERIFIED is never CONTAINED).
const icons = {
  HEALTHY: CheckCircle2,
  DEGRADED: TriangleAlert,
  FAILED: AlertCircle,
  UNKNOWN: HelpCircle,
  NOT_CONFIGURED: CircleSlash2,
  STALE: Clock3,
  DISABLED: CircleOff,
  CONNECTED: Link2,
  DISCONNECTED: Link2Off,
  NOT_VERIFIED: ShieldQuestion,
  ALERT: BellRing,
}

export function StatusBadge({ status = 'UNKNOWN', compact = false, label, ariaLabel }) {
  const safeStatus = icons[status] ? status : 'UNKNOWN'
  const Icon = icons[safeStatus]
  const displayLabel = label || safeStatus
  return (
    <span className={`status status--${safeStatus.toLowerCase()}${compact ? ' status--compact' : ''}`} data-status={safeStatus} aria-label={ariaLabel || `สถานะ ${displayLabel}`}>
      <Icon aria-hidden="true" size={compact ? 13 : 14} />
      <span>{displayLabel}</span>
    </span>
  )
}
