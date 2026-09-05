const statusPriority = Object.freeze({
  FAILED: 5,
  STALE: 4,
  DEGRADED: 3,
  NOT_CONFIGURED: 2,
  UNKNOWN: 1,
  DISABLED: 0,
  HEALTHY: -1,
})

const runtimeIssueMessageKeys = Object.freeze({
  COMPONENT_FAILED: 'issue.runtime.componentFailed',
  STATUS_STALE: 'issue.runtime.statusStale',
  ADAPTER_UNAVAILABLE: 'issue.runtime.adapterUnavailable',
  BROKER_DISCONNECTED: 'issue.runtime.brokerDisconnected',
  DEVICE_OFFLINE: 'issue.runtime.deviceOffline',
})

export function evidenceStatus(value = {}) {
  if (value.freshness === 'STALE') return 'STALE'
  return Object.hasOwn(statusPriority, value.status) ? value.status : 'UNKNOWN'
}

export function engineState(value) {
  return ['RUNNING', 'DEGRADED', 'STOPPED'].includes(value) ? value : 'UNKNOWN'
}

export function engineStatus(value) {
  return ({ RUNNING: 'HEALTHY', DEGRADED: 'DEGRADED', STOPPED: 'FAILED' })[engineState(value)] || 'UNKNOWN'
}

export function activeRuntimeModes(runtime = {}) {
  const modes = runtime.modes || {}
  return [
    ['MONITOR_ONLY', modes.monitorOnly],
    ['DRY_RUN', modes.dryRun],
    ['ARMED', modes.armed],
    ['AUTO_CONTAIN', modes.autoContain],
    ['RECOVERY_AUTHORIZED', modes.recoveryAuthorized],
  ].filter(([, enabled]) => enabled).map(([label]) => label)
}

export function runtimeComponent(runtime = {}, id) {
  return runtime.components?.find((component) => component.id === id) || { id, name: id, status: 'UNKNOWN' }
}

function addIssue(items, issue) {
  if (!items.some((item) => item.key === issue.key)) items.push(issue)
}

export function dashboardIssues(snapshot, { apiConnected = true } = {}) {
  const items = []
  const incident = snapshot.incidents?.[0]
  const device = snapshot.devices?.[0]
  const relay = runtimeComponent(snapshot.runtime, 'relay')

  if (!apiConnected) {
    addIssue(items, {
      key: 'api-disconnected', status: 'FAILED', component: 'Security Center API', route: 'settings',
      messageKey: 'issue.apiDisconnected.title', detailKey: 'issue.apiDisconnected.detail',
    })
  }

  if (incident?.severity === 'CRITICAL') {
    addIssue(items, {
      key: `incident-${incident.id}`, status: 'FAILED', component: incident.id, route: 'incidents',
      messageKey: 'issue.criticalIncident.title', detailKey: 'issue.criticalIncident.detail', variables: { id: incident.id },
    })
  }

  for (const [key, label, componentKey, domain, route] of [
    ['idea1', 'IDEA1 Access Security', 'idea1.component', snapshot.idea1, 'idea1'],
    ['idea2', 'IDEA2 Detection', 'idea2.component', snapshot.idea2, 'idea2'],
  ]) {
    const status = evidenceStatus(domain)
    if (status !== 'HEALTHY') {
      addIssue(items, {
        key, status, component: label, componentKey, route,
        messageKey: status === 'STALE' ? 'issue.domainStale.title' : 'issue.domainReview.title',
        detailKey: 'issue.domain.detail',
      })
    }
  }

  const physicalRelayState = device?.physicalRelayState
  if (!physicalRelayState || physicalRelayState === 'UNKNOWN' || relay.status === 'UNKNOWN') {
    addIssue(items, {
      key: 'relay-not-verified', status: 'UNKNOWN', component: 'IDEA3 relay evidence', route: 'lockdown',
      messageKey: 'issue.relay.title', detailKey: 'issue.relay.detail',
    })
  }

  if (snapshot.auditIntegrity?.status !== 'HEALTHY') {
    addIssue(items, {
      key: 'audit-integrity', status: evidenceStatus(snapshot.auditIntegrity), component: 'Audit Store', route: 'audit',
      messageKey: 'issue.audit.title', detailKey: 'issue.audit.detail',
    })
  }

  for (const issue of snapshot.runtime?.issues || []) {
    addIssue(items, {
      key: `runtime-${issue.code}-${issue.component}`,
      status: issue.severity === 'CRITICAL' ? 'FAILED' : 'DEGRADED',
      component: issue.component,
      route: issue.component?.includes('relay') ? 'lockdown' : 'devices',
      messageKey: runtimeIssueMessageKeys[issue.code] || 'issue.runtime.generic',
      detailKey: 'issue.runtime.detail', variables: { code: issue.code, count: issue.count ?? 1 },
    })
  }

  return items
    .sort((a, b) => (statusPriority[b.status] ?? 0) - (statusPriority[a.status] ?? 0))
    .slice(0, 5)
}

export function recommendedActions(issues) {
  return issues.slice(0, 3).map((issue) => ({
    ...issue,
    actionKey: issue.route === 'incidents' ? 'action.reviewIncident'
      : issue.route === 'lockdown' ? 'action.reviewIdea3'
        : issue.route === 'audit' ? 'action.reviewAudit'
          : issue.route === 'settings' ? 'action.reviewProductionSettings'
            : 'action.openDetails',
    actionVariables: { component: issue.component },
  }))
}
