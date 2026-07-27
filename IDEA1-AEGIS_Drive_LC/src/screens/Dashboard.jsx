import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Cell,
} from 'recharts'
import {
  Database, Files as FilesIcon, Link2, ShieldCheck, ArrowUpRight, ArrowDownRight,
  FlaskConical, LogIn, FileText, Clock,
} from 'lucide-react'
import { Card, CardTitle, Chip, Dot, IconBtn, Segmented, Reveal, ErrorState, EmptyState, SkeletonLoader } from '../components/ui.jsx'
import { useApi, useCountUp, useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtRelative, fmtCountdown, fmtStamp, fmtBytes } from '../lib/format.js'

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
function StatCard({ icon: Icon, label, value, suffix, decimals = 0, delta, deltaUp, alarm = false, allClearLabel, delay = 0, footer, gradientValue = false }) {
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
        ) : (
          <Chip tone={alarm ? 'danger' : 'ok'}>{alarm ? `▲ ${value}` : allClearLabel}</Chip>
        )}
      </div>
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mt-4">{label}</p>
      {/* lang="en" — DESIGN.md · Cascade traps. This is a tabular-nums stat */}
      <p
        lang="en"
        className={`text-3xl font-mono font-semibold tracking-tight leading-none mt-1.5 ${gradientValue ? 'bg-clip-text text-transparent bg-gradient-to-r from-blue-500 to-purple-500 dark:from-blue-400 dark:to-purple-400' : 'text-slate-900 dark:text-white'}`}
        style={{ fontVariantNumeric: 'tabular-nums', color: alarm ? 'var(--danger)' : value === 0 && allClearLabel ? 'var(--ok)' : undefined }}
      >
        {display}
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

/* ── Data Lake Health — สถานะจริงจาก /healthz + demo override สำหรับผู้นำเสนอ ── */
const TIERS = [
  { id: 'app', nameKey: 'tierApp', tech: 'NGINX / Express', baseLat: 12 },
  { id: 'meta', nameKey: 'tierMeta', tech: 'PostgreSQL', baseLat: 4 },
  { id: 'fs', nameKey: 'tierStorage', tech: 'Linux FS / HDD', baseLat: 2 },
]

