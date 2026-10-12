import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { Chip, Dot, Btn, PillSelect, ErrorState, InlineEmptyState, DependencyUnavailableState, SkeletonLoader } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { fmtStamp } from '../lib/format.js'

/* The audit ledger is deliberately a different material: sharper corners,
   denser rows, mono figures. An append-only record should look like one.

   ⚠️ Privacy-preserving (สเปกบังคับ): ชื่อไฟล์/เป้าหมายถูกเก็บและแสดงเป็น SHA-256
   — ผู้ตรวจ log เห็นว่า "เกิดอะไรกับรายการไหน (ระบุซ้ำได้)" โดยไม่เห็นชื่อจริง
   endpoint นี้เป็นของ Admin เท่านั้น (requireRole ฝั่งเซิร์ฟเวอร์) */

const RES_LABEL = { OK: 'resOk', DENIED: 'resDenied', BLOCKED: 'resBlocked' }

/* ตัวกรองภายใต้ t('filterResult') เสนอโดเมนของค่า result จริงใน ledger ทีละค่า
   ไม่ใช่การจับกลุ่ม — value ของแต่ละ option "คือ" ค่า result ที่ถูกบันทึกไว้ตรง ๆ
   (ยกเว้น 'all' ที่แปลว่าไม่กรอง) การเทียบจึงเป็นการเทียบเท่ากันแบบตรงตัว
   ค่าที่เก็บในฐานข้อมูลและความหมายฝั่งเซิร์ฟเวอร์ไม่ถูกแตะ */
const RESULT_FILTERS = [
  { value: 'all', label: 'filterAll' },
  { value: 'OK', label: 'filterSuccess' },
  { value: 'DENIED', label: 'filterDenied' },
  { value: 'BLOCKED', label: 'filterBlocked' },
]

/* ช่วงเวลาแบบ preset — สำหรับ ledger ที่เรียงตามเวลาอยู่แล้ว การเลือก "ย้อนหลังเท่าไร"
   ตรงกับคำถามที่ผู้ตรวจถามจริงมากกว่าการจิ้มปฏิทินสองครั้ง */
const RANGE_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 }

/** normalize แถวจากทั้งโหมด PG (snake_case) และ dev fallback (camelCase) */
const norm = (e) => ({
  at: new Date(e.at).getTime(),
  actor: e.actor_label ?? e.actorLabel ?? '—',
  role: e.role ?? '—',
  action: e.action,
  targetHash: e.target_hash ?? e.targetHash ?? null,
  result: e.result,
  ip: e.source_ip ?? e.sourceIp ?? '—',
})

