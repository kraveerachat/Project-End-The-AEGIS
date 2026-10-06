import { useLayoutEffect, useRef } from 'react'
import { gsap } from 'gsap'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Cell,
} from 'recharts'
import {
  Database, Files as FilesIcon, Link2, ShieldCheck, ArrowUpRight, ArrowDownRight,
  LogIn, FileText, Clock,
} from 'lucide-react'
import { Card, CardTitle, Chip, Dot, Reveal, ErrorState, DependencyUnavailableState, SkeletonLoader } from '../components/ui.jsx'
import { ServerTelemetry } from '../components/ServerTelemetry.jsx'
import { useApi, useCountUp, useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtRelative, fmtCountdown, fmtStamp, fmtBytes } from '../lib/format.js'
import { isPlatformWired } from '../lib/fetchState.js'
import { normalizeDashboardData, shouldShowDashboardFetchError } from '../lib/dashboardState.js'
import { useDashboardMotion } from '../lib/useDashboardMotion.js'

/* ทุกตัวเลขบนจอนี้มาจาก /api/dashboard · /api/storage · /healthz และจัดการครบสี่สถานะ
   (loading = skeleton · error = ข้อความ + Retry · empty = บอกตรง ๆ · success = ข้อมูลจริง)

   ⚠️ กราฟกิจกรรมเคยเป็น transfer7d: เจ็ดแถวที่ตั้งค่าไว้เองใน store.js (Tue up:42
   down:118 …) พร้อมธง projected สองแถวท้ายที่วาดเป็นลายขวางว่า "คาดการณ์" — ไม่มีการ
   คาดการณ์ใดเกิดขึ้นและไม่มีตัวเลขใดถูกวัด กราฟที่เด่นที่สุดบนจอแรกจึงนิ่งเท่ากันทุกวัน
   ไม่ว่าระบบจะถูกใช้งานจริงแค่ไหน ตอนนี้นับเหตุการณ์จาก audit_log จริง

   ⚠️ หน่วยเป็น "จำนวนครั้ง" ไม่ใช่ GB โดยเจตนา: audit_log ไม่เก็บขนาดไบต์ต่อเหตุการณ์
   (ตั้งใจเก็บน้อยที่สุดเพื่อความเป็นส่วนตัว) การเดาปริมาณจากขนาดไฟล์ปัจจุบันจะผิดทันที
   ที่ไฟล์ถูกอัปโหลดทับหรือถูกลบ — จอจึงบอกสิ่งที่นับได้จริง ไม่ใช่สิ่งที่ดูน่าประทับใจกว่า */

/* ── Stat card — hero number counts, ค่าจริงจากเซิร์ฟเวอร์ ─────────── */
function StatCard({ icon: Icon, label, value, valueLabel, suffix, decimals = 0, delta, deltaUp, alarm = false, allClearLabel, statusTone = 'ok', delay = 0, footer, meterPercent = null, meterLabel = '' }) {
  const v = useCountUp(value, 700, decimals)
  const display = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString('en-US')
  return (
    <Card
      className={`dashboard-stat-card relative overflow-hidden p-5 rise-in ${meterPercent != null ? 'dashboard-capacity-card' : ''} ${alarm ? 'border-pulse' : ''}`}
      style={{
        animationDelay: `${delay}ms`,
        ...(alarm ? { background: 'var(--danger-soft)', borderColor: 'var(--danger)' } : {}),
      }}
    >
      <div className="flex items-start justify-between">
        <div className="metric-icon flex size-9 items-center justify-center rounded-[10px] bg-accent-soft text-accent-ink">
          <Icon size={17} strokeWidth={1.6} />
        </div>
        {delta != null ? (
          <Chip tone={deltaUp ? 'ok' : 'danger'}>
            {deltaUp ? <ArrowUpRight size={12} strokeWidth={2} /> : <ArrowDownRight size={12} strokeWidth={2} />}
            {delta}
          </Chip>
        ) : allClearLabel ? (
          <Chip tone={alarm ? 'danger' : statusTone}>{alarm ? `▲ ${value}` : allClearLabel}</Chip>
        ) : null}
      </div>
      <p className="mt-3 text-[13px] font-medium text-ink-2">{label}</p>
      {/* lang="en" — DESIGN.md · Cascade traps. This is a tabular-nums stat */}
      <p
        lang="en"
        className="mt-1.5 font-mono text-[28px] font-semibold tracking-[-0.025em] leading-none text-ink"
        style={{ fontVariantNumeric: 'tabular-nums', color: alarm ? 'var(--danger)' : value === 0 && allClearLabel && statusTone === 'ok' ? 'var(--ok)' : undefined }}
      >
        {valueLabel ?? display}
        {suffix && <span className="ml-1.5 text-[15px] font-semibold text-ink-3">{suffix}</span>}
      </p>
      {meterPercent != null && (
        <div className="dashboard-capacity-ring" style={{ '--capacity-pct': `${meterPercent}%` }} role="img" aria-label={`${meterPercent}% ${meterLabel}`}>
          <span lang="en">{meterPercent}%</span>
        </div>
      )}
      {footer && (
        <div className="mt-3 border-t border-line pt-3">
          {footer}
        </div>
      )}
    </Card>
  )
}

