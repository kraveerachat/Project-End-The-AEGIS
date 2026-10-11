import { isAcknowledgedIncident } from './dashboard.js'

const STAGE_ALIASES = Object.freeze({
  requested: 'REQUESTED',
  accepted: 'ACCEPTED',
  ack: 'ACKED',
  execution: 'EXECUTED',
  physical: 'PHYSICALLY VERIFIED',
})

const DISPATCH_KEYS = new Set([
  'DISPATCH_PENDING', 'DISPATCH_UNAVAILABLE', 'CORE_CLAIMED', 'PUBLISHED', 'DRY_RUN_ONLY',
  'OUTCOME_UNKNOWN', 'FAILED', 'EXPIRED', 'EXPIRED_AT_CORE', 'PENDING_DISPATCH',
])

function legacyStage(incident, id) {
  const stage = incident?.evidenceStages?.find((item) => item.stage === STAGE_ALIASES[id])
  return stage?.status === 'HEALTHY' ? stage : null
}

function dispatchStage(incident) {
  const dispatch = incident?.dispatch
  if (!dispatch) return { key: 'NOT_OBSERVED', status: 'UNKNOWN', observed: false }
  const key = DISPATCH_KEYS.has(incident.responseState) ? incident.responseState : dispatch.state
  if (['FAILED', 'OUTCOME_UNKNOWN'].includes(key)) return { key, status: key === 'FAILED' ? 'FAILED' : 'UNKNOWN', observed: false }
  if (['EXPIRED', 'EXPIRED_AT_CORE'].includes(key)) return { key, status: 'STALE', observed: false }
  if (dispatch.boundary?.command_published === true || ['CORE_CLAIMED', 'PUBLISHED'].includes(key)) return { key, status: 'HEALTHY', observed: true }
  return { key: key || 'NOT_OBSERVED', status: 'UNKNOWN', observed: false }
}

/**
 * The six evidence stages of the cyber-physical chain, each read from its own
 * field so one stage can never be inferred from another. `observed` means the
 * server holds evidence for that stage only; ACK is not execution, and
 * execution is not physical verification.
 */
export function responseChain(incident) {
  const boundary = incident?.dispatch?.boundary
  const flag = (name, id) => (boundary ? boundary[name] === true : legacyStage(incident, id) !== null)
  const stamp = (id) => incident?.evidenceStages?.find((item) => item.stage === STAGE_ALIASES[id])?.timestamp ?? null
  const stage = (id, observed, extra = {}) => ({
    id,
    observed,
    key: observed ? 'OBSERVED' : 'NOT_OBSERVED',
    status: observed ? 'HEALTHY' : 'UNKNOWN',
    timestamp: stamp(id),
    ...extra,
  })

  const accepted = Boolean(incident?.dispatch) || legacyStage(incident, 'accepted') !== null
  const dispatch = dispatchStage(incident)
  const physical = flag('physical_evidence', 'physical')
  return [
    stage('requested', flag('command_requested', 'requested')),
    stage('accepted', accepted),
    { id: 'dispatch', timestamp: null, ...dispatch },
    stage('ack', boundary ? boundary.acknowledged === true : isAcknowledgedIncident(incident) || legacyStage(incident, 'ack') !== null),
    stage('execution', flag('executed', 'execution')),
    stage('physical', physical, physical ? {} : { key: 'NOT_VERIFIED', status: 'NOT_VERIFIED' }),
  ]
}
