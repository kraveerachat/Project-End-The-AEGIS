/**
 * The containment acceptance boundary.
 *
 * PR7 stops at an Admin decision about a containment candidate. Requested,
 * Published, ACK, Executed, and Physical Evidence are separate reviewed stages,
 * so every one of them is reported as not reached and nothing here can request,
 * publish, acknowledge, or execute a command.
 */
export const CONTAINMENT_DECISIONS = Object.freeze(['ACCEPT', 'REJECT'])

const STATE_BY_DECISION = Object.freeze({
  ACCEPT: 'CONTAINMENT_ACCEPTED',
  REJECT: 'CONTAINMENT_REJECTED',
})

export const CONTAINMENT_CANDIDATE_STATE = 'CONTAINMENT_CANDIDATE'

export function containmentBoundary() {
  return {
    command_requested: false,
    command_published: false,
    acknowledged: false,
    executed: false,
    physical_evidence: false,
  }
}

export function containmentStateFor(decision) {
  return STATE_BY_DECISION[decision] ?? null
}

/**
 * A decision is only valid against an incident that is currently a candidate.
 * An absent, already-decided, or unrecognized incident fails closed.
 */
export function evaluateContainmentDecision({ incident, decision }) {
  const state = containmentStateFor(decision)
  if (!state) return { ok: false, error: { code: 'DECISION_INVALID' } }
  if (!incident || incident.state !== CONTAINMENT_CANDIDATE_STATE) {
    return { ok: false, error: { code: 'INCIDENT_NOT_CANDIDATE' } }
  }
  return { ok: true, state }
}

/** Only stable IDs, codes, and counts cross into durable storage. */
export function containmentDecisionRecord({ incident, decision, state }) {
  return {
    incidentId: incident.id,
    decision,
    state,
    correlationKey: incident.correlationKey ?? null,
    severity: incident.severity ?? null,
    evidenceIds: Array.isArray(incident.evidenceIds) ? [...incident.evidenceIds].sort() : [],
  }
}

export function containmentResponse(incidentId, state) {
  return { incident_id: incidentId, state, ...containmentBoundary() }
}