export function Audit({ t, placeholderMode = false }) {
  const api = useApi('/api/audit', { refreshMs: 30_000 })
  const [result, setResult] = useState('all')
  const [actor, setActor] = useState('all')
  const [action, setAction] = useState('all')
  const [range, setRange] = useState('all')
  const nowTs = Date.now()

  const events = useMemo(
    () => placeholderMode ? [] : (api.data?.events ?? []).map(norm),
    [api.data, placeholderMode],
  )
  const fetchError = visibleFetchError(api.error, placeholderMode)
  const actors = useMemo(() => [...new Set(events.map((e) => e.actor))], [events])
  const actions = useMemo(() => [...new Set(events.map((e) => e.action))], [events])

  const visible = (e) =>
    (result === 'all' || e.result === result) &&
    (actor === 'all' || e.actor === actor) &&
    (action === 'all' || e.action === action) &&
    (range === 'all' || e.at >= nowTs - RANGE_MS[range])

  const exportCsv = () => {
    const head = 'timestamp,actor,role,action,target_sha256,result,source_ip'
    const rows = events.map((e) =>
      [fmtStamp(e.at), e.actor, e.role, e.action, e.targetHash ?? '', e.result, e.ip].join(','),
    )
    const blob = new Blob([`${head}\n${rows.join('\n')}`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'aegis-audit-log.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const visibleCount = events.filter(visible).length

  return (
    <div>
      {/* filters — one row above the ledger */}
      <div className="neo-toolbar flex items-center gap-2.5 mb-4 flex-wrap">
        <div className="w-44">
          <PillSelect aria-label={t('filterRange')} value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="all">{t('filterRange')} · {t('filterAll')}</option>
            <option value="24h">{t('hours24')}</option>
            <option value="7d">{t('days7')}</option>
            <option value="30d">{t('days30')}</option>
          </PillSelect>
        </div>
        {/* ทุก option ขึ้นต้นด้วย t('filterResult') เพราะค่าที่ปรากฏบนปุ่มคือ option ที่
            เลือกอยู่ — ตัวกรองจึงพูดชื่อตัวเองเสมอ เหมือนอีกสามตัวในแถวเดียวกัน
            เดิมมีเพียง all กับ denied และ denied แปลว่า "ทุกค่าที่ไม่ใช่ OK" ทำให้
            DENIED กับ BLOCKED ถูกยุบเป็นกลุ่มเดียว และเลือกดูเฉพาะรายการที่เป็น OK ไม่ได้เลย */}
        <div className="w-52">
          <PillSelect aria-label={t('filterResult')} value={result} onChange={(e) => setResult(e.target.value)}>
            {RESULT_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>{t('filterResult')} · {t(option.label)}</option>
            ))}
          </PillSelect>
        </div>
        <div className="w-44">
          <PillSelect aria-label={t('filterActor')} value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="all">{t('filterActor')} · {t('filterAll')}</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </PillSelect>
        </div>
        <div className="w-44">
          <PillSelect aria-label={t('filterAction')} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="all">{t('filterAction')} · {t('filterAll')}</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </PillSelect>
        </div>
        <span className="neo-toolbar-count text-[12px] text-ink-3 ml-1" style={{ fontVariantNumeric: 'tabular-nums' }}>{visibleCount} / {events.length}</span>
        <div className="flex-1" />
        <Btn variant="outline" size="sm" onClick={exportCsv} disabled={events.length === 0}>
          <Download size={13} strokeWidth={1.5} />
          {t('exportCsv')}
        </Btn>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
        <p className="text-[12px] text-ink-3">{t('auditSubtitle')}</p>
        {/* Counts of the rows already loaded and currently shown. Nothing is
            rendered until the ledger has actually been read. */}
        {!api.loading && !fetchError && !placeholderMode && events.length > 0 && (
          <div className="neo-summary-strip" role="status" aria-live="polite">
            {RESULT_FILTERS.filter((option) => option.value !== 'all').map((option) => (
              <span key={option.value} className="neo-summary-item" data-result={option.value}>
                <Dot tone={option.value === 'OK' ? 'ok' : 'danger'} size={6} />
                {t(option.label)}
                <strong>{events.filter((e) => visible(e) && e.result === option.value).length}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="neo-ledger bg-card border border-line overflow-hidden" style={{ borderRadius: 'var(--r-ledger)', boxShadow: 'var(--elev-1)' }}>
          <div className="overflow-x-auto">
            <div className="min-w-[860px] relative">
              {/* header */}
              <div
                className="neo-table-head grid gap-3 items-center px-4 pl-10 bg-sunken border-b border-line text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em] h-9"
                style={{ gridTemplateColumns: '150px minmax(140px,1.2fr) 130px minmax(170px,1.6fr) 84px 118px' }}
              >
                <span>{t('colTimestamp')}</span>
                <span>{t('colActor')}</span>
                <span>{t('colAction')}</span>
                <span>{t('colTargetA')} · SHA-256</span>
                <span>{t('colResult')}</span>
                <span>{t('colSourceIp')}</span>
              </div>

              {/* chain motif — append-only, visibly linked */}
              <div className="absolute left-4 top-9 bottom-0 w-px bg-line" aria-hidden />

              {/* แถวทั้งหมดยุบเหลือ 0 เมื่อไม่มีอะไรตรงตัวกรอง — ต้องบอก ไม่ใช่ปล่อยว่างเปล่า */}
              {api.loading ? (
                <div className="px-5 py-4"><SkeletonLoader type="table" /></div>
              ) : fetchError ? (
                <ErrorState t={t} kind={fetchError} onRetry={api.retry} />
              ) : placeholderMode ? (
                <DependencyUnavailableState t={t} title={t('auditUnavailable')} compact className="mx-4 my-3" />
              ) : events.length === 0 ? (
                <InlineEmptyState className="justify-start pl-10">{t('emptyNoAudit')}</InlineEmptyState>
              ) : visibleCount === 0 ? (
                <p role="status" className="px-4 pl-10 h-10 flex items-center text-[12.5px] text-ink-3">
                  {t('emptyNoAuditFiltered')}
                </p>
              ) : null}

              {!api.loading && !fetchError && events.map((e, i) => {
                const bad = e.result !== 'OK'
                const shown = visible(e)
                return (
                  <div
                    key={`${e.at}-${i}`}
                    className="overflow-hidden transition-[max-height,opacity] duration-[var(--dur-base)]"
                    style={{ maxHeight: shown ? 40 : 0, opacity: shown ? 1 : 0, transitionTimingFunction: 'var(--ease)' }}
                  >
                    <div
                      data-result={bad ? 'denied' : 'ok'}
                      className="neo-table-row relative grid gap-3 items-center px-4 pl-10 h-10 border-b border-line text-[12.5px] rise-in"
                      style={{
                        gridTemplateColumns: '150px minmax(140px,1.2fr) 130px minmax(170px,1.6fr) 84px 118px',
                        animationDelay: `${Math.min(i * 25, 400)}ms`,
                        // A denied row reads through its tint, red chain node and
                        // result chip; no side-stripe accent.
                        background: bad ? 'var(--danger-soft)' : 'transparent',
                      }}
                    >
                      {/* chain node */}
                      <span aria-hidden className="absolute left-[13px] size-[7px] rounded-full border bg-card" style={{ borderColor: bad ? 'var(--danger)' : 'var(--ink-3)' }} />
                      <span className="font-mono text-[11.5px] text-ink-2 whitespace-nowrap">{fmtStamp(e.at)}</span>
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-ink">{e.actor}</span>
                        <span className="text-ink-3"> · {e.role}</span>
                      </span>
                      <span className="font-mono text-[11.5px] text-ink-2 whitespace-nowrap">{e.action}</span>
                      {/* เป้าหมายแสดงเป็น hash เสมอ — ไม่มีชื่อไฟล์จริงบนจอนี้ */}
                      <span className="font-mono text-[11px] text-ink-2 truncate" title={e.targetHash ?? undefined}>
                        {e.targetHash ? `${e.targetHash.slice(0, 8)}·${e.targetHash.slice(8, 16)}·…` : '—'}
                      </span>
                      <span>
                        <Chip tone={bad ? 'danger' : 'ok'}>{t(RES_LABEL[e.result] ?? 'resOk')}</Chip>
                      </span>
                      <span className="font-mono text-[11.5px] text-ink-2 whitespace-nowrap">{e.ip}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
    </div>
  )
}
