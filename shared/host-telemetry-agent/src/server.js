// src/server.js — AEGIS host telemetry agent · IPC surface
//
// One route, one method, one path-addressed listener. There is deliberately no
// `port` anywhere in this file: the agent must be unreachable from any network,
// and the only thing standing between host metrics and the rest of the machine
// is the socket's 0660 mode plus the group Drive is added to.
//
// The response is *projected*, not serialized. The sampler already produces the
// right shape, but re-deriving the body from a fixed allowlist means a future
// field added upstream cannot leak by accident — it simply will not be copied.
import fspDefault from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'

import { SOCKET_MODE } from './config.js'

export const TELEMETRY_ROUTE = '/internal/telemetry'

/** The complete set of top-level keys the agent may emit. */
export const AGENT_TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'measuredAt', 'metrics'])

/**
 * The complete set of keys each metric may emit.
 *
 * Nothing here identifies the host, its users, its containers, its addresses,
 * or its filesystem layout. `interface` is the one configured NIC name, which
 * the operator supplied in the first place.
 */
export const AGENT_METRIC_KEYS = Object.freeze({
  cpu: Object.freeze(['available', 'percent', 'windowSeconds']),
  memory: Object.freeze(['available', 'usedBytes', 'totalBytes', 'percent']),
  network: Object.freeze(['available', 'interface', 'rxBytesPerSec', 'txBytesPerSec', 'windowSeconds']),
  uptime: Object.freeze(['available', 'hostSeconds']),
})

/** Copy only allowlisted keys, and only when the metric claims availability. */
function projectMetric(name, value) {
  if (!value || value.available !== true) return { available: false }
  const projected = {}
  for (const key of AGENT_METRIC_KEYS[name]) {
    if (value[key] !== undefined) projected[key] = value[key]
  }
  projected.available = true
  return projected
}

/**
 * Rebuild the wire body from a snapshot using the allowlist only.
 *
 * @param {object} snapshot
 * @returns {object}
 */
export function projectAgentSnapshot(snapshot) {
  return {
    schemaVersion: 1,
    measuredAt: snapshot.measuredAt,
    metrics: {
      cpu: projectMetric('cpu', snapshot.metrics?.cpu),
      memory: projectMetric('memory', snapshot.metrics?.memory),
      network: projectMetric('network', snapshot.metrics?.network),
      uptime: projectMetric('uptime', snapshot.metrics?.uptime),
    },
  }
}

/** Is something actually listening on this path right now? */
function defaultProbe(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath })
    const done = (answer) => { socket.destroy(); resolve(answer) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

/**
 * Make the socket path safe to bind, without ever deleting something it should
 * not.
 *
 * A SIGKILLed agent leaves its socket inode behind and the next bind fails with
 * EADDRINUSE. Reclaiming it is correct — but only after proving nothing answers
 * on it, and only when the leftover really is a socket. A regular file or a
 * directory at that path means the deployment is misconfigured, and the right
 * response is to refuse rather than to unlink whatever is there.
 *
 * @param {string} socketPath
 * @param {{ fs?: object, probe?: (p: string) => Promise<boolean> }} [deps]
 */
export async function prepareSocketPath(socketPath, { fs = fspDefault, probe = defaultProbe } = {}) {
  let stats
  try {
    stats = await fs.stat(socketPath)
  } catch (err) {
    if (err.code === 'ENOENT') return // nothing to reclaim
    throw err
  }

  if (!stats.isSocket()) {
    throw new Error(`refusing to start: ${socketPath} exists and is not a socket`)
  }
  if (await probe(socketPath)) {
    throw new Error(`refusing to start: ${socketPath} is already in use by a live agent`)
  }
  await fs.unlink(socketPath)
}

/**
 * Create the agent's IPC server.
 *
 * @param {object} options
 * @param {{ snapshot: () => object|null }} options.sampler
 * @param {string} options.socketPath
 * @param {number} [options.socketMode]
 */
export function createTelemetryServer({ sampler, socketPath, socketMode = SOCKET_MODE, fs = fspDefault }) {
  if (!sampler) throw new Error('sampler is required')
  if (!socketPath) throw new Error('socketPath is required')

  const send = (res, status, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      // Telemetry is a point-in-time measurement; a cached copy is a lie.
      'Cache-Control': 'no-store',
      ...extraHeaders,
    })
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    // Compare the path only — a query string must not open a second route, and
    // the URL is never turned into a filesystem path anywhere in this agent.
    const requestPath = (req.url ?? '').split('?')[0]
    if (requestPath !== TELEMETRY_ROUTE) return send(res, 404, { error: 'not-found' })
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET' })

    const snapshot = sampler.snapshot()
    // No sample yet means the first window has not closed. Saying so is honest;
    // returning an empty snapshot would read as "the host has no metrics".
    if (!snapshot) return send(res, 503, { error: 'no-sample-yet' })
    return send(res, 200, projectAgentSnapshot(snapshot))
  })

  // A connection that errors mid-flight must not take the agent down with it.
  server.on('clientError', (_err, socket) => { socket.destroy() })

  return {
    async start() {
      await prepareSocketPath(socketPath, { fs })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      // Windows named pipes carry an ACL, not a POSIX mode; chmod is a no-op
      // there and must not be treated as a startup failure.
      if (process.platform !== 'win32') await fs.chmod(socketPath, socketMode)
    },

    async stop() {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve))
      }
      // Close does not remove the inode on POSIX; leaving it behind would make
      // the next start take the stale-reclaim path for no reason.
      if (process.platform !== 'win32') {
        await fs.unlink(socketPath).catch((err) => {
          if (err.code !== 'ENOENT') throw err
        })
      }
    },

    /** A string here is the proof there is no TCP port. */
    address: () => server.address(),
  }
}
