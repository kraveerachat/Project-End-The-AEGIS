const ago = (now, seconds) => new Date(now.getTime() - seconds * 1_000).toISOString()

function statusSource(id, name, status, generatedAt, latencyMs, detail) {
  return { id, name, status, freshness: 'FRESH', generatedAt, latencyMs, detail }
}

export function createDemoProvider({ clock = () => new Date() } = {}) {
  return {
    async getSnapshot() {
      const now = clock()
      const generatedAt = now.toISOString()
      const events = [
        { id: 'demo-event-001', timestamp: ago(now, 22), source: 'IDEA2', type: 'PERSON_DETECTED', result: 'DETECTED', severity: 'HIGH', sourceIp: '10.30.0.24', target: 'CAM-02', dedupCount: 1 },
        { id: 'demo-event-002', timestamp: ago(now, 194), source: 'IDEA1', type: 'ACCESS_CONTROL', action: 'LOGIN', result: 'DENIED', severity: 'WARNING', sourceIp: '10.30.0.24', target: 'AEGIS Drive', dedupCount: 3 },
        { id: 'demo-event-003', timestamp: ago(now, 330), source: 'IDEA3', type: 'ACK_RECEIVED', result: 'VERIFIED', severity: 'INFO', sourceIp: '10.30.0.31', target: 'ESP32-LOCK-01', dedupCount: 1 },
        { id: 'demo-event-004', timestamp: ago(now, 480), source: 'IDEA2', type: 'LINE_CROSSING', result: 'DETECTED', severity: 'WARNING', sourceIp: '10.30.0.18', target: 'CAM-01', dedupCount: 1 },
        { id: 'demo-event-005', timestamp: ago(now, 640), source: 'IDEA1', type: 'ACCESS_CONTROL', action: 'SHARE', result: 'BLOCKED', severity: 'HIGH', sourceIp: '10.30.0.51', target: 'AEGIS Drive', dedupCount: 2 },
      ]
      const alerts = [
        { id: 'demo-alert-001', timestamp: ago(now, 22), source: 'CORRELATION', type: 'MULTI_SOURCE_ACTIVITY', severity: 'CRITICAL', sourceIp: '10.30.0.24', target: 'Zone B', dedupCount: 4, status: 'UNACKNOWLEDGED' },
        { id: 'demo-alert-002', timestamp: ago(now, 480), source: 'IDEA2', type: 'LINE_CROSSING', severity: 'HIGH', sourceIp: '10.30.0.18', target: 'CAM-01', dedupCount: 1, status: 'UNACKNOWLEDGED' },
        { id: 'demo-alert-003', timestamp: ago(now, 640), source: 'IDEA1', type: 'ACCESS_BLOCKED', severity: 'WARNING', sourceIp: '10.30.0.51', target: 'AEGIS Drive', dedupCount: 2, status: 'ACKNOWLEDGED' },
      ]
      const incidents = [{
        id: 'demo-inc-001', severity: 'CRITICAL', state: 'INVESTIGATING',
        firstSeen: ago(now, 194), lastSeen: ago(now, 22), sourceIp: '10.30.0.24',
        idea1Count: 3, idea2Count: 1, responseState: 'ACKED',
        title: 'ตรวจพบกิจกรรมผิดปกติข้าม IDEA1 และ IDEA2',
        summary: 'การปฏิเสธสิทธิ์ซ้ำสัมพันธ์กับการตรวจจับบุคคลในช่วงเวลา 10 นาที',
        evidenceStages: [
          { stage: 'REQUESTED', status: 'HEALTHY', timestamp: ago(now, 88) },
          { stage: 'ACCEPTED', status: 'HEALTHY', timestamp: ago(now, 86) },
          { stage: 'ACKED', status: 'HEALTHY', timestamp: ago(now, 84) },
          { stage: 'EXECUTED', status: 'UNKNOWN', timestamp: null },
          { stage: 'PHYSICALLY VERIFIED', status: 'UNKNOWN', timestamp: null },
        ],
      }]
      const runtimeComponents = [
        ['runtime', 'Supervisor', 'HEALTHY'], ['broker', 'MQTT Broker', 'HEALTHY'],
        ['esp32', 'ESP32', 'HEALTHY'], ['relay', 'Relay', 'UNKNOWN'],
        ['uplink', 'Uplink', 'UNKNOWN'], ['heartbeat', 'Heartbeat', 'HEALTHY'], ['ack', 'ACK', 'HEALTHY'],
      ].map(([id, name, status]) => ({ id, name, status }))

      return structuredClone({
        schemaVersion: 1,
        mode: 'DEMO',
        generatedAt,
        overall: { status: 'DEGRADED', evidenceAgeMs: 4_000, eventCount: 128, activeIncidents: 1, highAlerts: 2 },
        sources: [
          statusSource('idea1', 'IDEA1 Access Security', 'HEALTHY', ago(now, 12), 4.2, 'Sanitized contract'),
          statusSource('idea2', 'IDEA2 Detection', 'HEALTHY', ago(now, 22), 8.7, 'Sanitized contract'),
          statusSource('idea3', 'IDEA3 Runtime', 'DEGRADED', ago(now, 4), 2.1, 'Monitor-only / Dry-run'),
          statusSource('events', 'Event Store', 'HEALTHY', ago(now, 2), 1.4, 'In-memory demo repository'),
          statusSource('audit', 'Audit Store', 'HEALTHY', ago(now, 2), 1.8, 'Append-oriented demo ledger'),
        ],
        events,
        idea1: { status: 'HEALTHY', freshness: 'FRESH', generatedAt: ago(now, 12), summary: { denied: 18, blocked: 7, uniqueSourceIps: 11, repeated: 5, escalated: 2 }, events: events.filter((event) => event.source === 'IDEA1') },
        idea2: { status: 'HEALTHY', freshness: 'FRESH', generatedAt: ago(now, 22), summary: { detections: 34, high: 6, critical: 1, cameras: 3 }, events: events.filter((event) => event.source === 'IDEA2') },
        alerts,
        incidents,
        audit: [
          { id: 'demo-audit-001', timestamp: ago(now, 84), category: 'DEVICE', action: 'ACK_RECEIVED', outcome: 'SUCCESS', actorRef: 'runtime-adapter', resourceType: 'device', resourceId: 'ESP32-LOCK-01' },
          { id: 'demo-audit-002', timestamp: ago(now, 120), category: 'INCIDENT', action: 'STATE_CHANGE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'incident', resourceId: 'demo-inc-001' },
          { id: 'demo-audit-003', timestamp: ago(now, 420), category: 'AUTH', action: 'LOGIN', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'session', resourceId: 'current' },
        ],
        runtime: {
          schemaVersion: 1, generatedAt: ago(now, 4), evidenceAgeMs: 4_000, freshness: 'FRESH', status: 'DEGRADED',
          components: runtimeComponents,
          modes: { monitorOnly: true, dryRun: true, armed: false, autoContain: false, recoveryAuthorized: false },
          issues: [{ code: 'COMPONENT_FAILED', component: 'relay-evidence', severity: 'WARNING', firstSeen: ago(now, 900), lastSeen: ago(now, 4), count: 3 }],
          evidenceSource: 'demo-runtime-status-v1',
          timeline: [
            { id: 'rt-1', timestamp: ago(now, 4), title: 'Heartbeat verified', detail: 'ESP32-LOCK-01', status: 'HEALTHY' },
            { id: 'rt-2', timestamp: ago(now, 84), title: 'ACK received', detail: 'nonce verified', status: 'HEALTHY' },
            { id: 'rt-3', timestamp: ago(now, 900), title: 'Relay evidence unavailable', detail: 'physical sensor not configured', status: 'UNKNOWN' },
          ],
          readiness: [
            ['MQTT broker', 'HEALTHY'], ['Device heartbeat', 'HEALTHY'], ['ACK validation', 'HEALTHY'],
            ['HMAC policy', 'DEGRADED'], ['Nonce policy', 'HEALTHY'], ['Timestamp validation', 'HEALTHY'],
            ["Dead Man's Switch", 'NOT_CONFIGURED'], ['Recovery authorization', 'DISABLED'],
          ].map(([label, status]) => ({ label, status })),
        },
        devices: [{
          id: 'ESP32-LOCK-01', type: 'ESP32 + Relay', status: 'DEGRADED', lastSeen: ago(now, 4),
          heartbeat: 'HEALTHY', ack: 'HEALTHY', relay: 'UNKNOWN', requestedRelayState: 'OPEN',
          physicalRelayState: 'UNKNOWN', firmwareVersion: '1.4.2', evidenceAgeMs: 4_000,
        }],
        recovery: {
          gatewayStatus: 'DISABLED', liveHardware: false, authorization: 'DISABLED', incidentState: 'INVESTIGATING',
          preconditions: [
            ['Admin session', true], ['CSRF proof', true], ['Exact confirmation', false],
            ['Eligible incident', true], ['Reachable device', true], ['Acceptable ACK', true],
            ['Runtime mode', true], ['Recovery authorization', false], ['Fresh evidence', true],
          ].map(([label, satisfied]) => ({ label, satisfied })),
          runbook: ['Verify incident evidence', 'Confirm containment state', 'Validate administrator session', 'Validate recovery authorization', 'Send signed request', 'Verify ACK', 'Verify physical network state', 'Close incident'],
          history: [{ id: 'demo-recovery-001', timestamp: ago(now, 3_600), stage: 'VALIDATION', outcome: 'DENIED', detail: 'Recovery authorization disabled' }],
        },
        settings: {
          adapters: [
            { id: 'idea1', name: 'IDEA1 adapter', enabled: true, configured: true, timeoutMs: 2500, alias: 'drive-security', lastValidation: ago(now, 12), lastSuccess: ago(now, 12) },
            { id: 'idea2', name: 'IDEA2 adapter', enabled: true, configured: true, timeoutMs: 2500, alias: 'detection-events', lastValidation: ago(now, 22), lastSuccess: ago(now, 22) },
            { id: 'runtime', name: 'IDEA3 runtime', enabled: true, configured: true, timeoutMs: 2500, alias: 'runtime-status', lastValidation: ago(now, 4), lastSuccess: ago(now, 4) },
          ],
          policy: { dedupWindowSeconds: 60, correlationWindowMinutes: 10, escalationThreshold: 3, eventRetentionDays: 30, auditRetentionDays: 180, exportLimit: 1000 },
          security: { csrf: 'ENFORCED', adminRbac: 'ENFORCED', secureCookieProduction: 'REQUIRED', productionDemo: 'DENIED', rawPayload: 'DENIED' },
        },
        provenance: { provider: 'isolated-demo-provider', liveMerged: false, persistence: 'SESSION_AND_MEMORY_ONLY' },
      })
    },
  }
}
