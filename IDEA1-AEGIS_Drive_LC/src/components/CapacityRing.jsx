import { useMemo, useState } from 'react'
import { Card, CardTitle, NotYetImplemented } from './ui.jsx'
import { fmtBytes } from '../lib/format.js'

/* Two concentric rings, two explicitly different denominators.

   Outer: the whole filesystem volume. AEGIS-used + other used on this volume + free.
   Inner: AEGIS-used bytes only. Earlier versions + other files + vault + documents +
          archives + media.

   A positive segment always receives the ring's full band width and its exact angular
   share. There is deliberately no minimum angle, rounded cap, or thin-tick fallback:
   all three would make a very small value look larger than it is. The legend carries
   exact bytes and a truthful `<0.1%` label when the arc is sub-pixel. */

const AEGIS_SEGMENTS = [
  { key: 'versions', color: 'var(--capacity-versions)' },
  { key: 'other', color: 'var(--capacity-other-files)' },
  { key: 'vaultSeg', color: 'var(--capacity-vault)' },
  { key: 'docs', color: 'var(--capacity-documents)' },
  { key: 'archives', color: 'var(--capacity-archives)' },
  { key: 'media', color: 'var(--capacity-media)' },
]

const CHART = { size: 360, cx: 180, cy: 180, outerR: 132, innerR: 92, band: 30 }
const ROW_GRID = 'grid grid-cols-[14px_minmax(0,1fr)_auto_62px] items-center gap-x-3'

function ringRows(parts, base) {
  let cursor = 0
  return parts.map((part) => {
    const frac = base > 0 && part.bytes > 0 ? part.bytes / base : 0
    const row = { ...part, frac, startFrac: cursor }
    cursor += frac
    return row
  })
}

function Segment({ row, ring, radius, band, active }) {
  if (row.frac <= 0) return null
  const circumference = 2 * Math.PI * radius
  const length = row.frac * circumference
  const dimmed = Boolean(active) && row.id !== active
  return (
    <circle
      data-capacity-ring={ring}
      data-capacity-segment={row.id}
      cx={CHART.cx}
      cy={CHART.cy}
      r={radius}
      fill="none"
      stroke={row.color}
      strokeWidth={band}
      strokeLinecap="butt"
      strokeDasharray={`${length} ${Math.max(0, circumference - length)}`}
      strokeDashoffset={-row.startFrac * circumference}
      style={{
        opacity: dimmed ? 0.3 : 1,
        transition: 'opacity var(--dur-fast) var(--ease)',
      }}
    />
  )
}

function Swatch({ row, empty }) {
  return (
    <span
      aria-hidden
      className="size-3 rounded-[4px] border border-line"
      style={{ backgroundColor: row.color, opacity: empty ? 0.42 : 1 }}
    />
  )
}

function LegendHead({ title, total, t, shareLabel }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <p className="text-[12px] font-semibold text-ink">{title}</p>
        <p className="text-[11.5px] text-ink-3 font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>{total}</p>
      </div>
      <div className={`${ROW_GRID} px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3`} aria-hidden>
        <span />
        <span>{t('capacityLegendCategory')}</span>
        <span className="text-right">{t('capacityLegendSize')}</span>
        <span className="text-right">{shareLabel}</span>
      </div>
    </>
  )
}

