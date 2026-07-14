import { useEffect, useState } from 'react'
import { HardDrive, Thermometer, Activity, Clock } from 'lucide-react'
import { Card, CardTitle, Chip, Th, Segmented } from '../components/ui.jsx'
import { useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtCountdown, fmtRelative } from '../lib/format.js'
import { BREAKDOWN, DISKS, BACKUP_JOBS } from '../lib/data.js'

/* ── Capacity — big stacked bar; Free is hatched: nothing is there ── */
function CapacityCard({ t }) {
  const total = BREAKDOWN.reduce((s, b) => s + b.gb, 0)
  return (
    <Card className="p-5">
      <CardTitle>{t('capacity')}</CardTitle>
      <div className="flex items-center gap-0.5 h-10" aria-hidden>
        {BREAKDOWN.map((seg, i) => (
          <div
            key={seg.key}
            className={`h-9 ${seg.color === 'hatch' ? 'hatch hatch-ink3 border border-line' : ''} ${i === 0 ? 'rounded-l-full' : ''} ${i === BREAKDOWN.length - 1 ? 'rounded-r-full' : ''}`}
            style={{ width: `${(seg.gb / total) * 100}%`, backgroundColor: seg.color === 'hatch' ? 'var(--card-sunken)' : seg.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 mt-4">
        {BREAKDOWN.map((seg) => (
          <span key={seg.key} className="flex items-center gap-2 text-[13px]">
            <span
              className={`size-3 rounded-[4px] ${seg.color === 'hatch' ? 'hatch hatch-ink3 border border-line' : ''}`}
              style={{ backgroundColor: seg.color === 'hatch' ? 'var(--card-sunken)' : seg.color }}
              aria-hidden
            />
            <span className="font-medium text-ink-2">{t(seg.key)}</span>
            <span className="text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{seg.gb} GB</span>
          </span>
        ))}
      </div>
    </Card>
  )
}

/* ── One disk panel ─────────────────────────────────────────────── */
function DiskPanel({ t, disk, failed, rebuildPct }) {
  const isRebuilding = rebuildPct != null && rebuildPct < 100
  const dead = failed && !isRebuilding
  return (
    <div className="relative flex-1 min-w-[220px] rounded-[var(--r-tile)] border p-4 overflow-hidden transition-colors duration-[var(--dur-base)]"
      style={{ borderColor: 'var(--line)', background: 'var(--card)' }}>
      {/* rebuild fill — rises bottom → top in solid blue */}
      {isRebuilding && (
        <div aria-hidden className="absolute inset-x-0 bottom-0 transition-[height] duration-300"
          style={{ height: `${rebuildPct}%`, background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }} />
      )}
      {/* failure veil — the data is no longer present */}
      <div
        aria-hidden
        className="absolute inset-0 hatch hatch-ink3 bg-sunken/80 pointer-events-none transition-[clip-path] duration-500"
        style={{
          clipPath: dead ? 'inset(0 0 0 0)' : isRebuilding ? `inset(0 0 ${rebuildPct}% 0)` : 'inset(0 0 100% 0)',
          transitionTimingFunction: 'var(--ease)',
        }}
      />
      <div className="relative" style={{ filter: dead ? 'saturate(0)' : 'none', opacity: dead ? 0.6 : 1 }}>
        <div className="flex items-center gap-2.5">
          <div className="size-8 rounded-[9px] bg-sunken flex items-center justify-center">
            <HardDrive size={15} strokeWidth={1.5} className="text-ink-2" />
          </div>
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-ink truncate">{disk.model}</p>
            <p className="font-mono text-[10.5px] text-ink-3 truncate">{disk.serial}</p>
          </div>
          {dead && <Chip tone="danger" className="ml-auto">{t('diskFailed')}</Chip>}
          {isRebuilding && <Chip tone="accent" className="ml-auto" mono>{rebuildPct}%</Chip>}
        </div>
        {/* capacity bar — hollow when the disk is gone */}
        <div className="mt-3.5 h-2 rounded-full overflow-hidden" style={{ background: 'var(--line)', outline: dead ? '1px dashed var(--ink-3)' : 'none' }}>
          <div className="h-full rounded-full transition-[width] duration-[var(--dur-slow)]"
            style={{ width: dead ? '0%' : `${(disk.usedTB / disk.capacityTB) * 100}%`, background: 'var(--accent)' }} />
        </div>
        <p className="text-[11.5px] text-ink-3 mt-1.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {dead ? '—' : `${disk.usedTB} TB`} / {disk.capacityTB} TB
        </p>
        <div className="grid grid-cols-3 gap-2 mt-3 text-[11.5px]">
          <span className="flex items-center gap-1.5 text-ink-2" title={t('temperature')}>
            <Thermometer size={12} strokeWidth={1.5} className="text-ink-3" />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{dead ? '—' : `${disk.temp}°C`}</span>
          </span>
          <span className="flex items-center gap-1.5 text-ink-2" title={t('smart')}>
            <Activity size={12} strokeWidth={1.5} className="text-ink-3" />
            {dead ? '—' : disk.smart}
          </span>
          <span className="flex items-center gap-1.5 text-ink-2" title={t('powerOn')}>
            <Clock size={12} strokeWidth={1.5} className="text-ink-3" />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{disk.hours.toLocaleString('en-US')} {t('hours')}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── RAID 1 mirror ──────────────────────────────────────────────── */
function RaidCard({ t }) {
  const reduced = useReducedMotion()
  const [state, setState] = useState('healthy') // healthy | degraded | rebuilding
  const [rebuildPct, setRebuildPct] = useState(null)

  useEffect(() => {
    if (state !== 'rebuilding') {
      setRebuildPct(null)
      return
    }
    let raf
    const total = reduced ? 1 : 9000
    const t0 = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / total)
      setRebuildPct(Math.round(p * 100))
      if (p < 1) raf = requestAnimationFrame(tick)
      else setState('healthy') // rebuild completes → mirror restored
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state, reduced])

  const chip = state === 'healthy'
    ? <Chip tone="ok"><span className="size-1.5 rounded-full bg-current" /> {t('synced')}</Chip>
    : state === 'degraded'
      ? <Chip tone="danger">{t('degraded')}</Chip>
      : <Chip tone="accent">{t('rebuilding')} · {rebuildPct ?? 0}%</Chip>

  return (
    <Card className="p-5">
      <CardTitle right={chip}>{t('raidTitle')}</CardTitle>

      <div className="mb-4">
        <Segmented
          ariaLabel={t('demoForce')}
          options={[
            { value: 'healthy', label: t('synced') },
            { value: 'degraded', label: t('degraded') },
            { value: 'rebuilding', label: t('rebuilding') },
          ]}
          value={state}
          onChange={setState}
        />
      </div>

      <div className="flex items-stretch gap-0 max-md:flex-col">
        <div className="flex-1" style={state === 'degraded' ? { outline: '1.5px solid var(--warn)', outlineOffset: 2, borderRadius: 'var(--r-tile)' } : {}}>
          <DiskPanel t={t} disk={DISKS[0]} failed={false} rebuildPct={null} />
          {state === 'degraded' && (
            <p className="mt-2 text-center"><Chip tone="warn">{t('unprotected')}</Chip></p>
          )}
        </div>

        {/* the mirror link between the disks */}
        <div className="flex items-center justify-center px-2 max-md:py-2 max-md:rotate-90 shrink-0 w-16 max-md:w-auto max-md:h-10" aria-hidden>
          <svg width="48" height="24" viewBox="0 0 48 24">
            {state === 'healthy' && (
              <g className={reduced ? '' : 'dot-pulse'} style={{ transformOrigin: 'center' }}>
                <path d="M6 9h30l-4 -4M42 15h-30l4 4" fill="none" stroke="var(--ok)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )}
            {state === 'degraded' && (
              <g>
                <line x1="4" y1="12" x2="18" y2="12" stroke="var(--danger)" strokeWidth="1.8" strokeDasharray="3 4" strokeLinecap="round" />
                <line x1="30" y1="12" x2="44" y2="12" stroke="var(--danger)" strokeWidth="1.8" strokeDasharray="3 4" strokeLinecap="round" />
                <path d="M22 7l4 10M26 7l-4 10" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" />
              </g>
            )}
            {state === 'rebuilding' && (
              <line x1="4" y1="12" x2="44" y2="12" stroke="var(--accent)" strokeWidth="2" strokeDasharray="5 5" strokeLinecap="round">
                {!reduced && <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.8s" repeatCount="indefinite" />}
              </line>
            )}
          </svg>
        </div>

        <div className="flex-1">
          <DiskPanel t={t} disk={DISKS[1]} failed={state !== 'healthy'} rebuildPct={state === 'rebuilding' ? rebuildPct : null} />
        </div>
      </div>
    </Card>
  )
}

/* ── Backup schedule ────────────────────────────────────────────── */
function BackupCard({ t }) {
  const now = useNow(1000)
  const freqLabel = { hourly: t('everyHour'), daily: t('daily'), weekly: t('days7') }
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-[16px] font-semibold text-ink">{t('backupSchedule')}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line bg-sunken">
              <Th className="pl-5">{t('colJob')}</Th>
              <Th>{t('colTarget')}</Th>
              <Th>{t('colFrequency')}</Th>
              <Th>{t('colLastRun')}</Th>
              <Th>{t('colStatus')}</Th>
              <Th>{t('colNextRun')}</Th>
            </tr>
          </thead>
          <tbody>
            {BACKUP_JOBS.map((job) => (
              <tr key={job.id} className="border-b border-line last:border-b-0 hover:bg-sunken transition-colors duration-[var(--dur-fast)]" style={{ height: 'var(--row-h)' }}>
                <td className="px-4 pl-5 text-[13.5px] font-medium text-ink whitespace-nowrap">{job.job}</td>
                <td className="px-4 font-mono text-[12px] text-ink-2 whitespace-nowrap">{job.target}</td>
                <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{freqLabel[job.freq]}</td>
                <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{fmtRelative(t, job.lastRun, now)}</td>
                <td className="px-4"><Chip tone="ok">{t('resOk')}</Chip></td>
                <td className="px-4 font-mono text-[12.5px] text-ink whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmtCountdown(job.nextRun - now, t('expired'))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function Storage({ t }) {
  return (
    <div className="flex flex-col gap-5">
      <CapacityCard t={t} />
      <RaidCard t={t} />
      <BackupCard t={t} />
    </div>
  )
}
