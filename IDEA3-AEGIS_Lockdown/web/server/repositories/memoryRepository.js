import { randomUUID } from 'node:crypto'
import {
  DISPATCH_ACTIONS,
  DISPATCH_LIST_LIMIT,
  dispatchAuditEntry,
  dispatchEvidenceAuditEntry,
  dispatchIncidentOverlay,
  pendingDispatchAction,
  safeDispatchEvidence,
  validateDispatchListLimit,
} from '../domain/dispatch.js'
import { operationalErrorFingerprint } from '../domain/operationalErrors.js'
import {
  DEFAULT_SETTINGS,
  auditEntryForOperationalError,
  sanitizeAuditEntry,
  sanitizeIncidentNote,
  containmentAuditEntry,
  integrationAuditEntry,
  safeContainmentDecision,
  sanitizedSettings,
  validateAuditLimit,
} from './auditRecords.js'

export function createMemoryRepository({ clock = () => new Date() } = {}) {
  const acknowledgedAlerts = new Set()
  const incidentNotes = new Map()
  const audit = []
  const activeOperationalErrors = new Set()
  const containmentDecisions = new Map()
  const dispatchActions = new Map()
  const dispatchEvidence = new Map()
  const activeIntegrationMarkers = new Set()
  const correlatedIncidents = new Set()
  const settings = { ...DEFAULT_SETTINGS }

  function appendAudit(entry) {
    const record = {
      id: `audit-${String(audit.length + 1).padStart(5, '0')}`,
      timestamp: clock().toISOString(),
      ...sanitizeAuditEntry(entry),
    }
    audit.unshift(record)
    return record
  }

  function orderedAudit() {
    return [...audit].sort((left, right) => (
      Date.parse(right.timestamp) - Date.parse(left.timestamp)
      || Number.parseInt(right.id.slice('audit-'.length), 10) - Number.parseInt(left.id.slice('audit-'.length), 10)
    ))
  }

  function dispatchForIncident(incidentId) {
    for (const action of dispatchActions.values()) {
      if (action.incidentId === incidentId) return { ...action }
    }
    return null
  }

  function expirePastDueDispatch(now) {
    for (const action of dispatchActions.values()) {
      if (action.state === 'PENDING_DISPATCH' && action.expiresAt <= now) {
        action.state = 'EXPIRED'
        appendAudit(dispatchAuditEntry('ACTION_EXPIRED', action, 'system'))
      }
    }
  }

  function byAcceptance(left, right) {
    if (left.acceptedAt !== right.acceptedAt) return left.acceptedAt < right.acceptedAt ? -1 : 1
    if (left.actionId === right.actionId) return 0
    return left.actionId < right.actionId ? -1 : 1
  }

  function evidenceForAction(actionId) {
    return [...(dispatchEvidence.get(actionId)?.values() ?? [])]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => ({ ...entry, detail: { ...entry.detail } }))
  }

  return {
    acknowledgeAlert(id) {
      acknowledgedAlerts.add(id)
      return appendAudit({ category: 'ALERT', action: 'ACKNOWLEDGE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'alert', resourceId: id })
    },
    addIncidentNote(id, note) {
      incidentNotes.set(id, sanitizeIncidentNote(note))
      return appendAudit({ category: 'INCIDENT', action: 'ADD_NOTE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'incident', resourceId: id })
    },
    recordAction(entry) {
      return appendAudit(entry)
    },
    recordContainmentDecision(decision, { mintDispatch = false } = {}) {
      const safe = safeContainmentDecision(decision)
      const existing = containmentDecisions.get(safe.incidentId)
      if (existing) {
        return {
          status: existing.decision === safe.decision ? 'UNCHANGED' : 'CONFLICT',
          ...existing,
          audit: null,
          dispatch: dispatchForIncident(safe.incidentId),
        }
      }
      containmentDecisions.set(safe.incidentId, safe)
      const audit = appendAudit(containmentAuditEntry(safe))
      let dispatch = null
      if (mintDispatch && safe.decision === 'ACCEPT') {
        dispatch = pendingDispatchAction({ actionId: randomUUID(), incidentId: safe.incidentId, acceptedAt: audit.timestamp })
        dispatchActions.set(dispatch.actionId, { ...dispatch })
        appendAudit(dispatchAuditEntry('ACTION_MINTED', dispatch, 'session-admin'))
      }
      return { status: 'RECORDED', ...safe, audit, dispatch }
    },
    readContainmentDecision(incidentId) {
      return containmentDecisions.get(incidentId) ?? null
    },
    readDispatchAction(actionId) {
      const action = dispatchActions.get(actionId)
      return action ? { ...action } : null
    },
    listPendingDispatchActions({ limit = DISPATCH_LIST_LIMIT } = {}) {
      validateDispatchListLimit(limit)
      const now = clock().toISOString()
      expirePastDueDispatch(now)
      return [...dispatchActions.values()]
        .filter((action) => action.state === 'PENDING_DISPATCH' && action.expiresAt > now && DISPATCH_ACTIONS.includes(action.action))
        .sort(byAcceptance)
        .slice(0, limit)
        .map((action) => ({ ...action }))
    },
    claimDispatchAction(actionId, { subject } = {}) {
      if (typeof subject !== 'string' || subject.length === 0) {
        throw new TypeError('A machine subject is required to claim a dispatch action')
      }
      const now = clock().toISOString()
      expirePastDueDispatch(now)
      const action = dispatchActions.get(actionId)
      if (!action) return { status: 'NOT_FOUND', dispatch: null }
      if (!DISPATCH_ACTIONS.includes(action.action)) return { status: 'NOT_DISPATCHABLE', dispatch: { ...action } }
      if (action.state === 'EXPIRED') return { status: 'EXPIRED', dispatch: { ...action } }
      if (action.state !== 'PENDING_DISPATCH') return { status: 'ALREADY_CLAIMED', dispatch: { ...action } }
      action.state = 'CORE_CLAIMED'
      action.claimedAt = now
      action.claimedBy = subject
      appendAudit(dispatchAuditEntry('ACTION_CLAIMED', action, 'machine-core'))
      return { status: 'CLAIMED', dispatch: { ...action } }
    },
    readDispatchEvidence(actionId) {
      return evidenceForAction(actionId)
    },
    recordDispatchEvidence(actionId, entry) {
      const safe = safeDispatchEvidence(entry)
      if (!safe) throw new TypeError('Dispatch evidence is outside the allowlist')
      const action = dispatchActions.get(actionId)
      if (!action) return { status: 'NOT_FOUND', evidence: null }
      if (action.state !== 'CORE_CLAIMED') return { status: 'NOT_CLAIMED', evidence: null }

      const recorded = dispatchEvidence.get(actionId) ?? new Map()
      const existing = recorded.get(safe.sequence)
      if (existing) {
        const identical = existing.stage === safe.stage
          && existing.observedAt === safe.observedAt
          && JSON.stringify(existing.detail) === JSON.stringify(safe.detail)
        return { status: identical ? 'UNCHANGED' : 'CONFLICT', evidence: { ...existing, detail: { ...existing.detail } } }
      }
      const evidence = { ...safe, receivedAt: clock().toISOString() }
      recorded.set(safe.sequence, evidence)
      dispatchEvidence.set(actionId, recorded)
      appendAudit(dispatchEvidenceAuditEntry(actionId, safe))
      return { status: 'RECORDED', evidence: { ...evidence, detail: { ...evidence.detail } } }
    },
    recordIntegrationOutcome({ sources = [], conflicts = [], incidents = [] } = {}) {
      const recorded = []
      const emit = (action, fields) => {
        const entry = integrationAuditEntry(action, fields)
        if (entry) recorded.push(appendAudit(entry))
        return Boolean(entry)
      }

      for (const source of sources) {
        if (source?.status === 'NOT_CONFIGURED') continue
        const failureMarker = `${source.source}:ADAPTER_FAILURE`
        if (source.status === 'HEALTHY') {
          if (activeIntegrationMarkers.delete(failureMarker)) emit('ADAPTER_RECOVERED', { source: source.source })
        } else if (!activeIntegrationMarkers.has(failureMarker)) {
          if (emit('ADAPTER_FAILURE', { source: source.source, code: source.code })) activeIntegrationMarkers.add(failureMarker)
        }

        const rejectionMarker = `${source.source}:EVENT_REJECTED`
        const rejectedCount = Number.isSafeInteger(source.rejectedCount) ? source.rejectedCount : 0
        if (rejectedCount > 0) {
          if (!activeIntegrationMarkers.has(rejectionMarker)) {
            if (emit('EVENT_REJECTED', { source: source.source, count: rejectedCount })) activeIntegrationMarkers.add(rejectionMarker)
          }
        } else {
          activeIntegrationMarkers.delete(rejectionMarker)
        }
      }

      for (const conflict of conflicts) {
        const marker = `CONFLICT:${conflict?.source}:${conflict?.event_id}`
        if (activeIntegrationMarkers.has(marker)) continue
        if (emit('EVENT_ID_CONFLICT', { source: conflict?.source, code: conflict?.event_id })) activeIntegrationMarkers.add(marker)
      }

      for (const incident of incidents) {
        if (typeof incident?.id !== 'string' || correlatedIncidents.has(incident.id)) continue
        if (emit('INCIDENT_CORRELATED', { incident })) correlatedIncidents.add(incident.id)
      }

      return recorded
    },
    updateSettings(next) {
      Object.assign(settings, sanitizedSettings(next))
      return { ...settings }
    },
    recordOperationalErrors(errors) {
      const unique = new Map()
      for (const error of Array.isArray(errors) ? errors : []) {
        unique.set(operationalErrorFingerprint(error), error)
      }
      const recorded = []
      for (const [fingerprint, error] of unique) {
        if (activeOperationalErrors.has(fingerprint)) continue
        recorded.push(appendAudit(auditEntryForOperationalError(error)))
      }
      activeOperationalErrors.clear()
      for (const fingerprint of unique.keys()) activeOperationalErrors.add(fingerprint)
      return recorded
    },
    queryAudit({ limit = 100 } = {}) {
      validateAuditLimit(limit)
      return orderedAudit().slice(0, limit)
    },
    apply(snapshot, { lastMachineContactAt = null } = {}) {
      const now = clock()
      const withDispatch = (incident) => {
        const action = dispatchForIncident(incident.id)
        return dispatchIncidentOverlay(incident, action, action ? evidenceForAction(action.actionId) : [], { lastMachineContactAt, now })
      }
      return {
        ...snapshot,
        alerts: snapshot.alerts.map((alert) => acknowledgedAlerts.has(alert.id) ? { ...alert, status: 'ACKNOWLEDGED' } : alert),
        incidents: snapshot.incidents.map((incident) => withDispatch(
          incidentNotes.has(incident.id) ? { ...incident, analystNote: incidentNotes.get(incident.id) } : incident,
        )),
        audit: [...orderedAudit(), ...snapshot.audit],
        settings: { ...snapshot.settings, policy: { ...snapshot.settings.policy, ...settings } },
      }
    },
    close() {},
  }
}
