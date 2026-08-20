import {
  Activity, Cpu, Gauge, HardDrive, MemoryStick, Network, RadioTower,
} from 'lucide-react'
import { Card, CardTitle, Chip } from './ui.jsx'
import { fmtBytes } from '../lib/format.js'

const METRICS = [
  { id: 'cpu', labelKey: 'telemetryCpu', icon: Cpu },
  { id: 'memory', labelKey: 'telemetryRam', icon: MemoryStick },
  { id: 'disk', labelKey: 'telemetryDisk', icon: HardDrive },
  { id: 'network', labelKey: 'telemetryNetwork', icon: Network },
  { id: 'twingate', labelKey: 'telemetryTwingate', icon: RadioTower },
  { id: 'uptime', labelKey: 'telemetryUptime', icon: Activity },
]

const STATE_META = {
  loading: { labelKey: 'telemetryStateLoading', tone: 'neutral' },
  available: { labelKey: 'telemetryStateNormal', tone: 'ok' },
  warning: { labelKey: 'telemetryStateWarning', tone: 'warn' },
  critical: { labelKey: 'telemetryStateCritical', tone: 'danger' },
  unavailable: { labelKey: 'telemetryStateUnavailable', tone: 'neutral' },
}

const number = (value) => typeof value === 'number' && Number.isFinite(value)
const percent = (value) => number(value) ? `${Math.round(value)}%` : null
const temperature = (value) => number(value) ? `${Math.round(value)} °C` : null
const latency = (value) => number(value) ? `${Math.round(value)} ms` : null
const load = (value) => number(value) ? `Load ${value.toFixed(2)}` : null
const rate = (value) => number(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} Mbps` : null

function MiniGauge({ value, label }) {
  if (!number(value)) return null
  const normalized = Math.min(100, Math.max(0, value))
  return (
    <div className="flex items-center gap-2.5" aria-label={`${label} ${Math.round(normalized)}%`}>
      <span className="relative size-9 rounded-full grid place-items-center bg-sunken" aria-hidden>
        <span
          className="absolute inset-0 rounded-full"
          style={{ background: `conic-gradient(var(--accent) ${normalized}%, var(--line) 0)` }}
        />
        <span className="absolute inset-[4px] rounded-full bg-card" />
        <Gauge size={13} strokeWidth={1.6} className="relative text-ink-3" />
      </span>
      <strong className="font-mono text-[20px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(normalized)}%
      </strong>
    </div>
  )
}

function MetricRows({ t, id, metric }) {
  if (id === 'cpu') {
    return (
      <>
        <MiniGauge value={metric.usagePercent} label={t('telemetryUsage')} />
        <span>{temperature(metric.temperatureC) ?? t('telemetryValueUnavailable')}</span>
        <span>{load(metric.load) ?? t('telemetryValueUnavailable')}</span>
      </>
    )
  }
  if (id === 'memory') {
    const used = number(metric.usedBytes) ? fmtBytes(metric.usedBytes) : null
    const total = number(metric.totalBytes) ? fmtBytes(metric.totalBytes) : null
    return (
      <>
        <MiniGauge value={metric.usagePercent} label={t('telemetryUsage')} />
        <span>{used && total ? `${used} / ${total}` : t('telemetryValueUnavailable')}</span>
      </>
    )
  }
  if (id === 'disk') {
    const used = number(metric.usedBytes) ? fmtBytes(metric.usedBytes) : null
    const total = number(metric.totalBytes) ? fmtBytes(metric.totalBytes) : null
    return (
      <>
        <MiniGauge value={metric.usagePercent} label={t('telemetryUsage')} />
        <span>{used && total ? `${used} / ${total}` : t('telemetryValueUnavailable')}</span>
        <span>{metric.health || t('telemetryValueUnavailable')}</span>
      </>
    )
  }
  if (id === 'network') {
    return (
      <>
        <span>↓ {rate(metric.rxMbps) ?? t('telemetryValueUnavailable')}</span>
        <span>↑ {rate(metric.txMbps) ?? t('telemetryValueUnavailable')}</span>
        <span>{latency(metric.latencyMs) ?? t('telemetryValueUnavailable')}</span>
      </>
    )
  }
  if (id === 'twingate') {
    return (
      <>
        <span>{metric.connectorStatus || t('telemetryValueUnavailable')}</span>
        <span>{metric.reachability || t('telemetryValueUnavailable')}</span>
        <span>{latency(metric.latencyMs) ?? t('telemetryValueUnavailable')}</span>
      </>
    )
  }
  return (
    <>
      <span>{metric.hostLabel || t('telemetryValueUnavailable')}</span>
      <span>{metric.applicationLabel || t('telemetryValueUnavailable')}</span>
    </>
  )
}

function TelemetryTile({ t, definition, value }) {
  const metric = value && typeof value === 'object' ? value : {}
  const state = STATE_META[metric.state] ? metric.state : 'unavailable'
  const meta = STATE_META[state]
  const Icon = definition.icon
  const unavailable = state === 'unavailable'
  const loading = state === 'loading'

  return (
    <article
      className={`min-w-0 rounded-[var(--r-tile)] border border-line bg-card p-4 ${unavailable ? 'hatch hatch-ink3' : ''}`}
      aria-label={`${t(definition.labelKey)} · ${t(meta.labelKey)}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="size-8 rounded-[9px] bg-sunken grid place-items-center text-ink-2">
          <Icon size={15} strokeWidth={1.5} aria-hidden />
        </span>
        <h3 className="text-[13px] font-semibold text-ink">{t(definition.labelKey)}</h3>
        <Chip tone={meta.tone} className="ml-auto">{t(meta.labelKey)}</Chip>
      </div>
      {loading ? (
        <div className="mt-4 flex flex-col gap-2 animate-pulse" aria-busy="true">
          <span className="h-5 w-2/3 skeleton" />
          <span className="h-3 w-1/2 skeleton" />
        </div>
      ) : unavailable ? (
        <p className="mt-4 text-[12.5px] text-ink-2 leading-relaxed max-w-[32ch]">
          {t('telemetryNoSource')}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-2 font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <MetricRows t={t} id={definition.id} metric={metric} />
        </div>
      )}
    </article>
  )
}

export function ServerTelemetry({ t, data }) {
  return (
    <Card className="p-5">
      <CardTitle sub={t('serverTelemetrySub')}>{t('serverTelemetry')}</CardTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {METRICS.map((definition) => (
          <TelemetryTile key={definition.id} t={t} definition={definition} value={data?.[definition.id]} />
        ))}
      </div>
    </Card>
  )
}
