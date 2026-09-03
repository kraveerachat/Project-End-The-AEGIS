// server/backup/derive.js — AEGIS Drive (IDEA1) · backup facts and risk
//
// Pure functions from a VALIDATED agent status (schema.js) to the numbers and
// the one risk word the Storage screen shows. Every value is derived from job
// history the agent actually recorded; configuration alone never produces
// HEALTHY, and "no jobs yet" produces `null`, never 0 % or 100 %.
//
// Risk rules, in evaluation order:
//
//   agent unreachable / status invalid                     -> UNKNOWN
//   no valid protected target (NOT_CONFIGURED, SAME_FAILURE_DOMAIN,
//     TARGET_UNAVAILABLE)                                  -> NOT_CONFIGURED
//   last completed backup FAILED with no newer SUCCESS     -> CRITICAL
//   no successful backup has ever completed                -> CRITICAL
//   last successful backup older than maxBackupAgeHours    -> CRITICAL
//   last restore verification FAILED                       -> CRITICAL
//   last successful backup older than 75 % of the max age  -> WARNING
//   restore verification never performed                   -> WARNING
//   restore verification older than verifyIntervalDays     -> WARNING
//   otherwise                                              -> HEALTHY

export const BACKUP_RISK = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  HEALTHY: 'HEALTHY',
  UNKNOWN: 'UNKNOWN',
})

const DAY_MS = 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * DAY_MS
const STALE_FRACTION = 0.75

const completedBackups = (history) => history.filter((j) => j.kind === 'backup' && j.status !== 'RUNNING' && j.finishedAt)
const byFinishedDesc = (a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt)

/**
 * successful completed backup jobs / all completed backup jobs in the last
 * 30 days, as a percentage with one decimal — or null when there are none.
 */
export function successRate30d(history, now = Date.now()) {
  const recent = completedBackups(history).filter((j) => now - Date.parse(j.finishedAt) <= THIRTY_DAYS_MS)
  if (recent.length === 0) return null
  const successes = recent.filter((j) => j.status === 'SUCCESS').length
  return Math.round((successes / recent.length) * 1000) / 10
}

/** Latest completed verify job, or a NOT_TESTED marker. */
export function lastRestoreVerification(history) {
  const verifies = history.filter((j) => j.kind === 'verify' && j.status !== 'RUNNING' && j.finishedAt).sort(byFinishedDesc)
  if (verifies.length === 0) return { at: null, status: 'NOT_TESTED' }
  const last = verifies[0]
  return { at: last.finishedAt, status: last.restoreVerification === 'PASS' ? 'PASS' : 'FAIL' }
}

/**
 * Derive the facts and risk from a validated status.
 *
 * @param {object|null} status validated agent status, or null when unavailable
 * @param {{ now?: number, unavailableReason?: string|null }} [options]
 */
export function deriveBackupReport(status, { now = Date.now(), unavailableReason = null } = {}) {
  if (!status) {
    return {
      available: false,
      reason: unavailableReason ?? 'agent-unreachable',
      engine: null,
      state: 'UNKNOWN',
      target: null,
      policy: null,
      job: null,
      nextRun: null,
      lastSuccessfulBackup: null,
      lastFailedBackup: null,
      backupAgeSeconds: null,
      maxBackupAgeSeconds: null,
      bytesCovered: null,
      lastSnapshotId: null,
      integrity: 'NOT_RUN',
      restoreVerification: { at: null, status: 'NOT_TESTED' },
      successRate30d: null,
      completedJobs30d: 0,
      risk: BACKUP_RISK.UNKNOWN,
      riskReasons: [unavailableReason ?? 'agent-unreachable'],
    }
  }

  const history = status.history
  const completed = completedBackups(history).sort(byFinishedDesc)
  const lastCompleted = completed[0] ?? null
  const lastSuccess = completed.find((j) => j.status === 'SUCCESS') ?? null
  const lastFailure = completed.find((j) => j.status === 'FAILED') ?? null
  const backupAgeSeconds = lastSuccess ? Math.max(0, Math.round((now - Date.parse(lastSuccess.finishedAt)) / 1000)) : null
  const maxBackupAgeSeconds = status.limits.maxBackupAgeHours * 3600
  const verification = lastRestoreVerification(history)
  const verificationAgeMs = verification.at ? now - Date.parse(verification.at) : null
  const rate = successRate30d(history, now)
  const completed30d = completed.filter((j) => now - Date.parse(j.finishedAt) <= THIRTY_DAYS_MS).length

  const reasons = []
  let risk
  const targetValid = status.state === 'READY' || status.state === 'RUNNING'
  if (!targetValid) {
    risk = BACKUP_RISK.NOT_CONFIGURED
    reasons.push(status.state === 'NOT_CONFIGURED' ? 'no-target-selected' : status.state === 'SAME_FAILURE_DOMAIN' ? 'target-same-failure-domain' : 'target-unavailable')
  } else {
    if (lastCompleted && lastCompleted.status === 'FAILED') reasons.push('last-backup-failed')
    if (!lastSuccess) reasons.push('no-successful-backup')
    else if (backupAgeSeconds > maxBackupAgeSeconds) reasons.push('backup-older-than-max-age')
    if (verification.status === 'FAIL') reasons.push('restore-verification-failed')

    if (reasons.length) {
      risk = BACKUP_RISK.CRITICAL
    } else {
      if (backupAgeSeconds > maxBackupAgeSeconds * STALE_FRACTION) reasons.push('backup-becoming-stale')
      if (verification.status === 'NOT_TESTED') reasons.push('restore-never-verified')
      else if (verificationAgeMs !== null && verificationAgeMs > status.limits.verifyIntervalDays * DAY_MS) reasons.push('restore-verification-stale')
      risk = reasons.length ? BACKUP_RISK.WARNING : BACKUP_RISK.HEALTHY
    }
  }

  return {
    available: true,
    reason: null,
    engine: status.engine,
    state: status.state,
    target: status.target ? { ...status.target } : null,
    policy: { ...status.policy },
    job: status.job ? { ...status.job } : null,
    nextRun: status.nextRun,
    lastSuccessfulBackup: lastSuccess?.finishedAt ?? null,
    lastFailedBackup: lastFailure?.finishedAt ?? null,
    backupAgeSeconds,
    maxBackupAgeSeconds,
    bytesCovered: lastSuccess?.bytesScanned ?? null,
    lastSnapshotId: lastSuccess?.snapshotId ?? null,
    integrity: lastSuccess ? lastSuccess.integrityCheck : (lastCompleted?.integrityCheck ?? 'NOT_RUN'),
    restoreVerification: verification,
    successRate30d: rate,
    completedJobs30d: completed30d,
    risk,
    riskReasons: reasons,
  }
}
