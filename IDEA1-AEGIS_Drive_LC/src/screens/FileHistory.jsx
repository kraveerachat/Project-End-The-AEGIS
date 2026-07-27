import { useState } from 'react'
import { History, RotateCcw, Download, FileText, Info } from 'lucide-react'
import {
  Card, CardTitle, Chip, Btn, Modal, ModalClose, ErrorState, EmptyState, SkeletonLoader,
} from '../components/ui.jsx'
import { useApi, useNow } from '../lib/hooks.js'
import { apiFetch, apiUrl } from '../lib/api.js'
import { fmtRelative, fmtDateTime, fmtBytes } from '../lib/format.js'

/* ── จอนี้แทนที่ "Snapshots" ที่เป็นของปลอมทั้งหมด ────────────────────────────────
   ของเดิม: แปดแถว snap-0086…snap-0093 ที่ hard-code ไว้ใน store.js พร้อม deltaGB และ
   ธง verified แล้วปุ่ม rollback ยิง POST ที่ไป "ตั้งธง destroyed" ให้แถวที่ใหม่กว่า
   เป้าหมาย — แถบความคืบหน้าเดินสวย ๆ 2.4 วินาที จอขึ้นว่า restored แล้วบอกจำนวน GB
   ที่ "เสียไป" **โดยไม่มีไบต์ของใครถูกกู้คืนเลยแม้แต่ไบต์เดียว** นั่นคือการโกหกในเรื่องที่
   ผู้ใช้พึ่งพามันที่สุด: การกู้ข้อมูล

   ทำไมไม่ทำ snapshot ของจริง: Data Lake อยู่บน Docker named volume ธรรมดา ไม่ใช่
   LVM/ZFS/Btrfs และคอนเทนเนอร์รันด้วย user 'node' ไม่มี CAP_SYS_ADMIN — point-in-time
   image ของทั้งชั้นเก็บไฟล์ทำไม่ได้ด้วยของที่มีอยู่ (ต้องเปลี่ยน infrastructure)

   สิ่งที่ทำได้จริงและกู้ข้อมูลได้จริงคือ "ประวัติต่อไฟล์": อัปโหลดชื่อเดิมทับ → ไบต์ชุดเก่า
   ถูกเก็บไว้ กดกู้คืน → ไบต์ชุดนั้นกลับมาเป็นไฟล์ปัจจุบันจริง ๆ จอจึงใช้ชื่อที่ตรงกับ
   สิ่งที่มันทำ และการ์ดด้านล่างบอกขอบเขตที่ต่างจาก snapshot ไว้ตรง ๆ ไม่ซ่อน */

function ScopeNote({ t }) {
  return (
    <div className="rounded-[var(--r-tile)] p-4 flex gap-3" style={{ background: 'var(--warn-soft)' }}>
      <Info size={16} strokeWidth={1.8} style={{ color: 'var(--warn)' }} className="shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold leading-relaxed" style={{ color: 'var(--warn)' }}>
          {t('versionsScopeTitle')}
        </p>
        <p className="text-[12.5px] leading-relaxed mt-1" style={{ color: 'var(--warn)' }}>
          {t('versionsScopeBody')}
        </p>
      </div>
    </div>
  )
}

