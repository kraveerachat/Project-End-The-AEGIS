// src/components/BackupConfiguration.jsx — AEGIS Drive (IDEA1) · Admin backup controls
//
// Everything an Admin can set here is an ID from a list the host backup agent
// publishes: which allowlisted target, which schedule preset, which retention
// preset, and whether the schedule is enabled. There is no path field, no host
// field, no command field, and the two action buttons only ask the agent to
// start a job — the outcome arrives later through job history, never as a
// success animation here.
//
// Every state the agent can be in has an honest rendering: not connected,
// connected but no targets allowlisted, tools missing on the host, a target
// on the same physical disk as the data. None of them is dressed up.
import { useEffect, useState } from 'react'
import { Archive, ShieldCheck } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Field, PillSelect, Toggle, ErrorState, SkeletonLoader, NotYetImplemented } from './ui.jsx'
import { useApi } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch } from '../lib/api.js'
import { fmtDateTime } from '../lib/format.js'

export const SCHEDULE_LABEL = {
  'disabled': 'scheduleDisabled',
  'every-6h': 'scheduleEvery6h',
  'daily-02:00': 'scheduleDaily0200',
  'daily-03:30': 'scheduleDaily0330',
  'weekly-sun-03:00': 'scheduleWeeklySun0300',
}
export const RETENTION_LABEL = {
  'keep-7d-4w': 'retentionKeep7d4w',
  'keep-14d-8w-6m': 'retentionKeep14d8w6m',
  'keep-30d-12w-12m': 'retentionKeep30d12w12m',
}
export const PROTECTION_LABEL = {
  OFF_HOST: 'protectionOffHost',
  DIFFERENT_DEVICE: 'protectionDifferentDevice',
  SAME_FAILURE_DOMAIN: 'protectionSameFailureDomain',
  NOT_MOUNTED: 'protectionNotMounted',
  UNKNOWN: 'protectionUnknown',
}
export const PROTECTION_TONE = {
  OFF_HOST: 'ok',
  DIFFERENT_DEVICE: 'ok',
  SAME_FAILURE_DOMAIN: 'danger',
  NOT_MOUNTED: 'warn',
  UNKNOWN: 'neutral',
}

/** Label for an ID: the preset name when known, otherwise the raw ID (never blank). */
export const labelFor = (t, table, id) => (table[id] ? t(table[id]) : String(id))

/** The allowlisted targets with their live failure-domain classification. */
export function BackupTargetList({ t, placeholderMode = false }) {
  const api = useApi('/api/backup', { refreshMs: 60_000 })
  const fetchError = visibleFetchError(api.error, placeholderMode)
  const view = placeholderMode ? null : api.data

  if (api.loading && !view) return <SkeletonLoader />
  if (fetchError) return <ErrorState t={t} kind={fetchError} onRetry={api.retry} />
  if (!view || !view.report?.available) {
    return <NotYetImplemented label={t('notConnected')}>{t('backupAgentUnavailable')}</NotYetImplemented>
  }
  if (view.targets.length === 0) {
    return <NotYetImplemented label={t('notAvailable')}>{t('backupNoTargets')}</NotYetImplemented>
  }
  return (
    <ul className="flex flex-col gap-2" aria-label={t('backupTargets')}>
      {view.targets.map((target) => (
        <li key={target.id} className="flex flex-wrap items-center gap-3 py-2 border-b border-line last:border-b-0">
          <span className="font-medium text-[13px] text-ink">{target.label}</span>
          <span className="font-mono text-[11.5px] text-ink-3">{target.id} · {target.type}</span>
          <Chip tone={PROTECTION_TONE[target.protection] ?? 'neutral'} className="ml-auto">
            {labelFor(t, PROTECTION_LABEL, target.protection)}
          </Chip>
        </li>
      ))}
    </ul>
  )
}

