import { fmtBytes, fmtCountdown, fmtRelative, fmtStamp } from './format.js'

/*
 * Builders for the compact hover/focus previews (components/HoverPreview.jsx).
 *
 * Rules every builder follows:
 * - Input is an object the screen already holds and already renders. Nothing
 *   here fetches, so a preview can never show more than the user can see.
 * - Fields are picked explicitly — never spread — so a credential, hash or
 *   token that ever appears on an input object still cannot reach the DOM.
 *   (Share rows carry `hasPassword` as a boolean; the password itself never
 *   leaves the server, and even that boolean is only used as an auth label.)
 * - A missing or non-finite value renders the explicit "unavailable" copy,
 *   never 0: an invented zero reads exactly like a real idle reading.
 */

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const unavailable = (t) => t('telemetryValueUnavailable')

/* Scope chip per stored share scope. `public` must exist on its own: a
   fallback to `any` would label an Internet link as AEGIS-reachable. */
export const SHARE_SCOPE_CHIP = {
  zones: { key: 'chipZoneRestricted', tone: 'accent' },
  vlan: { key: 'chipVlanOnly', tone: 'accent' },
  subnet: { key: 'chipSubnet', tone: 'accent' },
  any: { key: 'chipAnyNetwork', tone: 'warn' },
  public: { key: 'chipPublicInternet', tone: 'danger' },
}
export const SHARE_AUTH_LABEL = { password: 'authPassword', otc: 'authOtc', none: 'authNone' }

export const shareScopeChip = (scope) => SHARE_SCOPE_CHIP[scope] ?? SHARE_SCOPE_CHIP.any

export function sharePreview(t, share, now) {
  if (!share) return null
  const chip = shareScopeChip(share.scope)
  const msLeft = finite(share.expiresAt) ? share.expiresAt - now : null
  return {
    kind: 'share',
    eyebrow: t('previewShare'),
    title: String(share.fileName ?? ''),
    status: { tone: chip.tone, label: t(chip.key) },
    rows: [
      { label: t('previewAuth'), value: t(SHARE_AUTH_LABEL[share.authType] ?? 'authNone') },
      {
        label: t('previewExpires'),
        value: msLeft == null ? unavailable(t) : msLeft > 0 ? fmtCountdown(msLeft, t('expired')) : t('expired'),
        mono: true,
      },
      { label: t('previewHits'), value: finite(share.hits) ? String(share.hits) : unavailable(t), mono: true },
    ],
  }
}

export function loginPreview(t, event, now) {
  if (!event) return null
  const at = new Date(event.at).getTime()
  const ok = event.result === 'OK'
  const ip = event.source_ip ?? event.sourceIp
  return {
    kind: 'login',
    eyebrow: t('previewSignIn'),
    title: finite(at) ? fmtStamp(at) : unavailable(t),
    status: { tone: ok ? 'ok' : 'danger', label: ok ? t('resOk') : t('resDenied') },
    rows: [
      { label: t('previewWhen'), value: finite(at) ? fmtRelative(t, at, now) : unavailable(t) },
      { label: t('previewSourceIp'), value: ip ? String(ip) : unavailable(t), mono: true },
    ],
  }
}

/* Type comes from the name the row already prints — the recent-files payload
   carries no MIME type or size, and neither is guessed here. */
export function fileTypeLabel(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ''))
  return match ? match[1].toUpperCase() : null
}

export function recentFilePreview(t, file, now) {
  if (!file) return null
  const type = fileTypeLabel(file.name)
  const modified = finite(file.modified) ? file.modified : new Date(file.modified).getTime()
  return {
    kind: 'file',
    eyebrow: t('previewFile'),
    title: String(file.name ?? ''),
    rows: [
      { label: t('previewType'), value: type ?? unavailable(t), mono: Boolean(type) },
      ...(finite(file.size) ? [{ label: t('previewSize'), value: fmtBytes(file.size), mono: true }] : []),
      { label: t('previewModified'), value: finite(modified) ? `${fmtRelative(t, modified, now)} · ${fmtStamp(modified)}` : unavailable(t) },
    ],
  }
}

export function lakePreview(t, { name, tech, state, stateLabel, tone, latencyMs }) {
  return {
    kind: 'lake',
    eyebrow: t('lakeHealth'),
    title: name,
    status: { tone, label: stateLabel },
    rows: [
      { label: t('previewBackend'), value: tech },
      { label: t('previewLatency'), value: finite(latencyMs) ? `${latencyMs.toFixed(1)} ms` : t('latencyUnavailable'), mono: finite(latencyMs) },
      ...(state === 'healthy' ? [] : [{ label: t('previewState'), value: stateLabel }]),
    ],
  }
}

