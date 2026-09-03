import { HardDrive, Database, Archive } from 'lucide-react'
import {
  Card, CardTitle, Chip, Btn, ErrorState, InlineEmptyState, SkeletonLoader, NotYetImplemented,
} from '../components/ui.jsx'
import { CapacityCard } from '../components/CapacityRing.jsx'
import { PROTECTION_LABEL, PROTECTION_TONE, labelFor } from '../components/BackupConfiguration.jsx'
import { useApi, useNow } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { fmtBytes, fmtDateTime, fmtRelative } from '../lib/format.js'

/* ── จอนี้เคยเป็นแหล่งข้อมูลปลอมที่อันตรายที่สุดในแอป ────────────────────────────────
   ของเดิมแสดง: ดิสก์สองลูก 'WD Red Pro 4TB' พร้อม serial (WD-WX32DA8L7K4N /
   WD-WX32DA8L2C9F), อุณหภูมิ 38°C และ 41°C, 'SMART: PASSED', ชั่วโมงทำงาน 14,208
   และ backup job สามงาน (Nightly incremental / Vault ciphertext replica / PostgreSQL
   WAL archive) ที่มี lastRun และ nextRun เดินอยู่ — **ทั้งหมด hard-code ไว้ใน store.js
   ไม่มีค่าใดถูกอ่านมาจากที่ไหนเลย** ฮาร์ดแวร์ชุดนั้นไม่มีอยู่ใน deployment นี้ และไม่มี
   backup job ใดถูกตั้งค่าไว้ที่ไหน

   ทำไมมันร้ายกว่าตัวเลขผิดธรรมดา: ผู้ดูแลที่เห็น "SMART: PASSED" จะเลิกตรวจสุขภาพดิสก์
   และผู้ที่เห็น "Nightly incremental · ok · 9 ชั่วโมงที่แล้ว" จะเชื่อว่ามีสำเนาข้อมูลอยู่จริง
   สองความเชื่อนั้นคือสิ่งที่ทำให้คนไม่ทำสำรองข้อมูลจนถึงวันที่ดิสก์เสีย

   สิ่งที่แสดงตอนนี้:
   - ความจุ: statfs ของ mount ที่ Data Lake อยู่ + ผลรวมตามหมวดจากฐานข้อมูล — ตอนนี้อ่านเป็น
     วงแหวนพร้อมตาราง legend แทนแท่งแนวนอน (ดู components/CapacityRing.jsx สำหรับกติกา
     ของลายขวางและการจัดการหมวดที่เล็กเกินกว่าจะวาดได้) ตัวเลขและสัญญา API ไม่เปลี่ยน
   - สุขภาพดิสก์: หลักฐาน SMART จากตัวเก็บข้อมูลบนโฮสต์ (สิทธิ์จำกัดหนึ่งอุปกรณ์) ผ่าน
     telemetry agent → Drive ตรวจสอบสัญญาแล้วสรุปสถานะ — ไม่มีหลักฐาน = "ไม่ทราบ"
   - สำรองข้อมูล: สถานะ/ประวัติงาน/ความเสี่ยงจาก host backup agent ที่แยกสิทธิ์ —
     ตั้งค่าอย่างเดียวไม่มีวันเป็น "ปกติ" และปลายทางบนดิสก์ลูกเดียวกันคือ "ไม่ได้รับการป้องกัน"
   - RAID: ประกาศว่าไม่ได้ตั้งค่า เพราะไม่มี array ใน deployment นี้ ไม่มีการเดา
   คอนเทนเนอร์ Drive ยังไม่มีสิทธิ์ raw device ใด ๆ — ค่าทั้งหมดมาจาก agent ที่แยกออกไป */

