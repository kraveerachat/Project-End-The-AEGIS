import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Cell,
} from 'recharts'
import {
  Database, Files as FilesIcon, Users, ShieldCheck, ArrowUpRight, ArrowDownRight,
  FlaskConical, Upload, Download, Link2, LogIn, Camera, ShieldAlert, KeyRound,
} from 'lucide-react'
import { Card, CardTitle, Chip, Dot, Sparkline, IconBtn, Segmented } from '../components/ui.jsx'
import { useCountUp, useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtRelative } from '../lib/format.js'
import { ACTIVITY, TRANSFER_7D, BREAKDOWN, SPARK } from '../lib/data.js'

/* ── Stat card — hero number counts, sparkline bleeds to the corners ── */
function StatCard({ icon: Icon, label, value, suffix, decimals = 0, delta, deltaUp, spark, alarm = false, allClearLabel, delay = 0 }) {
  const v = useCountUp(value, 700, decimals)
  const display = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString('en-US')
  return (
    <Card
      className={`relative overflow-hidden p-5 pb-10 rise-in ${alarm ? 'border-pulse' : ''}`}
      style={{
        animationDelay: `${delay}ms`,
        ...(alarm ? { background: 'var(--danger-soft)', borderColor: 'var(--danger)' } : {}),
      }}
    >
      <div className="flex items-start justify-between">
        <div className="size-8 rounded-[9px] bg-sunken flex items-center justify-center">
          <Icon size={16} strokeWidth={1.5} className="text-ink-2" />
        </div>
        {delta != null ? (
          <Chip tone={deltaUp ? 'ok' : 'danger'}>
            {deltaUp ? <ArrowUpRight size={12} strokeWidth={2} /> : <ArrowDownRight size={12} strokeWidth={2} />}
            {delta}
          </Chip>
        ) : (
          <Chip tone={alarm ? 'danger' : 'ok'}>{alarm ? `▲ ${value}` : allClearLabel}</Chip>
        )}
      </div>
      <p className="text-[13px] font-medium text-ink-3 mt-3">{label}</p>
      <p
        className="text-[34px] font-semibold tracking-[-0.01em] leading-tight mt-0.5"
        style={{ fontVariantNumeric: 'tabular-nums', color: alarm ? 'var(--danger)' : value === 0 && allClearLabel ? 'var(--ok)' : 'var(--ink)' }}
      >
        {display}
        {suffix && <span className="text-[17px] font-medium text-ink-3 ml-1.5">{suffix}</span>}
      </p>
      <div className="absolute bottom-0 left-0 right-0 h-7 opacity-90">
        <Sparkline data={spark} color={alarm ? 'var(--danger)' : 'var(--accent)'} width={200} height={28} fill className="w-full h-full" />
      </div>
    </Card>
  )
}

/* ── Data Lake Health — three tiers resting on one another ─────────── */
const TIERS = [
  { id: 'app', nameKey: 'tierApp', tech: 'NGINX', spark: SPARK.nginx, baseLat: 12 },
  { id: 'meta', nameKey: 'tierMeta', tech: 'PostgreSQL', spark: SPARK.postgres, baseLat: 4 },
  { id: 'fs', nameKey: 'tierStorage', tech: 'Linux FS / HDD', spark: SPARK.fs, baseLat: 2 },
]

