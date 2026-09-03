// server/backup/maintenance.js — AEGIS Drive (IDEA1) · backup write-freeze
//
// Drive's half of the consistency model documented in
// shared/host-backup-agent/src/job.js. The agent asks for a bounded freeze;
// Drive is the only process that can actually stop its own destructive
// mutations, so Drive:
//
//   1. polls the agent's status (a local socket, cheap);
//   2. on seeing a job with quiesceRequired=true, refuses DESTRUCTIVE requests
//      with 503 BACKUP_MAINTENANCE until the agent's leaseUntil — enforced on
//      Drive's own clock, so a hung agent cannot freeze Drive forever;
//   3. once every destructive request that was already in flight has finished,
//      acknowledges to the agent (POST /internal/backup/quiesced);
//   4. lifts the freeze as soon as the agent reports the job is past its
//      quiesced phases, or the lease expires, whichever comes first.
//
// What counts as destructive: anything that can move or remove bytes that a
// metadata row already references. Reads, downloads, share creation and
// brand-new uploads that have not yet been committed are not blocked.
//
// The gate is also where completed jobs are noticed and turned into audit
// events with a SYSTEM actor, so the audit log records BACKUP_RUN_SUCCESS /
// FAILED and BACKUP_VERIFY_PASS / FAIL exactly once per job.
import { BACKUP_ROUTES } from './client.js'

export const MAINTENANCE_CODE = 'BACKUP_MAINTENANCE'

/** Phases during which the agent needs the freeze held. Mirrors job.js. */
export const QUIESCED_PHASES = Object.freeze(['QUIESCE_REQUESTED', 'QUIESCED', 'DUMPING', 'SNAPSHOTTING'])

/** Polling cadence: fast while a job is live, relaxed when idle. */
export const ACTIVE_POLL_MS = 3_000
export const IDLE_POLL_MS = 30_000

/**
 * Destructive routes, matched on the path Express sees under /api.
 * Each one can rename or unlink a storage key that a `files`, `file_versions`,
 * `vault_blobs` or `vault_v2_blobs` row points at.
 */
const DESTRUCTIVE = [
  { method: 'POST', pattern: /^\/files\/upload\/?$/ },                         // same-name replace moves current -> versions/
  { method: 'POST', pattern: /^\/files\/uploads\/[^/]+\/commit\/?$/ },          // same as above, V2 path
  { method: 'DELETE', pattern: /^\/files\/[^/]+\/?$/ },                         // removes current + version bytes
  { method: 'POST', pattern: /^\/files\/[^/]+\/versions\/[^/]+\/restore\/?$/ }, // swaps current <-> version keys
  { method: 'DELETE', pattern: /^\/vault\/blobs\/[^/]+\/?$/ },                  // removes ciphertext
  { method: 'POST', pattern: /^\/vault\/uploads\/[^/]+\/commit\/?$/ },          // publishes into vault/ (conservative)
]

export function isDestructiveRequest(method, path) {
  return DESTRUCTIVE.some((rule) => rule.method === method && rule.pattern.test(path))
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.fetchStatus returns { ok, status } | { ok:false, reason }
 * @param {(body: object) => Promise<object>} deps.acknowledge POSTs /internal/backup/quiesced
 * @param {(event: object) => Promise<void>} [deps.recordAudit]
 * @param {(text: string) => string} [deps.hash] sha256 for audit target
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
export function createBackupMaintenance({
  fetchStatus, acknowledge, recordAudit, hash = (s) => s, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (!fetchStatus || !acknowledge) throw new Error('backup maintenance needs fetchStatus and acknowledge')

  let freeze = null // { jobId, leaseUntil, acknowledged }
  let inFlight = 0
  let timer = null
  let stopped = true
  const seenCompleted = new Set()

  const freezeActive = () => freeze !== null && now() < freeze.leaseUntil

  /** Express middleware: refuse destructive mutations during a freeze; count the rest. */
  function middleware(req, res, next) {
    if (!isDestructiveRequest(req.method, req.path)) return next()
    if (freezeActive()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((freeze.leaseUntil - now()) / 1000))
      res.set('Retry-After', String(retryAfterSeconds))
      return res.status(503).json({ error: MAINTENANCE_CODE, code: MAINTENANCE_CODE, retryAfterSeconds })
    }
    inFlight += 1
    let released = false
    const release = () => { if (!released) { released = true; inFlight -= 1 } }
    res.on('finish', release)
    res.on('close', release)
    return next()
  }

  async function auditCompleted(history) {
    if (!recordAudit) return
    for (const job of history) {
      if (job.status === 'RUNNING' || seenCompleted.has(job.jobId)) continue
      seenCompleted.add(job.jobId)
      if (seenCompleted.size > 500) seenCompleted.delete(seenCompleted.values().next().value)
      const action = job.kind === 'verify'
        ? (job.restoreVerification === 'PASS' ? 'BACKUP_VERIFY_PASS' : 'BACKUP_VERIFY_FAIL')
        : (job.status === 'SUCCESS' ? 'BACKUP_RUN_SUCCESS' : 'BACKUP_RUN_FAILED')
      await recordAudit({
        actorId: null,
        actorLabel: 'SYSTEM:backup-agent',
        role: 'SYSTEM',
        action,
        targetHash: hash(job.jobId),
        result: action.endsWith('SUCCESS') || action.endsWith('PASS') ? 'OK' : 'BLOCKED',
      }).catch(() => {})
    }
  }

  /** One coordination step. Safe to call repeatedly; never throws. */
  async function tick() {
    let result
    try {
      result = await fetchStatus()
    } catch {
      result = { ok: false, reason: 'unreachable' }
    }
    if (!result?.ok) {
      // Agent gone: hold any freeze until its lease (Drive's clock), then drop it.
      if (freeze && !freezeActive()) freeze = null
      return { active: freezeActive(), reachable: false }
    }

    const status = result.status
    const job = status.job
    const wantsFreeze = Boolean(job && job.quiesceRequired && QUIESCED_PHASES.includes(job.phase))

    if (wantsFreeze) {
      if (!freeze || freeze.jobId !== job.jobId) {
        const leaseUntil = Math.min(Date.parse(job.leaseUntil), now() + 3600 * 1000)
        freeze = { jobId: job.jobId, leaseUntil, acknowledged: false }
      }
      if (freezeActive() && !freeze.acknowledged && job.phase === 'QUIESCE_REQUESTED' && inFlight === 0) {
        const ack = await acknowledge({ jobId: job.jobId }).catch(() => ({ ok: false }))
        if (ack?.ok) freeze.acknowledged = true
      }
    } else if (freeze) {
      freeze = null
    }

    await auditCompleted(Array.isArray(status.history) ? status.history : [])
    return { active: freezeActive(), reachable: true }
  }

  function schedule(delayMs) {
    if (stopped) return
    timer = setTimer(() => {
      tick()
        .catch(() => {})
        .finally(() => schedule(freeze ? ACTIVE_POLL_MS : IDLE_POLL_MS))
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    middleware,
    tick,
    start() {
      if (!stopped) return
      stopped = false
      schedule(0)
    },
    stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
    },
    /** Sanitized live state, for /api/storage and tests. */
    snapshot() {
      return {
        active: freezeActive(),
        jobId: freeze?.jobId ?? null,
        leaseUntil: freeze ? new Date(freeze.leaseUntil).toISOString() : null,
        acknowledged: freeze?.acknowledged ?? false,
        inFlight,
      }
    },
    /** Test hook: force the "seen" set so repeated ticks do not double-audit. */
    __seenCount: () => seenCompleted.size,
  }
}

export { BACKUP_ROUTES }
