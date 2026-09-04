// src/schedule.js — AEGIS host backup agent · fixed schedule and retention presets
//
// An Admin chooses an ID. There is no cron expression, no free-form interval:
// a preset is a name for a policy that has been reviewed once and is then
// reused, which also means the Storage screen can render it in Thai and
// English from the ID alone.

/** Schedule presets: id -> descriptor. Times are host-local wall clock. */
export const SCHEDULES = Object.freeze({
  'disabled': Object.freeze({ kind: 'disabled' }),
  'every-6h': Object.freeze({ kind: 'interval', everyMs: 6 * 60 * 60 * 1000 }),
  'daily-02:00': Object.freeze({ kind: 'daily', hour: 2, minute: 0 }),
  'daily-03:30': Object.freeze({ kind: 'daily', hour: 3, minute: 30 }),
  'weekly-sun-03:00': Object.freeze({ kind: 'weekly', weekday: 0, hour: 3, minute: 0 }),
})
export const SCHEDULE_IDS = Object.freeze(Object.keys(SCHEDULES))

/** Retention presets: what `restic forget` keeps. */
export const RETENTIONS = Object.freeze({
  'keep-7d-4w': Object.freeze({ daily: 7, weekly: 4, monthly: 0 }),
  'keep-14d-8w-6m': Object.freeze({ daily: 14, weekly: 8, monthly: 6 }),
  'keep-30d-12w-12m': Object.freeze({ daily: 30, weekly: 12, monthly: 12 }),
})
export const RETENTION_IDS = Object.freeze(Object.keys(RETENTIONS))

/**
 * The next run strictly after `fromMs` for a schedule, or null when disabled.
 *
 * Interval schedules are anchored to `lastRunMs` when known so a restart does
 * not fire a backup immediately; a never-run interval schedule fires one
 * interval after `fromMs`.
 *
 * @param {string} scheduleId
 * @param {number} fromMs
 * @param {{ lastRunMs?: number|null }} [options]
 * @returns {number | null}
 */
export function nextRunAfter(scheduleId, fromMs, { lastRunMs = null } = {}) {
  const schedule = SCHEDULES[scheduleId]
  if (!schedule || schedule.kind === 'disabled') return null

  if (schedule.kind === 'interval') {
    const anchor = Number.isFinite(lastRunMs) && lastRunMs !== null ? lastRunMs : fromMs
    let next = anchor + schedule.everyMs
    while (next <= fromMs) next += schedule.everyMs
    return next
  }

  const candidate = new Date(fromMs)
  candidate.setHours(schedule.hour, schedule.minute, 0, 0)
  if (schedule.kind === 'daily') {
    if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }
  // weekly
  const delta = (schedule.weekday - candidate.getDay() + 7) % 7
  candidate.setDate(candidate.getDate() + delta)
  if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 7)
  return candidate.getTime()
}

/** `restic forget` arguments for a retention preset. */
export function forgetArgsFor(retentionId) {
  const retention = RETENTIONS[retentionId]
  if (!retention) throw new Error(`unknown retention ${retentionId}`)
  const args = ['--keep-daily', String(retention.daily), '--keep-weekly', String(retention.weekly)]
  if (retention.monthly > 0) args.push('--keep-monthly', String(retention.monthly))
  return args
}
