export function createMemoryRepository({ clock = () => new Date() } = {}) {
  const acknowledgedAlerts = new Set()
  const incidentNotes = new Map()
  const audit = []
  const settings = {
    dedupWindowSeconds: 60,
    correlationWindowMinutes: 10,
    escalationThreshold: 3,
    eventRetentionDays: 30,
    auditRetentionDays: 180,
    exportLimit: 1000,
  }

  function appendAudit(entry) {
    const record = {
      id: `audit-${String(audit.length + 1).padStart(5, '0')}`,
      timestamp: clock().toISOString(),
      ...entry,
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
      Object.assign(settings, next)
      return { ...settings }
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
  }
}
