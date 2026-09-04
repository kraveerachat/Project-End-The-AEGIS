// server/backup/client.js — AEGIS Drive (IDEA1) · host backup agent client
//
// The backup agent is a separate host process with its own user, group and
// socket (shared/host-backup-agent/). Drive is its ONLY client and reaches it
// the same way it reaches the telemetry agent: one Unix socket path from
// server configuration, never a host, port or URL, never anything from a
// request.
//
// Drive never executes a backup. It asks the agent to, forwards an Admin's
// allowlisted policy choice, and acknowledges the write-freeze. Every reply is
// validated as untrusted input before it reaches a screen.
import { fetchAgentJson } from '../telemetry/client.js'
import { validateBackupStatus } from './schema.js'

export const DEFAULT_BACKUP_SOCKET = '/run/aegis-backup/backup.sock'

export const BACKUP_ROUTES = Object.freeze({
  STATUS: '/internal/backup/status',
  RUN: '/internal/backup/run',
  VERIFY: '/internal/backup/verify',
  QUIESCED: '/internal/backup/quiesced',
  POLICY: '/internal/backup/policy',
})

/** Status is answered from memory plus a few stat() calls; 1500 ms is plenty. */
export const STATUS_TIMEOUT_MS = 1500

/** Commands classify the target (a handful of file reads) before answering. */
export const COMMAND_TIMEOUT_MS = 4000

/** Socket path is server configuration only — never a request parameter. */
export const backupSocketPath = (env = process.env) => env.AEGIS_BACKUP_SOCKET || DEFAULT_BACKUP_SOCKET

/**
 * @param {{ socketPath: string, now?: number }} options
 * @returns {Promise<{ ok: true, status: object } | { ok: false, reason: string }>}
 */
export function fetchBackupStatus({ socketPath, now = Date.now() }) {
  return fetchAgentJson({
    socketPath,
    route: BACKUP_ROUTES.STATUS,
    timeoutMs: STATUS_TIMEOUT_MS,
    validate: (raw) => validateBackupStatus(raw, { now }),
  }).then((result) => (result.ok ? { ok: true, status: result.status } : { ok: false, reason: result.reason }))
}

/**
 * POST a command to the agent. The reply is returned as-is (a small object
 * with `ok`, `jobId`, `reason` or `error`) plus the HTTP status, so the route
 * can map 409 ("busy", "not-configured") to a truthful client response.
 *
 * @param {{ socketPath: string, route: string, body?: object }} options
 */
export function postBackupCommand({ socketPath, route, body }) {
  if (!Object.values(BACKUP_ROUTES).includes(route) || route === BACKUP_ROUTES.STATUS) {
    return Promise.resolve({ ok: false, reason: 'invalid-route' })
  }
  return fetchAgentJson({
    socketPath,
    route,
    method: 'POST',
    body: body ?? {},
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxTimeoutMs: COMMAND_TIMEOUT_MS,
  }).then((result) => {
    if (result.ok) return { ok: true, status: result.httpStatus, body: result.body ?? {} }
    return { ok: false, reason: result.reason, status: result.httpStatus ?? null, body: result.body ?? null }
  })
}
