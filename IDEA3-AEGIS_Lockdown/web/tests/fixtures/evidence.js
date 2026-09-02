export const fixedNow = new Date('2026-09-03T00:12:24.000Z')

export const idea1DeniedRaw = Object.freeze({
  timestamp: '2026-09-03T00:09:10.000Z',
  action: 'LOGIN',
  result: 'DENIED',
  source_ip: '10.30.0.24',
})

export const idea2DetectionRaw = Object.freeze({
  timestamp: '2026-09-03T00:12:02.000Z',
  type: 'PERSON_DETECTED',
  severity: 'HIGH',
  source_ip: '10.30.0.24',
  target: 'CAM-02',
  result: 'DETECTED',
  frame: 'base64-image-must-never-leave-producer',
  embedding: [0.42, 0.11],
  face_name: 'private-person',
  password: 'must-not-pass',
})

export const healthyRuntimeRaw = Object.freeze({
  schemaVersion: 1,
  generatedAt: '2026-09-03T00:12:20.000Z',
  status: 'HEALTHY',
  components: {
    runtime: 'HEALTHY',
    broker: 'HEALTHY',
    esp32: 'HEALTHY',
    relay: 'UNKNOWN',
    uplink: 'UNKNOWN',
    heartbeat: 'HEALTHY',
    ack: 'HEALTHY',
  },
  modes: {
    monitorOnly: true,
    dryRun: true,
    armed: false,
    autoContain: false,
    recoveryAuthorized: false,
  },
  issues: [],
  evidenceSource: 'idea3-runtime-status-v1',
  rawLog: 'must not be returned',
  mqttPassword: 'must not be returned',
})

export const futureRuntimeRaw = Object.freeze({
  ...healthyRuntimeRaw,
  generatedAt: '2026-09-03T00:15:00.000Z',
})
