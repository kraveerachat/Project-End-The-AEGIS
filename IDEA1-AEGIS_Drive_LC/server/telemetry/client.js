// server/telemetry/client.js — AEGIS Drive (IDEA1) · host agent client
//
// Drive reaches the host telemetry agent over one Unix socket and nothing else.
// There is deliberately no host, port, protocol, or URL option anywhere in this
// module: a telemetry client that could be pointed at a network address is a
// telemetry client that can be pointed somewhere it should not go, and no part
// of this feature requires it.
//
// These functions never throw and never reject. Telemetry is decoration on a
// storage product — a dead agent, a hung agent, or an agent speaking nonsense
// must degrade the dashboard, not a Drive request. Every failure comes back as
// { ok: false, reason } and the API turns it into a truthful `unavailable`.
//
// Two routes, two contracts, one socket — /internal/telemetry (V1, the
// production-verified host counters) and /internal/disk-health (its own
// versioned schema, added later). They are fetched and validated separately
// so neither can break the other.
import http from 'node:http'

import { validateDiskHealthResponse } from './diskHealthSchema.js'
import { validateAgentSnapshot } from './schema.js'

/** The agent's telemetry route. */
export const AGENT_ROUTE = '/internal/telemetry'

/** The agent's disk-health route (separate versioned contract). */
export const DISK_HEALTH_ROUTE = '/internal/disk-health'

/**
 * Hard ceiling on how long a Drive request may wait for the host agent.
 *
 * The agent answers from an in-memory snapshot, so a healthy reply is
 * sub-millisecond. 1500 ms is generous for a local socket and short enough that
 * a wedged agent cannot become a Drive latency problem.
 */
export const DEFAULT_TIMEOUT_MS = 1500

/** A local agent's snapshot is well under 1 KB; 64 KiB is pure headroom. */
export const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * A usable socket path: absolute-ish, no scheme, no host:port shape.
 *
 * This is belt-and-braces — the parameter is named socketPath and is only ever
 * supplied by server configuration — but it makes the "no network" property
 * checkable rather than merely intended.
 */
export function isUsableSocketPath(value) {
  if (typeof value !== 'string' || !value) return false
  if (value.includes('://')) return false
  // A bare `host:port` has a colon but no path separator. Windows named pipes
  // (\\.\pipe\name) and POSIX socket paths both contain a separator.
  if (!value.includes('/') && !value.includes('\\')) return false
  return true
}

/**
 * GET one JSON document from a Unix-socket agent and validate it.
 *
 * @param {object} options
 * @param {string} options.socketPath
 * @param {string} options.route
 * @param {(raw: unknown) => { ok: true, [k: string]: unknown } | { ok: false, reason: string }} options.validate
 * @param {number} [options.timeoutMs] capped at maxTimeoutMs
 * @param {number} [options.maxTimeoutMs]
 * @param {string} [options.method]
 * @param {object} [options.body]
 * @returns {Promise<{ ok: true, httpStatus: number, [k: string]: unknown } | { ok: false, reason: string, httpStatus?: number, body?: unknown }>}
 */
export function fetchAgentJson({
  socketPath, route, validate, timeoutMs = DEFAULT_TIMEOUT_MS, maxTimeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body,
}) {
  if (!isUsableSocketPath(socketPath)) {
    return Promise.resolve({ ok: false, reason: 'invalid-socket-path' })
  }
  // Capped, not trusted: a caller asking for 30 s must not be able to hold a
  // Drive request open for 30 s.
  const budgetMs = Math.max(1, Math.min(Number(timeoutMs) || maxTimeoutMs, maxTimeoutMs))

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), budgetMs)
    const payload = body === undefined ? null : JSON.stringify(body)
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}

    const req = http.request({ socketPath, path: route, method, headers }, (res) => {
      let text = ''
      let bytes = 0
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_RESPONSE_BYTES) return finish({ ok: false, reason: 'response-too-large' })
        text += chunk
      })
      res.on('error', () => finish({ ok: false, reason: 'unreachable' }))
      res.on('end', () => {
        // The HTTP status travels as `httpStatus`: a validator's own result may
        // legitimately carry a `status` field (the backup contract does).
        // A non-success status is reported as such even when its body is not
        // JSON; the body is parsed only when it is (a 409 carries a reason).
        if (res.statusCode !== 200 && res.statusCode !== 202) {
          let errorBody = null
          try { errorBody = text ? JSON.parse(text) : null } catch { errorBody = null }
          return finish({ ok: false, reason: `agent-status-${res.statusCode}`, httpStatus: res.statusCode, body: errorBody })
        }
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          return finish({ ok: false, reason: 'malformed-json', httpStatus: res.statusCode })
        }
        if (!validate) return finish({ ok: true, httpStatus: res.statusCode, body: parsed })
        // Structural validation is the agent's contract check, so its reason is
        // passed through unchanged — the API and the receipt both benefit from
        // knowing *which* field was wrong.
        const validated = validate(parsed)
        return finish(validated.ok ? { ...validated, httpStatus: res.statusCode } : { ok: false, reason: validated.reason })
      })
    })

    // ENOENT (no socket), ECONNREFUSED (no listener), EACCES (not in the
    // socket's group) all mean the same thing to Drive: no host agent.
    req.on('error', () => finish({ ok: false, reason: 'unreachable' }))
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Fetch and validate the current host telemetry snapshot (V1 contract).
 *
 * @param {object} options
 * @param {string} options.socketPath the agent's Unix socket
 * @param {number} [options.timeoutMs] capped at DEFAULT_TIMEOUT_MS
 * @param {number} [options.now] epoch ms, for deterministic validation
 * @returns {Promise<{ ok: true, snapshot: object } | { ok: false, reason: string }>}
 */
export function fetchHostTelemetry({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now() }) {
  return fetchAgentJson({
    socketPath,
    route: AGENT_ROUTE,
    timeoutMs,
    validate: (raw) => validateAgentSnapshot(raw, { now }),
  }).then((result) => (result.ok ? { ok: true, snapshot: result.snapshot } : { ok: false, reason: result.reason }))
}

/**
 * Fetch and validate the host disk-health document.
 *
 * @param {object} options
 * @param {string} options.socketPath the agent's Unix socket
 * @param {number} [options.timeoutMs]
 * @param {number} [options.now]
 * @returns {Promise<{ ok: true, document: object } | { ok: false, reason: string }>}
 */
export function fetchHostDiskHealth({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now() }) {
  return fetchAgentJson({
    socketPath,
    route: DISK_HEALTH_ROUTE,
    timeoutMs,
    validate: (raw) => validateDiskHealthResponse(raw, { now }),
  }).then((result) => (result.ok ? { ok: true, document: result.document } : { ok: false, reason: result.reason }))
}
