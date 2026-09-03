// src/job.js — AEGIS host backup agent · job runner and consistency model
//
// ── The consistency problem ───────────────────────────────────────────
// The PostgreSQL dump and the byte snapshot cannot be taken at the same
// instant. A file row written into the dump at T0 must point at bytes that
// still exist, unchanged, when restic reads them at T1 > T0. In Drive, bytes
// never change in place, but two operations MOVE or REMOVE a key that a
// metadata row references: same-name replacement (uploads/x renamed into
// versions/), and delete (uploads/x and its versions removed). A vault-blob
// delete does the same for ciphertext.
//
// ── The model: a bounded write-freeze lease with acknowledgement ──────
//   1. The agent enters QUIESCE_REQUESTED with a lease (leaseUntil) and an
//      acknowledgement deadline (ackDeadline).
//   2. Drive polls the agent's status. Seeing QUIESCE_REQUESTED, it refuses
//      DESTRUCTIVE mutations (delete, replace-commit, version restore, vault
//      delete) with 503 BACKUP_MAINTENANCE, waits for in-flight ones to drain,
//      then POSTs /internal/backup/quiesced. Reads, downloads, shares and
//      brand-new uploads continue: a new key that is not yet in any row is a
//      harmless extra in the snapshot, never a dangling reference.
//   3. Only after the acknowledgement does the agent run pg_dump and then
//      restic backup. If Drive never acknowledges before ackDeadline, the job
//      FAILS with QUIESCE_TIMEOUT. It is never allowed to "back up anyway".
//   4. The freeze ends when the snapshot is complete (phase leaves the
//      quiesced set) or when leaseUntil passes, whichever is first. Drive
//      enforces leaseUntil on its own clock, so a hung agent cannot freeze
//      Drive indefinitely; and if the lease expires before the snapshot is
//      done, the job FAILS with LEASE_EXPIRED — a backup taken partly outside
//      the freeze is not reported as SUCCESS.
//   5. `restic check` and retention pruning run AFTER release; they do not
//      need the freeze and must not extend it.
//
// A green status therefore means: target on different hardware, Drive
// acknowledged the freeze, dump readable, snapshot complete inside the lease,
// repository check passed. Nothing less.
import { randomUUID } from 'node:crypto'
import fspDefault from 'node:fs/promises'
import path from 'node:path'

import { DUMP_FILE_NAME, dumpDatabase, verifyDumpReadable } from './pgdump.js'
import { forgetArgsFor } from './schedule.js'
import { PROTECTION, classifyTarget, isProtected } from './targets.js'

export const PHASES = Object.freeze({
  IDLE: 'IDLE',
  QUIESCE_REQUESTED: 'QUIESCE_REQUESTED',
  QUIESCED: 'QUIESCED',
  DUMPING: 'DUMPING',
  SNAPSHOTTING: 'SNAPSHOTTING',
  CHECKING: 'CHECKING',
  PRUNING: 'PRUNING',
  VERIFYING: 'VERIFYING',
})

/** Phases during which Drive must hold the write freeze. */
export const QUIESCED_PHASES = Object.freeze([PHASES.QUIESCE_REQUESTED, PHASES.QUIESCED, PHASES.DUMPING, PHASES.SNAPSHOTTING])

/** Bounded subset for `restic check --read-data-subset` during verification. */
export const VERIFY_READ_DATA_SUBSET = '10%'

