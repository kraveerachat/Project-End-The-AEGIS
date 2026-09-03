// server/backup/schema.js — AEGIS Drive (IDEA1) · backup agent status contract
//
// Everything the backup agent says is checked here before Drive believes it.
// Same rules as the telemetry contract: fail closed, unknown key = rejection,
// no repair. A status that fails validation renders as "agent data invalid",
// never as a partially-trusted backup state.

export const BACKUP_STATUS_SCHEMA_VERSION = 1
export const CLOCK_TOLERANCE_MS = 5_000

export const BACKUP_STATES = Object.freeze(['NOT_CONFIGURED', 'SAME_FAILURE_DOMAIN', 'TARGET_UNAVAILABLE', 'READY', 'RUNNING'])
export const PROTECTIONS = Object.freeze(['OFF_HOST', 'DIFFERENT_DEVICE', 'SAME_FAILURE_DOMAIN', 'NOT_MOUNTED', 'UNKNOWN'])
export const TARGET_TYPES = Object.freeze(['external-mount', 'off-host-sftp', 'off-host-rest'])
export const JOB_KINDS = Object.freeze(['backup', 'verify'])
export const JOB_STATUSES = Object.freeze(['RUNNING', 'SUCCESS', 'FAILED'])
export const JOB_PHASES = Object.freeze(['IDLE', 'QUIESCE_REQUESTED', 'QUIESCED', 'DUMPING', 'SNAPSHOTTING', 'CHECKING', 'PRUNING', 'VERIFYING'])
export const CHECK_RESULTS = Object.freeze(['PASS', 'FAIL', 'NOT_RUN'])
export const RESTORE_RESULTS = Object.freeze(['PASS', 'FAIL', 'NOT_TESTED'])
export const ERROR_CODES = Object.freeze([
  'TARGET_NOT_CONFIGURED', 'TARGET_NOT_PROTECTED', 'TARGET_UNAVAILABLE', 'QUIESCE_TIMEOUT', 'LEASE_EXPIRED',
  'PG_DUMP_FAILED', 'PG_DUMP_UNREADABLE', 'RESTIC_INIT_FAILED', 'RESTIC_BACKUP_FAILED', 'RESTIC_CHECK_FAILED',
  'RESTIC_FORGET_FAILED', 'RESTORE_FAILED', 'CONTENT_MISSING', 'TOOL_MISSING', 'INTERNAL',
])

const TOP_LEVEL_KEYS = ['schemaVersion', 'measuredAt', 'engine', 'tools', 'policy', 'allowed', 'limits', 'targets', 'target', 'state', 'job', 'nextRun', 'lastBackupAt', 'history']
const POLICY_KEYS = ['activeTargetId', 'scheduleId', 'retentionId', 'enabled']
const TARGET_KEYS = ['id', 'label', 'type', 'protection']
const JOB_KEYS = ['jobId', 'kind', 'phase', 'startedAt', 'leaseUntil', 'ackDeadline', 'quiesceRequired']
const HISTORY_KEYS = ['jobId', 'kind', 'trigger', 'startedAt', 'finishedAt', 'status', 'targetId', 'targetType', 'protection', 'bytesScanned', 'bytesBackedUp', 'snapshotId', 'integrityCheck', 'restoreVerification', 'errorCode']
const LIMIT_KEYS = ['quiesceLeaseSeconds', 'quiesceAckTimeoutSeconds', 'maxBackupAgeHours', 'verifyIntervalDays']
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const JOB_ID_PATTERN = /^[0-9a-f-]{8,64}$/
const MAX_HISTORY = 50

const fail = (reason) => ({ ok: false, reason })
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnlyKeys = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key))
const hasAllKeys = (object, required) => required.every((key) => key in object)
const isNonNegativeOrNull = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const isPositiveInt = (value) => Number.isInteger(value) && value > 0

function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (new Date(ms).toISOString() !== new Date(value).toISOString()) return null
  return ms
}
const isInstantOrNull = (value) => value === null || parseInstant(value) !== null

function validateTarget(target) {
  if (!isPlainObject(target) || !hasOnlyKeys(target, TARGET_KEYS) || !hasAllKeys(target, TARGET_KEYS)) return 'target-shape'
  if (typeof target.id !== 'string' || !ID_PATTERN.test(target.id)) return 'target-id'
  if (typeof target.label !== 'string' || !target.label || target.label.length > 64) return 'target-label'
  if (!TARGET_TYPES.includes(target.type)) return 'target-type'
  if (!PROTECTIONS.includes(target.protection)) return 'target-protection'
  return null
}

function validateHistoryEntry(entry) {
  if (!isPlainObject(entry) || !hasOnlyKeys(entry, HISTORY_KEYS) || !hasAllKeys(entry, HISTORY_KEYS)) return 'history-shape'
  if (typeof entry.jobId !== 'string' || !JOB_ID_PATTERN.test(entry.jobId)) return 'history-job-id'
  if (!JOB_KINDS.includes(entry.kind)) return 'history-kind'
  if (entry.trigger !== 'manual' && entry.trigger !== 'schedule') return 'history-trigger'
  if (parseInstant(entry.startedAt) === null) return 'history-started-at'
  if (!isInstantOrNull(entry.finishedAt)) return 'history-finished-at'
  if (!JOB_STATUSES.includes(entry.status)) return 'history-status'
  if (entry.targetId !== null && (typeof entry.targetId !== 'string' || !ID_PATTERN.test(entry.targetId))) return 'history-target-id'
  if (entry.targetType !== null && !TARGET_TYPES.includes(entry.targetType)) return 'history-target-type'
  if (entry.protection !== null && !PROTECTIONS.includes(entry.protection)) return 'history-protection'
  if (!isNonNegativeOrNull(entry.bytesScanned) || !isNonNegativeOrNull(entry.bytesBackedUp)) return 'history-bytes'
  if (entry.snapshotId !== null && (typeof entry.snapshotId !== 'string' || entry.snapshotId.length > 64)) return 'history-snapshot'
  if (!CHECK_RESULTS.includes(entry.integrityCheck)) return 'history-integrity'
  if (!RESTORE_RESULTS.includes(entry.restoreVerification)) return 'history-restore'
  if (entry.errorCode !== null && !ERROR_CODES.includes(entry.errorCode)) return 'history-error-code'
  return null
}