function LegendRows({ rows, active, setActive, amount, share, shareLabel }) {
  return (
    <ul className="flex flex-col border-t border-line">
      {rows.map((row) => {
        const empty = row.bytes <= 0
        const cells = (
          <>
            <span className="grid place-items-center"><Swatch row={row} empty={empty} /></span>
            <span className={`truncate text-left text-[13px] font-medium ${empty ? 'text-ink-3' : 'text-ink-2'}`}>{row.label}</span>
            <span className={`text-right text-[13px] font-mono ${empty ? 'text-ink-3' : 'text-ink'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{amount(row.bytes)}</span>
            <span className="text-right text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{share(row.bytes)}</span>
          </>
        )
        if (empty) return <li key={row.id} className={`${ROW_GRID} min-h-9 px-2 py-1.5`}>{cells}</li>
        return (
          <li key={row.id}>
            <button
              type="button"
              aria-pressed={active === row.id}
              aria-label={`${row.label}: ${amount(row.bytes)}, ${share(row.bytes)} ${shareLabel}${row.hint ? `. ${row.hint}` : ''}`}
              title={row.hint}
              onMouseEnter={() => setActive(row.id)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(row.id)}
              onBlur={() => setActive(null)}
              onClick={() => setActive((current) => (current === row.id ? null : row.id))}
              className={`${ROW_GRID} min-h-11 w-full px-2 py-1.5 rounded-[8px] cursor-pointer transition-colors duration-[var(--dur-fast)] hover:bg-sunken focus-visible:bg-sunken ${active === row.id ? 'bg-sunken' : ''}`}
            >
              {cells}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function CapacityCard({ t, capacityBytes, usage, unaccountedBytes }) {
  const [active, setActive] = useState(null)
  const total = capacityBytes?.totalBytes ?? 0
  const free = capacityBytes?.freeBytes ?? 0
  const used = capacityBytes?.usedBytes ?? 0
  const otherOnVolume = Math.max(0, unaccountedBytes ?? 0)

  const model = useMemo(() => {
    const aegis = AEGIS_SEGMENTS.map((segment) => ({
      id: segment.key,
      label: t(segment.key),
      color: segment.color,
      bytes: Math.max(0, usage?.[segment.key] ?? 0),
    }))
    const aegisTotal = aegis.reduce((sum, row) => sum + row.bytes, 0)
    const volume = [
      { id: 'aegis', label: t('capacityAegisData'), hint: t('capacityAegisHint'), color: 'var(--capacity-aegis)', bytes: aegisTotal },
      { id: 'unaccounted', label: t('unaccounted'), hint: t('unaccountedHint'), color: 'var(--capacity-volume-other)', bytes: otherOnVolume },
      { id: 'free', label: t('free'), color: 'var(--capacity-volume-free)', bytes: free },
    ]
    return {
      aegisTotal,
      volume: ringRows(volume, total),
      aegis: ringRows(aegis, aegisTotal),
    }
  }, [free, otherOnVolume, t, total, usage])

  const pct = (bytes, base) => {
    if (base <= 0 || bytes <= 0) return '0%'
    const value = (bytes / base) * 100
    return value < 0.1 ? t('capacityTinyShare') : `${value.toFixed(1)}%`
  }
  const amount = (bytes) => (bytes <= 0 ? t('storageZeroGb') : fmtBytes(bytes))
  const shareOfVolume = (bytes) => pct(bytes, total)
  const shareOfAegis = (bytes) => pct(bytes, model.aegisTotal)
  const usedPct = total > 0 ? ((used / total) * 100).toFixed(1) : '0.0'
  const activeRow = [...model.volume, ...model.aegis].find((row) => row.id === active) ?? null
  const activeShare = activeRow
    ? (model.volume.includes(activeRow) ? shareOfVolume(activeRow.bytes) : shareOfAegis(activeRow.bytes))
    : null

  if (!capacityBytes || total <= 0) {
    return (
      <Card className="p-5">
        <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>
        <NotYetImplemented label={t('notAvailable')}>{t('capacityUnreadable')}</NotYetImplemented>
      </Card>
    )
  }

  const accessibleLabel = `${t('capacityRingLabel', { used: fmtBytes(used), total: fmtBytes(total), free: amount(free), pct: usedPct })}. ${t('capacityAegisRingLabel', { total: amount(model.aegisTotal), n: String(model.aegis.filter((row) => row.bytes > 0).length) })}`

  return (
    <Card className="p-5">
      <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>

      <div className="capacity-dual-layout grid grid-cols-[minmax(280px,0.9fr)_minmax(320px,1.1fr)] gap-8 items-center max-lg:grid-cols-1">
        <div className="w-full max-w-[420px] mx-auto">
          <svg viewBox={`0 0 ${CHART.size} ${CHART.size}`} className="w-full h-auto" role="img" aria-label={accessibleLabel}>
            <g transform={`rotate(-90 ${CHART.cx} ${CHART.cy})`}>
              <circle cx={CHART.cx} cy={CHART.cy} r={CHART.outerR} fill="none" stroke="var(--capacity-rail)" strokeWidth={CHART.band} />
              {model.volume.map((row) => <Segment key={row.id} row={row} ring="volume" radius={CHART.outerR} band={CHART.band} active={active} />)}
              <circle cx={CHART.cx} cy={CHART.cy} r={CHART.innerR} fill="none" stroke="var(--capacity-rail)" strokeWidth={CHART.band} />
              {model.aegis.map((row) => <Segment key={row.id} row={row} ring="aegis" radius={CHART.innerR} band={CHART.band} active={active} />)}
            </g>

            {activeRow ? (
              <g aria-hidden>
                <text x={CHART.cx} y={CHART.cy - 13} textAnchor="middle" className="fill-ink" style={{ fontSize: '12px', fontWeight: 600 }}>{activeRow.label}</text>
                <text x={CHART.cx} y={CHART.cy + 9} textAnchor="middle" className="fill-ink" style={{ fontSize: '17px', fontVariantNumeric: 'tabular-nums' }}>{amount(activeRow.bytes)}</text>
                <text x={CHART.cx} y={CHART.cy + 27} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>{activeShare}</text>
              </g>
            ) : (
              <g aria-hidden>
                <text x={CHART.cx} y={CHART.cy + 3} textAnchor="middle" className="fill-ink" style={{ fontSize: '31px', fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{usedPct}%</text>
                <text x={CHART.cx} y={CHART.cy + 24} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '10.5px', fontWeight: 650, letterSpacing: '0.08em' }}>{t('capacityUsed').toUpperCase()}</text>
              </g>
            )}
          </svg>

          <div className="grid grid-cols-2 gap-2 mt-1" aria-hidden>
            <div className="rounded-[var(--r-tile)] border border-line bg-sunken px-3 py-2">
              <span className="block text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{t('capacityVolumeGroup')}</span>
              <span className="block text-[12px] text-ink-2 mt-0.5">{amount(total)}</span>
            </div>
            <div className="rounded-[var(--r-tile)] border border-line bg-sunken px-3 py-2">
              <span className="block text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{t('capacityAegisGroup')}</span>
              <span className="block text-[12px] text-ink-2 mt-0.5">{amount(model.aegisTotal)}</span>
            </div>
          </div>
        </div>

        <div className="min-w-0 grid grid-cols-1 gap-5">
          <div>
            <LegendHead title={t('capacityVolumeGroup')} total={amount(total)} t={t} shareLabel={t('capacityLegendShare')} />
            <LegendRows rows={model.volume} active={active} setActive={setActive} amount={amount} share={shareOfVolume} shareLabel={t('capacityLegendShare')} />
          </div>
          <div>
            <LegendHead title={t('capacityAegisGroup')} total={amount(model.aegisTotal)} t={t} shareLabel={t('capacityShareOfAegis')} />
            <LegendRows rows={model.aegis} active={active} setActive={setActive} amount={amount} share={shareOfAegis} shareLabel={t('capacityShareOfAegis')} />
            <p className="text-[11.5px] text-ink-3 leading-relaxed mt-2 px-2">
              {model.aegisTotal > 0 ? t('capacityAegisBase', { total: amount(model.aegisTotal) }) : t('capacityAegisEmpty')}
            </p>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-4 gap-x-6 gap-y-4 mt-6 pt-5 border-t border-line max-md:grid-cols-2">
        {[
          [t('capacityTotal'), amount(total)],
          [t('capacityUsed'), amount(used)],
          [t('free'), amount(free)],
          [t('capacityUsedPct'), `${usedPct}%`],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</dt>
            <dd className="text-[16px] font-mono text-ink mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
