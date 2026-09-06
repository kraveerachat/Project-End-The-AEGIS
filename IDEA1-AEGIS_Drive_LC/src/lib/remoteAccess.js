const CONNECTOR_STATUS_LABEL = {
  HEALTHY: 'connStatusHealthy',
  STARTING: 'connStatusStarting',
  UNHEALTHY: 'connStatusUnhealthy',
  STOPPED: 'connStatusStopped',
  RESTARTING: 'connStatusRestarting',
  NOT_CONFIGURED: 'valNotConfigured',
  UNKNOWN: 'connStatusUnknown',
}

const CONNECTOR_STATUS_TONE = {
  HEALTHY: 'ok',
  STARTING: 'warn',
  UNHEALTHY: 'danger',
  STOPPED: 'danger',
  RESTARTING: 'warn',
  NOT_CONFIGURED: null,
  UNKNOWN: null,
}

const RUNTIME_STATE_LABEL = {
  RUNNING: 'runtimeRunning',
  STOPPED: 'runtimeStopped',
  RESTARTING: 'runtimeRestarting',
  UNKNOWN: 'valNotMeasured',
}

const DOCKER_HEALTH_LABEL = {
  HEALTHY: 'dockerHealthHealthy',
  UNHEALTHY: 'dockerHealthUnhealthy',
  STARTING: 'dockerHealthStarting',
  NOT_CONFIGURED: 'valNotConfigured',
  UNKNOWN: 'valNotMeasured',
}

const CONNECTOR_REASON_LABEL = {
  'connector-not-found': 'connReasonNotFound',
  'docker-unavailable': 'connReasonDockerUnavailable',
  'inspect-failed': 'connReasonInspectFailed',
  'collector-not-run': 'connReasonCollectorNotRun',
  'not-configured': 'connReasonNotConfigured',
  'invalid-evidence': 'connReasonInvalid',
  'agent-unreachable': 'connReasonAgentUnreachable',
  stale: 'connReasonStale',
}

export function connectorStatusLabel(t, status) {
  return t(CONNECTOR_STATUS_LABEL[status] ?? 'connStatusUnknown')
}

export function connectorStatusTone(status) {
  return CONNECTOR_STATUS_TONE[status] ?? null
}

export function connectorRuntimeLabel(t, state) {
  return t(RUNTIME_STATE_LABEL[state] ?? 'valNotMeasured')
}

export function connectorHealthLabel(t, health) {
  return t(DOCKER_HEALTH_LABEL[health] ?? 'valNotMeasured')
}

export function connectorReasonKey(reason) {
  return CONNECTOR_REASON_LABEL[reason] ?? null
}

/** Compact local-runtime summary for surfaces that do not show connector detail. */
export function localConnectorSummary(t, local, { loading = false, error = null } = {}) {
  if (loading && !local) return { label: t('telemetryStateLoading'), tone: null, state: 'loading' }
  if (error || !local?.available) {
    return { label: t('telemetryStateUnavailable'), tone: null, state: 'unavailable' }
  }
  if (local.stale === true || local.reason === 'stale') {
    return { label: t('telemetryStateStale'), tone: 'warn', state: 'stale' }
  }

  const status = local.status ?? 'UNKNOWN'
  const statusLabel = connectorStatusLabel(t, status)
  const runtimeLabel = local.runtimeState ? connectorRuntimeLabel(t, local.runtimeState) : null
  return {
    label: runtimeLabel && runtimeLabel !== statusLabel ? `${statusLabel} / ${runtimeLabel}` : statusLabel,
    tone: connectorStatusTone(status),
    state: status.toLowerCase(),
  }
}