/**
 * Validate a raw /internal/backup/status body.
 *
 * @param {unknown} raw
 * @param {{ now?: number, clockToleranceMs?: number }} [options]
 * @returns {{ ok: true, status: object } | { ok: false, reason: string }}
 */
export function validateBackupStatus(raw, { now = Date.now(), clockToleranceMs = CLOCK_TOLERANCE_MS } = {}) {
  if (!isPlainObject(raw)) return fail('not-an-object')
  if (!hasOnlyKeys(raw, TOP_LEVEL_KEYS) || !hasAllKeys(raw, TOP_LEVEL_KEYS)) return fail('unexpected-or-missing-top-level-key')
  if (raw.schemaVersion !== BACKUP_STATUS_SCHEMA_VERSION) return fail('unsupported-schema-version')
  const measuredMs = parseInstant(raw.measuredAt)
  if (measuredMs === null) return fail('malformed-measured-at')
  if (measuredMs > now + clockToleranceMs) return fail('measured-in-the-future')
  if (raw.engine !== 'restic') return fail('engine-unknown')

  if (!isPlainObject(raw.tools) || !hasOnlyKeys(raw.tools, ['resticPresent', 'pgDumpPresent'])) return fail('tools-shape')
  for (const key of ['resticPresent', 'pgDumpPresent']) {
    if (raw.tools[key] !== null && typeof raw.tools[key] !== 'boolean') return fail('tools-value')
  }

  const policy = raw.policy
  if (!isPlainObject(policy) || !hasOnlyKeys(policy, POLICY_KEYS) || !hasAllKeys(policy, POLICY_KEYS)) return fail('policy-shape')
  if (policy.activeTargetId !== null && (typeof policy.activeTargetId !== 'string' || !ID_PATTERN.test(policy.activeTargetId))) return fail('policy-target')
  if (typeof policy.scheduleId !== 'string' || !ID_PATTERN.test(policy.scheduleId.replace(':', '-'))) return fail('policy-schedule')
  if (typeof policy.retentionId !== 'string' || !ID_PATTERN.test(policy.retentionId)) return fail('policy-retention')
  if (typeof policy.enabled !== 'boolean') return fail('policy-enabled')

  const allowed = raw.allowed
  if (!isPlainObject(allowed) || !hasOnlyKeys(allowed, ['scheduleIds', 'retentionIds']) || !hasAllKeys(allowed, ['scheduleIds', 'retentionIds'])) return fail('allowed-shape')
  for (const key of ['scheduleIds', 'retentionIds']) {
    if (!Array.isArray(allowed[key]) || allowed[key].length > 32 || !allowed[key].every((id) => typeof id === 'string' && id.length <= 48)) return fail('allowed-values')
  }

  const limits = raw.limits
  if (!isPlainObject(limits) || !hasOnlyKeys(limits, LIMIT_KEYS) || !hasAllKeys(limits, LIMIT_KEYS)) return fail('limits-shape')
  for (const key of LIMIT_KEYS) if (!isPositiveInt(limits[key])) return fail('limits-value')

  if (!Array.isArray(raw.targets) || raw.targets.length > 32) return fail('targets-shape')
  for (const target of raw.targets) {
    const reason = validateTarget(target)
    if (reason) return fail(reason)
  }
  if (raw.target !== null) {
    const reason = validateTarget(raw.target)
    if (reason) return fail(reason)
  }
  if (!BACKUP_STATES.includes(raw.state)) return fail('state-unknown')

  if (raw.job !== null) {
    const job = raw.job
    if (!isPlainObject(job) || !hasOnlyKeys(job, JOB_KEYS) || !hasAllKeys(job, JOB_KEYS)) return fail('job-shape')
    if (typeof job.jobId !== 'string' || !JOB_ID_PATTERN.test(job.jobId)) return fail('job-id')
    if (!JOB_KINDS.includes(job.kind) || !JOB_PHASES.includes(job.phase)) return fail('job-kind-or-phase')
    for (const key of ['startedAt', 'leaseUntil', 'ackDeadline']) if (parseInstant(job[key]) === null) return fail('job-timestamps')
    if (typeof job.quiesceRequired !== 'boolean') return fail('job-quiesce')
  }
  if (!isInstantOrNull(raw.nextRun) || !isInstantOrNull(raw.lastBackupAt)) return fail('timestamps')

  if (!Array.isArray(raw.history) || raw.history.length > MAX_HISTORY) return fail('history-shape')
  for (const entry of raw.history) {
    const reason = validateHistoryEntry(entry)
    if (reason) return fail(reason)
  }
  return { ok: true, status: raw }
}
