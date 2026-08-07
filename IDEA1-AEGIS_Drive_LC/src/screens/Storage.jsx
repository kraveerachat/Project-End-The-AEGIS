import { HardDrive, Database, Archive } from 'lucide-react'
import {
  Card, CardTitle, Btn, ErrorState, InlineEmptyState, SkeletonLoader, NotYetImplemented,
} from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { fmtBytes } from '../lib/format.js'

/* ── จอนี้เคยเป็นแหล่งข้อมูลปลอมที่อันตรายที่สุดในแอป ────────────────────────────────
   ของเดิมแสดง: ดิสก์สองลูก 'WD Red Pro 4TB' พร้อม serial (WD-WX32DA8L7K4N /
   WD-WX32DA8L2C9F), อุณหภูมิ 38°C และ 41°C, 'SMART: PASSED', ชั่วโมงทำงาน 14,208
   และ backup job สามงาน (Nightly incremental / Vault ciphertext replica / PostgreSQL
   WAL archive) ที่มี lastRun และ nextRun เดินอยู่ — **ทั้งหมด hard-code ไว้ใน store.js
   ไม่มีค่าใดถูกอ่านมาจากที่ไหนเลย** ฮาร์ดแวร์ชุดนั้นไม่มีอยู่ใน deployment นี้ และไม่มี
   backup job ใดถูกตั้งค่าไว้ที่ไหน

   ทำไมมันร้ายกว่าตัวเลขผิดธรรมดา: ผู้ดูแลที่เห็น "SMART: PASSED" จะเลิกตรวจสุขภาพดิสก์
   และผู้ที่เห็น "Nightly incremental · ok · 9 ชั่วโมงที่แล้ว" จะเชื่อว่ามีสำเนาข้อมูลอยู่จริง
   สองความเชื่อนั้นคือสิ่งที่ทำให้คนไม่ทำสำรองข้อมูลจนถึงวันที่ดิสก์เสีย

   ทำไมอ่านค่าจริงไม่ได้ (ตรวจแล้ว ไม่ใช่สันนิษฐาน): smartctl/mdadm ไม่ได้ติดตั้งใน image
   (node:20-alpine) และต้องเข้าถึง raw device ซึ่งต้อง CAP_SYS_RAWIO หรือ privileged —
   compose ไม่ได้ให้ และคอนเทนเนอร์รันด้วย user 'node' ไม่ใช่ root; ส่วน mdadm ต้องอ่าน
   /proc/mdstat ของโฮสต์ และ deployment นี้ไม่มี RAID array อยู่เลย
   การได้ค่าจริงต้องเพิ่มสิทธิ์ระดับโฮสต์ = เปลี่ยน infrastructure ไม่ใช่เขียนโค้ดเพิ่ม

   สิ่งที่เหลืออยู่บนจอนี้จึงเป็นของจริงล้วน: ความจุจาก statfs ของ mount ที่ Data Lake อยู่
   และการแบ่งตามหมวดจากผลรวมในฐานข้อมูล ส่วนที่วัดไม่ได้ถูกประกาศว่าวัดไม่ได้ */

const SEG = [
  { key: 'docs', color: 'var(--accent)' },
  { key: 'archives', color: 'var(--ink-3)' },
  { key: 'media', color: 'var(--violet)' },
  { key: 'vaultSeg', color: 'var(--ink)' },
  { key: 'versions', color: 'var(--warn)' },
  { key: 'other', color: 'var(--accent-ink)' },
]

