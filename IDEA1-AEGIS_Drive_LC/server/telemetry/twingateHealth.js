// server/telemetry/twingateHealth.js — AEGIS Drive (IDEA1) · remote access projection
//
// Drive has no Docker access and never will: the Docker socket is
// root-equivalent, and a web application that can reach it is a web application
// that can take the host. What changed is that a separate, bounded host oneshot
// now inspects the connector container and the unprivileged telemetry agent
// republishes that evidence on its existing socket. Drive fetches it, validates
// it as untrusted input, and derives a status.
//
// ⚠️ The distinction this module exists to preserve: LOCAL runtime health and
//    the TWINGATE CONTROL PLANE are two different questions, and Drive can only
//    answer the first. A container that is up and passing its healthcheck here
//    is evidence that the connector process is running on this host — it is not
//    evidence that Twingate currently considers the connector connected. Those
//    are reported as two separate blocks, and the control-plane block says
//    plainly that nothing measured it.
//
// The projection keeps three things separate, exactly as disk health does:
// whether evidence exists, how old it is, and what it says. A stale RUNNING
// renders as UNKNOWN with the last reading still visible.
import { fetchHostTwingateConnector } from './client.js'
import { agentSocketPath } from './index.js'
import {
  CONNECTOR_STATUS, TWINGATE_STALE_THRESHOLD_SECONDS,
  deriveConnectorStatus, twingateEvidenceAgeSeconds,
} from './twingateHealthSchema.js'

/** Reason attached when the host agent cannot be reached at all. */
export const AGENT_UNREACHABLE = 'agent-unreachable'

/**
 * The Twingate control plane, declared and never measured.
 *
 * This is a constant on purpose, in the same spirit as RAID_NOT_CONFIGURED in
 * storageReport.js: the honest answer is that Drive has no approved source for
 * it. Implementing it would mean an authenticated Twingate API call with a
 * credential Drive does not hold and should not hold, which is a separate task.
 * Until then the UI must not be able to render anything but "not measured".
 */
export const CONTROL_PLANE_NOT_MEASURED = Object.freeze({
  measured: false,
  telemetry: 'not-measured',
  state: 'unavailable',
  reason: 'no-approved-source',
})

/** The one shape for "no local evidence". No state and no count ride along. */
function unavailable(reason) {
  return {
    available: false,
    status: CONNECTOR_STATUS.UNKNOWN,
    reason,
    stale: false,
    runtimeState: null,
    health: null,
    restartCount: null,
    startedAt: null,
    measuredAt: null,
    ageSeconds: null,
    maxAgeSeconds: TWINGATE_STALE_THRESHOLD_SECONDS,
  }
}

/**
 * Current LOCAL connector runtime health.
 *
 * Never throws. Never returns HEALTHY without fresh evidence of a running
 * container whose Docker healthcheck actually passed.
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.fetch] host agent connector client
 * @param {number} [options.now]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function localConnectorHealth({ fetch, now = Date.now(), env = process.env } = {}) {
  const read = fetch ?? (() => fetchHostTwingateConnector({ socketPath: agentSocketPath(env), now }))
  const result = await read().catch(() => ({ ok: false, reason: AGENT_UNREACHABLE }))
  if (!result?.ok) {
    // Contract failures keep their specific reason; transport failures collapse
    // to one word the UI can explain ("the host agent is not connected").
    const transport = ['unreachable', 'timeout', 'invalid-socket-path', 'malformed-json', 'response-too-large']
    const reason = typeof result?.reason === 'string'
      && !transport.includes(result.reason)
      && !result.reason.startsWith('agent-status-')
      ? result.reason
      : AGENT_UNREACHABLE
    return unavailable(reason)
  }

  const { document } = result
  if (document.connector.available !== true) return unavailable(document.connector.reason)

  const ageSeconds = twingateEvidenceAgeSeconds(document.measuredAt, now)
  const stale = ageSeconds === null || ageSeconds > TWINGATE_STALE_THRESHOLD_SECONDS
  const { status, reason } = deriveConnectorStatus(document.connector, { stale })

  return {
    available: true,
    status,
    reason,
    stale,
    runtimeState: document.connector.runtimeState,
    health: document.connector.health,
    restartCount: document.connector.restartCount,
    startedAt: document.connector.startedAt,
    measuredAt: document.measuredAt,
    ageSeconds: ageSeconds === null ? null : Math.max(0, Math.round(ageSeconds)),
    maxAgeSeconds: TWINGATE_STALE_THRESHOLD_SECONDS,
  }
}

/**
 * The whole remote-access document for GET /api/remote-access.
 *
 * `channel` and `resource` are configuration facts about this deployment, not
 * measurements — they are what AEGIS is set up to use, and they are stated as
 * such. `localConnector` is measured. `controlPlane` is explicitly not.
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.connector]
 */
export async function buildRemoteAccessReport({ connector = localConnectorHealth } = {}) {
  const localConnector = await connector().catch(() => unavailable(AGENT_UNREACHABLE))
  return {
    channel: 'twingate',
    resource: 'AEGIS Drive · NAS :443',
    accessModel: 'least-privilege',
    localConnector,
    controlPlane: { ...CONTROL_PLANE_NOT_MEASURED },
  }
}