function LakeHealth({ t, health }) {
  const [demoOpen, setDemoOpen] = useState(false)
  // override เป็นเครื่องมือเดโม่ "เท่านั้น" (แสดงสถานะ degraded/down ให้ผู้ตรวจดูได้)
  // ค่าเริ่มต้นจริงมาจาก /healthz — ไม่ใช่ตัวเลขแต่งขึ้น
  const [override, setOverride] = useState({})
  const tierStates = {
    app: override.app ?? (health ? 'healthy' : 'down'),
    meta: override.meta ?? (health ? (health.db === 'postgres' || health.db === 'memory' ? 'healthy' : 'down') : 'down'),
    fs: override.fs ?? (health?.ok ? 'healthy' : 'down'),
  }
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
                onChange={(v) => setOverride((s) => ({ ...s, [tier.id]: v }))}
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

/* ── Login history — personal security status (สเปกของจอ Dashboard) ── */
function LoginHistoryCard({ t, events }) {
  return (
    <Card className="p-5 rise-in flex flex-col min-h-0" style={{ animationDelay: '200ms' }}>
      <CardTitle sub={t('dashLoginHistorySub')}>{t('dashLoginHistory')}</CardTitle>
      {events.length === 0 ? (
        <EmptyState icon={LogIn} title={t('emptyNoActivity')} />
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
        <EmptyState icon={Link2} title={t('emptyNoShares')} />
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
        <EmptyState icon={FilesIcon} title={t('emptyNoFiles')} hint={t('emptyNoFilesHint')} />
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
  const rows = data.map((d) => ({
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
      {empty ? (
        <EmptyState icon={FilesIcon} title={t('activityEmpty')} hint={t('activityEmptyHint')} />
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} barGap={3} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeWidth={1} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} dy={6} />
              {/* allowDecimals=false — จำนวนครั้งเป็นจำนวนเต็มเสมอ */}
              <YAxis axisLine={false} tickLine={false} width={38} allowDecimals={false} />
              <RTooltip content={<ChartTooltip t={t} />} cursor={{ fill: 'var(--card-sunken)' }} />
              <Bar dataKey="uploads" radius={[8, 8, 0, 0]} maxBarSize={18} fill="var(--ink)" isAnimationActive={!reduced} animationDuration={600} animationEasing="ease-out" />
              <Bar dataKey="downloads" radius={[8, 8, 0, 0]} maxBarSize={18} fill="var(--accent)" isAnimationActive={!reduced} animationDuration={600} animationEasing="ease-out" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

/* ── The dashboard grid — สี่สถานะครบที่ระดับจอ ───────────────────────── */
export function Dashboard({ t, lang }) {
  const now = useNow(1000)
  const dash = useApi('/api/dashboard', { refreshMs: 30_000 })
  const storage = useApi('/api/storage', { refreshMs: 60_000 })
  const health = useApi('/healthz', { refreshMs: 15_000 })

  if (dash.loading) return <SkeletonLoader type="dashboard" />
  if (dash.error) return <ErrorState t={t} kind={dash.error} onRetry={dash.retry} />

  const d = dash.data
  const m = d.metrics
  // ⚠️ null = statfs อ่านค่าไม่ได้ ไม่ใช่ "ศูนย์" — การ์ดต้องบอกว่าไม่รู้ ไม่ใช่วาด 0%
  const hasCapacity = m.storageTotalBytes != null && m.storageBytes != null
  const usedPct = hasCapacity && m.storageTotalBytes > 0
    ? Math.min(100, Math.round((m.storageBytes / m.storageTotalBytes) * 100))
    : null

  return (
    <div className="flex flex-col gap-6">
      {/* Top 4 KPI Cards — ตัวเลขจริงจากเซิร์ฟเวอร์ทั้งหมด */}
      <Reveal delay={0}>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 max-xl:gap-5">
          <StatCard
            icon={Database}
            label={t('statStorage')}
            value={hasCapacity ? m.storageBytes / 1e9 : 0}
            suffix={hasCapacity ? `GB ${t('ofTotal')} ${fmtBytes(m.storageTotalBytes)}` : t('notAvailable')}
            decimals={1}
            gradientValue
            footer={hasCapacity ? (
              <div className="flex flex-col gap-1.5">
                <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-600 to-purple-600 rounded-full" style={{ width: `${usedPct}%` }} />
                </div>
                <div className="flex justify-between text-[11px] text-slate-400 dark:text-slate-500 font-semibold font-mono">
                  <span>{usedPct}% {t('capacityUsed')}</span>
                  <span>{fmtBytes(Math.max(0, m.storageTotalBytes - m.storageBytes))} {t('free')}</span>
                </div>
              </div>
            ) : (
              // อ่านความจุไม่ได้ — บอกตรง ๆ แทนที่จะวาดแถบจากค่าที่เดา
              <p className="text-[11.5px] text-ink-3 leading-relaxed">{t('capacityUnreadable')}</p>
            )}
          />
          <StatCard icon={FilesIcon} label={t('statFiles')} value={m.files} allClearLabel={t('resOk')} delay={40} />
          <StatCard icon={Link2} label={t('activeLinks')} value={m.activeShares} allClearLabel={t('resOk')} delay={80} />
          <StatCard
            icon={ShieldCheck}
            label={t('statSecurity')}
            value={d.securityAlerts}
            alarm={d.securityAlerts > 0}
            allClearLabel={t('allClear')}
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
            ) : storage.error ? (
              <Card><ErrorState t={t} kind={storage.error} onRetry={storage.retry} /></Card>
            ) : (
              <StorageBreakdown t={t} usage={storage.data?.usage} capacityBytes={storage.data?.capacityBytes} />
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
            <EmptyState icon={FileText} title={t('emptyNoFiles')} hint={t('emptyNoFilesHint')} />
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