function LakeHealth({ t, tierStates, setTierStates }) {
  const [demoOpen, setDemoOpen] = useState(false)
  // A tier "rests on" every tier below it: if anything beneath is unwell,
  // the tiers above desaturate and settle down 2px — dependency made visible.
  const brokenBelow = (idx) => TIERS.some((tier, i) => i > idx && tierStates[tier.id] !== 'healthy')

  return (
    <Card className="p-5 rise-in" style={{ animationDelay: '160ms' }}>
      <CardTitle
        sub={t('lakeSubtitle')}
        right={
          <IconBtn label={t('demoControls')} onClick={() => setDemoOpen((v) => !v)} className={demoOpen ? 'bg-sunken text-ink' : ''}>
            <FlaskConical size={15} strokeWidth={1.5} />
          </IconBtn>
        }
      >
        {t('lakeHealth')}
      </CardTitle>

      {demoOpen && (
        <div className="mb-4 p-3 rounded-[var(--r-tile)] bg-sunken border border-line flex flex-col gap-2 fade-in">
          {TIERS.map((tier) => (
            <div key={tier.id} className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-3">{t(tier.nameKey)}</span>
              <Segmented
                ariaLabel={`${t('demoForce')} ${tier.tech}`}
                options={[
                  { value: 'healthy', label: t('tierHealthy') },
                  { value: 'degraded', label: t('tierDegraded') },
                  { value: 'down', label: t('tierDown') },
                ]}
                value={tierStates[tier.id]}
                onChange={(v) => setTierStates((s) => ({ ...s, [tier.id]: v }))}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col">
        {TIERS.map((tier, idx) => {
          const state = tierStates[tier.id]
          const dimmed = state === 'healthy' && brokenBelow(idx)
          const tone = state === 'healthy' ? 'ok' : state === 'degraded' ? 'warn' : 'danger'
          const lat = state === 'healthy' ? tier.baseLat : state === 'degraded' ? tier.baseLat * 14 : null
          return (
            <div key={tier.id}>
              {idx > 0 && (
                <div className="flex justify-center h-3" aria-hidden>
                  <div
                    className="w-px h-full"
                    style={
                      brokenBelow(idx - 1) || tierStates[TIERS[idx - 1].id] !== 'healthy'
                        ? { borderLeft: '1px dashed var(--ink-3)' }
                        : { background: 'var(--line)' }
                    }
                  />
                </div>
              )}
              <div
                className="flex items-center gap-3 rounded-[var(--r-tile)] border px-4 h-14 transition-[transform,background-color,border-color,filter] duration-[var(--dur-base)]"
                style={{
                  transform: dimmed ? 'translateY(2px)' : 'translateY(0)',
                  filter: dimmed ? 'saturate(0)' : 'none',
                  opacity: dimmed ? 0.62 : 1,
                  background: state === 'degraded' ? 'var(--warn-soft)' : state === 'down' ? 'var(--danger-soft)' : 'var(--card)',
                  borderColor: state === 'healthy' ? 'var(--line)' : 'transparent',
                  transitionTimingFunction: 'var(--ease)',
                }}
              >
                <Dot tone={tone} pulse={state === 'healthy'} />
                <span className="text-[12.5px] font-semibold tracking-[0.04em] text-ink whitespace-nowrap">{t(tier.nameKey)}</span>
                <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-sm:hidden">{tier.tech}</span>
                <div className="flex-1 min-w-4" />
                <div className="w-24 h-6 max-sm:hidden" style={{ opacity: state === 'down' ? 0.25 : 1 }}>
                  <Sparkline data={tier.spark} color={state === 'healthy' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--danger)'} width={96} height={24} className="w-full h-full" />
                </div>
                <span className="text-[12px] font-medium w-16 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: state === 'healthy' ? 'var(--ink-2)' : tone === 'warn' ? 'var(--warn)' : 'var(--danger)' }}>
                  {lat != null ? `${lat} ms` : '—'}
                </span>
                <Chip tone={tone}>{state === 'healthy' ? t('tierHealthy') : state === 'degraded' ? t('tierDegraded') : t('tierDown')}</Chip>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ── Activity feed ─────────────────────────────────────────────────── */
const ACT_ICONS = { uploaded: Upload, downloaded: Download, 'created share link': Link2, 'share link open': ShieldAlert, 'login attempt': LogIn, 'verified checksum': ShieldCheck, 'snapshot created': Camera, 'vault unlock': KeyRound }

function ActivityFeed({ t }) {
  const now = useNow(30_000)
  return (
    <Card className="p-5 rise-in flex flex-col min-h-0" style={{ animationDelay: '200ms' }}>
      <CardTitle>{t('activity')}</CardTitle>
      <div className="flex flex-col gap-1 overflow-y-auto -mr-2 pr-2 max-h-[300px]">
        {ACTIVITY.map((a) => {
          const bad = a.result === 'blocked' || a.result === 'denied'
          const Icon = ACT_ICONS[a.action] ?? FilesIcon
          return (
            <div
              key={a.id}
              className="flex items-start gap-3 rounded-[10px] px-3 py-2.5"
              style={bad ? { background: 'var(--danger-soft)', borderLeft: '2px solid var(--danger)' } : {}}
            >
              <div className="size-7 rounded-full bg-sunken flex items-center justify-center shrink-0 mt-0.5">
                <Icon size={13} strokeWidth={1.5} style={{ color: bad ? 'var(--danger)' : 'var(--ink-2)' }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink-2 leading-snug">
                  <span className="font-semibold text-ink">{a.actor}</span> {a.action}{' '}
                  <span className="text-ink font-medium break-all">{a.target}</span>
                </p>
                <p className="text-[11.5px] text-ink-3 mt-0.5">{fmtRelative(t, a.time, now)}</p>
              </div>
              <Chip tone={bad ? 'danger' : 'ok'} className="mt-0.5">
                {a.result === 'ok' ? t('resOk') : a.result === 'blocked' ? t('resBlocked') : t('resDenied')}
              </Chip>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ── Storage breakdown — rounded stacked bar, hatch = free ─────────── */
function StorageBreakdown({ t }) {
  const [hovered, setHovered] = useState(null)
  const total = BREAKDOWN.reduce((s, b) => s + b.gb, 0)
  return (
    <Card className="p-5 rise-in" style={{ animationDelay: '240ms' }}>
      <CardTitle>{t('storageBreakdown')}</CardTitle>
      <div className="flex items-end gap-0.5 h-8 mt-1" aria-hidden>
        {BREAKDOWN.map((seg, i) => (
          <div
            key={seg.key}
            className={`h-7 transition-transform duration-[var(--dur-fast)] ${seg.color === 'hatch' ? 'hatch hatch-ink3 border border-line' : ''} ${i === 0 ? 'rounded-l-full' : ''} ${i === BREAKDOWN.length - 1 ? 'rounded-r-full' : ''}`}
            style={{
              width: `${(seg.gb / total) * 100}%`,
              backgroundColor: seg.color === 'hatch' ? 'var(--card-sunken)' : seg.color,
              transform: hovered === seg.key ? 'translateY(-3px)' : 'none',
              transitionTimingFunction: 'var(--ease)',
            }}
          />
        ))}
      </div>
      <div className="mt-4 flex flex-col">
        {BREAKDOWN.map((seg) => (
          <div
            key={seg.key}
            onMouseEnter={() => setHovered(seg.key)}
            onMouseLeave={() => setHovered(null)}
            className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded-[8px] hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-default"
          >
            <span
              className={`size-3 rounded-[4px] shrink-0 ${seg.color === 'hatch' ? 'hatch hatch-ink3 border border-line' : ''}`}
              style={{ backgroundColor: seg.color === 'hatch' ? 'var(--card-sunken)' : seg.color }}
              aria-hidden
            />
            <span className="text-[13px] font-medium text-ink-2">{t(seg.key)}</span>
            <span className="ml-auto text-[13px] text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{seg.gb} GB</span>
            <span className="w-12 text-right text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {((seg.gb / total) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ── Upload / Download — the black/blue signature chart ────────────── */
function ChartTooltip({ active, payload, label, t }) {
  if (!active || !payload?.length) return null
  const projected = payload[0]?.payload?.projected
  return (
    <div className="bg-card border border-line rounded-[var(--r-tile)] px-3.5 py-2.5" style={{ boxShadow: 'var(--elev-2)' }}>
      <p className="text-[12px] font-semibold text-ink mb-1">
        {label}
        {projected && <span className="ml-2 text-[10.5px] font-medium text-ink-3 uppercase tracking-[0.06em]">{t('projected')}</span>}
      </p>
      {payload.map((p) => (
        <p key={p.dataKey} className="text-[12.5px] text-ink-2 flex items-center gap-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span className="size-2 rounded-full" style={{ background: p.dataKey === 'up' ? 'var(--ink)' : 'var(--accent)' }} />
          {p.dataKey === 'up' ? t('uploads') : t('downloads')} · {p.value} GB
        </p>
      ))}
    </div>
  )
}

function TransferChart({ t }) {
  const reduced = useReducedMotion()
  return (
    <Card className="p-5 rise-in" style={{ animationDelay: '280ms' }}>
      <CardTitle
        right={
          <div className="flex items-center gap-3 text-[12px] font-medium text-ink-3">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: 'var(--ink)' }} />{t('uploads')}</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: 'var(--accent)' }} />{t('downloads')}</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] hatch hatch-ink3 border border-line" />{t('projected')}</span>
          </div>
        }
      >
        {t('transferActivity')}
      </CardTitle>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={TRANSFER_7D} barGap={3} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeWidth={1} />
            <XAxis dataKey="day" axisLine={false} tickLine={false} dy={6} />
            <YAxis axisLine={false} tickLine={false} width={38} />
            <RTooltip content={<ChartTooltip t={t} />} cursor={{ fill: 'var(--card-sunken)' }} />
            <Bar dataKey="up" radius={[8, 8, 0, 0]} maxBarSize={18} isAnimationActive={!reduced} animationDuration={600} animationEasing="ease-out">
              {TRANSFER_7D.map((d) => (
                <Cell key={d.day} fill={d.projected ? 'url(#hatch-ink)' : 'var(--ink)'} />
              ))}
            </Bar>
            <Bar dataKey="down" radius={[8, 8, 0, 0]} maxBarSize={18} isAnimationActive={!reduced} animationDuration={600} animationEasing="ease-out">
              {TRANSFER_7D.map((d) => (
                <Cell key={d.day} fill={d.projected ? 'url(#hatch-accent)' : 'var(--accent)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

/* ── The dashboard grid ────────────────────────────────────────────── */
export function Dashboard({ t, metrics }) {
  const [tierStates, setTierStates] = useState({ app: 'healthy', meta: 'healthy', fs: 'healthy' })
  const alerts = useMemo(() => Object.values(tierStates).filter((s) => s !== 'healthy').length, [tierStates])

  return (
    <div className="grid grid-cols-12 gap-6 max-xl:gap-5">
      <div className="col-span-3 max-lg:col-span-6 max-md:col-span-12">
        <StatCard icon={Database} label={t('statStorage')} value={metrics.storageGB} suffix={`GB ${t('of')} 1 TB`} decimals={0} delta="4.1%" deltaUp spark={SPARK.storage} />
      </div>
      <div className="col-span-3 max-lg:col-span-6 max-md:col-span-12">
        <StatCard icon={FilesIcon} label={t('statFiles')} value={metrics.files} delta="12.4%" deltaUp spark={SPARK.files} delay={40} />
      </div>
      <div className="col-span-3 max-lg:col-span-6 max-md:col-span-12">
        <StatCard icon={Users} label={t('statSessions')} value={3} delta="1" deltaUp={false} spark={SPARK.sessions} delay={80} />
      </div>
      <div className="col-span-3 max-lg:col-span-6 max-md:col-span-12">
        <StatCard icon={ShieldCheck} label={t('statAlerts')} value={alerts} spark={SPARK.alerts} alarm={alerts > 0} allClearLabel={t('allClear')} delay={120} />
      </div>

      <div className="col-span-8 max-lg:col-span-12">
        <LakeHealth t={t} tierStates={tierStates} setTierStates={setTierStates} />
      </div>
      <div className="col-span-4 max-lg:col-span-12">
        <ActivityFeed t={t} />
      </div>

      <div className="col-span-6 max-lg:col-span-12">
        <StorageBreakdown t={t} />
      </div>
      <div className="col-span-6 max-lg:col-span-12">
        <TransferChart t={t} />
      </div>
    </div>
  )
}