/**
 * @param {object} deps
 * @param {object} deps.config validated static config
 * @param {object} deps.policyStore
 * @param {object} deps.history
 * @param {(target: object) => object} deps.resticFor builds a restic wrapper for a target
 * @param {Function} [deps.dumpDatabase]
 * @param {Function} [deps.verifyDumpReadable]
 * @param {Function} [deps.classify] classifyTarget-compatible
 * @param {() => number} [deps.now]
 * @param {object} [deps.fs]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
export function createJobRunner({
  config,
  policyStore,
  history,
  resticFor,
  dumpDatabase: dump = dumpDatabase,
  verifyDumpReadable: verifyDump = verifyDumpReadable,
  classify,
  now = Date.now,
  fs = fspDefault,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!config || !policyStore || !history || !resticFor || !classify) throw new Error('job runner dependencies missing')

  let current = null // { jobId, kind, phase, leaseUntil, ackDeadline, startedAt, record, ack, ackTimer }
  let lastCompleted = null

  const iso = (ms) => new Date(ms).toISOString()
  const leaseMs = config.limits.quiesceLeaseSeconds * 1000
  const ackMs = config.limits.quiesceAckTimeoutSeconds * 1000

  async function classifyActive(policy) {
    if (!policy.activeTargetId) return { target: null, classification: null }
    const target = config.targets.find((t) => t.id === policy.activeTargetId) ?? null
    if (!target) return { target: null, classification: null }
    const classification = await classify(target)
    return { target, classification }
  }

  async function finish(record, patch) {
    const finalRecord = { ...record, ...patch, finishedAt: iso(now()) }
    await history.upsert(finalRecord)
    lastCompleted = finalRecord
    current = null
    return finalRecord
  }

  /** Wait for Drive's acknowledgement or the deadline. */
  function awaitAcknowledgement(job) {
    return new Promise((resolve) => {
      job.ack = () => { clearTimer(job.ackTimer); resolve(true) }
      job.ackTimer = setTimer(() => resolve(false), Math.max(0, job.ackDeadline - now()))
      if (typeof job.ackTimer?.unref === 'function') job.ackTimer.unref()
    })
  }

  const withinLease = (job) => now() < job.leaseUntil

  async function runBackup(job, target, classification, policy) {
    const restic = resticFor(target)
    const record = job.record

    // ── 1. quiesce handshake ───────────────────────────────────────────
    job.phase = PHASES.QUIESCE_REQUESTED
    const acknowledged = await awaitAcknowledgement(job)
    if (!acknowledged) return finish(record, { status: 'FAILED', errorCode: 'QUIESCE_TIMEOUT' })
    job.phase = PHASES.QUIESCED
    if (!withinLease(job)) return finish(record, { status: 'FAILED', errorCode: 'LEASE_EXPIRED' })

    // ── 2. metadata dump (transaction-consistent) ──────────────────────
    job.phase = PHASES.DUMPING
    const dumpDir = path.posix.join(config.stateDir, 'dump')
    const dumpFile = path.posix.join(dumpDir, DUMP_FILE_NAME)
    try {
      await fs.mkdir(dumpDir, { recursive: true, mode: 0o750 })
      const dumped = await dump({ binary: config.tools.pgDump, connection: config.postgres, outputFile: dumpFile })
      if (!dumped.ok) return finish(record, { status: 'FAILED', errorCode: 'PG_DUMP_FAILED' })
      const readable = await verifyDump({ binary: config.tools.pgRestore, file: dumpFile })
      if (!readable.ok) return finish(record, { status: 'FAILED', errorCode: 'PG_DUMP_UNREADABLE' })
    } catch (err) {
      return finish(record, { status: 'FAILED', errorCode: err?.code === 'ENOENT' ? 'TOOL_MISSING' : 'PG_DUMP_FAILED' })
    }
    if (!withinLease(job)) return finish(record, { status: 'FAILED', errorCode: 'LEASE_EXPIRED' })

    // ── 3. byte snapshot (dump + Data Lake subdirectories) ─────────────
    job.phase = PHASES.SNAPSHOTTING
    let summary
    try {
      if (!(await restic.isInitialized())) {
        const init = await restic.init()
        if (!init.ok) return finish(record, { status: 'FAILED', errorCode: 'RESTIC_INIT_FAILED' })
      }
      await restic.unlock()
      const paths = [dumpDir, ...config.source.include.map((name) => path.posix.join(config.source.datalakePath, name))]
      const backup = await restic.backup(paths)
      if (!backup.ok) return finish(record, { status: 'FAILED', errorCode: 'RESTIC_BACKUP_FAILED' })
      summary = backup.summary
    } catch (err) {
      return finish(record, { status: 'FAILED', errorCode: err?.code === 'ENOENT' ? 'TOOL_MISSING' : 'RESTIC_BACKUP_FAILED' })
    }
    if (!withinLease(job)) {
      // The snapshot exists but part of it was taken after Drive was free to
      // mutate again. It is not evidence of a consistent backup.
      return finish(record, { status: 'FAILED', errorCode: 'LEASE_EXPIRED', snapshotId: summary.snapshotId })
    }

    // ── 4. release; check and prune outside the freeze ─────────────────
    job.phase = PHASES.CHECKING
    const withSummary = {
      snapshotId: summary.snapshotId,
      bytesScanned: summary.bytesScanned,
      bytesBackedUp: summary.bytesBackedUp,
    }
    try {
      const check = await restic.check()
      if (!check.ok) return finish(record, { status: 'FAILED', errorCode: 'RESTIC_CHECK_FAILED', integrityCheck: 'FAIL', ...withSummary })
    } catch {
      return finish(record, { status: 'FAILED', errorCode: 'RESTIC_CHECK_FAILED', integrityCheck: 'FAIL', ...withSummary })
    }

    job.phase = PHASES.PRUNING
    try {
      const forget = await restic.forget(forgetArgsFor(policy.retentionId))
      if (!forget.ok) return finish(record, { status: 'FAILED', errorCode: 'RESTIC_FORGET_FAILED', integrityCheck: 'PASS', ...withSummary })
    } catch {
      return finish(record, { status: 'FAILED', errorCode: 'RESTIC_FORGET_FAILED', integrityCheck: 'PASS', ...withSummary })
    }

    return finish(record, { status: 'SUCCESS', integrityCheck: 'PASS', ...withSummary })
  }

  async function runVerify(job, target) {
    const restic = resticFor(target)
    const record = job.record
    job.phase = PHASES.VERIFYING
    const verifyDir = path.posix.join(config.stateDir, 'verify', job.jobId)
    try {
      // a. repository integrity, reading a bounded slice of actual pack data
      const check = await restic.check({ readDataSubset: VERIFY_READ_DATA_SUBSET })
      if (!check.ok) return finish(record, { status: 'FAILED', errorCode: 'RESTIC_CHECK_FAILED', integrityCheck: 'FAIL', restoreVerification: 'FAIL' })

      // b. expected durable content is present in the latest snapshot
      const listing = await restic.listSnapshot('latest')
      const expected = [
        path.posix.join(config.stateDir, 'dump', DUMP_FILE_NAME),
        ...config.source.include.map((name) => path.posix.join(config.source.datalakePath, name)),
      ]
      const missing = expected.filter((p) => !listing.paths.includes(p))
      if (!listing.ok || missing.length) return finish(record, { status: 'FAILED', errorCode: 'CONTENT_MISSING', integrityCheck: 'PASS', restoreVerification: 'FAIL' })

      // c. isolated restore of the metadata dump, then prove it is readable.
      //    The target is a per-job directory inside the agent's own state dir;
      //    nothing under the production volume or database is written.
      await fs.mkdir(verifyDir, { recursive: true, mode: 0o750 })
      const restored = await restic.restoreTo(verifyDir, { snapshot: 'latest', include: [expected[0]] })
      if (!restored.ok) return finish(record, { status: 'FAILED', errorCode: 'RESTORE_FAILED', integrityCheck: 'PASS', restoreVerification: 'FAIL' })
      const readable = await verifyDump({ binary: config.tools.pgRestore, file: path.posix.join(verifyDir, expected[0]) })
      if (!readable.ok) return finish(record, { status: 'FAILED', errorCode: 'PG_DUMP_UNREADABLE', integrityCheck: 'PASS', restoreVerification: 'FAIL' })

      return finish(record, { status: 'SUCCESS', integrityCheck: 'PASS', restoreVerification: 'PASS' })
    } catch (err) {
      return finish(record, { status: 'FAILED', errorCode: err?.code === 'ENOENT' ? 'TOOL_MISSING' : 'INTERNAL', restoreVerification: 'FAIL' })
    } finally {
      await fs.rm(verifyDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function start(kind, trigger) {
    if (current) return { ok: false, reason: 'busy', jobId: current.jobId }
    const policy = await policyStore.get()
    const startedAt = now()
    const jobId = randomUUID()
    const { target, classification } = await classifyActive(policy)

    const record = {
      jobId, kind, trigger, startedAt: iso(startedAt), finishedAt: null, status: 'RUNNING',
      targetId: target?.id ?? null, targetType: target?.type ?? null, protection: classification?.protection ?? null,
      bytesScanned: null, bytesBackedUp: null, snapshotId: null,
      integrityCheck: 'NOT_RUN', restoreVerification: 'NOT_TESTED', errorCode: null,
    }
    current = { jobId, kind, phase: PHASES.IDLE, startedAt, leaseUntil: startedAt + leaseMs, ackDeadline: startedAt + ackMs, record, ack: null, ackTimer: null }
    await history.upsert(record)

    if (!target) return { ok: false, reason: 'not-configured', job: await finish(record, { status: 'FAILED', errorCode: 'TARGET_NOT_CONFIGURED' }) }
    if (classification.protection === PROTECTION.NOT_MOUNTED || classification.protection === PROTECTION.UNKNOWN) {
      return { ok: false, reason: 'target-unavailable', job: await finish(record, { status: 'FAILED', errorCode: 'TARGET_UNAVAILABLE' }) }
    }
    if (!isProtected(classification.protection)) {
      return { ok: false, reason: 'target-not-protected', job: await finish(record, { status: 'FAILED', errorCode: 'TARGET_NOT_PROTECTED' }) }
    }

    const run = kind === 'backup' ? runBackup(current, target, classification, policy) : runVerify(current, target)
    // The run continues in the background; a caller that wants the outcome awaits `done`.
    const done = run.catch(async (err) => finish(record, { status: 'FAILED', errorCode: 'INTERNAL' }).catch(() => ({ ...record, status: 'FAILED', errorCode: 'INTERNAL', detail: err?.message })))
    current.done = done
    return { ok: true, jobId, done }
  }

  return {
    requestBackup: ({ trigger = 'manual' } = {}) => start('backup', trigger),
    requestVerify: ({ trigger = 'manual' } = {}) => start('verify', trigger),

    /** Drive's acknowledgement that destructive mutations are refused and drained. */
    acknowledgeQuiesce(jobId) {
      if (!current || current.jobId !== jobId) return { ok: false, reason: 'no-such-job' }
      if (current.phase !== PHASES.QUIESCE_REQUESTED) return { ok: false, reason: 'not-awaiting-acknowledgement', phase: current.phase }
      current.ack?.()
      return { ok: true }
    },

    /** Sanitized live state for the status route. */
    status() {
      if (!current) return { running: false, job: null }
      const quiesceHeld = QUIESCED_PHASES.includes(current.phase) && now() < current.leaseUntil
      return {
        running: true,
        job: {
          jobId: current.jobId,
          kind: current.kind,
          phase: current.phase,
          startedAt: iso(current.startedAt),
          leaseUntil: iso(current.leaseUntil),
          ackDeadline: iso(current.ackDeadline),
          quiesceRequired: quiesceHeld,
        },
      }
    },

    classifyActive,
    lastCompleted: () => lastCompleted,
  }
}
