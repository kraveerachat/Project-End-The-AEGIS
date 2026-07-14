import { useEffect, useRef, useState } from 'react'
import { UploadCloud, FileText, File as FileIcon, Shield, Sparkles } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, ScrambleHash } from '../components/ui.jsx'
import { useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtBytes, fmtRelative } from '../lib/format.js'
import { FILES } from '../lib/data.js'

const STAGES = ['staged', 'encrypting', 'transferring', 'hashing', 'indexed']
const STAGE_KEY = { staged: 'stStaged', encrypting: 'stEncrypting', transferring: 'stTransferring', hashing: 'stHashing', indexed: 'stIndexed' }

const HEXC = '0123456789abcdef'
const randHash = () => Array.from({ length: 64 }, () => HEXC[(Math.random() * 16) | 0]).join('')

const SIM_FILES = [
  { name: 'meeting-notes_2026-07-14.docx', size: 234_881 },
  { name: 'invoice_TH-2026-0847.pdf', size: 1_204_224 },
  { name: 'site-survey_photos.zip', size: 68_812_800 },
  { name: 'inventory-export_jul.xlsx', size: 3_412_990 },
  { name: 'training-video_onboarding.mp4', size: 214_748_364 },
]

/* One upload row — drives itself through the five visible stages. */
function UploadRow({ t, item, onIndexed }) {
  const reduced = useReducedMotion()
  const [stage, setStage] = useState('staged')
  const [progress, setProgress] = useState(0)
  const [rate, setRate] = useState(0)
  const doneRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const timers = []
    const later = (fn, ms) => timers.push(setTimeout(fn, reduced ? 1 : ms))

    const encMs = 900
    const xferMs = Math.min(4200, 1400 + item.size / 300_000)

    later(() => !cancelled && setStage('encrypting'), 350)
    later(() => {
      if (cancelled) return
      setStage('transferring')
      const mbps = 40 + Math.random() * 55
      setRate(mbps)
      const t0 = performance.now()
      const tick = () => {
        if (cancelled) return
        const p = Math.min(1, (performance.now() - t0) / (reduced ? 1 : xferMs))
        setProgress(Math.round(p * 100))
        if (p < 1) requestAnimationFrame(tick)
        else setStage('hashing')
      }
      requestAnimationFrame(tick)
    }, 350 + encMs)

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [item, reduced])

  const isEnc = stage === 'encrypting'
  const isCipher = STAGES.indexOf(stage) >= 1 && stage !== 'indexed'
  const chipTone = stage === 'indexed' ? 'ok' : stage === 'staged' ? 'neutral' : 'accent'

  return (
    <div
      className="relative overflow-hidden rounded-[var(--r-tile)] border border-line transition-colors duration-[var(--dur-base)]"
      style={{ background: stage === 'indexed' ? 'var(--ok-soft)' : 'var(--card)' }}
    >
      {/* the file becoming ciphertext before your eyes */}
      <div
        aria-hidden
        className="absolute inset-0 hatch hatch-ink3 pointer-events-none transition-[clip-path,opacity]"
        style={{
          clipPath: isEnc || isCipher ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
          opacity: isEnc ? 0.9 : isCipher ? 0.28 : 0,
          transitionDuration: isEnc ? '900ms' : 'var(--dur-base)',
          transitionTimingFunction: 'var(--ease)',
        }}
      />
      <div className="relative flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-[9px] bg-sunken flex items-center justify-center shrink-0">
          <FileIcon size={15} strokeWidth={1.5} className="text-ink-2" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink truncate">{item.name}</p>
          <p className="text-[11.5px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtBytes(item.size)}
            {stage === 'transferring' && ` · ${progress}% · ${rate.toFixed(0)} MB/s`}
          </p>
        </div>
        {stage === 'indexed' && (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
          </svg>
        )}
        <Chip tone={chipTone}>{t(STAGE_KEY[stage])}</Chip>
      </div>

      {(stage === 'hashing' || stage === 'indexed') && (
        <div className="relative px-4 pb-3 -mt-1">
          <ScrambleHash
            hash={item.sha256}
            playing={stage === 'hashing'}
            duration={900}
            onDone={() => {
              setStage('indexed')
              if (!doneRef.current) {
                doneRef.current = true
                onIndexed(item)
              }
            }}
            groupClass="text-ink-3 !text-[10.5px]"
          />
        </div>
      )}

      {/* thin live progress under the row */}
      <div className="relative h-0.5 bg-transparent">
        <div
          className="h-full transition-[width] duration-150"
          style={{
            width: stage === 'transferring' ? `${progress}%` : stage === 'staged' || stage === 'encrypting' ? '0%' : '100%',
            background: stage === 'indexed' ? 'var(--ok)' : 'var(--accent)',
          }}
        />
      </div>
    </div>
  )
}

