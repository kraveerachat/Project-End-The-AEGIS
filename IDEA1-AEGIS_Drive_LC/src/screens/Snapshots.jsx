import { useMemo, useState } from 'react'
import { RotateCcw, Check, History } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Modal, ModalClose, Th, Progress, ErrorState, EmptyState, SkeletonLoader } from '../components/ui.jsx'
import { useApi, useReducedMotion } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'
import { fmtDateTime } from '../lib/format.js'

/* ⚠️ Phase 2: snapshot มาจาก GET /api/snapshots — rollback คือ POST จริง
   การยืนยันมีชั้นเดียวและเป็น Modal พิมพ์ id (ไม่มี confirm() ของเบราว์เซอร์)
   — ผู้ใช้ต้องพิมพ์ชื่อ snapshot เอง เพราะนี่คือการกระทำที่ทำลายข้อมูลที่ใหม่กว่า */

export function Snapshots({ t, lang }) {
  const reduced = useReducedMotion()
  const snapsApi = useApi('/api/snapshots')
  // เก่า → ใหม่ ซ้าย → ขวา (เส้นเวลา); ตารางแสดงใหม่ → เก่า
  const snaps = useMemo(() => [...(snapsApi.data?.snapshots ?? [])].reverse(), [snapsApi.data])

  const [selected, setSelected] = useState(null)
  const [ask, setAsk] = useState(null)
  const [confirmText, setConfirmText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | restoring | done | failed
  const [progress, setProgress] = useState(0)
  const [restoredId, setRestoredId] = useState(null)
  const [hovered, setHovered] = useState(null)

  const liveSnaps = snaps.filter((s) => !s.destroyed)
  const markerIdx = snaps.length // "now" — ปลายขวาสุด
  const posOf = (i) => `${(i / Math.max(1, snaps.length)) * 100}%`

  const beginRollback = async () => {
    const snap = ask
    if (!snap) return
    setAsk(null)
    setConfirmText('')
    setPhase('restoring')
    setProgress(0)

    // การ rollback จริงเกิดฝั่งเซิร์ฟเวอร์ — แถบความคืบหน้าเดินคู่ไปกับ request
    const reqPromise = apiFetch(`/api/snapshots/${encodeURIComponent(snap.id)}/rollback`, { method: 'POST' })
    const total = reduced ? 1 : 2400
    const t0 = performance.now()
    await new Promise((resolve) => {
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / total)
        setProgress(Math.round(p * 100))
        if (p < 1) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    const res = await reqPromise
    if (!res.ok) {
      setPhase('failed')
      return
    }
    setRestoredId(snap.id)
    setPhase('done')
    snapsApi.retry() // สถานะจริง (แถวที่ถูกทำลาย) มาจากเซิร์ฟเวอร์
  }

  if (snapsApi.loading) return <SkeletonLoader type="table" />
  if (snapsApi.error) return <Card><ErrorState t={t} kind={snapsApi.error} onRetry={snapsApi.retry} /></Card>

  return (
    <div className="flex flex-col gap-5">
      {phase === 'restoring' && (
        <div className="rounded-[var(--r-tile)] px-4 py-3" style={{ background: 'var(--warn-soft)' }} role="status" aria-live="polite">
          <p className="text-[12.5px] font-semibold tracking-[0.05em] mb-2" style={{ color: 'var(--warn)' }}>{t('restoring')}</p>
          <Progress value={progress} color="var(--warn)" track="color-mix(in srgb, var(--warn) 20%, transparent)" />
        </div>
      )}
      {phase === 'done' && (
        <div className="rounded-[var(--r-tile)] px-4 py-3 flex items-center gap-2.5 fade-in" style={{ background: 'var(--ok-soft)' }} role="status" aria-live="polite">
          <Check size={15} strokeWidth={2} style={{ color: 'var(--ok)' }} />
          <p className="text-[13px] font-semibold" style={{ color: 'var(--ok)' }}>{t('restored', { id: restoredId })}</p>
        </div>
      )}
      {phase === 'failed' && (
        <div className="rounded-[var(--r-tile)] px-4 py-3 flex items-center gap-2.5 fade-in" style={{ background: 'var(--danger-soft)' }} role="alert">
          <p className="text-[13px] font-semibold" style={{ color: 'var(--danger)' }}>{t('actionFailed')}</p>
          <Btn variant="outline" size="sm" className="ml-auto" onClick={() => setPhase('idle')}>{t('retry')}</Btn>
        </div>
      )}

      {snaps.length === 0 ? (
        <Card>
          <EmptyState icon={History} title={t('emptyNoSnapshots')} hint={t('emptyNoSnapshotsHint')} />
        </Card>
      ) : (
        <>
          {/* timeline — most recent on the right */}
          <Card className="p-5 pb-7">
            <CardTitle>{t('snapshotTimeline')}</CardTitle>
            <div className="relative h-10 mx-3">
              <div className="absolute left-0 right-0 top-1/2 h-px bg-line" aria-hidden />
              {snaps.map((s, i) => {
                const dead = s.destroyed
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelected(s.id === selected ? null : s.id)}
                    onMouseEnter={() => setHovered(s.id)}
                    onMouseLeave={() => setHovered(null)}
                    aria-label={`${s.id} · ${fmtDateTime(s.time, lang)}`}
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-6 flex items-center justify-center cursor-pointer group"
                    style={{ left: posOf(i) }}
                  >
                    <span
                      className={`size-3 rounded-full border-2 transition-[background-color,border-color,transform] duration-[var(--dur-fast)] ${dead ? 'hatch hatch-ink3' : ''}`}
                      style={{
                        borderColor: dead ? 'var(--line)' : selected === s.id ? 'var(--accent)' : 'var(--ink-3)',
                        backgroundColor: selected === s.id && !dead ? 'var(--accent-soft)' : 'var(--card)',
                        transform: hovered === s.id ? 'scale(1.35)' : 'scale(1)',
                      }}
                    />
                    {hovered === s.id && (
                      <span
                        className="absolute bottom-7 left-1/2 -translate-x-1/2 bg-card border border-line rounded-[9px] px-2.5 py-1.5 text-[11px] whitespace-nowrap font-medium text-ink"
                        style={{ boxShadow: 'var(--elev-2)', zIndex: 'var(--z-tooltip)' }}
                      >
                        <span className="font-mono">{s.id}</span> · {fmtDateTime(s.time, lang)}
                        {dead && <span className="text-ink-3"> · —</span>}
                      </span>
                    )}
                  </button>
                )
              })}
              {/* the current-state marker */}
              <span
                aria-hidden
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full border-2 transition-[left] duration-[1400ms]"
                style={{ left: posOf(markerIdx), background: 'var(--accent)', borderColor: 'var(--card)', boxShadow: 'var(--elev-1)', transitionTimingFunction: 'var(--ease)' }}
              />
              <span className="absolute -top-1 text-[10px] font-semibold tracking-[0.08em] text-ink-3 transition-[left] duration-[1400ms] -translate-x-1/2" style={{ left: posOf(markerIdx), transitionTimingFunction: 'var(--ease)' }}>
                {t('current')}
              </span>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line bg-sunken">
                    <Th className="pl-5">{t('colId')}</Th>
                    <Th>{t('colTimestamp')}</Th>
                    <Th>{t('colDelta')}</Th>
                    <Th>{t('colVerified')}</Th>
                    <Th> </Th>
                  </tr>
                </thead>
                <tbody>
                  {[...snaps].reverse().map((s, i) => {
                    const dead = s.destroyed
                    return (
                      <tr
                        key={s.id}
                        className={`border-b border-line last:border-b-0 transition-colors duration-[var(--dur-fast)] rise-in ${dead ? 'hatch hatch-ink3' : 'hover:bg-sunken'}`}
                        style={{ height: 'var(--row-h)', animationDelay: `${i * 25}ms`, opacity: dead ? 0.55 : 1 }}
                      >
                        <td className="px-4 pl-5 font-mono text-[12.5px] text-ink">{s.id}</td>
                        <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{fmtDateTime(s.time, lang)}</td>
                        <td className="px-4 text-[13px] text-ink-2" style={{ fontVariantNumeric: 'tabular-nums' }}>+{s.deltaGB} GB</td>
                        <td className="px-4">
                          <Chip tone={s.verified ? 'ok' : 'warn'}>{s.verified ? t('integrityOk') : t('integrityPending')}</Chip>
                        </td>
                        <td className="px-4 text-right">
                          <Btn
                            variant="outline"
                            size="sm"
                            disabled={dead || phase === 'restoring'}
                            onClick={() => { setAsk(s); setConfirmText('') }}
                          >
                            <RotateCcw size={13} strokeWidth={1.5} />
                            {t('rollback')}
                          </Btn>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* rollback confirm — พิมพ์ id เพื่อยืนยัน (การกระทำทำลายข้อมูลที่ใหม่กว่า) */}
      <Modal open={!!ask} onClose={() => { setAsk(null); setConfirmText('') }} width={460} labelledBy="rb-title">
        <ModalClose onClose={() => { setAsk(null); setConfirmText('') }} label={t('cancel')} />
        <h2 id="rb-title" className="text-[18px] font-semibold text-ink">{t('rollbackTitle')}</h2>
        {ask && (
          <>
            <div className="mt-4 flex flex-col gap-2.5">
              <p className="text-[13.5px] leading-relaxed rounded-[10px] px-3.5 py-2.5" style={{ background: 'var(--ok-soft)', color: 'var(--ink)' }}>
                {t('rollbackWhatRestored', { time: fmtDateTime(ask.time, lang) })}
              </p>
              <p className="text-[13.5px] leading-relaxed rounded-[10px] px-3.5 py-2.5" style={{ background: 'var(--danger-soft)', color: 'var(--ink)' }}>
                {t('rollbackWhatLost', {
                  delta: `${liveSnaps.filter((x) => x.time > ask.time).reduce((sum, x) => sum + x.deltaGB, 0).toFixed(1)} GB`,
                })}
              </p>
            </div>
            <label htmlFor="rb-confirm" className="block text-[13px] font-medium text-ink-2 mt-5 mb-1.5">
              {t('rollbackTypeToConfirm')} — <span className="font-mono font-semibold text-ink">{ask.id}</span>
            </label>
            <input
              id="rb-confirm"
              type="text"
              className="w-full font-mono text-[14px] bg-sunken border border-line rounded-[var(--r-tile)] px-3.5 h-10 text-ink focus:outline-none focus:border-accent"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="e.g. snap-0092"
            />
            <div className="flex gap-2.5 mt-6">
              <Btn variant="outline" className="flex-1" onClick={() => { setAsk(null); setConfirmText('') }}>{t('cancel')}</Btn>
              <Btn
                variant="danger"
                className="flex-1"
                disabled={confirmText !== ask.id}
                onClick={beginRollback}
              >
                {t('rollbackAction')}
              </Btn>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