export function BackupConfiguration({ t, placeholderMode = false }) {
  const api = useApi('/api/backup', { refreshMs: 30_000 })
  const fetchError = visibleFetchError(api.error, placeholderMode)
  const view = placeholderMode ? null : api.data
  const report = view?.report ?? null

  const [draft, setDraft] = useState(null)
  const [saveState, setSaveState] = useState(null) // null | 'saving' | 'saved' | 'failed'
  const [command, setCommand] = useState(null)    // { kind: 'ok'|'refused'|'failed', text }

  // Seed the form from the agent's current policy exactly once per load; a
  // later silent refresh must not overwrite what the Admin is editing.
  useEffect(() => {
    if (report?.available && report.policy && draft === null) setDraft({ ...report.policy })
  }, [report, draft])

  const save = async (event) => {
    event.preventDefault()
    if (!draft) return
    setSaveState('saving')
    setCommand(null)
    const { ok } = await apiFetch('/api/backup/policy', { method: 'PATCH', body: draft })
    setSaveState(ok ? 'saved' : 'failed')
    if (ok) api.refresh()
  }

  const run = async (path) => {
    setCommand(null)
    const res = await apiFetch(path, { method: 'POST' })
    if (res.ok) setCommand({ kind: 'ok', text: t('backupRequested', { jobId: String(res.data?.jobId ?? '').slice(0, 8) || '—' }) })
    else if (res.status === 409) setCommand({ kind: 'refused', text: t('backupRefused', { reason: res.data?.reason ?? 'refused' }) })
    else setCommand({ kind: 'failed', text: t('backupAgentUnavailable') })
    api.refresh()
  }

  const selectedTarget = draft?.activeTargetId ? view?.targets.find((x) => x.id === draft.activeTargetId) : null
  const sameDomain = selectedTarget?.protection === 'SAME_FAILURE_DOMAIN'
  const busy = saveState === 'saving' || Boolean(report?.job)

  return (
    <Card className="p-5">
      <CardTitle sub={t('backupConfigSub')}>{t('backupConfigTitle')}</CardTitle>

      {api.loading && !view && <SkeletonLoader />}
      {fetchError && <ErrorState t={t} kind={fetchError} onRetry={api.retry} />}

      {view && !report?.available && (
        <NotYetImplemented label={t('notConnected')}>
          {String(report?.reason ?? '').startsWith('agent-data-invalid') ? t('backupAgentInvalid') : t('backupAgentUnavailable')}
        </NotYetImplemented>
      )}

      {view && report?.available && (
        <form onSubmit={save} className="flex flex-col gap-4">
          {view.tools && (view.tools.resticPresent === false || view.tools.pgDumpPresent === false) && (
            <p role="alert" className="text-[12.5px] rounded-[10px] px-3 py-2 leading-relaxed" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
              {t('backupToolsMissing')}
            </p>
          )}

          <Field id="backup-target" label={t('backupTarget')}>
            {view.targets.length === 0
              ? <p className="text-[12.5px] text-ink-2">{t('backupNoTargets')}</p>
              : (
                <PillSelect
                  id="backup-target"
                  value={draft?.activeTargetId ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, activeTargetId: e.target.value || null }))}
                  disabled={busy}
                >
                  <option value="">{t('backupTargetNone')}</option>
                  {view.targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label} — {labelFor(t, PROTECTION_LABEL, target.protection)}
                    </option>
                  ))}
                </PillSelect>
              )}
          </Field>
          {sameDomain && (
            <p role="alert" className="text-[12.5px] rounded-[10px] px-3 py-2 leading-relaxed" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
              {t('backupSameDomainWhy')}
            </p>
          )}

          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <Field id="backup-schedule" label={t('backupSchedule')}>
              <PillSelect id="backup-schedule" value={draft?.scheduleId ?? 'disabled'} onChange={(e) => setDraft((d) => ({ ...d, scheduleId: e.target.value }))} disabled={busy}>
                {view.allowed.scheduleIds.map((id) => <option key={id} value={id}>{labelFor(t, SCHEDULE_LABEL, id)}</option>)}
              </PillSelect>
            </Field>
            <Field id="backup-retention" label={t('backupRetention')}>
              <PillSelect id="backup-retention" value={draft?.retentionId ?? ''} onChange={(e) => setDraft((d) => ({ ...d, retentionId: e.target.value }))} disabled={busy}>
                {view.allowed.retentionIds.map((id) => <option key={id} value={id}>{labelFor(t, RETENTION_LABEL, id)}</option>)}
              </PillSelect>
            </Field>
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium text-ink-2">{t('backupEnabled')}</span>
            <Toggle on={Boolean(draft?.enabled)} onChange={(on) => setDraft((d) => ({ ...d, enabled: on }))} label={t('backupEnabled')} />
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line">
            <Btn variant="outline" size="sm" type="submit" disabled={busy || !draft}>
              <ShieldCheck size={14} strokeWidth={1.5} />
              {t('backupSave')}
            </Btn>
            <Btn variant="outline" size="sm" type="button" onClick={() => run('/api/backup/run')} disabled={busy || report.state === 'NOT_CONFIGURED'}>
              <Archive size={14} strokeWidth={1.5} />
              {t('backupRunNow')}
            </Btn>
            <Btn variant="outline" size="sm" type="button" onClick={() => run('/api/backup/verify')} disabled={busy || !report.lastSuccessfulBackup}>
              {t('backupVerifyNow')}
            </Btn>
            {saveState === 'saved' && <span role="status" className="text-[12.5px] text-ok">{t('backupSaved')}</span>}
            {saveState === 'failed' && <span role="alert" className="text-[12.5px]" style={{ color: 'var(--danger)' }}>{t('backupSaveFailed')}</span>}
          </div>
          {command && (
            <p role={command.kind === 'ok' ? 'status' : 'alert'} className="text-[12.5px]" style={{ color: command.kind === 'ok' ? 'var(--ink-2)' : 'var(--danger)' }}>
              {command.text}
            </p>
          )}
          {report.job && (
            <p role="status" className="text-[12.5px] text-ink-2">
              {t('jobStatusRunning')} · {report.job.kind === 'verify' ? t('jobVerify') : t('jobBackup')} · {report.job.phase} · {fmtDateTime(Date.parse(report.job.startedAt))}
            </p>
          )}
        </form>
      )}
    </Card>
  )
}