/* ── shared bits ─────────────────────────────────────────────────────── */
const STATUS_TONE = { HEALTHY: 'ok', WARNING: 'warn', CRITICAL: 'danger', UNKNOWN: 'neutral', NOT_CONFIGURED: 'neutral' }
const DISK_STATUS_LABEL = { HEALTHY: 'diskStatusHealthy', WARNING: 'diskStatusWarning', CRITICAL: 'diskStatusCritical', UNKNOWN: 'diskStatusUnknown' }
const DISK_REASON_LABEL = {
  'agent-unreachable': 'diskReasonAgentUnreachable',
  'smartctl-absent': 'diskReasonSmartctlAbsent',
  'collector-not-run': 'diskReasonCollectorNotRun',
  'not-configured': 'diskReasonNotConfigured',
  'smart-unsupported': 'diskReasonSmartUnsupported',
}
const DISK_WARNING_LABEL = {
  'smart-failed': 'diskWarnSmartFailed',
  'attribute-failing-now': 'diskWarnAttributeFailingNow',
  'attribute-failed-past': 'diskWarnAttributeFailedPast',
  'reallocated-sectors': 'diskWarnReallocatedSectors',
  'pending-sectors': 'diskWarnPendingSectors',
  'offline-uncorrectable': 'diskWarnOfflineUncorrectable',
  'reported-uncorrectable': 'diskWarnReportedUncorrectable',
  'temperature-high': 'diskWarnTemperatureHigh',
  'nvme-critical-warning': 'diskWarnNvmeCriticalWarning',
  'nvme-spare-low': 'diskWarnNvmeSpareLow',
  'nvme-wear-high': 'diskWarnNvmeWearHigh',
  'smartctl-partial-failure': 'diskWarnSmartctlPartialFailure',
}
const BACKUP_STATE_LABEL = {
  NOT_CONFIGURED: 'backupStateNotConfigured', SAME_FAILURE_DOMAIN: 'backupStateSameFailureDomain',
  TARGET_UNAVAILABLE: 'backupStateTargetUnavailable', READY: 'backupStateReady', RUNNING: 'backupStateRunning', UNKNOWN: 'backupStateUnknown',
}
const BACKUP_STATE_TONE = { NOT_CONFIGURED: 'neutral', SAME_FAILURE_DOMAIN: 'danger', TARGET_UNAVAILABLE: 'warn', READY: 'ok', RUNNING: 'accent', UNKNOWN: 'neutral' }
const BACKUP_RISK_LABEL = {
  HEALTHY: 'backupRiskHealthy', WARNING: 'backupRiskWarning', CRITICAL: 'backupRiskCritical',
  NOT_CONFIGURED: 'backupRiskNotConfigured', UNKNOWN: 'backupRiskUnknown',
}
const RISK_REASON_LABEL = {
  'last-backup-failed': 'riskLastBackupFailed',
  'no-successful-backup': 'riskNoSuccessfulBackup',
  'backup-older-than-max-age': 'riskBackupOlderThanMaxAge',
  'restore-verification-failed': 'riskRestoreVerificationFailed',
  'backup-becoming-stale': 'riskBackupBecomingStale',
  'restore-never-verified': 'riskRestoreNeverVerified',
  'restore-verification-stale': 'riskRestoreVerificationStale',
  'no-target-selected': 'riskNoTargetSelected',
  'target-same-failure-domain': 'riskTargetSameFailureDomain',
  'target-unavailable': 'riskTargetUnavailable',
}
const CHECK_LABEL = { PASS: 'checkPass', FAIL: 'checkFail', NOT_RUN: 'checkNotRun', NOT_TESTED: 'restoreNotTested' }
const CHECK_TONE = { PASS: 'ok', FAIL: 'danger', NOT_RUN: 'neutral', NOT_TESTED: 'neutral' }
const JOB_STATUS_LABEL = { SUCCESS: 'jobStatusSuccess', FAILED: 'jobStatusFailed', RUNNING: 'jobStatusRunning' }
const JOB_STATUS_TONE = { SUCCESS: 'ok', FAILED: 'danger', RUNNING: 'accent' }