export function storageCategoryPreview(t, { key, bytes, accounted }) {
  if (!finite(bytes)) return null
  const pct = finite(accounted) && accounted > 0 ? (bytes / accounted) * 100 : null
  return {
    kind: 'storage',
    eyebrow: t('storageBreakdown'),
    title: t(key),
    rows: [
      { label: t('previewSize'), value: fmtBytes(bytes), mono: true },
      { label: t('storageCategoryShare'), value: pct != null ? `${pct.toFixed(1)}%` : unavailable(t), mono: pct != null },
    ],
  }
}

export function capacityPreview(t, { usedBytes, totalBytes }) {
  if (!finite(usedBytes) || !finite(totalBytes) || totalBytes <= 0) return null
  const pct = Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100))
  return {
    kind: 'capacity',
    eyebrow: t('statStorage'),
    title: `${pct.toFixed(1)}% ${t('capacityUsed')}`,
    rows: [
      { label: t('capacityUsed'), value: fmtBytes(usedBytes), mono: true },
      { label: t('free'), value: fmtBytes(Math.max(0, totalBytes - usedBytes)), mono: true },
      { label: t('capacityTotal'), value: fmtBytes(totalBytes), mono: true },
    ],
  }
}

export function securityPreview(t, { count, unavailable: missing = false }) {
  return {
    kind: 'security',
    eyebrow: t('previewSecurity'),
    title: t('statSecurity'),
    status: missing
      ? { tone: 'neutral', label: unavailable(t) }
      : count > 0 ? { tone: 'danger', label: `${count}` } : { tone: 'ok', label: t('allClear') },
    rows: [
      { label: t('previewWindow'), value: t('previewSecurityWindow') },
    ],
  }
}

const rate = (value) => (finite(value) ? `${fmtBytes(value)}/s` : null)
const duration = (seconds) => (finite(seconds) ? fmtCountdown(seconds * 1000) : null)

/**
 * Telemetry tile preview. `stateLabel`/`tone` come from the tile's own state
 * derivation so the preview can never disagree with the chip beside it.
 */
export function telemetryPreview(t, { id, label, metric, stateLabel, tone }) {
  const m = metric && typeof metric === 'object' ? metric : {}
  const na = unavailable(t)
  const rows = []
  if (m.available === true) {
    if (id === 'cpu') {
      rows.push({ label: t('telemetryUsage'), value: finite(m.percent) ? `${Math.round(m.percent)}%` : na, mono: true })
      rows.push({ label: t('previewSampleWindow'), value: finite(m.windowSeconds) ? `${m.windowSeconds}s` : na, mono: true })
    } else if (id === 'memory' || id === 'disk') {
      rows.push({ label: t('telemetryUsage'), value: finite(m.percent) ? `${Math.round(m.percent)}%` : na, mono: true })
      rows.push({
        label: t('previewUsedOfTotal'),
        value: finite(m.usedBytes) && finite(m.totalBytes) ? `${fmtBytes(m.usedBytes)} / ${fmtBytes(m.totalBytes)}` : na,
        mono: true,
      })
      if (id === 'disk') rows.push({ label: t('telemetryDiskHealth'), value: na })
    } else if (id === 'network') {
      rows.push({ label: t('previewReceive'), value: rate(m.rxBytesPerSec) ?? na, mono: true })
      rows.push({ label: t('previewSend'), value: rate(m.txBytesPerSec) ?? na, mono: true })
      rows.push({ label: t('previewInterface'), value: m.interface ? String(m.interface) : na, mono: Boolean(m.interface) })
    } else if (id === 'temperature') {
      rows.push({ label: t('telemetryTemperature'), value: finite(m.celsius) ? `${m.celsius} °C` : na, mono: true })
      rows.push({ label: t('previewSensor'), value: m.sensor ? String(m.sensor) : na, mono: Boolean(m.sensor) })
    } else if (id === 'uptime') {
      rows.push({ label: t('telemetryUptimeHost'), value: (m.host?.available === true && duration(m.host.seconds)) || na, mono: true })
      rows.push({ label: t('telemetryUptimeService'), value: (m.service?.available === true && duration(m.service.seconds)) || na, mono: true })
    }
  }
  return {
    kind: 'telemetry',
    eyebrow: t('serverTelemetry'),
    title: label,
    status: { tone, label: stateLabel },
    rows,
  }
}