export function FileHistory({ t, lang }) {
  const now = useNow(30_000)
  const listApi = useApi('/api/file-versions')
  const files = listApi.data?.files ?? []
  const stats = listApi.data?.stats

  const [selectedId, setSelectedId] = useState(null)
  const activeId = selectedId ?? files.find((f) => f.versionCount > 0)?.id ?? files[0]?.id ?? null
  const detailApi = useApi(activeId ? `/api/files/${encodeURIComponent(activeId)}/versions` : null)
  const versions = detailApi.data?.versions ?? []
  const current = detailApi.data?.file

  const [ask, setAsk] = useState(null)      // เวอร์ชันที่กำลังยืนยันจะกู้คืน
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // null | 'ok' | 'error'

  const restore = async () => {
    if (!ask || busy) return
    setBusy(true)
    setResult(null)
    const res = await apiFetch(
      `/api/files/${encodeURIComponent(activeId)}/versions/${encodeURIComponent(ask.id)}/restore`,
      { method: 'POST' },
    )
    setBusy(false)
    setAsk(null)
    setResult(res.ok ? 'ok' : 'error')
    if (res.ok) { detailApi.retry(); listApi.retry() }
  }

  if (listApi.loading) return <SkeletonLoader type="table" />
  if (listApi.error) return <Card><ErrorState t={t} kind={listApi.error} onRetry={listApi.retry} /></Card>

  return (
    <div className="flex flex-col gap-5">
      {result && (
        <div
          role="status"
          className="rounded-[var(--r-tile)] px-4 py-3 text-[13px] font-medium"
          style={result === 'ok'
            ? { background: 'var(--ok-soft, color-mix(in srgb, var(--ok) 12%, transparent))', color: 'var(--ok)' }
            : { background: 'var(--danger-soft)', color: 'var(--danger)' }}
        >
          {result === 'ok' ? t('versionRestored') : t('actionFailed')}
        </div>
      )}

      <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
        {/* ── ไฟล์ของฉัน ─────────────────────────────────────────────── */}
        <div className="col-span-4 max-lg:col-span-12">
          <Card className="overflow-hidden">
            <div className="px-5 pt-5 pb-3 flex items-center gap-2">
              <FileText size={16} strokeWidth={1.5} className="text-ink-3" />
              <h2 className="text-[15px] font-semibold text-ink">{t('versionsMyFiles')}</h2>
              {stats && <Chip tone="neutral" className="ml-auto">{stats.versions}</Chip>}
            </div>
            {files.length === 0 ? (
              <EmptyState icon={FileText} title={t('emptyNoFiles')} hint={t('versionsEmptyHint')} />
            ) : (
              <div className="flex flex-col">
                {files.map((f) => {
                  const active = String(f.id) === String(activeId)
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => { setSelectedId(f.id); setResult(null) }}
                      aria-current={active ? 'true' : undefined}
                      className={`text-left px-5 py-3 border-b border-line last:border-b-0 transition-colors duration-[var(--dur-fast)] cursor-pointer ${
                        active ? 'bg-sunken' : 'hover:bg-sunken'
                      }`}
                    >
                      <span className="block text-[13.5px] font-medium text-ink truncate">{f.name}</span>
                      <span className="block text-[11.5px] text-ink-3 mt-0.5">
                        {f.versionCount === 0
                          ? t('versionsNone')
                          : t('versionsCount', { n: String(f.versionCount) })}
                        {f.latestVersionAt ? ` · ${fmtRelative(t, f.latestVersionAt, now)}` : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        {/* ── ประวัติของไฟล์ที่เลือก ──────────────────────────────────── */}
        <div className="col-span-8 max-lg:col-span-12 flex flex-col gap-5">
          <Card className="overflow-hidden">
            <div className="px-5 pt-5 pb-3 flex items-center gap-2 flex-wrap">
              <History size={16} strokeWidth={1.5} className="text-ink-3" />
              <h2 className="text-[15px] font-semibold text-ink truncate">
                {current?.name ?? t('versionsTitle')}
              </h2>
            </div>

            {detailApi.loading ? (
              <div className="px-5 pb-5"><SkeletonLoader type="table" /></div>
            ) : detailApi.error ? (
              <ErrorState t={t} kind={detailApi.error} onRetry={detailApi.retry} />
            ) : !current ? (
              <EmptyState icon={History} title={t('versionsPickFile')} />
            ) : (
              <div className="flex flex-col">
                {/* แถวปัจจุบัน — แยกให้เห็นชัดว่าอันไหนคือของที่ใช้อยู่ตอนนี้ */}
                <div className="flex items-center gap-3 px-5 py-3.5 border-b border-line flex-wrap bg-sunken">
                  <Chip tone="accent">{t('versionCurrent')}</Chip>
                  <span className="text-[13px] text-ink-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {fmtBytes(current.size)}
                  </span>
                  <span className="text-[12px] text-ink-3">{fmtDateTime(current.modified, lang)}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] text-ink-3 truncate max-w-[16ch]" title={current.sha256 ?? ''}>
                    {current.sha256 ? current.sha256.slice(0, 12) : '—'}
                  </span>
                </div>

                {versions.length === 0 ? (
                  <EmptyState icon={History} title={t('versionsNone')} hint={t('versionsEmptyHint')} />
                ) : (
                  versions.map((v) => (
                    <div key={v.id} className="flex items-center gap-3 px-5 py-3.5 border-b border-line last:border-b-0 flex-wrap">
                      <span className="text-[13px] text-ink-2 min-w-[9ch]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtBytes(v.size)}
                      </span>
                      <span className="text-[12px] text-ink-3 min-w-[14ch]">{fmtDateTime(v.createdAt, lang)}</span>
                      {v.supersededByName && (
                        <span className="text-[11.5px] text-ink-3 truncate max-w-[18ch]">
                          {t('versionSupersededBy')} {v.supersededByName}
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className="font-mono text-[11px] text-ink-3 truncate max-w-[16ch]" title={v.sha256 ?? ''}>
                        {v.sha256 ? v.sha256.slice(0, 12) : '—'}
                      </span>
                      {/* ดาวน์โหลดก่อนกู้ได้ — ตรวจให้แน่ใจว่าเป็นตัวที่ต้องการจริง */}
                      <a
                        href={apiUrl(`/api/files/${encodeURIComponent(activeId)}/versions/${encodeURIComponent(v.id)}/download`)}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-line text-[12.5px] font-medium text-ink-2 hover:bg-sunken transition-colors duration-[var(--dur-fast)]"
                      >
                        <Download size={13} strokeWidth={1.6} />
                        {t('download')}
                      </a>
                      <Btn variant="outline" size="sm" onClick={() => { setAsk(v); setResult(null) }}>
                        <RotateCcw size={13} strokeWidth={1.6} />
                        {t('versionRestore')}
                      </Btn>
                    </div>
                  ))
                )}
              </div>
            )}
          </Card>

          <ScopeNote t={t} />
        </div>
      </div>

      {/* ยืนยันการกู้คืน — ไม่ต้องพิมพ์ id เหมือนของเดิม เพราะการกระทำนี้ "ไม่ทำลายอะไร"
          ไบต์ปัจจุบันถูกเก็บเป็นเวอร์ชันใหม่ก่อนเสมอ กู้ผิดตัวก็กู้กลับได้ — การบังคับพิมพ์
          ยืนยันสำหรับการกระทำที่ย้อนกลับได้คือพิธีกรรมที่สอนให้ผู้ใช้กดผ่านไปเฉย ๆ */}
      <Modal open={!!ask} onClose={() => setAsk(null)} width={460} labelledBy="restore-title">
        <ModalClose onClose={() => setAsk(null)} label={t('cancel')} />
        <h2 id="restore-title" className="text-[18px] font-semibold text-ink">{t('versionRestoreTitle')}</h2>
        <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">
          {ask && t('versionRestoreBody', { when: fmtDateTime(ask.createdAt, lang) })}
        </p>
        <p className="text-[12.5px] text-ink-3 mt-2 leading-relaxed">{t('versionRestoreSafe')}</p>
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setAsk(null)}>{t('cancel')}</Btn>
          <Btn variant="primary" className="flex-1" onClick={restore} disabled={busy}>
            {busy ? t('versionRestoring') : t('versionRestore')}
          </Btn>
        </div>
      </Modal>
    </div>
  )
}