// The API speaks ISO-8601; the formatters take epoch milliseconds.
const ms = (iso) => (iso ? Date.parse(iso) : null)
const stamp = (iso) => (iso ? fmtDateTime(ms(iso)) : null)

function Fact({ label, children, mono = false }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className={`text-[13px] text-ink truncate ${mono ? 'font-mono' : ''}`}>{children}</dd>
    </div>
  )
}

/* ── Disk health — evidence from the host collector, status derived by Drive ── */
function DiskHealthCard({ t, disk, now }) {
  const status = disk?.status ?? 'UNKNOWN'
  return (
    <Card className="p-5">
      <CardTitle sub={t('diskHealthSource')} right={<Chip tone={STATUS_TONE[status] ?? 'neutral'}>{t(DISK_STATUS_LABEL[status] ?? 'diskStatusUnknown')}</Chip>}>
        {t('diskHealth')}
      </CardTitle>
      <div className="flex items-start gap-3">
        <HardDrive size={16} strokeWidth={1.5} className="text-ink-3 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          {!disk?.available ? (
            <NotYetImplemented label={t('diskUnavailable')}>
              {DISK_REASON_LABEL[disk?.reason] ? t(DISK_REASON_LABEL[disk.reason]) : t('diskReasonOther', { reason: disk?.reason ?? 'unknown' })}
            </NotYetImplemented>
          ) : (
            <>
              {disk.stale && (
                <p role="status" className="text-[12.5px] rounded-[10px] px-3 py-2 mb-3 leading-relaxed" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
                  {t('diskStale', { minutes: Math.round((disk.maxAgeSeconds ?? 1800) / 60) })}
                </p>
              )}
              <dl className="grid grid-cols-3 gap-x-6 gap-y-3 max-md:grid-cols-2">
                <Fact label={t('diskModel')}>{disk.model ?? '—'}</Fact>
                <Fact label={t('diskDevice')} mono>{disk.device ?? '—'}</Fact>
                <Fact label={t('diskSmart')}>
                  {disk.smart?.passed === true ? t('diskSmartPassed') : disk.smart?.passed === false ? t('diskSmartFailed') : t('diskSmartNotReported')}
                </Fact>
                {/* null = ไม่ได้รายงาน — แสดง "—" ไม่ใช่ 0 */}
                <Fact label={t('diskTemperature')} mono>{disk.temperatureCelsius === null ? '—' : `${disk.temperatureCelsius} °C`}</Fact>
                <Fact label={t('diskPowerOnHours')} mono>{disk.powerOnHours === null ? '—' : disk.powerOnHours.toLocaleString()}</Fact>
                <Fact label={t('diskCapacity')} mono>{disk.capacityBytes === null ? '—' : fmtBytes(disk.capacityBytes)}</Fact>
              </dl>
              <div className="mt-3 pt-3 border-t border-line">
                <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1">{t('diskWarnings')}</p>
                {disk.warnings.length === 0
                  ? <p className="text-[12.5px] text-ink-2">{t('diskNoWarnings')}</p>
                  : (
                    <ul className="flex flex-col gap-1">
                      {disk.warnings.map((code) => (
                        <li key={code} className="text-[12.5px] text-ink flex items-center gap-2">
                          <span className="size-1.5 rounded-full shrink-0" style={{ background: 'var(--warn)' }} aria-hidden />
                          {DISK_WARNING_LABEL[code] ? t(DISK_WARNING_LABEL[code]) : code}
                        </li>
                      ))}
                    </ul>
                  )}
                {disk.measuredAt && (
                  <p className="text-[11.5px] text-ink-3 mt-2">{t('diskMeasured', { ago: fmtRelative(t, ms(disk.measuredAt), now) })}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/* ── Backup — state, facts, risk and job history from the host backup agent ── */
function BackupCard({ t, backup, history, go, now }) {
  const state = backup?.state ?? 'UNKNOWN'
  const risk = backup?.risk ?? 'UNKNOWN'
  const available = Boolean(backup?.available)
  const jobs = Array.isArray(history) ? history : []
  const when = (iso) => (iso ? stamp(iso) : t('backupNever'))

  return (
    <Card className="p-5">
      <CardTitle right={<Chip tone={BACKUP_STATE_TONE[state] ?? 'neutral'}>{t(BACKUP_STATE_LABEL[state] ?? 'backupStateUnknown')}</Chip>}>
        {t('backupJobs')}
      </CardTitle>

      {!available && (
        <div className="mb-4">
          <NotYetImplemented label={t('notConnected')}>
            {String(backup?.reason ?? '').startsWith('agent-data-invalid') ? t('backupAgentInvalid') : t('backupUnavailableReason')}
          </NotYetImplemented>
        </div>
      )}

      {available && (
        <>
          {state === 'SAME_FAILURE_DOMAIN' && (
            <p role="alert" className="text-[12.5px] rounded-[10px] px-3 py-2 mb-4 leading-relaxed" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
              {t('backupSameDomainWhy')}
            </p>
          )}
          <dl className="grid grid-cols-3 gap-x-6 gap-y-3 max-md:grid-cols-2">
            <Fact label={t('backupRisk')}>
              <Chip tone={STATUS_TONE[risk] ?? 'neutral'}>{t(BACKUP_RISK_LABEL[risk] ?? 'backupRiskUnknown')}</Chip>
            </Fact>
            <Fact label={t('backupTarget')}>{backup.target ? backup.target.label : t('backupTargetNone')}</Fact>
            <Fact label={t('backupTargetProtection')}>
              {backup.target
                ? <Chip tone={PROTECTION_TONE[backup.target.protection] ?? 'neutral'}>{labelFor(t, PROTECTION_LABEL, backup.target.protection)}</Chip>
                : '—'}
            </Fact>
            <Fact label={t('backupLastSuccess')}>{when(backup.lastSuccessfulBackup)}</Fact>
            <Fact label={t('backupLastFailure')}>{when(backup.lastFailedBackup)}</Fact>
            <Fact label={t('backupNextRun')}>{backup.nextRun ? stamp(backup.nextRun) : t('backupNotScheduled')}</Fact>
            <Fact label={t('backupBytesCovered')} mono>{backup.bytesCovered === null ? '—' : fmtBytes(backup.bytesCovered)}</Fact>
            <Fact label={t('backupIntegrity')}>
              <Chip tone={CHECK_TONE[backup.integrity] ?? 'neutral'}>{t(CHECK_LABEL[backup.integrity] ?? 'checkNotRun')}</Chip>
            </Fact>
            <Fact label={t('backupRestoreVerification')}>
              <Chip tone={CHECK_TONE[backup.restoreVerification?.status] ?? 'neutral'}>{t(CHECK_LABEL[backup.restoreVerification?.status] ?? 'restoreNotTested')}</Chip>
              {backup.restoreVerification?.at && <span className="ml-2 text-[11.5px] text-ink-3">{fmtRelative(t, ms(backup.restoreVerification.at), now)}</span>}
            </Fact>
            {/* null = ยังไม่มีงานที่เสร็จใน 30 วัน — ไม่ใช่ 0% และไม่ใช่ 100% */}
            <Fact label={t('backupSuccessRate')} mono>{backup.successRate30d === null ? t('backupNoJobs') : `${backup.successRate30d}% (${backup.completedJobs30d})`}</Fact>
            <Fact label={t('backupEngine')} mono>{backup.engine ?? '—'}</Fact>
          </dl>
          {backup.riskReasons?.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {backup.riskReasons.map((code) => (
                <li key={code} className="text-[12.5px] text-ink-2 flex items-center gap-2">
                  <span className="size-1.5 rounded-full shrink-0" style={{ background: risk === 'CRITICAL' ? 'var(--danger)' : 'var(--warn)' }} aria-hidden />
                  {RISK_REASON_LABEL[code] ? t(RISK_REASON_LABEL[code]) : code}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-4 overflow-x-auto rounded-[var(--r-tile)] border border-line">
        <div className="min-w-[520px]">
          <div className="grid grid-cols-[1fr_160px_120px] gap-3 px-4 h-9 items-center bg-sunken border-b border-line text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em]">
            <span>{t('colJob')}</span>
            <span>{t('colStarted')}</span>
            <span>{t('colResult')}</span>
          </div>
          {jobs.length === 0 ? (
            <InlineEmptyState
              action={
                <Btn variant="outline" size="sm" onClick={() => go?.('settings')}>
                  <Archive size={13} strokeWidth={1.5} />
                  {t('setupNow')}
                </Btn>
              }
            >
              {t('backupScheduleEmpty')}
            </InlineEmptyState>
          ) : jobs.slice(0, 8).map((job) => (
            <div key={job.jobId} className="grid grid-cols-[1fr_160px_120px] gap-3 px-4 py-2.5 items-center border-b border-line last:border-b-0 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium text-ink">{job.kind === 'verify' ? t('jobVerify') : t('jobBackup')}</span>
                <span className="text-ink-3 text-[12px]"> · {job.trigger === 'schedule' ? t('triggerSchedule') : t('triggerManual')}</span>
                {job.errorCode && <span className="font-mono text-[11.5px] text-ink-3"> · {job.errorCode}</span>}
              </span>
              <span className="text-ink-2 text-[12.5px]">{stamp(job.startedAt)}</span>
              <Chip tone={JOB_STATUS_TONE[job.status] ?? 'neutral'}>{t(JOB_STATUS_LABEL[job.status] ?? 'jobStatusRunning')}</Chip>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

export function Storage({ t, go, placeholderMode = false }) {
  const api = useApi('/api/storage', { refreshMs: 60_000 })
  // Admin sees job history through /api/backup; a DataLake-User gets 403 there,
  // which is the correct answer and simply leaves the table empty.
  const backupApi = useApi('/api/backup', { refreshMs: 60_000 })
  const now = useNow(30_000)
  const d = placeholderMode ? {} : (api.data ?? {})
  const fetchError = visibleFetchError(api.error, placeholderMode)
  const history = placeholderMode ? [] : (backupApi.data?.history ?? [])

  return (
    <div className="flex flex-col gap-5">
      {api.loading && <Card className="p-5"><SkeletonLoader type="table" /></Card>}
      {fetchError && <Card><ErrorState t={t} kind={fetchError} onRetry={api.retry} /></Card>}
      {d.maintenance?.active && (
        <p role="status" className="text-[12.5px] rounded-[10px] px-3 py-2 leading-relaxed" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
          {t('backupMaintenanceActive', { until: stamp(d.maintenance.leaseUntil) })}
        </p>
      )}
      <CapacityCard
        t={t}
        capacityBytes={d.capacityBytes}
        usage={d.usage}
        unaccountedBytes={d.unaccountedBytes}
      />

      <DiskHealthCard t={t} disk={d.diskHealth} now={now} />

      <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
        <Card className="p-5">
          <CardTitle>{t('raidStatus')}</CardTitle>
          <div className="flex items-start gap-3">
            <Database size={16} strokeWidth={1.5} className="text-ink-3 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              {/* RAID ยังไม่ได้ตั้งค่า — ไม่มี array ใน deployment นี้ และไม่มีการเดาเปอร์เซ็นต์ */}
              <NotYetImplemented label={t('notConnected')}>{t('raidWhy')}</NotYetImplemented>
            </div>
          </div>
        </Card>

        <BackupCard t={t} backup={d.backup} history={history} go={go} now={now} />
      </div>
    </div>
  )
}
