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

/** Display states derived for the Admin (spec §4.8). None of them means "Contained". */
export const DISPATCH_RESPONSE_STATES = Object.freeze([
  'DISPATCH_PENDING',
  'DISPATCH_UNAVAILABLE',
  'CORE_CLAIMED',
  'PUBLISHED',
  'DRY_RUN_ONLY',
  'ACK_RECEIVED',
  'STATUS_CORRELATED',
  'OUTCOME_UNKNOWN',
  'FAILED',
  'EXPIRED',
  'EXPIRED_AT_CORE',
])

/** A pending action counts as dispatchable only after machine contact within this window. */
export const DISPATCH_CONTACT_WINDOW_MS = 120_000

const EVIDENCE_KEYS = new Set(['sequence', 'stage', 'observedAt', 'detail'])
const EVIDENCE_DETAIL_RULES = Object.freeze({
  ackCode: (value) => value === 'OK',
  deviceState: (value) => value === 'NORMAL' || value === 'LOCKDOWN',
  reasonCode: (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value),
})
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Reduce Core-reported evidence to its allowlisted form (spec §4.7), or null.
 * Only stable codes cross into storage. An ACK must carry ackCode OK, a STATUS
 * must carry deviceState, and neither field is accepted on any other stage.
 */
export function safeDispatchEvidence(entry) {
  if (!plainObject(entry) || Object.keys(entry).some((key) => !EVIDENCE_KEYS.has(key))) return null
  const { sequence, stage, observedAt, detail = {} } = entry
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 1000) return null
  if (!DISPATCH_EVIDENCE_STAGES.includes(stage)) return null
  if (typeof observedAt !== 'string' || !CANONICAL_TIMESTAMP.test(observedAt)) return null
  const parsed = Date.parse(observedAt)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== observedAt) return null
  if (!plainObject(detail)) return null

  const safeDetail = {}
  for (const key of Object.keys(detail).sort()) {
    if (!Object.hasOwn(EVIDENCE_DETAIL_RULES, key) || !EVIDENCE_DETAIL_RULES[key](detail[key])) return null
    safeDetail[key] = detail[key]
  }
  if ((stage === 'ACK') !== Object.hasOwn(safeDetail, 'ackCode')) return null
  if ((stage === 'STATUS') !== Object.hasOwn(safeDetail, 'deviceState')) return null
  return { sequence, stage, observedAt, detail: safeDetail }
}

export function dispatchEvidenceAuditEntry(actionId, evidence) {
  return {
    category: 'DISPATCH',
    action: 'EVIDENCE_RECORDED',
    outcome: 'SUCCESS',
    actorRef: 'machine-core',
    resourceType: 'dispatch_action',
    resourceId: actionId,
    detail: { stage: evidence.stage, sequence: evidence.sequence },
  }
}

/**
 * Derive what the Admin sees for one dispatch action (spec §4.8). Terminal
 * states win, then the furthest Core-reported stage, then the server state. A
 * pending action counts as DISPATCH_PENDING only after recent authenticated
 * machine contact. Evidence is never promoted: execution and physical evidence
 * stay false in S2.
 */
export function dispatchDisplay({ action, evidence = [], lastMachineContactAt = null, now = new Date() }) {
  const stages = new Set(evidence.map(({ stage }) => stage))
  const acknowledged = evidence.some(({ stage, detail }) => stage === 'ACK' && detail?.ackCode === 'OK')
  const correlated = evidence.some(({ stage, detail }) => stage === 'STATUS' && detail?.deviceState === 'LOCKDOWN')
  const nowMs = now.getTime()
  const pastDue = action.state === 'PENDING_DISPATCH' && nowMs >= Date.parse(action.expiresAt)

  let responseState
  if (stages.has('OUTCOME_UNKNOWN')) responseState = 'OUTCOME_UNKNOWN'
  else if (stages.has('FAILED')) responseState = 'FAILED'
  else if (stages.has('EXPIRED_AT_CORE')) responseState = 'EXPIRED_AT_CORE'
  else if (action.state === 'EXPIRED' || pastDue) responseState = 'EXPIRED'
  else if (correlated) responseState = 'STATUS_CORRELATED'
  else if (acknowledged) responseState = 'ACK_RECEIVED'
  else if (stages.has('PUBLISHED')) responseState = 'PUBLISHED'
  else if (stages.has('DRY_RUN')) responseState = 'DRY_RUN_ONLY'
  else if (action.state === 'CORE_CLAIMED') responseState = 'CORE_CLAIMED'
  else {
    const contactMs = lastMachineContactAt instanceof Date ? lastMachineContactAt.getTime() : Number.NaN
    responseState = Number.isFinite(contactMs) && nowMs - contactMs < DISPATCH_CONTACT_WINDOW_MS
      ? 'DISPATCH_PENDING'
      : 'DISPATCH_UNAVAILABLE'
  }

  return {
    responseState,
    humanReviewRequired: responseState === 'OUTCOME_UNKNOWN',
    boundary: {
      command_requested: true,
      command_published: stages.has('PUBLISHED'),
      acknowledged,
      executed: false,
      physical_evidence: false,
    },
  }
}

/** Overlay one snapshot incident with its dispatch display; incidents without an action are unchanged. */
export function dispatchIncidentOverlay(incident, action, evidence, { lastMachineContactAt = null, now }) {
  if (!action) return incident
  const display = dispatchDisplay({ action, evidence, lastMachineContactAt, now })
  return {
    ...incident,
    responseState: display.responseState,
    dispatch: {
      actionId: action.actionId,
      state: action.state,
      expiresAt: action.expiresAt,
      humanReviewRequired: display.humanReviewRequired,
      boundary: display.boundary,
    },
  }
}