function InlineEmptyState({ children, className = '' }) {
  return (
    <p role="status" className={`py-5 text-[13px] text-ink-3 leading-relaxed ${className}`}>
      {children}
    </p>
  )
}

/* ── Data Lake Health — สถานะจาก /healthz เท่านั้น ไม่มี client override ── */
const TIERS = [
  { id: 'application', nameKey: 'tierApp', techKey: 'tierAppTech' },
  { id: 'metadata', nameKey: 'tierMeta', tech: 'PostgreSQL' },
  { id: 'storage', nameKey: 'tierStorage', techKey: 'tierStorageTech' },
]

function LakeHealth({ t, health }) {
  // แต่ละแถวอ่านผล probe ของตัวเองเท่านั้น — missing/unchecked = ยังไม่มีข้อมูล,
  // checked+failed = ล่มจริง ห้ามใช้ health.ok ก้อนเดียวสร้างสีเขียวให้ทั้งสามชั้น
  const tierStates = Object.fromEntries(TIERS.map((tier) => {
    const layer = health?.layers?.[tier.id]
    const state = !layer
      ? (health?.ok === true && health?.db === 'postgres' ? 'unavailable' : 'notConnected')
      : layer.checked !== true
        ? 'notConnected'
      : layer.ok === true ? 'healthy' : 'down'
    return [tier.id, state]
  }))
  const brokenBelow = (idx) => TIERS.some((tier, i) => i > idx && tierStates[tier.id] !== 'healthy')

  return (
    <Card className="lake-health-card dashboard-motion-card p-5 rise-in" style={{ animationDelay: '160ms' }}>
      <CardTitle sub={t('lakeSubtitle')}>{t('lakeHealth')}</CardTitle>

      <div className="flex flex-col">
        {TIERS.map((tier, idx) => {
          const state = tierStates[tier.id]
          const layer = health?.layers?.[tier.id]
          const tech = tier.id === 'metadata' && health?.db === 'memory'
            ? t('metadataMemoryDisconnected')
            : tier.techKey ? t(tier.techKey) : tier.tech
          const dimmed = state === 'healthy' && brokenBelow(idx)
          const tone = state === 'healthy' ? 'ok' : state === 'degraded' ? 'warn' : state === 'down' ? 'danger' : 'neutral'
          const lat = layer?.measured === true && Number.isFinite(layer.latencyMs)
            ? layer.latencyMs
            : null
          return (
            <div key={tier.id}>
              {idx > 0 && (
                <div className="lake-connector flex h-3 justify-center" aria-hidden>
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
                className="lake-health-row flex h-14 items-center gap-3 rounded-[var(--r-tile)] border px-4 transition-[transform,background-color,border-color,filter] duration-[var(--dur-base)]"
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
                <span className="lake-health-name text-[12.5px] font-semibold tracking-[0.04em] text-ink whitespace-nowrap">{t(tier.nameKey)}</span>
                <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-xl:hidden">{tech}</span>
                <div className="flex-1 min-w-4" />
                <span className="lake-health-latency text-[12px] font-medium w-16 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: state === 'healthy' ? 'var(--ink-2)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--ink-3)' }}>
                  {lat != null ? `${lat.toFixed(1)} ms` : t('latencyUnavailable')}
                </span>
                <Chip tone={tone} className="lake-health-state">{state === 'healthy' ? t('tierHealthy') : state === 'degraded' ? t('tierDegraded') : state === 'down' ? t('tierDown') : state === 'unavailable' ? t('latencyUnavailable') : t('notConnected')}</Chip>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ── Login history — personal security status (สเปกของจอ Dashboard) ── */
function LoginHistoryCard({ t, events, unavailable = false }) {
  return (
    <Card className="p-5 rise-in flex flex-col min-h-0" style={{ animationDelay: '200ms' }}>
      <CardTitle sub={t('dashLoginHistorySub')}>{t('dashLoginHistory')}</CardTitle>
      {unavailable ? (
        <DependencyUnavailableState t={t} title={t('dashboardUnavailable')} compact />
      ) : events.length === 0 ? (
        <InlineEmptyState>{t('emptyNoLoginHistory')}</InlineEmptyState>
      ) : (
        <div className="flex flex-col gap-1 overflow-y-auto -mr-2 pr-2 max-h-[300px]">
          {events.map((e, i) => {
            const at = new Date(e.at).getTime()
            const bad = e.result !== 'OK'
            return (
              <div key={i} className="flex items-start gap-3 rounded-[10px] px-3 py-2.5">
                <div className="size-7 rounded-full bg-sunken flex items-center justify-center shrink-0 mt-0.5">
                  <LogIn size={13} strokeWidth={1.5} className={bad ? 'text-danger' : 'text-ink-2'} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink-2 leading-snug flex items-center gap-2">
                    <span className="font-mono text-[12px]">{fmtStamp(at)}</span>
                    <Chip tone={bad ? 'danger' : 'ok'}>{bad ? t('resDenied') : t('resOk')}</Chip>
                  </p>
                  <p className="font-mono text-[11.5px] text-ink-3 mt-0.5">{e.source_ip ?? e.sourceIp ?? '—'}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

/* ── Active share links (สเปกของจอ Dashboard) ────────────────────────── */
function ActiveLinksCard({ t, shares, now, unavailable = false }) {
  return (
    <Card className="p-5 flex flex-col min-h-0" style={{ animationDelay: '250ms' }}>
      <CardTitle>{t('activeLinks')}</CardTitle>
      {unavailable ? (
        <DependencyUnavailableState t={t} title={t('dashboardUnavailable')} compact />
      ) : shares.length === 0 ? (
        <InlineEmptyState>{t('emptyNoShares')}</InlineEmptyState>
      ) : (
        <div className="flex flex-col gap-2.5">
          {shares.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
              <Link2 size={14} strokeWidth={1.5} className="text-ink-3 shrink-0" />
              <span className="block text-[13.5px] font-medium text-ink truncate flex-1 min-w-0">{s.fileName}</span>
              <span className="text-[11.5px] text-ink-3 font-mono shrink-0 flex items-center gap-1.5">
                <Clock size={11} strokeWidth={1.8} />
                {fmtCountdown(s.expiresAt - now, t('expired'))}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ── Storage breakdown — ไบต์จริงจาก /api/storage (hatch = ว่าง) ──────── */
const SEG_COLORS = {
  docs: 'var(--neo-category-docs, var(--accent))', archives: 'var(--neo-category-archives, var(--accent))', media: 'var(--neo-category-media, var(--accent))',
  vaultSeg: 'var(--neo-category-vault, var(--accent))', versions: 'var(--neo-category-versions, var(--accent))', other: 'var(--neo-category-other, var(--accent))',
}

function StorageHero({ t, usedBytes, totalBytes, usage, unavailable, unavailableLabel, storageLoading, storageError, onRetry }) {
  const ringRef = useRef(null)
  const categoriesRef = useRef(null)
  const lastRingPct = useRef(null)
  const categoriesRevealed = useRef(false)
  const reduced = useReducedMotion()
  const capacityKnown = !unavailable && Number.isFinite(usedBytes) && Number.isFinite(totalBytes) && totalBytes > 0
  const usedPct = capacityKnown ? Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100))) : null
  const freeBytes = capacityKnown ? Math.max(0, totalBytes - usedBytes) : null
  // /api/storage is independent of /api/dashboard. A metadata/dashboard
  // outage must not hide a successful storage response or relabel its error.
  const categoriesAvailable = !storageLoading && !storageError && usage != null
  const segs = categoriesAvailable
    ? Object.keys(SEG_COLORS).map((key) => ({ key, bytes: usage?.[key] ?? 0, color: SEG_COLORS[key] })).filter((seg) => seg.bytes > 0)
    : []
  const visibleCategories = categoriesAvailable
    ? segs
    : Object.keys(SEG_COLORS).slice(0, 5).map((key) => ({ key, bytes: null, color: SEG_COLORS[key] }))
  // Category percentage is relative to bytes classified by /api/storage, not
  // the volume capacity. These are different denominators and must stay named.
  const accounted = segs.reduce((sum, seg) => sum + seg.bytes, 0)

  useLayoutEffect(() => {
    if (reduced) return undefined
    const tweens = []
    if (capacityKnown && ringRef.current && lastRingPct.current !== usedPct) {
      tweens.push(gsap.fromTo(ringRef.current,
        { '--capacity-pct': `${lastRingPct.current ?? 0}%` },
        { '--capacity-pct': `${usedPct}%`, duration: 0.72, ease: 'power3.out' }))
      lastRingPct.current = usedPct
    }
    if (categoriesAvailable && categoriesRef.current && !categoriesRevealed.current) {
      tweens.push(gsap.fromTo(categoriesRef.current.querySelectorAll('.dashboard-storage-category-track > span'),
        { scaleX: 0 },
        { scaleX: 1, duration: 0.52, stagger: 0.055, ease: 'power3.out' }))
      categoriesRevealed.current = true
    }
    return () => tweens.forEach((tween) => tween.kill())
  }, [capacityKnown, usedPct, categoriesAvailable, reduced])

  return (
    <Card className="dashboard-storage-hero dashboard-motion-card p-5">
      <div className="dashboard-panel-heading">
        <span className="dashboard-panel-icon"><Database size={19} strokeWidth={1.7} aria-hidden /></span>
        <div className="min-w-0">
          <h2 className="dashboard-panel-title">{t('statStorage')}</h2>
          <p className="dashboard-panel-subtitle">{t('storageBreakdownSub')}</p>
        </div>
        {!capacityKnown && <Chip tone="neutral" className="ml-auto">{unavailable ? unavailableLabel : t('capacityUnreadable')}</Chip>}
      </div>

      <div className="dashboard-storage-hero-body">
        <div className="dashboard-storage-capacity">
          <div
            ref={ringRef}
            className={`dashboard-storage-radial ${capacityKnown ? '' : 'is-unavailable'}`}
            style={capacityKnown ? { '--capacity-pct': `${usedPct}%` } : undefined}
            role="img"
            aria-label={capacityKnown ? `${usedPct}% ${t('capacityUsed')}` : t('capacityUnreadable')}
          >
            <div className="dashboard-storage-radial-center">
              <strong lang="en">{capacityKnown ? `${usedPct}%` : '—'}</strong>
              <span>{t('capacityUsedPct')}</span>
            </div>
          </div>
          <dl className="dashboard-storage-totals">
            <div><dt>{t('capacityUsed')}</dt><dd lang="en">{capacityKnown ? fmtBytes(usedBytes) : '—'}</dd></div>
            <div><dt>{t('free')}</dt><dd lang="en">{freeBytes != null ? fmtBytes(freeBytes) : '—'}</dd></div>
            <div><dt>{t('capacityTotal')}</dt><dd lang="en">{capacityKnown ? fmtBytes(totalBytes) : '—'}</dd></div>
          </dl>
        </div>

        <div className="dashboard-storage-categories">
          <h3>{t('storageBreakdown')}</h3>
          <p className="dashboard-storage-denominator">{t('storageCategoryShare')}</p>
          {categoriesAvailable && segs.length === 0 ? (
            <InlineEmptyState>{t('emptyNoFiles')}</InlineEmptyState>
          ) : (
            <div ref={categoriesRef} className="dashboard-storage-category-list">
              {visibleCategories.map((seg) => {
                const percent = seg.bytes != null && accounted > 0 ? (seg.bytes / accounted) * 100 : null
                return (
                  <div className="dashboard-storage-category" key={seg.key} data-tooltip={percent != null ? `${t(seg.key)} · ${fmtBytes(seg.bytes)} · ${percent.toFixed(1)}%` : undefined}>
                    <div className="dashboard-storage-category-label">
                      <span>{t(seg.key)}</span>
                      <span lang="en">{seg.bytes != null ? <>{fmtBytes(seg.bytes)} <small>{percent.toFixed(1)}%</small></> : '—'}</span>
                    </div>
                    <div className="dashboard-storage-category-track" role={percent != null ? 'progressbar' : undefined} tabIndex={percent != null ? 0 : undefined} aria-label={percent != null ? t(seg.key) : undefined} aria-valuenow={percent != null ? Math.round(percent) : undefined} aria-valuetext={percent != null ? `${percent.toFixed(1)}% ${t('storageCategoryShare')}` : undefined} aria-valuemin={percent != null ? 0 : undefined} aria-valuemax={percent != null ? 100 : undefined} aria-hidden={percent == null ? true : undefined}>
                      {percent != null && <span style={{ width: `${percent}%`, background: seg.color }} />}
                    </div>
                  </div>
                )
              })}
              {!categoriesAvailable && (
                <div className="dashboard-storage-category-status" role="status">
                  <span>{t(storageLoading ? 'telemetryStateLoading' : 'notAvailable')}</span>
                  {storageError && <button type="button" onClick={onRetry}>{t('retry')}</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

/* ── Activity — จำนวนครั้งของการอัปโหลด/ดาวน์โหลดต่อวัน จาก audit_log จริง ──── */
function ChartTooltip({ active, payload, label, t }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-line rounded-[var(--r-tile)] px-3.5 py-2.5" style={{ boxShadow: 'var(--elev-2)' }}>
      <p className="text-[12px] font-semibold text-ink mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="text-[12.5px] text-ink-2 flex items-center gap-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span className="size-2 rounded-full" style={{ background: p.dataKey === 'uploads' ? 'var(--ink)' : 'var(--accent)' }} />
          {p.dataKey === 'uploads' ? t('uploads') : t('downloads')} · {p.value}
        </p>
      ))}
    </div>
  )
}

function ActivityChart({ t, lang, data }) {
  const reduced = useReducedMotion()
  // ป้ายแกน X เป็นชื่อวันตามภาษาที่เลือก — เซิร์ฟเวอร์คืนวันที่ ISO ไม่ใช่ชื่อวันภาษาอังกฤษ
  // (ชื่อวันเป็นเรื่องของการแสดงผล ไม่ใช่ข้อมูล)
  const rows = data.map((d) => ({
    ...d,
    label: new Date(`${d.date}T00:00:00Z`).toLocaleDateString(
      lang === 'th' ? 'th-TH' : lang === 'zh' ? 'zh-CN' : 'en-US',
      { weekday: 'short', timeZone: 'UTC' },
    ),
  }))
  const empty = rows.length === 0 || rows.every((r) => r.uploads === 0 && r.downloads === 0)

  return (
    <Card className="p-5 rise-in" style={{ animationDelay: '280ms' }}>
      <CardTitle
        sub={t('activitySub')}
        right={
          <div className="flex items-center gap-3 text-[12px] font-medium text-ink-3">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: 'var(--ink)' }} />{t('uploads')}</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: 'var(--accent)' }} />{t('downloads')}</span>
          </div>
        }
      >
        {t('activityTitle')}
      </CardTitle>
      {/* ⚠️ ยังไม่มีกิจกรรมเลย ≠ กราฟเปล่าที่ดูเหมือนพัง — บอกตรง ๆ ว่าไม่มีเหตุการณ์
          ในเจ็ดวันนี้ (ของเดิมไม่มีสถานะนี้เพราะข้อมูลปลอมทำให้มีแท่งอยู่เสมอ) */}
      {rows.length > 0 && <div className="dashboard-activity-plot h-56" role="img" aria-label={t('activityTitle')}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} barGap={3} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeWidth={1} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} dy={6} />
            {/* allowDecimals=false — จำนวนครั้งเป็นจำนวนเต็มเสมอ */}
            <YAxis axisLine={false} tickLine={false} width={38} allowDecimals={false} domain={[0, 'auto']} />
            <RTooltip content={<ChartTooltip t={t} />} cursor={{ fill: 'var(--card-sunken)' }} />
            <Bar dataKey="uploads" radius={[8, 8, 0, 0]} maxBarSize={18} fill="var(--ink)" isAnimationActive={!reduced} animationDuration={600} animationEasing="ease-out" />
            <Bar dataKey="downloads" radius={[8, 8, 0, 0]} maxBarSize={18} fill="var(--accent)" isAnimationActive={!reduced} animationDuration={600} animationEasing="ease-out" />
          </BarChart>
        </ResponsiveContainer>
      </div>}
      <table className="sr-only">
        <caption>{t('activitySub')}</caption>
        <thead><tr><th scope="col">{t('activityDay')}</th><th scope="col">{t('uploads')}</th><th scope="col">{t('downloads')}</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.date}>
            <th scope="row"><time dateTime={row.date}>{row.date}</time></th>
            <td>{row.uploads}</td>
            <td>{row.downloads}</td>
          </tr>
        ))}</tbody>
      </table>
      {empty && <InlineEmptyState className="pt-3 pb-0 text-center">{t('activityEmpty')}</InlineEmptyState>}
    </Card>
  )
}

/* ── The dashboard grid — สี่สถานะครบที่ระดับจอ ───────────────────────── */
export function Dashboard({ t, lang, health, go, telemetry = null, telemetryLoading = false }) {
  const rootRef = useRef(null)
  const reduced = useReducedMotion()
  const now = useNow(1000)
  const dash = useApi('/api/dashboard', { refreshMs: 30_000 })
  const storage = useApi('/api/storage', { refreshMs: 60_000 })
  useDashboardMotion(rootRef, !dash.loading && !health.loading, reduced)

  if (dash.loading || health.loading) return <SkeletonLoader type="dashboard" />

  const usingPlaceholder = !isPlatformWired(health.data)
  const showDashboardError = shouldShowDashboardFetchError(dash.error, health.data)
  const dashboardUnavailable = usingPlaceholder || showDashboardError || dash.data == null
  const d = normalizeDashboardData(dashboardUnavailable ? null : dash.data)
  const m = d.metrics
  const showStorageError = shouldShowDashboardFetchError(storage.error, health.data)
  const measuredCapacity = storage.data?.capacityBytes
  const hasStorageCapacity = Number.isFinite(measuredCapacity?.usedBytes)
    && Number.isFinite(measuredCapacity?.totalBytes)
    && measuredCapacity.totalBytes > 0
  const placeholderLabel = dashboardUnavailable ? t(usingPlaceholder ? 'notConnected' : 'dashboardUnavailable') : null

  return (
    <div ref={rootRef} className="dashboard-layout flex flex-col gap-5">
      {showDashboardError && (
        <Card><ErrorState t={t} kind={dash.error} onRetry={dash.retry} /></Card>
      )}
      {/* Storage capacity and measured telemetry lead the scan path. */}
      <div className="dashboard-kpi-grid">
        <StorageHero
          t={t}
          usedBytes={hasStorageCapacity ? measuredCapacity.usedBytes : m.storageBytes}
          totalBytes={hasStorageCapacity ? measuredCapacity.totalBytes : m.storageTotalBytes}
          usage={storage.data?.usage}
          unavailable={dashboardUnavailable && !hasStorageCapacity}
          unavailableLabel={placeholderLabel}
          storageLoading={storage.loading}
          storageError={showStorageError}
          onRetry={storage.retry}
        />
        <ServerTelemetry t={t} data={telemetry} loading={telemetryLoading} />
      </div>

      {/* Operational and account security state precedes secondary counts. */}
      <Reveal delay={100}>
        <div className="dashboard-primary-grid">
          <div className="dashboard-health-panel"><LakeHealth t={t} health={health.data} /></div>
          <div className="dashboard-security-panel">
          <StatCard
            icon={ShieldCheck}
            label={t('statSecurity')}
            value={d.securityAlerts}
            valueLabel={dashboardUnavailable ? '—' : undefined}
            alarm={!dashboardUnavailable && d.securityAlerts > 0}
            allClearLabel={placeholderLabel ?? t('allClear')}
            statusTone={dashboardUnavailable ? 'neutral' : 'ok'}
            delay={120}
          />
            <LoginHistoryCard t={t} events={d.loginHistory ?? []} unavailable={dashboardUnavailable} />
          </div>
        </div>
      </Reveal>

      {/* Seven-day audit history is real; /api/telemetry supplies current values only. */}
      <Reveal delay={200}>
        <div className="dashboard-secondary-grid">
          <div className="dashboard-activity-panel">
            {dashboardUnavailable ? (
              <Card className="p-5 dashboard-activity-card"><CardTitle>{t('activityTitle')}</CardTitle><p className="dashboard-quiet-state" role="status">{t('dashboardUnavailable')}</p></Card>
            ) : (
              <ActivityChart t={t} lang={lang} data={d.activity7d ?? []} />
            )}
          </div>
          <div className="dashboard-kpi-stack">
            <StatCard icon={FilesIcon} label={t('statFiles')} value={m.files} valueLabel={dashboardUnavailable ? '—' : undefined} allClearLabel={placeholderLabel} statusTone="neutral" delay={40} />
            <StatCard icon={Link2} label={t('activeLinks')} value={m.activeShares} valueLabel={dashboardUnavailable ? '—' : undefined} allClearLabel={placeholderLabel} statusTone="neutral" delay={80} />
          </div>
        </div>
      </Reveal>

      {/* Secondary lists from /api/dashboard. */}
      <Reveal delay={260}>
        <div className="dashboard-recents-grid">
          <ActiveLinksCard t={t} shares={d.shares ?? []} now={now} unavailable={dashboardUnavailable} />
          <Card className="p-5">
          <CardTitle>{t('recentFiles')}</CardTitle>
          {dashboardUnavailable ? (
            <DependencyUnavailableState t={t} title={t('dashboardUnavailable')} compact />
          ) : (d.recentFiles ?? []).length === 0 ? (
            <InlineEmptyState>{t('emptyNoRecentFiles')}</InlineEmptyState>
          ) : (
            <div className="flex flex-col">
              {d.recentFiles.map((f) => (
                <div key={f.id} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
                  <FileText size={14} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                  <span className="block text-[13.5px] font-medium text-ink truncate flex-1 min-w-0">{f.name}</span>
                  <span className="text-[11.5px] text-ink-3 font-mono shrink-0">{fmtRelative(t, f.modified, now)}</span>
                </div>
              ))}
            </div>
          )}
          </Card>
        </div>
      </Reveal>
    </div>
  )
}
