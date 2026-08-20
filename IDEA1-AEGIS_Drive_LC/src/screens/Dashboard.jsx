import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Cell,
} from 'recharts'
import {
  Database, Files as FilesIcon, Link2, ShieldCheck, ArrowUpRight, ArrowDownRight,
  LogIn, FileText, Clock, Upload, Vault,
} from 'lucide-react'
import { Btn, Card, CardTitle, Chip, Dot, Reveal, ErrorState, SkeletonLoader } from '../components/ui.jsx'
import { useApi, useCountUp, useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtRelative, fmtCountdown, fmtStamp, fmtBytes } from '../lib/format.js'
import { isPlatformWired } from '../lib/fetchState.js'
import { normalizeDashboardData, shouldShowDashboardFetchError } from '../lib/dashboardState.js'

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
function StatCard({ icon: Icon, label, value, valueLabel, suffix, decimals = 0, delta, deltaUp, alarm = false, allClearLabel, statusTone = 'ok', delay = 0, footer }) {
  const v = useCountUp(value, 700, decimals)
  const display = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString('en-US')
  return (
    <Card
      className={`relative overflow-hidden p-6 pb-6 rise-in ${alarm ? 'border-pulse' : ''}`}
      style={{
        animationDelay: `${delay}ms`,
        ...(alarm ? { background: 'var(--danger-soft)', borderColor: 'var(--danger)' } : {}),
      }}
    >
      <div className="flex items-start justify-between">
        <div className="size-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent-ink">
          <Icon size={18} strokeWidth={1.5} />
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
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mt-4">{label}</p>
      {/* lang="en" — DESIGN.md · Cascade traps. This is a tabular-nums stat */}
      <p
        lang="en"
        className="text-3xl font-mono font-semibold tracking-tight leading-none mt-1.5 text-slate-900 dark:text-white"
        style={{ fontVariantNumeric: 'tabular-nums', color: alarm ? 'var(--danger)' : value === 0 && allClearLabel && statusTone === 'ok' ? 'var(--ok)' : undefined }}
      >
        {valueLabel ?? display}
        {suffix && <span className="text-lg font-semibold text-slate-400 dark:text-slate-500 ml-1.5">{suffix}</span>}
      </p>
      {footer && (
        <div className="mt-4 pt-3 border-t border-line">
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
  { id: 'application', nameKey: 'tierApp', tech: 'Express event loop' },
  { id: 'metadata', nameKey: 'tierMeta', tech: 'PostgreSQL' },
  { id: 'storage', nameKey: 'tierStorage', tech: 'Linux FS / HDD' },
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
    <Card className="p-5 rise-in" style={{ animationDelay: '160ms' }}>
      <CardTitle sub={t('lakeSubtitle')}>{t('lakeHealth')}</CardTitle>

      <div className="flex flex-col">
        {TIERS.map((tier, idx) => {
          const state = tierStates[tier.id]
          const layer = health?.layers?.[tier.id]
          const tech = tier.id === 'metadata' && health?.db === 'memory' ? 'in-memory (not connected)' : tier.tech
          const dimmed = state === 'healthy' && brokenBelow(idx)
          const tone = state === 'healthy' ? 'ok' : state === 'degraded' ? 'warn' : state === 'down' ? 'danger' : 'neutral'
          const lat = layer?.measured === true && Number.isFinite(layer.latencyMs)
            ? layer.latencyMs
            : null
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
                <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-sm:hidden">{tech}</span>
                <div className="flex-1 min-w-4" />
                <span className="text-[12px] font-medium w-16 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: state === 'healthy' ? 'var(--ink-2)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--ink-3)' }}>
                  {lat != null ? `${lat.toFixed(1)} ms` : t('latencyUnavailable')}
                </span>
                  <Chip tone={tone}>{state === 'healthy' ? t('tierHealthy') : state === 'degraded' ? t('tierDegraded') : state === 'down' ? t('tierDown') : state === 'unavailable' ? t('latencyUnavailable') : t('notConnected')}</Chip>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ── Login history — personal security status (สเปกของจอ Dashboard) ── */
function LoginHistoryCard({ t, events }) {
  return (
    <Card className="p-5 rise-in flex flex-col min-h-0" style={{ animationDelay: '200ms' }}>
      <CardTitle sub={t('dashLoginHistorySub')}>{t('dashLoginHistory')}</CardTitle>
      {events.length === 0 ? (
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
function ActiveLinksCard({ t, shares, now }) {
  return (
    <Card className="p-5 flex flex-col min-h-0" style={{ animationDelay: '250ms' }}>
      <CardTitle>{t('activeLinks')}</CardTitle>
      {shares.length === 0 ? (
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
  docs: 'var(--accent)', archives: 'var(--ink-3)', media: 'var(--violet)',
  vaultSeg: 'var(--ink)', versions: 'var(--warn)', other: 'var(--accent-ink)',
}

function StorageBreakdown({ t, usage, capacityBytes }) {
  const [hovered, setHovered] = useState(null)
  const segs = Object.keys(SEG_COLORS)
    .map((key) => ({ key, bytes: usage?.[key] ?? 0, color: SEG_COLORS[key] }))
    .filter((s) => s.bytes > 0)
  const accounted = segs.reduce((n, s) => n + s.bytes, 0)
  // ฐานของสัดส่วน = พื้นที่ที่ "แอปนี้" ใช้ ไม่ใช่ความจุทั้ง volume — ไม่งั้นทุกแท่งจะ
  // เล็กจนมองไม่เห็นบนดิสก์ใหญ่ และตัวเลข % จะตอบคำถามที่ไม่มีใครถาม
  const total = accounted || 1

  return (
    <Card className="p-5 rise-in" style={{ animationDelay: '240ms' }}>
      <CardTitle sub={t('storageBreakdownSub')}>{t('storageBreakdown')}</CardTitle>
      {segs.length === 0 ? (
        <>
          <div className="h-7 mt-1 rounded-full bg-sunken border border-line overflow-hidden" aria-label="0%" />
          <InlineEmptyState>{t('emptyNoFiles')}</InlineEmptyState>
          {capacityBytes && (
            <p className="text-[11.5px] text-ink-3 leading-relaxed">
              {t('storageBreakdownFree')} <span className="font-mono">{capacityBytes.freeBytes === 0 ? '0 GB' : fmtBytes(capacityBytes.freeBytes ?? 0)}</span>
            </p>
          )}
        </>
      ) : (
        <>
          <div className="flex items-end gap-0.5 h-8 mt-1" aria-hidden>
            {segs.map((seg, i) => (
              <div
                key={seg.key}
                className={`h-7 transition-transform duration-[var(--dur-fast)] ${i === 0 ? 'rounded-l-full' : ''} ${i === segs.length - 1 ? 'rounded-r-full' : ''}`}
                style={{
                  width: `${(seg.bytes / total) * 100}%`,
                  backgroundColor: seg.color,
                  transform: hovered === seg.key ? 'translateY(-3px)' : 'none',
                  transitionTimingFunction: 'var(--ease)',
                }}
              />
            ))}
          </div>
          <div className="mt-4 flex flex-col">
            {segs.map((seg) => (
              <div
                key={seg.key}
                onMouseEnter={() => setHovered(seg.key)}
                onMouseLeave={() => setHovered(null)}
                className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded-[8px] hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-default"
              >
                <span className="size-3 rounded-[4px] shrink-0" style={{ backgroundColor: seg.color }} aria-hidden />
                <span className="text-[13px] font-medium text-ink-2">{t(seg.key)}</span>
                <span className="ml-auto text-[13px] text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(seg.bytes)}</span>
                <span className="w-12 text-right text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {((seg.bytes / total) * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
          {capacityBytes && (
            <p className="text-[11.5px] text-ink-3 mt-3 leading-relaxed">
              {t('storageBreakdownFree')} <span className="font-mono">{fmtBytes(capacityBytes.freeBytes)}</span>
            </p>
          )}
        </>
      )}
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
  const displayData = data.length > 0 ? data : Array.from({ length: 7 }, (_, index) => {
    const day = new Date()
    day.setUTCHours(0, 0, 0, 0)
    day.setUTCDate(day.getUTCDate() - (6 - index))
    return { date: day.toISOString().slice(0, 10), uploads: 0, downloads: 0 }
  })
  const rows = displayData.map((d) => ({
    ...d,
    label: new Date(`${d.date}T00:00:00Z`).toLocaleDateString(
      lang === 'th' ? 'th-TH' : lang === 'zh' ? 'zh-CN' : 'en-US',
      { weekday: 'short', timeZone: 'UTC' },
    ),
  }))
  const empty = rows.every((r) => r.uploads === 0 && r.downloads === 0)

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
      <div className="h-56">
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
      </div>
      {empty && <InlineEmptyState className="pt-3 pb-0 text-center">{t('activityEmpty')}</InlineEmptyState>}
    </Card>
  )
}

/* ── The dashboard grid — สี่สถานะครบที่ระดับจอ ───────────────────────── */
export function Dashboard({ t, lang, health, go }) {
  const now = useNow(1000)
  const dash = useApi('/api/dashboard', { refreshMs: 30_000 })
  const storage = useApi('/api/storage', { refreshMs: 60_000 })

  if (dash.loading || health.loading) return <SkeletonLoader type="dashboard" />

  const usingPlaceholder = !isPlatformWired(health.data)
  const d = normalizeDashboardData(usingPlaceholder ? null : dash.data)
  const m = d.metrics
  // ⚠️ null = statfs อ่านค่าไม่ได้ ไม่ใช่ "ศูนย์" — การ์ดต้องบอกว่าไม่รู้ ไม่ใช่วาด 0%
  const hasCapacity = m.storageTotalBytes != null && m.storageBytes != null
  const usedPct = hasCapacity && m.storageTotalBytes > 0
    ? Math.min(100, Math.round((m.storageBytes / m.storageTotalBytes) * 100))
    : 0
  const showDashboardError = shouldShowDashboardFetchError(dash.error, health.data)
  const showStorageError = shouldShowDashboardFetchError(storage.error, health.data)
  const placeholderLabel = usingPlaceholder ? t('notConnected') : null

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-center justify-between gap-3 flex-wrap" aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title" className="text-sm font-semibold text-ink">{t('quickActions')}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <Btn variant="primary" size="sm" onClick={() => go('uploads')}>
            <Upload size={14} strokeWidth={1.7} />
            {t('uploadFile')}
          </Btn>
          <Btn variant="outline" size="sm" onClick={() => go('shares')}>
            <Link2 size={14} strokeWidth={1.7} />
            {t('createShareLink')}
          </Btn>
          <Btn variant="outline" size="sm" onClick={() => go('vault')}>
            <Vault size={14} strokeWidth={1.7} />
            {t('openPrivateVault')}
          </Btn>
        </div>
      </section>
      {showDashboardError && (
        <Card><ErrorState t={t} kind={dash.error} onRetry={dash.retry} /></Card>
      )}
      {/* Top 4 KPI Cards — ตัวเลขจริงจากเซิร์ฟเวอร์ทั้งหมด */}
      <Reveal delay={0}>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 max-xl:gap-5">
          <StatCard
            icon={Database}
            label={t('statStorage')}
            value={hasCapacity ? m.storageBytes : 0}
            valueLabel={hasCapacity ? fmtBytes(m.storageBytes) : '—'}
            suffix={hasCapacity ? `/ ${m.storageTotalBytes === 0 ? '0 GB' : fmtBytes(m.storageTotalBytes)}` : t('notAvailable')}
            allClearLabel={placeholderLabel}
            statusTone="neutral"
            footer={hasCapacity ? (
              <div className="flex flex-col gap-1.5">
                <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full" style={{ width: `${usedPct}%` }} />
                </div>
                <div className="flex justify-between text-[11px] text-slate-400 dark:text-slate-500 font-semibold font-mono">
                  <span>{usedPct}% {t('capacityUsed')}</span>
                  <span>{m.storageTotalBytes === 0 ? '0 GB' : fmtBytes(Math.max(0, m.storageTotalBytes - m.storageBytes))} {t('free')}</span>
                </div>
              </div>
            ) : (
              // อ่านความจุไม่ได้ — บอกตรง ๆ แทนที่จะวาดแถบจากค่าที่เดา
              <p className="text-[11.5px] text-ink-3 leading-relaxed">{t('capacityUnreadable')}</p>
            )}
          />
          <StatCard icon={FilesIcon} label={t('statFiles')} value={m.files} allClearLabel={placeholderLabel ?? t('resOk')} statusTone={usingPlaceholder ? 'neutral' : 'ok'} delay={40} />
          <StatCard icon={Link2} label={t('activeLinks')} value={m.activeShares} allClearLabel={placeholderLabel ?? t('resOk')} statusTone={usingPlaceholder ? 'neutral' : 'ok'} delay={80} />
          <StatCard
            icon={ShieldCheck}
            label={t('statSecurity')}
            value={d.securityAlerts}
            alarm={d.securityAlerts > 0}
            allClearLabel={placeholderLabel ?? t('allClear')}
            statusTone={usingPlaceholder ? 'neutral' : 'ok'}
            delay={120}
          />
        </div>
      </Reveal>

      {/* Mid row: LakeHealth (จาก /healthz) + login history / active links */}
      <Reveal delay={100}>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 lg:w-2/3">
            <LakeHealth t={t} health={health.data} />
          </div>
          <div className="w-full lg:w-1/3 flex flex-col gap-6">
            <LoginHistoryCard t={t} events={d.loginHistory ?? []} />
            <ActiveLinksCard t={t} shares={d.shares ?? []} now={now} />
          </div>
        </div>
      </Reveal>

      {/* Bottom row: breakdown (จาก /api/storage) + transfer chart */}
      <Reveal delay={200}>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 lg:w-1/2">
            {storage.loading ? (
              <Card className="p-5 h-64 animate-pulse"><div className="w-1/3 h-5 skeleton" /><div className="w-full h-8 skeleton mt-6 rounded-full" /></Card>
            ) : showStorageError ? (
              <Card><ErrorState t={t} kind={storage.error} onRetry={storage.retry} /></Card>
            ) : (
              <StorageBreakdown
                t={t}
                usage={usingPlaceholder ? {} : storage.data?.usage ?? {}}
                capacityBytes={usingPlaceholder
                  ? { totalBytes: 0, usedBytes: 0, freeBytes: 0 }
                  : storage.data?.capacityBytes ?? { totalBytes: 0, usedBytes: 0, freeBytes: 0 }}
              />
            )}
          </div>
          <div className="flex-1 lg:w-1/2">
            <ActivityChart t={t} lang={lang} data={d.activity7d ?? []} />
          </div>
        </div>
      </Reveal>

      {/* recent files — จาก /api/dashboard */}
      <Reveal delay={260}>
        <Card className="p-5">
          <CardTitle>{t('recentFiles')}</CardTitle>
          {(d.recentFiles ?? []).length === 0 ? (
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
      </Reveal>
    </div>
  )
}
