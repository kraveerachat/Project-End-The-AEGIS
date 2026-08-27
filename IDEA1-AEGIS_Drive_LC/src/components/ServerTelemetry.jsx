import {
  Activity, Cpu, Gauge, HardDrive, MemoryStick, Network, RadioTower,
} from 'lucide-react'
import { Card, CardTitle, Chip } from './ui.jsx'
import { fmtBytes, fmtCountdown } from '../lib/format.js'

// Renders the /api/telemetry contract (see server/telemetry/index.js).
//
// The one rule this component exists to keep: a metric that could not be
// measured says so. It never renders 0 — a fabricated zero is indistinguishable
// from a real idle reading, and the whole point of measuring is to be able to
// tell those apart. Every value below is therefore read through `number()`,
// which treats a missing field as "no data" rather than as a falsy zero.
//
// Stale is a third state, distinct from both available and unavailable: the
// host data is real but old, so it stays on screen with a label instead of
// being blanked (which would lose information) or shown as current (a lie).

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
  stale: { labelKey: 'telemetryStateStale', tone: 'warn' },
  warning: { labelKey: 'telemetryStateWarning', tone: 'warn' },
  critical: { labelKey: 'telemetryStateCritical', tone: 'danger' },
  restricted: { labelKey: 'telemetryStateRestricted', tone: 'neutral' },
  unavailable: { labelKey: 'telemetryStateUnavailable', tone: 'neutral' },
}

/**
 * The three ways a tile can carry no number. They are three different facts,
 * and collapsing them is exactly the blur this component exists to prevent:
 *
 *   loading      not asked yet — no claim about the source is possible at all
 *   restricted   measured, and deliberately not shown to this role
 *   unavailable  asked, and the source could not answer
 *
 * `loading` has no body copy: the chip already says it, and any sentence here
 * would be a statement about a source nothing has queried yet.
 *
 * `restricted` is currently unreachable from /api/telemetry: since the
 * 2026-08-27 visibility decision the server sends every authenticated user the
 * same approved host metrics and emits no `requires-admin` reason at all. The
 * branch is kept anyway, because it is generic — it renders whatever the
 * response says. Deleting it would mean that the day any metric is withheld
 * again, the screen would call an authorization outcome a measurement failure,
 * which is the one thing this component must never do.
 */
const EMPTY_COPY = {
  loading: null,
  restricted: 'telemetryRestricted',
  unavailable: 'telemetryNoSource',
}

const number = (value) => typeof value === 'number' && Number.isFinite(value)
const bytes = (value) => (number(value) ? fmtBytes(value) : null)
const rate = (value) => (number(value) ? `${fmtBytes(value)}/s` : null)
/** Seconds since boot/start, reusing the app's existing duration formatter. */
const duration = (seconds) => (number(seconds) ? fmtCountdown(seconds * 1000) : null)

/**
 * Tile state, derived from the metric itself.
 *
 * Thresholds are applied only to a metric that reported a real percentage, so
 * an unavailable tile can never be coloured as if it were healthy.
 *
 * `loading` applies only where there is nothing to replace: a refresh in flight
 * over a metric that already has a value leaves that value on screen, because
 * blanking a real reading to announce that a newer one is coming loses
 * information for no gain.
 */
function metricState(id, metric, loading = false) {
  if (!metric) return loading ? 'loading' : 'unavailable'
  if (metric.available !== true) {
    // Reason-driven, not role-driven: this component never asks who is looking.
    // It reports what the response reported. See EMPTY_COPY on why the
    // restricted branch survives a policy that no longer produces it.
    return metric.reason === 'requires-admin' ? 'restricted' : 'unavailable'
  }
  if (metric.stale === true) return 'stale'
  const value = id === 'uptime' ? null : metric.percent
  if (!number(value)) return 'available'
  if (value >= 90) return 'critical'
  if (value >= 75) return 'warning'
  return 'available'
}

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

/** "3.2 GB / 8.0 GB", or the no-data label when either half is missing. */
function UsedOfTotal({ t, used, total }) {
  const usedLabel = bytes(used)
  const totalLabel = bytes(total)
  return <span>{usedLabel && totalLabel ? `${usedLabel} / ${totalLabel}` : t('telemetryValueUnavailable')}</span>
}

/** One labelled sub-reading, e.g. "Host 11d 0h". */
function Labelled({ t, label, value }) {
  return <span>{`${label} ${value ?? t('telemetryValueUnavailable')}`}</span>
}

