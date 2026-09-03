import { Activity, Cable, Cpu, LockKeyhole, Radio, ShieldCheck } from 'lucide-react'
import { Card, CardTitle, Chip, Dot, ErrorState, SkeletonLoader } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'

const LOCALES = { en: 'en-US', th: 'th-TH', zh: 'zh-CN' }

function toneFor(status) {
  if (!status.available || !status.fresh) return 'neutral'
  if (status.state === 'FAILED' || status.state === 'LOCKDOWN') return 'danger'
  if (status.state === 'DEGRADED' || status.state.startsWith('WAIT_')) return 'warn'
  return status.state === 'RUNNING' ? 'ok' : 'neutral'
}

function StatusRow({ icon: Icon, label, value, tone = 'neutral' }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-line last:border-b-0">
      <dt className="flex items-center gap-3 min-w-0">
        <span className="size-9 rounded-[var(--r-tile)] bg-sunken text-ink-2 flex items-center justify-center shrink-0">
          <Icon size={17} strokeWidth={1.5} aria-hidden />
        </span>
        <span className="text-[13px] font-medium text-ink-2">{label}</span>
      </dt>
      <dd className="shrink-0"><Chip tone={tone} mono>{value}</Chip></dd>
    </div>
  )
}

export function Security({ t, lang }) {
  const api = useApi('/api/security/status', { refreshMs: 5_000 })

  if (api.loading) return <SkeletonLoader type="generic" />
  if (api.error) return <ErrorState t={t} kind={api.error} onRetry={api.retry} />

  const status = api.data?.idea3
  if (!status) return <ErrorState t={t} kind="server" onRetry={api.retry} />

  const tone = toneFor(status)
  const state = status.fresh ? status.state : 'UNKNOWN'
  const timestamp = status.updatedAt
    ? new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.en, {
        dateStyle: 'medium', timeStyle: 'medium',
      }).format(new Date(status.updatedAt))
    : t('securityUnavailable')

  return (
    <section aria-labelledby="security-overview-title" className="space-y-6" aria-live="polite">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="max-w-[70ch]">
          <p id="security-overview-title" className="text-[15px] font-semibold text-ink">
            {t('securityOverview')}
          </p>
          <p className="mt-1 text-[13px] text-ink-2">{t('securitySubtitle')}</p>
        </div>
        <Chip tone="accent" mono>
          <LockKeyhole size={13} strokeWidth={1.7} aria-hidden />
          {t('securityReadOnly')}
        </Chip>
      </div>

      {!status.available || !status.fresh ? (
        <div className="rounded-[var(--r-tile)] bg-sunken p-5 flex gap-4 hatch hatch-ink3" role="status">
          <Radio size={22} strokeWidth={1.5} className="text-ink-2 shrink-0 mt-0.5" aria-hidden />
          <div className="max-w-[70ch]">
            <h2 className="text-[15px] font-semibold text-ink">{t('securityUnavailable')}</h2>
            <p className="mt-1 text-[13px] text-ink-2">{t('securityUnavailableBody')}</p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-5">
        <Card className="p-6">
          <CardTitle
            sub={t('securityRuntimeSub')}
            right={<Chip tone={tone} mono><Dot tone={tone} pulse={tone === 'ok'} />{state}</Chip>}
          >
            {t('securityRuntime')}
          </CardTitle>
          <dl>
            <StatusRow icon={Activity} label={t('securityState')} value={state} tone={tone} />
            <StatusRow icon={ShieldCheck} label={t('securityMode')} value={status.armed} tone={status.armed === 'ARMED' ? 'warn' : 'neutral'} />
            <StatusRow icon={Cpu} label={t('securityProfile')} value={status.profile} />
            <StatusRow icon={LockKeyhole} label={t('securityExecution')} value={status.dryRun === true ? 'DRY RUN' : status.dryRun === false ? 'LIVE' : 'UNKNOWN'} tone={status.dryRun === true ? 'accent' : status.dryRun === false ? 'warn' : 'neutral'} />
          </dl>
        </Card>

        <Card className="p-6">
          <CardTitle sub={t('securityConnectivitySub')}>{t('securityConnectivity')}</CardTitle>
          <dl>
            <StatusRow icon={Radio} label={t('securityBroker')} value={status.broker} tone={status.broker === 'CONNECTED' ? 'ok' : 'neutral'} />
            <StatusRow icon={Cpu} label={t('securityDevice')} value={status.device} tone={status.device === 'ONLINE' ? 'ok' : 'neutral'} />
            <StatusRow icon={Cable} label={t('securityUplink')} value={status.uplink} tone={status.uplink === 'LOCKDOWN' ? 'danger' : status.uplink === 'NORMAL' ? 'ok' : 'neutral'} />
          </dl>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex items-start gap-4">
          <span className="size-10 rounded-[var(--r-tile)] bg-accent-soft flex items-center justify-center shrink-0">
            <ShieldCheck size={19} strokeWidth={1.5} aria-hidden />
          </span>
          <div className="max-w-[75ch]">
            <h2 className="text-[15px] font-semibold text-ink">{t('securityHardwarePending')}</h2>
            <p className="mt-1 text-[13px] text-ink-2">{t('securityHardwarePendingBody')}</p>
            <p className="mt-3 text-[12px] font-mono text-ink-3">
              {t('securityLastUpdate')}: {timestamp}
            </p>
          </div>
        </div>
      </Card>
    </section>
  )
}
