import { Activity, Database, HardDrive, Usb } from 'lucide-react'
import { Card, CardTitle, Chip } from './ui.jsx'
import { fmtBytes, fmtRelative } from '../lib/format.js'

const STATUS_TONE = {
  HEALTHY: 'ok',
  DEGRADED: 'warn',
  RECOVERING: 'accent',
  RESYNCING: 'accent',
  REBUILDING: 'accent',
  FAILED: 'danger',
  CRITICAL: 'danger',
  UNKNOWN: 'neutral',
  NOT_CONFIGURED: 'neutral',
}

const STATUS_LABEL = {
  HEALTHY: 'raidStatusHealthy',
  DEGRADED: 'raidStatusDegraded',
  RECOVERING: 'raidStatusRecovering',
  RESYNCING: 'raidStatusRecovering',
  REBUILDING: 'raidStatusRecovering',
  FAILED: 'raidStatusFailed',
  CRITICAL: 'raidStatusFailed',
  UNKNOWN: 'raidStatusUnknown',
  NOT_CONFIGURED: 'raidStatusNotConfigured',
}

const MEMBER_TONE = {
  ACTIVE: 'ok',
  HEALTHY: 'ok',
  SPARE: 'neutral',
  REBUILDING: 'accent',
  RECOVERING: 'accent',
  MISSING: 'danger',
  FAILED: 'danger',
  REMOVED: 'danger',
  UNKNOWN: 'neutral',
}

const MEMBER_LABEL = {
  ACTIVE: 'raidMemberActive',
  HEALTHY: 'raidMemberActive',
  SPARE: 'raidMemberSpare',
  REBUILDING: 'raidMemberRebuilding',
  RECOVERING: 'raidMemberRebuilding',
  MISSING: 'raidMemberMissing',
  FAILED: 'raidMemberFailed',
  REMOVED: 'raidMemberMissing',
  UNKNOWN: 'raidMemberUnknown',
}

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)

const maybeBytes = (value) => {
  const n = finite(value)
  return n === null ? null : fmtBytes(n)
}

const maybeMs = (value) => {
  const n = finite(value)
  return n === null ? null : `${n.toFixed(n >= 10 ? 1 : 2)} ms`
}

function Fact({ label, children, mono = false }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className={`truncate text-[12.5px] text-ink ${mono ? 'font-mono' : ''}`}>{children}</dd>
    </div>
  )
}

function LinkRail() {
  return (
    <div aria-hidden className="flex items-center justify-center max-md:h-8">
      <div className="h-px w-full bg-line max-md:h-full max-md:w-px" />
    </div>
  )
}

function MemberSlot({ t, member, slot }) {
  if (!member) {
    return (
      <div className="min-h-[170px] rounded-[14px] border border-dashed border-line bg-card-sunken/40 p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-2">
            <Usb size={16} strokeWidth={1.6} className="text-ink-3" />
            {t('raidMemberSlot', { n: slot })}
          </span>
          <Chip tone="neutral">{t('raidMemberWaiting')}</Chip>
        </div>
        <div className="flex min-h-[95px] flex-col items-center justify-center rounded-[10px] border border-dashed border-line px-4 text-center">
          <HardDrive size={22} strokeWidth={1.4} className="mb-2 text-ink-3" />
          <p className="text-[12.5px] font-medium text-ink-2">{t('raidMemberWaiting')}</p>
          <p className="mt-1 max-w-[28ch] text-[11.5px] leading-relaxed text-ink-3">{t('raidMemberWaitingHint')}</p>
        </div>
      </div>
    )
  }

  const state = String(member.state ?? (member.connected === false ? 'MISSING' : 'UNKNOWN')).toUpperCase()
  const readLatency = maybeMs(member.readLatencyMs ?? member.latency?.readMs)
  const writeLatency = maybeMs(member.writeLatencyMs ?? member.latency?.writeMs)
  const ioErrors = finite(member.ioErrors ?? member.errors?.io)

  return (
    <div className="min-h-[170px] rounded-[14px] border border-line bg-card-sunken p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
            <Usb size={16} strokeWidth={1.6} className="shrink-0 text-accent-ink" />
            <span className="truncate">{member.label ?? member.model ?? t('raidMemberSlot', { n: slot })}</span>
          </p>
          {member.model && member.label && <p className="mt-0.5 truncate text-[11.5px] text-ink-3">{member.model}</p>}
        </div>
        <Chip tone={MEMBER_TONE[state] ?? 'neutral'}>{t(MEMBER_LABEL[state] ?? 'raidMemberUnknown')}</Chip>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Fact label={t('raidMemberDevice')} mono>{member.device ?? '—'}</Fact>
        <Fact label={t('raidMemberCapacity')} mono>{maybeBytes(member.capacityBytes) ?? '—'}</Fact>
        <Fact label={t('raidMemberTransport')}>{member.transport ?? 'USB'}</Fact>
        <Fact label={t('raidMemberTemperature')} mono>
          {finite(member.temperatureCelsius) === null ? t('raidNotMeasured') : `${finite(member.temperatureCelsius)} °C`}
        </Fact>
        <Fact label={t('raidMemberReadLatency')} mono>{readLatency ?? t('raidNotMeasured')}</Fact>
        <Fact label={t('raidMemberWriteLatency')} mono>{writeLatency ?? t('raidNotMeasured')}</Fact>
        <Fact label={t('raidMemberIoErrors')} mono>{ioErrors === null ? t('raidNotMeasured') : ioErrors.toLocaleString()}</Fact>
        <Fact label={t('raidMemberRole')}>{member.role ?? '—'}</Fact>
      </dl>
    </div>
  )
}

