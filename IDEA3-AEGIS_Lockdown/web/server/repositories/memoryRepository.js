import { operationalErrorFingerprint } from '../domain/operationalErrors.js'
import {
  DEFAULT_SETTINGS,
  auditEntryForOperationalError,
  sanitizeAuditEntry,
  sanitizedSettings,
  validateAuditLimit,
} from './auditRecords.js'

export function createMemoryRepository({ clock = () => new Date() } = {}) {
  const acknowledgedAlerts = new Set()
  const incidentNotes = new Map()
  const audit = []
  const activeOperationalErrors = new Set()
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

  return {
    acknowledgeAlert(id) {
      acknowledgedAlerts.add(id)
      return appendAudit({ category: 'ALERT', action: 'ACKNOWLEDGE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'alert', resourceId: id })
    },
    addIncidentNote(id, note) {
      incidentNotes.set(id, note)
      return appendAudit({ category: 'INCIDENT', action: 'ADD_NOTE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'incident', resourceId: id })
    },
    recordAction(entry) {
      return appendAudit(entry)
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
      return audit.slice(0, limit)
    },
    apply(snapshot) {
      return {
        ...snapshot,
        alerts: snapshot.alerts.map((alert) => acknowledgedAlerts.has(alert.id) ? { ...alert, status: 'ACKNOWLEDGED' } : alert),
        incidents: snapshot.incidents.map((incident) => incidentNotes.has(incident.id) ? { ...incident, analystNote: incidentNotes.get(incident.id) } : incident),
        audit: [...audit, ...snapshot.audit],
        settings: { ...snapshot.settings, policy: { ...snapshot.settings.policy, ...settings } },
      }
    },
    close() {},
  }
}
