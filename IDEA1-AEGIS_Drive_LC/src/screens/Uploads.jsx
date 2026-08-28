import { useCallback, useEffect, useRef, useState } from 'react'
import { UploadCloud, FileText, File as FileIcon, RotateCcw } from 'lucide-react'
import { Card, CardTitle, Chip, ScrambleHash, ErrorState, InlineEmptyState } from '../components/ui.jsx'
import { useApi, useNow } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { cancelUploadSession, fetchTransferLimits, uploadFileResumable } from '../lib/chunkedUpload.js'
import { fmtBytes, fmtRelative } from '../lib/format.js'

/* ไม่มีการจำลองในจอนี้เลย —
   - ทุกไฟล์เดินทางผ่านเส้นทาง V2 แบบ chunk ที่ทำต่อจากที่ค้างได้ (LFT-V2-A):
       POST   /api/files/uploads                       เปิด session ที่ทนต่อ restart
       PUT    /api/files/uploads/:id/chunks/:index     ส่งทีละก้อนที่มีขอบเขต
       GET    /api/files/uploads/:id                   ถามว่าเซิร์ฟเวอร์ยังขาดก้อนไหน
       POST   /api/files/uploads/:id/commit            เซิร์ฟเวอร์ตรวจไบต์+SHA-256 เอง
   - แฮชคำนวณจริงจากไบต์ของไฟล์ ด้วย hash-wasm แบบ "อ่านทีละ slice"
     ⚠️ **จอนี้ไม่เรียก file.arrayBuffer() อีกต่อไป** — โค้ดเดิมดึงทั้งไฟล์เข้า RAM ของ
     แท็บก่อนอัปโหลด ทำให้เพดานที่แท้จริงของขนาดไฟล์เป็นหน่วยความจำของเบราว์เซอร์
     (ดู src/lib/chunkedUpload.js ซึ่งเป็นที่เดียวที่อ่านไบต์ของไฟล์)
   - เปอร์เซ็นต์และจำนวนไบต์มาจาก byte event ของเบราว์เซอร์ + สถานะ chunk ที่เซิร์ฟเวอร์
     รายงานกลับมาเท่านั้น ไม่มี timer และไม่มีเปอร์เซ็นต์ที่แต่งขึ้นตามสถานะ
   - เพดานขนาดไฟล์และพื้นที่ว่างที่แสดง มาจาก GET /api/files/uploads/limits ของ
     deployment จริง ไม่ใช่ค่าคงที่ใน bundle (เดิมคือ 1 GiB ที่ hard-code ไว้สองที่)
   - ประวัติการอัปโหลดมาจาก GET /api/files — ไม่มีลิสต์แต่งขึ้น
   - อัปโหลดชื่อเดิมทับของตัวเอง = สร้างเวอร์ชันใหม่ ไบต์ชุดเก่าถูกเก็บไว้ (ดูจอ File history) */

const STAGE_KEY = {
  preparing: 'upStagePreparing',
  hashing: 'upStageHashing',
  uploading: 'upStageUploading',
  paused: 'upStagePaused',
  committing: 'upStageCommitting',
  complete: 'upStageComplete',
  failed: 'upStageFailed',
  cancelled: 'upStageCancelled',
}

// เหตุผลที่แสดงใต้ชื่อไฟล์เมื่อหยุด/ล้มเหลว — ต้องบอกว่าต้องทำอะไรต่อ ไม่ใช่แค่ป้าย "Failed"
const REASON_KEY = {
  tooLarge: 'uploadTooLarge',
  noSpace: 'uploadNoSpace',
  checksum: 'uploadChecksumFailed',
  expired: 'uploadSessionExpired',
  network: 'uploadPausedNetwork',
  incomplete: 'uploadPausedNetwork',
}

const TERMINAL_STAGES = new Set(['complete', 'failed', 'cancelled'])

const stageTone = (stage) => {
  if (stage === 'complete') return 'ok'
  if (stage === 'failed') return 'danger'
  if (stage === 'paused') return 'warn'
  if (stage === 'cancelled') return 'neutral'
  return 'accent'
}

