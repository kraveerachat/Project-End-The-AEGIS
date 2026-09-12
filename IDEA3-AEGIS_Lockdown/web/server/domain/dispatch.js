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

/** The machine list returns at most this many pending actions, oldest first. */
export const DISPATCH_LIST_LIMIT = 10

/** Refuse any action other than CUT_UPLINK before it can reach storage (W11). */
export function assertDispatchable(action) {
  if (!DISPATCH_ACTIONS.includes(action)) {
    throw new Error('Only CUT_UPLINK can be dispatched')
  }
  return action
}

export function validateDispatchListLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISPATCH_LIST_LIMIT) {
    throw new RangeError(`Dispatch list limit must be an integer from 1 to ${DISPATCH_LIST_LIMIT}`)
  }
}

/**
 * The one pending action minted for an accepted decision. It expires exactly
 * DISPATCH_TTL_MS after acceptance and carries no claim yet.
 */
export function pendingDispatchAction({ actionId, incidentId, acceptedAt }) {
  return {
    actionId,
    incidentId,
    action: assertDispatchable('CUT_UPLINK'),
    state: 'PENDING_DISPATCH',
    acceptedAt,
    expiresAt: new Date(Date.parse(acceptedAt) + DISPATCH_TTL_MS).toISOString(),
    claimedAt: null,
    claimedBy: null,
  }
}

/** Only stable IDs, codes, and timestamps cross into the audit log. */
export function dispatchAuditEntry(auditAction, dispatch, actorRef) {
  return {
    category: 'DISPATCH',
    action: auditAction,
    outcome: 'SUCCESS',
    actorRef,
    resourceType: 'dispatch_action',
    resourceId: dispatch.actionId,
    detail: {
      incidentId: dispatch.incidentId,
      dispatchAction: dispatch.action,
      expiresAt: dispatch.expiresAt,
    },
  }
}
