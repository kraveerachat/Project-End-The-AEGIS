// TEST_ONLY — synthetic documents shaped like aegis_soc.runtime.safe_status_projection (schemaVersion 1).
// None of these is a capture from a real LAB, ESP32 or broker; they must never be served, seeded or presented as evidence.
export const labFixedNow = new Date('2026-10-17T10:00:00.000Z')

const base = Object.freeze({
  schemaVersion: 1,
  generatedAt: '2026-10-17T09:59:50.000Z',
  status: 'DEGRADED',
  dispatch: 'DISABLED',
  components: Object.freeze({ broker: 'CONNECTED', device: 'ONLINE', uplink: 'LOCKDOWN' }),
  modes: Object.freeze({ profile: 'lab', dryRun: true, autoContain: false, armed: 'MONITOR_ONLY' }),
  issues: Object.freeze([]),
  evidenceSource: 'RUNTIME_STATUS_FILE',
})

/** Core runtime state LOCKDOWN (projection maps it to DEGRADED). */
export const TEST_ONLY_labLockdownRaw = base

/** Core RUNNING but the device reports LOCKDOWN uplink (projection keeps status HEALTHY when not dry-run and dispatch ACTIVE). */
export const TEST_ONLY_labRunningUplinkLockdownRaw = Object.freeze({
  ...base,
  status: 'HEALTHY',
  dispatch: 'ACTIVE',
  modes: Object.freeze({ ...base.modes, dryRun: false, armed: 'ARMED' }),
})

export const TEST_ONLY_labAbsentRaw = Object.freeze({
  schemaVersion: 1,
  generatedAt: null,
  status: 'UNKNOWN',
  dispatch: 'UNKNOWN',
  components: Object.freeze({}),
  modes: Object.freeze({ profile: 'UNKNOWN', dryRun: true, autoContain: false, armed: 'UNKNOWN' }),
  issues: Object.freeze([]),
  evidenceSource: 'RUNTIME_STATUS_ABSENT',
})

/** Hostile extras a producer must never be able to turn into physical-state claims. */
export const TEST_ONLY_labClaimedPhysicalExtras = Object.freeze({
  relay: 'CUT',
  requestedRelayState: 'CUT',
  physicalRelayState: 'CUT',
  ack: 'ACK_OK',
  heartbeat: 'ALIVE',
  lastAck: '2026-10-17T09:59:59.000Z',
})