/* One upload row — สถานะเดินตาม "งานจริง" ไม่ใช่ timer */
function UploadRow({ t, item, onResume, onCancel }) {
  const reasonKey = REASON_KEY[item.reason]
  const resumable = item.stage === 'paused' && Boolean(item.session)
  const active = !TERMINAL_STAGES.has(item.stage)

  return (
    <div
      className="relative overflow-hidden rounded-[var(--r-tile)] border border-line transition-colors duration-[var(--dur-base)]"
      style={{ background: item.stage === 'complete' ? 'var(--ok-soft)' : item.stage === 'failed' ? 'var(--danger-soft)' : 'var(--card)' }}
    >
      <div className="relative flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-[9px] bg-sunken flex items-center justify-center shrink-0">
          <FileIcon size={15} strokeWidth={1.5} className="text-ink-2" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink truncate">{item.name}</p>
          {/* ไบต์ที่ส่งไปแล้ว / ทั้งหมด และก้อนที่เท่าไรจากทั้งหมด — ตัวเลขที่วัดได้จริงทั้งคู่ */}
          <p className="text-[11.5px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {t('uploadBytesCounter', { done: fmtBytes(item.transferredBytes), total: fmtBytes(item.size) })}
            {item.chunkCount > 0 && (
              <> · {t('uploadChunkCounter', { done: Math.min(item.chunkIndex + 1, item.chunkCount), total: item.chunkCount })}</>
            )}
          </p>
          {reasonKey && (
            <p role="alert" className="text-[11.5px] font-medium mt-0.5" style={{ color: item.stage === 'paused' ? 'var(--warn)' : 'var(--danger)' }}>
              {t(reasonKey)}
            </p>
          )}
        </div>
        {item.stage === 'complete' && (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
          </svg>
        )}
        <Chip tone={stageTone(item.stage)}>{t(STAGE_KEY[item.stage])}</Chip>
      </div>

      {(resumable || active) && (
        <div className="relative px-4 pb-2.5 -mt-1 flex justify-end gap-3">
          {resumable && (
            <button
              type="button"
              onClick={() => onResume(item.id)}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <RotateCcw size={12} aria-hidden />{t('uploadResume')}
            </button>
          )}
          {(active || resumable) && (
            <button
              type="button"
              onClick={() => onCancel(item.id)}
              className="text-[12px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('cancel')}
            </button>
          )}
        </div>
      )}

      {item.sha256 && (item.stage === 'uploading' || item.stage === 'committing' || item.stage === 'complete') && (
        <div className="relative px-4 pb-3 -mt-1">
          <ScrambleHash hash={item.sha256} playing={false} duration={1} groupClass="text-ink-3 !text-[10.5px]" />
        </div>
      )}

      {/* เปอร์เซ็นต์ระหว่างส่งมาจาก byte event ของ browser + สถานะ chunk ของเซิร์ฟเวอร์เท่านั้น */}
      <div
        className="relative h-0.5 bg-transparent"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={item.stage === 'complete' ? 100 : item.progress}
      >
        <div
          className="h-full transition-[width] duration-300"
          style={{
            width: `${item.stage === 'complete' ? 100 : item.progress}%`,
            background: item.stage === 'complete' ? 'var(--ok)' : item.stage === 'failed' ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      </div>
    </div>
  )
}

export function Uploads({ t, placeholderMode = false, runUpload = uploadFileResumable, loadLimits = fetchTransferLimits }) {
  const now = useNow(30_000)
  const filesApi = useApi('/api/files', { refreshMs: 30_000 })
  const recent = placeholderMode ? [] : (filesApi.data?.files ?? []).filter((f) => f.type !== 'Folder').slice(0, 6)
  const fetchError = visibleFetchError(filesApi.error, placeholderMode)

  const [dragOver, setDragOver] = useState(false)
  const [queue, setQueue] = useState([])
  // เพดานจริงของ deployment นี้ — null = ยังอ่านไม่ได้ (จอบอกตามนั้น ไม่เดาตัวเลขให้)
  const [limits, setLimits] = useState(null)
  const inputRef = useRef(null)
  const idRef = useRef(0)
  const controllers = useRef(new Map())
  const itemsRef = useRef(new Map())

  useEffect(() => {
    if (placeholderMode) return undefined
    const controller = new AbortController()
    loadLimits({ signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setLimits(value) })
      .catch(() => { /* อ่านไม่ได้ = ยังไม่รู้ ไม่ใช่ศูนย์ และไม่ใช่ค่าที่แต่งขึ้น */ })
    return () => controller.abort()
  }, [loadLimits, placeholderMode])

  // ยกเลิกงานที่ยังค้างเมื่อออกจากจอ — request ที่ยังวิ่งต่อหลัง unmount คือ state ที่หลุดมือ
  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort()
  }, [])

  const patch = useCallback((id, changes) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...changes } : q)))
  }, [])

  /** เดินหนึ่งรอบของงานอัปโหลด — ใช้ทั้งการเริ่มครั้งแรกและการกด "ทำต่อ" */
  const run = useCallback(async (id, file, resumeFrom) => {
    const controller = new AbortController()
    controllers.current.set(id, controller)
    try {
      const result = await runUpload({
        file,
        upload: resumeFrom?.session ?? null,
        sha256: resumeFrom?.sha256 ?? null,
        signal: controller.signal,
        onStage: (stage) => patch(id, { stage, reason: null }),
        onHashProgress: ({ hashedBytes, totalBytes }) => patch(id, {
          progress: totalBytes === 0 ? 0 : Math.round((hashedBytes / totalBytes) * 1000) / 10,
        }),
        onProgress: ({ transferredBytes, totalBytes, percent, chunkIndex, chunkCount }) => patch(id, {
          transferredBytes, size: totalBytes, progress: percent, chunkIndex, chunkCount,
        }),
      })

      patch(id, {
        stage: result.stage,
        reason: result.reason ?? null,
        sha256: result.sha256 ?? null,
        session: result.upload ?? null,
        ...(result.ok ? { progress: 100, transferredBytes: file.size } : {}),
      })
      itemsRef.current.set(id, { file, session: result.upload ?? null, sha256: result.sha256 ?? null })
      if (result.ok) filesApi.retry()
    } catch {
      patch(id, { stage: 'failed', reason: 'server' })
    } finally {
      controllers.current.delete(id)
    }
  }, [filesApi, patch, runUpload])

  const resume = useCallback((id) => {
    const held = itemsRef.current.get(id)
    if (!held?.file) return
    patch(id, { stage: 'preparing', reason: null })
    run(id, held.file, held)
  }, [patch, run])

  const cancel = useCallback((id) => {
    controllers.current.get(id)?.abort()
    const held = itemsRef.current.get(id)
    // คืนพื้นที่พักฝั่งเซิร์ฟเวอร์ทันที แทนที่จะปล่อยให้ค้างจนหมดอายุ
    if (held?.session?.uploadId) cancelUploadSession(held.session.uploadId).catch(() => {})
    patch(id, { stage: 'cancelled', reason: null, session: null })
  }, [patch])

  // ⚠️ เพดานฝั่ง client เป็นแค่ความสะดวก (บอกผู้ใช้ทันทีโดยไม่ต้องส่งไฟล์ขึ้นไปให้ถูกปฏิเสธ)
  //    การบังคับจริงอยู่ที่เซิร์ฟเวอร์เสมอ และค่าที่ใช้เทียบมาจากเซิร์ฟเวอร์ ไม่ใช่ค่าคงที่
  //    ที่ต้องคอยแก้ให้ตรงกันสองที่ — ถ้ายังอ่านค่าไม่ได้ ก็ส่งขึ้นไปให้เซิร์ฟเวอร์ตัดสิน
  const enqueue = (fileList) => {
    for (const file of [...fileList]) {
      const id = `up-${idRef.current++}`
      const base = {
        id, name: file.name, size: file.size, sha256: null, progress: 0,
        transferredBytes: 0, chunkIndex: 0, chunkCount: 0, session: null,
      }
      if (limits && file.size > limits.maxLogicalFileBytes) {
        setQueue((prev) => [{ ...base, stage: 'failed', reason: 'tooLarge' }, ...prev])
        continue
      }
      itemsRef.current.set(id, { file, session: null, sha256: null })
      setQueue((prev) => [{ ...base, stage: 'preparing' }, ...prev])
      run(id, file, null)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer?.files
    if (dropped?.length) enqueue(dropped)
  }

  const capacity = limits?.capacity ?? null

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
          {/* ⚠️ สองเส้นทางมีการปกป้องคนละแบบ: หน้านี้คือ Data Lake ปกติซึ่งยังเก็บ
              plaintext; คำว่าเข้ารหัสก่อนส่งใช้ได้เฉพาะหน้า Private Vault เท่านั้น */}
          <p className="text-[12.5px] text-ink-3">{t('dropSub')}</p>
          {/* เพดานและพื้นที่ว่างของ deployment จริง — ไม่มีคำว่า "ไม่จำกัด" ที่ใดในจอนี้ */}
          <p className="text-[11.5px] text-ink-3 max-w-[46ch]">
            {limits
              ? t('uploadLimitNotice', { size: fmtBytes(limits.maxLogicalFileBytes), chunk: fmtBytes(limits.chunkSizeBytes) })
              : t('uploadLimitUnknown')}
          </p>
          {capacity && (
            <p className="text-[11.5px] text-ink-3 max-w-[46ch]">
              {capacity.measured
                ? t('uploadCapacityNotice', { free: fmtBytes(capacity.usableBytes), reserve: fmtBytes(capacity.reserveBytes) })
                : t('uploadCapacityUnknown')}
            </p>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              if (e.target.files?.length) enqueue(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {queue.length > 0 && (
        <div className="col-span-12 flex flex-col gap-2.5">
          {queue.map((item) => (
            <UploadRow key={item.id} t={t} item={item} onResume={resume} onCancel={cancel} />
          ))}
        </div>
      )}

      <div className="col-span-12">
        <Card className="p-5">
          <CardTitle>{t('recentUploads')}</CardTitle>
          {filesApi.loading ? (
            <div className="flex flex-col gap-2 animate-pulse" aria-busy="true">
              {[0, 1, 2].map((i) => <div key={i} className="h-9 skeleton rounded-[9px]" />)}
            </div>
          ) : fetchError ? (
            <ErrorState t={t} kind={fetchError} onRetry={filesApi.retry} />
          ) : recent.length === 0 ? (
            <InlineEmptyState>{t('emptyNoUploads')}</InlineEmptyState>
          ) : (
            <div className="flex flex-col">
              {recent.map((f) => (
                <div key={f.id} className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0">
                  <FileText size={15} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                  <span className="text-[13.5px] font-medium text-ink truncate flex-1 min-w-0">{f.name}</span>
                  <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-md:hidden" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(f.size)}</span>
                  <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-md:hidden">{f.uploader}</span>
                  <span className="text-[12.5px] text-ink-3 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRelative(t, f.modified, now)}</span>
                  <span className="ml-2 shrink-0">
                    <Chip tone="neutral">{t('encServer')}</Chip>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
