// server/telemetry/client.js — AEGIS Drive (IDEA1) · host agent client
//
// Drive reaches the host telemetry agent over one Unix socket and nothing else.
// There is deliberately no host, port, protocol, or URL option anywhere in this
// module: a telemetry client that could be pointed at a network address is a
// telemetry client that can be pointed somewhere it should not go, and no part
// of this feature requires it.
//
// This function never throws and never rejects. Telemetry is decoration on a
// storage product — a dead agent, a hung agent, or an agent speaking nonsense
// must degrade the dashboard, not a Drive request. Every failure comes back as
// { ok: false, reason } and the API turns it into a truthful `unavailable`.
import http from 'node:http'

import { validateAgentSnapshot } from './schema.js'

/** The agent's only route. */
export const AGENT_ROUTE = '/internal/telemetry'

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
function isUsableSocketPath(value) {
  if (typeof value !== 'string' || !value) return false
  if (value.includes('://')) return false
  // A bare `host:port` has a colon but no path separator. Windows named pipes
  // (\\.\pipe\name) and POSIX socket paths both contain a separator.
  if (!value.includes('/') && !value.includes('\\')) return false
  return true
}

/**
 * Fetch and validate the current host telemetry snapshot.
 *
 * @param {object} options
 * @param {string} options.socketPath the agent's Unix socket
 * @param {number} [options.timeoutMs] capped at DEFAULT_TIMEOUT_MS
 * @param {number} [options.now] epoch ms, for deterministic validation
 * @returns {Promise<{ ok: true, snapshot: object } | { ok: false, reason: string }>}
 */
export function fetchHostTelemetry({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now() }) {
  if (!isUsableSocketPath(socketPath)) {
    return Promise.resolve({ ok: false, reason: 'invalid-socket-path' })
  }
  // Capped, not trusted: a caller asking for 30 s must not be able to hold a
  // Drive request open for 30 s.
  const budgetMs = Math.max(1, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))

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

    const req = http.request({ socketPath, path: AGENT_ROUTE, method: 'GET' }, (res) => {
      if (res.statusCode !== 200) {
        res.resume() // drain so the socket can close cleanly
        return finish({ ok: false, reason: `agent-status-${res.statusCode}` })
      }

      let body = ''
      let bytes = 0
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_RESPONSE_BYTES) return finish({ ok: false, reason: 'response-too-large' })
        body += chunk
      })
      res.on('error', () => finish({ ok: false, reason: 'unreachable' }))
      res.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          return finish({ ok: false, reason: 'malformed-json' })
        }
        // Structural validation is the agent's contract check, so its reason is
        // passed through unchanged — the API and the receipt both benefit from
        // knowing *which* field was wrong.
        const validated = validateAgentSnapshot(parsed, { now })
        return finish(validated.ok
          ? { ok: true, snapshot: validated.snapshot }
          : { ok: false, reason: validated.reason })
      })
    })

    // ENOENT (no socket), ECONNREFUSED (no listener), EACCES (not in the
    // socket's group) all mean the same thing to Drive: no host metrics.
    req.on('error', () => finish({ ok: false, reason: 'unreachable' }))
    req.end()
  })
}
