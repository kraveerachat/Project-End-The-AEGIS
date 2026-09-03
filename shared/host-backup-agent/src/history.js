// src/history.js — AEGIS host backup agent · sanitized job history
//
// One JSON file in the agent's StateDirectory holding the last MAX_JOBS job
// records. A record carries numbers, IDs, ISO timestamps and enum strings —
// never a command line, never a path from the target, never an error message
// from a tool (those go to the journal, which is readable by more accounts
// than this file and by nobody through Drive).
import fspDefault from 'node:fs/promises'
import path from 'node:path'

export const MAX_JOBS = 200
export const HISTORY_FILE_NAME = 'jobs.json'

export const JOB_KINDS = Object.freeze(['backup', 'verify'])
export const JOB_STATUSES = Object.freeze(['RUNNING', 'SUCCESS', 'FAILED'])
export const CHECK_RESULTS = Object.freeze(['PASS', 'FAIL', 'NOT_RUN'])
export const RESTORE_RESULTS = Object.freeze(['PASS', 'FAIL', 'NOT_TESTED'])

/** The only error codes a job may record. Free-form messages never enter history. */
export const ERROR_CODES = Object.freeze([
  'TARGET_NOT_CONFIGURED', 'TARGET_NOT_PROTECTED', 'TARGET_UNAVAILABLE',
  'QUIESCE_TIMEOUT', 'LEASE_EXPIRED',
  'PG_DUMP_FAILED', 'PG_DUMP_UNREADABLE',
  'RESTIC_INIT_FAILED', 'RESTIC_BACKUP_FAILED', 'RESTIC_CHECK_FAILED', 'RESTIC_FORGET_FAILED',
  'RESTORE_FAILED', 'CONTENT_MISSING', 'TOOL_MISSING', 'INTERNAL',
])

const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/**
 * Normalise one job record to the contract, dropping anything unknown.
 * Returns null for a record that cannot be trusted (missing id or timestamps).
 */
export function sanitizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.jobId !== 'string' || !/^[0-9a-f-]{8,64}$/.test(raw.jobId)) return null
  if (!JOB_KINDS.includes(raw.kind) || !JOB_STATUSES.includes(raw.status)) return null
  if (!isIso(raw.startedAt)) return null
  return {
    jobId: raw.jobId,
    kind: raw.kind,
    trigger: raw.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: new Date(Date.parse(raw.startedAt)).toISOString(),
    finishedAt: isIso(raw.finishedAt) ? new Date(Date.parse(raw.finishedAt)).toISOString() : null,
    status: raw.status,
    targetId: typeof raw.targetId === 'string' ? raw.targetId.slice(0, 48) : null,
    targetType: typeof raw.targetType === 'string' ? raw.targetType.slice(0, 32) : null,
    protection: typeof raw.protection === 'string' ? raw.protection.slice(0, 32) : null,
    bytesScanned: numOrNull(raw.bytesScanned),
    bytesBackedUp: numOrNull(raw.bytesBackedUp),
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId.slice(0, 64) : null,
    integrityCheck: CHECK_RESULTS.includes(raw.integrityCheck) ? raw.integrityCheck : 'NOT_RUN',
    restoreVerification: RESTORE_RESULTS.includes(raw.restoreVerification) ? raw.restoreVerification : 'NOT_TESTED',
    errorCode: ERROR_CODES.includes(raw.errorCode) ? raw.errorCode : null,
  }
}

/**
 * @param {{ stateDir: string, fs?: object }} options
 */
export function createHistoryStore({ stateDir, fs = fspDefault }) {
  const file = path.posix.join(stateDir, HISTORY_FILE_NAME)
  let jobs = null

  async function load() {
    if (jobs) return jobs
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      jobs = Array.isArray(parsed) ? parsed.map(sanitizeJob).filter(Boolean) : []
    } catch {
      jobs = [] // missing or corrupt: start empty; never invent a past job
    }
    return jobs
  }

  async function persist() {
    const tmp = `${file}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(jobs), { encoding: 'utf8', mode: 0o640 })
    await fs.rename(tmp, file)
  }

  return {
    async list() {
      return [...(await load())]
    },
    /** Insert or replace by jobId (a RUNNING record is finalised in place). */
    async upsert(job) {
      const clean = sanitizeJob(job)
      if (!clean) throw new Error('refusing to record an off-contract job')
      const all = await load()
      const index = all.findIndex((j) => j.jobId === clean.jobId)
      if (index === -1) all.unshift(clean)
      else all[index] = clean
      if (all.length > MAX_JOBS) all.length = MAX_JOBS
      await persist()
      return clean
    },
  }
}