/* ── Capacity — ตัวเลขจาก statfs; ส่วนว่างเป็นลายขวาง = ไม่มีอะไรอยู่ตรงนั้น ── */
function CapacityCard({ t, capacityBytes, usage, unaccountedBytes }) {
  const total = capacityBytes?.totalBytes ?? 0
  const segs = SEG
    .map((s) => ({ ...s, bytes: usage?.[s.key] ?? 0 }))
  const unaccounted = unaccountedBytes ?? 0
  const free = capacityBytes?.freeBytes ?? 0
  const pct = (b) => (total > 0 ? (b / total) * 100 : 0)
  const amount = (bytes) => bytes === 0 ? t('storageZeroGb') : fmtBytes(bytes)

  return (
    <Card className="p-5">
      <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>

      <div className="relative flex items-center gap-0.5 h-10 rounded-full border border-line bg-sunken hatch hatch-ink3 overflow-hidden" aria-hidden>
        {segs.map((seg, i) => (
          <div
            key={seg.key}
            className={`h-9 relative z-[1] ${i === 0 ? 'rounded-l-full' : ''}`}
            style={{ width: `${pct(seg.bytes)}%`, backgroundColor: seg.color, minWidth: seg.bytes > 0 ? 2 : 0 }}
          />
        ))}
        {unaccounted > 0 && (
          <div className="h-9" style={{ width: `${pct(unaccounted)}%`, backgroundColor: 'var(--line)' }} />
        )}
        <div
          className="h-9 relative z-[1] hatch hatch-ink3 rounded-r-full"
          style={{ width: `${pct(free)}%`, backgroundColor: 'var(--card-sunken)' }}
        />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 mt-4">
        {segs.map((seg) => (
          <span key={seg.key} className="flex items-center gap-2 text-[13px]">
            <span className="size-3 rounded-[4px]" style={{ backgroundColor: seg.color }} aria-hidden />
            <span className="font-medium text-ink-2">{t(seg.key)}</span>
            <span className="text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {amount(seg.bytes)}
            </span>
          </span>
        ))}
        {unaccounted > 0 && (
          // ⚠️ ไบต์ที่ statfs นับว่าใช้ไปแต่แอปไม่รู้จัก — แสดงแยกแทนที่จะยัดรวมกับหมวดใด
          //    (ไฟล์ของระบบ, ข้อมูลของ container อื่นบน volume เดียวกัน, ไฟล์กำพร้า)
          <span className="flex items-center gap-2 text-[13px]" title={t('unaccountedHint')}>
            <span className="size-3 rounded-[4px]" style={{ backgroundColor: 'var(--line)' }} aria-hidden />
            <span className="font-medium text-ink-2">{t('unaccounted')}</span>
            <span className="text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(unaccounted)}</span>
          </span>
        )}
        <span className="flex items-center gap-2 text-[13px]">
          <span className="size-3 rounded-[4px] hatch hatch-ink3 border border-line" style={{ backgroundColor: 'var(--card-sunken)' }} aria-hidden />
          <span className="font-medium text-ink-2">{t('free')}</span>
          <span className="text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{amount(free)}</span>
        </span>
      </div>

      <div className="mt-4 pt-3 border-t border-line flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-ink-2">
        <span>{t('capacityTotal')}: <span className="font-mono text-ink">{amount(total)}</span></span>
        <span>{t('capacityUsed')}: <span className="font-mono text-ink">{amount(capacityBytes?.usedBytes ?? 0)}</span></span>
        <span>
          {t('capacityUsedPct')}: <span className="font-mono text-ink">
            {total > 0 ? Math.round(((capacityBytes?.usedBytes ?? 0) / total) * 100) : 0}%
          </span>
        </span>
      </div>
    </Card>
  )
}

export function Storage({ t, go, placeholderMode = false }) {
  const api = useApi('/api/storage', { refreshMs: 60_000 })
  const d = placeholderMode ? {} : (api.data ?? {})
  const fetchError = visibleFetchError(api.error, placeholderMode)

  return (
    <div className="flex flex-col gap-5">
      {api.loading && <Card className="p-5"><SkeletonLoader type="table" /></Card>}
      {fetchError && <Card><ErrorState t={t} kind={fetchError} onRetry={api.retry} /></Card>}
      <CapacityCard
        t={t}
        capacityBytes={d.capacityBytes}
        usage={d.usage}
        unaccountedBytes={d.unaccountedBytes}
      />

      {/* ── สิ่งที่ deployment นี้ยังวัดไม่ได้ — ประกาศไว้ชัด ๆ พร้อมเหตุผล ────────
          เว้นไว้เฉย ๆ จะอ่านเหมือน "ยังไม่ได้ทำ" หรือ "ลืม" การเขียนเหตุผลไว้ทำให้คนอ่าน
          ครั้งต่อไปรู้ว่ามันถูกพิจารณาแล้ว และรู้ว่าต้องเปลี่ยนอะไรถ้าจะให้มันเป็นจริง */}
      <Card className="p-5">
        <CardTitle>{t('diskHealth')}</CardTitle>
        <div className="flex items-start gap-3">
          <HardDrive size={16} strokeWidth={1.5} className="text-ink-3 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <NotYetImplemented label={t('notAvailable')}>{t('diskHealthWhy')}</NotYetImplemented>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
        <Card className="p-5">
          <CardTitle>{t('raidStatus')}</CardTitle>
          <div className="flex items-start gap-3">
            <Database size={16} strokeWidth={1.5} className="text-ink-3 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <NotYetImplemented label={t('notConnected')}>{t('raidWhy')}</NotYetImplemented>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <CardTitle>{t('backupJobs')}</CardTitle>
          <div className="overflow-x-auto rounded-[var(--r-tile)] border border-line">
            <div className="min-w-[520px]">
              <div className="grid grid-cols-[1fr_120px_120px] gap-3 px-4 h-9 items-center bg-sunken border-b border-line text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em]">
                <span>{t('backupTarget')}</span>
                <span>{t('backupSchedule')}</span>
                <span>{t('colStatus')}</span>
              </div>
              <InlineEmptyState
                action={
                  <Btn variant="outline" size="sm" onClick={() => go?.('settings')}>
                    <Archive size={13} strokeWidth={1.5} />
                    {t('setupNow')}
                  </Btn>
                }
              >
                {t('backupScheduleEmpty')}
              </InlineEmptyState>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
