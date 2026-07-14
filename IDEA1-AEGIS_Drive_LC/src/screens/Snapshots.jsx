import { useMemo, useState } from 'react'
import { RotateCcw, Check } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Modal, ModalClose, Th, Progress } from '../components/ui.jsx'
import { useReducedMotion } from '../lib/hooks.js'
import { fmtDateTime } from '../lib/format.js'
import { SNAPSHOTS } from '../lib/data.js'

const parseDelta = (d) => {
  const n = parseFloat(d.replace(/[+ ]/g, ''))
  return d.includes('MB') ? n / 1024 : n
}

export function Snapshots({ t, lang, onRollback }) {
  const reduced = useReducedMotion()
  const snaps = useMemo(() => [...SNAPSHOTS].reverse(), []) // oldest → newest, left → right
  const [markerIdx, setMarkerIdx] = useState(snaps.length) // = "now", right end
  const [destroyed, setDestroyed] = useState(new Set())
  const [selected, setSelected] = useState(null)
  const [ask, setAsk] = useState(null)
  const [confirmText, setConfirmText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | restoring | done
  const [progress, setProgress] = useState(0)
  const [restoredId, setRestoredId] = useState(null)
  const [hovered, setHovered] = useState(null)

  const posOf = (i) => `${(i / snaps.length) * 100}%`

  const beginRollback = () => {
    const snap = ask
    setAsk(null)
    setConfirmText('')
    setPhase('restoring')
    setProgress(0)
    const targetIdx = snaps.findIndex((s) => s.id === snap.id)
    setMarkerIdx(targetIdx) // the marker slides right → left along the axis

    const total = reduced ? 1 : 2400
    const t0 = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / total)
      setProgress(Math.round(p * 100))
      if (p < 1) requestAnimationFrame(tick)
      else {
        // everything newer than the target is destroyed — hatched from now on
        const newer = snaps.slice(targetIdx + 1).map((s) => s.id)
        setDestroyed(new Set(newer))
        const lostGB = snaps.slice(targetIdx + 1).reduce((s, x) => s + parseDelta(x.delta), 0)
        onRollback(lostGB) // dashboard metrics count backward to historical values
        setRestoredId(snap.id)
        setPhase('done')
      }
    }
    requestAnimationFrame(tick)
  }

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

      {/* timeline — most recent on the right */}
      <Card className="p-5 pb-7">
        <CardTitle>{t('snapshotTimeline')}</CardTitle>
        <div className="relative h-10 mx-3">
          <div className="absolute left-0 right-0 top-1/2 h-px bg-line" aria-hidden />
          {snaps.map((s, i) => {
            const dead = destroyed.has(s.id)
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
          {/* the current-state marker — slides backward on rollback */}
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
                const dead = destroyed.has(s.id)
                return (
                  <tr
                    key={s.id}
                    className={`border-b border-line last:border-b-0 transition-colors duration-[var(--dur-fast)] rise-in ${dead ? 'hatch hatch-ink3' : 'hover:bg-sunken'}`}
                    style={{ height: 'var(--row-h)', animationDelay: `${i * 25}ms`, opacity: dead ? 0.55 : 1 }}
                  >
                    <td className="px-4 pl-5 font-mono text-[12.5px] text-ink">{s.id}</td>
                    <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{fmtDateTime(s.time, lang)}</td>
                    <td className="px-4 text-[13px] text-ink-2" style={{ fontVariantNumeric: 'tabular-nums' }}>{s.delta}</td>
                    <td className="px-4">
                      <Chip tone={s.verified ? 'ok' : 'warn'}>{s.verified ? t('integrityOk') : t('integrityPending')}</Chip>
                    </td>
                    <td className="px-4 text-right">
                      <Btn variant="outline" size="sm" disabled={dead || phase === 'restoring'} onClick={() => setAsk(s)}>
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

      {/* heavy confirmation — type the snapshot ID */}
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
                  delta: `${snaps.slice(snaps.findIndex((s) => s.id === ask.id) + 1).reduce((s, x) => s + parseDelta(x.delta), 0).toFixed(1)} GB`,
                })}
              </p>
            </div>
            <label htmlFor="rb-confirm" className="block text-[13px] font-medium text-ink-2 mt-5 mb-1.5">
              {t('rollbackTypeToConfirm')} — <span className="font-mono font-semibold text-ink">{ask.id}</span>
            </label>
            <input
              id="rb-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={ask.id}
              autoComplete="off"
              className="w-full h-12 px-4 rounded-full bg-sunken border border-line font-mono text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
            <div className="flex gap-2.5 mt-5">
              <Btn variant="outline" className="flex-1" onClick={() => { setAsk(null); setConfirmText('') }}>{t('cancel')}</Btn>
              <Btn variant="danger" className="flex-1" disabled={confirmText !== ask.id} onClick={beginRollback}>
                {t('rollbackConfirm')}
              </Btn>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