function ArrayNode({ t, raid }) {
  const status = String(raid?.status ?? 'UNKNOWN').toUpperCase()
  const totalMembers = finite(raid?.totalMembers ?? raid?.membersTotal ?? raid?.memberCount)
  const activeMembers = finite(raid?.activeMembers ?? raid?.membersActive)
  const membersText = totalMembers === null
    ? '—'
    : `${activeMembers === null ? '?' : activeMembers}/${totalMembers}`

  return (
    <div className="rounded-[16px] border border-line bg-card p-4 text-center shadow-[var(--elev-1)]">
      <div className="mx-auto mb-3 grid size-11 place-items-center rounded-[13px] border border-line bg-card-sunken text-accent-ink">
        <Database size={21} strokeWidth={1.5} />
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{t('raidArray')}</p>
      <p className="mt-1 text-[16px] font-semibold text-ink">
        {raid?.level ? String(raid.level).toUpperCase() : t('raidStatusNotConfigured')}
      </p>
      <div className="mt-3 flex justify-center">
        <Chip tone={STATUS_TONE[status] ?? 'neutral'}>{t(STATUS_LABEL[status] ?? 'raidStatusUnknown')}</Chip>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-left">
        <Fact label={t('raidArrayDevice')} mono>{raid?.device ?? raid?.arrayDevice ?? '—'}</Fact>
        <Fact label={t('raidMembers')} mono>{membersText}</Fact>
        <Fact label={t('raidUsableCapacity')} mono>{maybeBytes(raid?.usableBytes) ?? '—'}</Fact>
        <Fact label={t('raidMount')} mono>{raid?.mountPoint ?? '—'}</Fact>
      </dl>
    </div>
  )
}

function SyncPanel({ t, raid }) {
  const sync = raid?.sync
  const pct = finite(sync?.progressPercent ?? sync?.percent)
  const speed = maybeBytes(sync?.speedBytesPerSec)
  const eta = finite(sync?.etaSeconds)
  const hasSync = sync && (sync.active === true || pct !== null || sync.action)

  if (!hasSync) return null

  return (
    <div className="mt-4 rounded-[12px] border border-line bg-card-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          <Activity size={15} strokeWidth={1.6} className="text-accent-ink" />
          {t('raidSync')}
        </p>
        <span className="font-mono text-[12px] text-ink-2">{pct === null ? t('raidNotMeasured') : `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`}</span>
      </div>
      {pct !== null && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.max(0, Math.min(100, pct))}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-3 max-sm:grid-cols-1">
        <Fact label={t('raidSyncAction')}>{sync?.action ?? t('raidStatusRecovering')}</Fact>
        <Fact label={t('raidSyncSpeed')} mono>{speed ? `${speed}/s` : t('raidNotMeasured')}</Fact>
        <Fact label={t('raidSyncEta')} mono>{eta === null ? t('raidNotMeasured') : `${Math.max(0, Math.round(eta / 60))} min`}</Fact>
      </dl>
    </div>
  )
}

/**
 * Presentation-only RAID surface.
 *
 * Today /api/storage returns NOT_CONFIGURED. This component deliberately does
 * not infer devices from browser state and does not create arrays. When a
 * future host collector supplies validated raid fields, the same surface can
 * render the array and member evidence without changing its truth model.
 */
export function RaidStatusCard({ t, raid, now = Date.now() }) {
  const status = String(raid?.status ?? 'UNKNOWN').toUpperCase()
  const available = raid?.available === true
  const members = Array.isArray(raid?.members) ? raid.members : []
  const primaryMembers = members.slice(0, 2)
  const extraMembers = members.slice(2)

  return (
    <Card className="p-5">
      <CardTitle
        sub={available ? t('raidTelemetryMeasured') : t('raidTelemetryStandby')}
        right={<Chip tone={STATUS_TONE[status] ?? 'neutral'}>{t(STATUS_LABEL[status] ?? 'raidStatusUnknown')}</Chip>}
      >
        {t('raidStatus')}
      </CardTitle>

      {!available && (
        <div className="mb-4 rounded-[12px] border border-line bg-card-sunken px-3.5 py-3">
          <p className="text-[12.5px] font-semibold text-ink">{t('raidTelemetryStandby')}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{t('raidWhy')}</p>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_32px_minmax(180px,0.72fr)_32px_minmax(0,1fr)] items-center gap-0 max-md:grid-cols-1">
        <MemberSlot t={t} member={primaryMembers[0]} slot={1} />
        <LinkRail />
        <ArrayNode t={t} raid={raid} />
        <LinkRail />
        <MemberSlot t={t} member={primaryMembers[1]} slot={2} />
      </div>

      {extraMembers.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{t('raidAdditionalMembers')}</p>
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            {extraMembers.map((member, index) => (
              <MemberSlot key={member.id ?? member.device ?? index} t={t} member={member} slot={index + 3} />
            ))}
          </div>
        </div>
      )}

      <SyncPanel t={t} raid={raid} />

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 max-md:grid-cols-1">
        <Fact label={t('raidArrayState')}>{raid?.arrayState ?? raid?.state ?? t('raidNotMeasured')}</Fact>
        <Fact label={t('raidLevel')}>{raid?.level ? String(raid.level).toUpperCase() : t('raidNotMeasured')}</Fact>
        <Fact label={t('raidMeasured')}>
          {raid?.measuredAt ? fmtRelative(t, Date.parse(raid.measuredAt), now) : t('raidNotMeasured')}
        </Fact>
      </div>

      {!available && (
        <p className="mt-4 text-[12px] leading-relaxed text-ink-3">{t('raidRequirement')}</p>
      )}
    </Card>
  )
}
