/**
 * The PR10 S2 Server → Core dispatch vocabulary (inventory §13.3, decision D7).
 *
 * This module is the single source of the dispatchable actions, the
 * server-owned action states, and the evidence stages the Core may report. The
 * SQLite schema builds its CHECK constraints from these lists. Only CUT_UPLINK
 * can ever be dispatched: RESTORE stays a Core-local authority (D4).
 */
export const DISPATCH_ACTIONS = Object.freeze(['CUT_UPLINK'])

/** Server-owned states. Every post-claim stage belongs to the Core. */
export const DISPATCH_ACTION_STATES = Object.freeze(['PENDING_DISPATCH', 'CORE_CLAIMED', 'EXPIRED'])

/** Stages the Core may report back. The server mirrors them and never infers them. */
export const DISPATCH_EVIDENCE_STAGES = Object.freeze([
  'PUBLISHED',
  'DRY_RUN',
  'ACK',
  'STATUS',
  'OUTCOME_UNKNOWN',
  'EXPIRED_AT_CORE',
  'FAILED',
])

/** D7: an accepted CUT expires 120 s after Admin acceptance. Deliberately not configurable. */
export const DISPATCH_TTL_MS = 120_000
