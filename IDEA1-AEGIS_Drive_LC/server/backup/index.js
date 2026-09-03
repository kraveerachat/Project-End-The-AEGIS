// server/backup/index.js — AEGIS Drive (IDEA1) · backup status projection and singleton gate
//
// Two exports the routes use:
//
//   backupReport()   the sanitized status for /api/storage (every authenticated
//                    user) — facts and risk derived from validated agent data.
//   adminBackupView() the fuller view for Admin: the allowlisted targets with
//                    their protection classification, the allowed schedule and
//                    retention IDs, the current policy, and recent job history.
//
// Plus the process-wide maintenance gate, constructed once so the middleware
// on the API router and the coordinator loop share one freeze state.
import { recordAudit, sha256Hex } from '../db/connection.js'
import { BACKUP_ROUTES, backupSocketPath, fetchBackupStatus, postBackupCommand } from './client.js'
import { deriveBackupReport } from './derive.js'
import { createBackupMaintenance } from './maintenance.js'

const TRANSPORT_REASONS = new Set(['unreachable', 'timeout', 'invalid-socket-path', 'malformed-json', 'response-too-large'])

/** Collapse transport failures to one word; keep contract failures specific. */
export function unavailableReasonFor(reason) {
  if (typeof reason !== 'string') return 'agent-unreachable'
  if (TRANSPORT_REASONS.has(reason) || reason.startsWith('agent-status-')) return 'agent-unreachable'
  return `agent-data-invalid:${reason}`
}

/**
 * @param {object} [options]
 * @param {() => Promise<object>} [options.fetch]
 * @param {number} [options.now]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function backupReport({ fetch, now = Date.now(), env = process.env } = {}) {
  const read = fetch ?? (() => fetchBackupStatus({ socketPath: backupSocketPath(env), now }))
  const result = await read().catch(() => ({ ok: false, reason: 'unreachable' }))
  if (!result?.ok) return deriveBackupReport(null, { now, unavailableReason: unavailableReasonFor(result?.reason) })
  return deriveBackupReport(result.status, { now })
}

/**
 * Admin view: everything in the report plus the configuration surface.
 */
export async function adminBackupView({ fetch, now = Date.now(), env = process.env } = {}) {
  const read = fetch ?? (() => fetchBackupStatus({ socketPath: backupSocketPath(env), now }))
  const result = await read().catch(() => ({ ok: false, reason: 'unreachable' }))
  if (!result?.ok) {
    return {
      report: deriveBackupReport(null, { now, unavailableReason: unavailableReasonFor(result?.reason) }),
      targets: [],
      allowed: { scheduleIds: [], retentionIds: [] },
      limits: null,
      tools: null,
      history: [],
    }
  }
  const status = result.status
  return {
    report: deriveBackupReport(status, { now }),
    targets: status.targets.map((t) => ({ ...t })),
    allowed: { scheduleIds: [...status.allowed.scheduleIds], retentionIds: [...status.allowed.retentionIds] },
    limits: { ...status.limits },
    tools: { ...status.tools },
    history: status.history.map((j) => ({ ...j })),
  }
}

/** Forward an Admin command to the agent. */
export function backupCommand(route, body, { env = process.env } = {}) {
  return postBackupCommand({ socketPath: backupSocketPath(env), route, body })
}

/** The one maintenance gate for this process. */
export const backupMaintenance = createBackupMaintenance({
  fetchStatus: () => fetchBackupStatus({ socketPath: backupSocketPath(process.env) }),
  acknowledge: (body) => postBackupCommand({ socketPath: backupSocketPath(process.env), route: BACKUP_ROUTES.QUIESCED, body })
    .then((r) => ({ ok: r.ok && r.body?.ok === true })),
  recordAudit,
  hash: sha256Hex,
})

export { BACKUP_ROUTES }