function MetricRows({ t, id, metric }) {
  if (id === 'cpu') {
    return (
      <>
        <MiniGauge value={metric.percent} label={t('telemetryUsage')} />
        <span>{number(metric.windowSeconds) ? `${metric.windowSeconds}s` : t('telemetryValueUnavailable')}</span>
      </>
    )
  }

  if (id === 'memory') {
    return (
      <>
        <MiniGauge value={metric.percent} label={t('telemetryUsage')} />
        <UsedOfTotal t={t} used={metric.usedBytes} total={metric.totalBytes} />
      </>
    )
  }

  if (id === 'disk') {
    return (
      <>
        <MiniGauge value={metric.percent} label={t('telemetryUsage')} />
        <UsedOfTotal t={t} used={metric.usedBytes} total={metric.totalBytes} />
        {/* SMART/RAID need raw device access this container does not have, so
            physical drive health stays explicitly unknown rather than green. */}
        <Labelled t={t} label={t('telemetryDiskHealth')} value={null} />
      </>
    )
  }

  if (id === 'network') {
    return (
      <>
        <span>{`↓ ${rate(metric.rxBytesPerSec) ?? t('telemetryValueUnavailable')}`}</span>
        <span>{`↑ ${rate(metric.txBytesPerSec) ?? t('telemetryValueUnavailable')}`}</span>
        <span>{metric.interface || t('telemetryValueUnavailable')}</span>
      </>
    )
  }

  if (id === 'twingate') {
    // Never reached in V1: Twingate has no approved source, so it always takes
    // the unavailable branch. Kept explicit so a future source cannot land here
    // with nothing to display.
    return <span>{t('telemetryValueUnavailable')}</span>
  }

  // Uptime carries two independent facts. The host may be unknown while Drive
  // always knows its own process age — they must never become one number.
  return (
    <>
      <Labelled
        t={t}
        label={t('telemetryUptimeHost')}
        value={metric.host?.available === true ? duration(metric.host.seconds) : null}
      />
      <Labelled
        t={t}
        label={t('telemetryUptimeService')}
        value={metric.service?.available === true ? duration(metric.service.seconds) : null}
      />
    </>
  )
}

function TelemetryTile({ t, definition, value, loading }) {
  const metric = value && typeof value === 'object' ? value : {}
  const state = metricState(definition.id, value, loading)
  const meta = STATE_META[state]
  const Icon = definition.icon
  // A tile with no reading to render. The hatch marks a source that failed;
  // loading and restricted are not failures and are not hatched.
  const emptyKey = EMPTY_COPY[state]
  const isEmpty = state in EMPTY_COPY

  return (
    <article
      className={`min-w-0 rounded-[var(--r-tile)] border border-line bg-card p-4 ${state === 'unavailable' ? 'hatch hatch-ink3' : ''}`}
      aria-label={`${t(definition.labelKey)} · ${t(meta.labelKey)}`}
      aria-busy={state === 'loading' ? 'true' : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span className="size-8 rounded-[9px] bg-sunken grid place-items-center text-ink-2">
          <Icon size={15} strokeWidth={1.5} aria-hidden />
        </span>
        <h3 className="text-[13px] font-semibold text-ink">{t(definition.labelKey)}</h3>
        <Chip tone={meta.tone} className="ml-auto">{t(meta.labelKey)}</Chip>
      </div>
      {isEmpty ? (
        <p className="mt-4 text-[12.5px] text-ink-2 leading-relaxed max-w-[32ch]">
          {emptyKey ? t(emptyKey) : ' '}
        </p>
      ) : (
        <div
          className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-2 font-mono"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          <MetricRows t={t} id={definition.id} metric={metric} />
        </div>
      )}
    </article>
  )
}

/**
 * @param {object} props
 * @param {object|null} props.data a full /api/telemetry response, or null when
 *   there is nothing to show.
 * @param {boolean} [props.loading] true while the first request for this screen
 *   is still in flight. It only changes tiles that have no value yet: "not
 *   asked" and "asked and failed" are different facts, and a tile must not
 *   accuse a source that has not been queried. A refresh over data already on
 *   screen leaves that data visible.
 */
export function ServerTelemetry({ t, data, loading = false }) {
  const metrics = data?.metrics ?? null
  return (
    <Card className="p-5">
      <CardTitle sub={t('serverTelemetrySub')}>{t('serverTelemetry')}</CardTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {METRICS.map((definition) => (
          <TelemetryTile
            key={definition.id}
            t={t}
            definition={definition}
            value={metrics?.[definition.id]}
            loading={loading}
          />
        ))}
      </div>
    </Card>
  )
}