export function Uploads({ t, onStorageAdded }) {
  const now = useNow(30_000)
  const [dragOver, setDragOver] = useState(false)
  const [queue, setQueue] = useState([])
  const inputRef = useRef(null)
  const idRef = useRef(0)

  const enqueue = (files) => {
    const items = files.map((f) => ({
      id: `up-${idRef.current++}`,
      name: f.name,
      size: f.size || 1_048_576,
      sha256: randHash(),
    }))
    setQueue((prev) => [...items, ...prev])
  }

  const simulate = () => {
    const pick = [...SIM_FILES].sort(() => Math.random() - 0.5).slice(0, 3)
    enqueue(pick)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer?.files ?? [])
    enqueue(dropped.length ? dropped.map((f) => ({ name: f.name, size: f.size })) : SIM_FILES.slice(0, 2))
  }

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
      <div className="col-span-12">
        {/* drop zone — crisp, instant */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t('dropHere')}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className="flex flex-col items-center justify-center gap-2 rounded-[20px] py-12 px-6 cursor-pointer transition-[background-color,border-color,transform] duration-[var(--dur-fast)] text-center"
          style={{
            border: dragOver ? '2px solid var(--accent)' : '2px dashed var(--line)',
            background: dragOver ? 'var(--accent-soft)' : 'var(--card-sunken)',
            transform: dragOver ? 'scale(1.01)' : 'scale(1)',
            transitionTimingFunction: 'var(--ease)',
          }}
        >
          <UploadCloud size={28} strokeWidth={1.5} style={{ color: dragOver ? 'var(--accent)' : 'var(--ink-3)' }} />
          <p className="text-[15px] font-semibold text-ink">{t('dropHere')}</p>
          <p className="text-[12.5px] text-ink-3">{t('dropSub')}</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []).map((f) => ({ name: f.name, size: f.size }))
              if (files.length) enqueue(files)
              e.target.value = ''
            }}
          />
        </div>
        <div className="flex justify-end mt-3">
          <Btn variant="ghost" size="sm" onClick={simulate}>
            <Sparkles size={13} strokeWidth={1.5} />
            {t('simulateUpload')}
          </Btn>
        </div>
      </div>

      {queue.length > 0 && (
        <div className="col-span-12 flex flex-col gap-2.5">
          {queue.map((item) => (
            <UploadRow key={item.id} t={t} item={item} onIndexed={(it) => onStorageAdded(it.size / 1_073_741_824)} />
          ))}
        </div>
      )}

      <div className="col-span-12">
        <Card className="p-5">
          <CardTitle>{t('recentUploads')}</CardTitle>
          <div className="flex flex-col">
            {FILES.slice(0, 6).map((f) => (
              <div key={f.id} className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0">
                <FileText size={15} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                <span className="text-[13.5px] font-medium text-ink truncate flex-1 min-w-0">{f.name}</span>
                <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-md:hidden" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(f.size)}</span>
                <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-md:hidden">{f.uploader}</span>
                <span className="text-[12.5px] text-ink-3 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRelative(t, f.modified, now)}</span>
                <span
                  className={`inline-flex items-center justify-center size-6 rounded-[7px] shrink-0 ${f.vault ? 'hatch hatch-ink3 border border-line bg-sunken' : ''}`}
                  style={f.vault ? {} : { background: 'var(--accent)' }}
                  title={f.vault ? t('encVault') : t('encServer')}
                >
                  <Shield size={12} strokeWidth={1.8} style={{ color: f.vault ? 'var(--ink-3)' : '#fff' }} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
