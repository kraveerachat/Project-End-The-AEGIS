// server/telemetry/index.js — AEGIS Drive (IDEA1) · Server Telemetry V1
//
// One normalized contract assembled from three sources with three different
// trust levels, kept visibly separate rather than blended:
//
//   host agent   CPU, memory, network, host uptime — a separate process on the
//                host, read over a Unix socket, validated as untrusted input.
//   Drive local  Data Lake capacity (statfs on the mount Drive already has) and
//                this process's own uptime. Always measurable.
//   static       Twingate. There is no approved source for connector state in
//                this deployment, so it is declared unavailable — permanently
//                and explicitly, not left blank for a reader to fill in.
//
// The invariant that matters most: `available: false` never carries a number.
// A metric object with values in it is always a real measurement. Zero is a
// measurement too, which is exactly why it must never be used as a placeholder
// for "we could not read this".
//
// Partial availability is the normal case, not an error: a dead host agent
// still leaves disk and service uptime perfectly measurable, and this endpoint
// answers 200 with the true subset rather than failing the request.
import { fetchHostTelemetry } from './client.js'
import { dataLakeTelemetry } from './disk.js'
import { STALE_THRESHOLD_SECONDS, isStale } from './schema.js'

export const TELEMETRY_SCHEMA_VERSION = 1

/** Where the host agent's socket is bind-mounted read-only into Drive. */
export const DEFAULT_AGENT_SOCKET = '/run/aegis-telemetry/telemetry.sock'

/**
 * Twingate connector state, permanently and truthfully unavailable in V1.
 *
 * The connector runs outside this deployment's observable boundary and no
 * approved source for its status exists. Reporting "unavailable" with a stated
 * reason is honest; inferring "online" from the fact that a request arrived
 * would be a guess dressed as a measurement.
 */
const TWINGATE = Object.freeze({
  available: false,
  scope: 'server-connector',
  status: 'unavailable',
  reason: 'no-approved-source',
})

/** The single unavailable shape: no scope for a stray number to hide in. */
const unavailable = () => ({ available: false })

/** Socket path is server configuration only — never a request parameter. */
export const agentSocketPath = (env = process.env) =>
  env.AEGIS_TELEMETRY_SOCKET || DEFAULT_AGENT_SOCKET

/**
 * Project one validated host metric, tagging it with the snapshot's staleness.
 *
 * Stale data is passed through, not discarded: a measurement from 40 s ago is
 * still true about the moment it names. It is labelled so the UI can say so.
 */
function hostMetric(metric, keys, stale) {
  if (!metric || metric.available !== true) return unavailable()
  const projected = { available: true }
  for (const key of keys) {
    if (metric[key] !== undefined) projected[key] = metric[key]
  }
  projected.stale = stale
  return projected
}

/**
 * Build the normalized telemetry response.
 *
 * Never throws: every source is already failure-tolerant, and a telemetry
 * problem must degrade the dashboard rather than a Drive request.
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.fetchHost] host agent client
 * @param {() => Promise<object>} [options.disk] Data Lake capacity projection
 * @param {() => number} [options.serviceUptimeSeconds]
 * @param {number} [options.now] epoch ms
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function buildTelemetry({
  fetchHost,
  disk = dataLakeTelemetry,
  serviceUptimeSeconds = () => process.uptime(),
  now = Date.now(),
  env = process.env,
} = {}) {
  const readHost = fetchHost
    ?? (() => fetchHostTelemetry({ socketPath: agentSocketPath(env), now }))

  const [host, diskMetric] = await Promise.all([
    readHost().catch(() => ({ ok: false, reason: 'unreachable' })),
    disk().catch(() => ({ available: false, reason: 'capacity-unreadable' })),
  ])

  // Unavailable and stale are different failures and are reported differently.
  // No host snapshot means there is no old measurement to be stale about, so
  // `stale` stays false and the metrics themselves say `available: false`.
  const hostOk = host?.ok === true
  const hostMetrics = hostOk ? host.snapshot.metrics : null
  const stale = hostOk ? isStale(host.snapshot.measuredAt, now) : false

  const cpu = hostMetric(hostMetrics?.cpu, ['percent', 'windowSeconds'], stale)
  const memory = hostMetric(hostMetrics?.memory, ['usedBytes', 'totalBytes', 'percent'], stale)
  const network = hostMetric(
    hostMetrics?.network,
    ['interface', 'rxBytesPerSec', 'txBytesPerSec', 'windowSeconds'],
    stale,
  )

  // Host uptime and Drive service uptime answer different questions — "has the
  // machine rebooted" versus "has this container restarted" — so they are kept
  // as two labelled facts rather than collapsed into one number.
  const hostUptime = hostMetrics?.uptime?.available === true
    ? { available: true, seconds: hostMetrics.uptime.hostSeconds, stale }
    : unavailable()
  const service = { available: true, seconds: serviceUptimeSeconds() }

  const ok = Boolean(
    hostOk && !stale
    && cpu.available && memory.available && network.available && hostUptime.available
    && diskMetric.available,
  )

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    // When Drive assembled this response. Host metrics describe a slightly
    // earlier instant; `stale` and `maxAgeSeconds` express how much earlier.
    measuredAt: new Date(now).toISOString(),
    // false means "something measurable was not measured" — a degraded but
    // still useful response, not a server error.
    ok,
    stale,
    maxAgeSeconds: STALE_THRESHOLD_SECONDS,
    metrics: {
      cpu,
      memory,
      disk: diskMetric,
      network,
      twingate: TWINGATE,
      uptime: {
        available: hostUptime.available || service.available,
        host: hostUptime,
        service,
      },
    },
  }
}
