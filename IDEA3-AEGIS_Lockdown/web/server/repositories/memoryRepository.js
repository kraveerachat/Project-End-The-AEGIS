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
    recordContainmentDecision(decision) {
      const safe = safeContainmentDecision(decision)
      const existing = containmentDecisions.get(safe.incidentId)
      if (existing) {
        return { status: existing.decision === safe.decision ? 'UNCHANGED' : 'CONFLICT', ...existing, audit: null }
      }
      containmentDecisions.set(safe.incidentId, safe)
      return { status: 'RECORDED', ...safe, audit: appendAudit(containmentAuditEntry(safe)) }
    },
    readContainmentDecision(incidentId) {
      return containmentDecisions.get(incidentId) ?? null
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
    apply(snapshot) {
      return {
        ...snapshot,
        alerts: snapshot.alerts.map((alert) => acknowledgedAlerts.has(alert.id) ? { ...alert, status: 'ACKNOWLEDGED' } : alert),
        incidents: snapshot.incidents.map((incident) => incidentNotes.has(incident.id) ? { ...incident, analystNote: incidentNotes.get(incident.id) } : incident),
        audit: [...orderedAudit(), ...snapshot.audit],
        settings: { ...snapshot.settings, policy: { ...snapshot.settings.policy, ...settings } },
      }
    },
    close() {},
  }
}
