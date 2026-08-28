import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, File as FileIcon, RotateCcw, UploadCloud, X } from 'lucide-react'

import { cancelUploadSession, fetchTransferLimits, uploadFileResumable } from '../lib/chunkedUpload.js'
import { fmtBytes } from '../lib/format.js'
import { Btn, Chip, IconBtn, InlineEmptyState } from './ui.jsx'

// ⚠️ เดิมที่นี่มีค่าคงที่ 1 GiB ซ้ำกับ fileStore.js และ Uploads.jsx สามที่ต้องแก้ให้ตรงกัน
//    เอง — ตอนนี้เพดานมาจาก GET /api/files/uploads/limits ของ deployment จริง
//    null = ยังอ่านไม่ได้ ซึ่งแปลว่า "ปล่อยให้เซิร์ฟเวอร์เป็นคนตัดสิน" ไม่ใช่เดาค่าให้
const ACTIVE_UPLOAD_STAGES = new Set(['waiting', 'preparing', 'hashing', 'processing', 'uploading', 'committing'])

export const activeUploadCount = (queue = []) => queue.filter((item) => ACTIVE_UPLOAD_STAGES.has(item.stage)).length
export const failedUploadCount = (queue = []) => queue.filter((item) => item.stage === 'failed').length
export const shouldShowQueueLauncher = (queue = []) => activeUploadCount(queue) > 0 || failedUploadCount(queue) > 0

// สถานะที่ผู้ใช้เห็น เดินตามขั้นจริงของโปรโตคอล V2 (ดู src/lib/chunkedUpload.js)
// waiting/processing ยังอยู่เพื่อรองรับคิวที่ถูกส่งเข้ามาจากภายนอกก่อนงานจะเริ่มเดิน
const STAGE_LABEL = {
  waiting: 'uploadWaiting',
  processing: 'uploadProcessing',
  preparing: 'upStagePreparing',
  hashing: 'upStageHashing',
  uploading: 'upStageUploading',
  paused: 'upStagePaused',
  committing: 'upStageCommitting',
  complete: 'uploadComplete',
  failed: 'uploadFailed',
  cancelled: 'uploadCancelled',
}

// เหตุผลที่แสดงใต้ชื่อไฟล์ — บอกว่าต้องทำอะไรต่อ ไม่ใช่แค่ป้าย "Failed"
const REASON_LABEL = {
  tooLarge: 'uploadTooLarge',
  noSpace: 'uploadNoSpace',
  checksum: 'uploadChecksumFailed',
  expired: 'uploadSessionExpired',
  network: 'uploadPausedNetwork',
  incomplete: 'uploadPausedNetwork',
}

const stageTone = (stage) => {
  if (stage === 'complete') return 'ok'
  if (stage === 'failed') return 'danger'
  if (stage === 'paused') return 'warn'
  if (stage === 'cancelled') return 'neutral'
  return 'accent'
}

function QueueRow({ t, item, onCancel, onRetry, onDismiss }) {
  const cancellable = ACTIVE_UPLOAD_STAGES.has(item.stage)
  const dismissible = ['complete', 'failed', 'cancelled'].includes(item.stage)
  const progress = item.stage === 'complete' ? 100 : item.progress
  // หยุดชั่วคราวแล้วยังมี session อยู่ = ทำต่อได้ ไม่ต้องเริ่มไฟล์ใหม่ทั้งก้อน
  const resumable = item.stage === 'paused' && Boolean(item.session)
  const reasonLabel = REASON_LABEL[item.reason]

  return (
    <div className="rounded-[var(--r-tile)] border border-line bg-card px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span className="size-8 rounded-[9px] bg-sunken flex items-center justify-center shrink-0">
          <FileIcon size={15} strokeWidth={1.5} className="text-ink-2" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-ink truncate">{item.name}</span>
          <span className="block text-[11.5px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(item.size)}</span>
        </span>
        <Chip tone={stageTone(item.stage)}>{t(STAGE_LABEL[item.stage])}</Chip>
      </div>

      {reasonLabel && (
        <p role="alert" className="mt-2 text-[11.5px] font-medium" style={{ color: item.stage === 'paused' ? 'var(--warn)' : 'var(--danger)' }}>{t(reasonLabel)}</p>
      )}

      {/* ไบต์ที่ส่งไปแล้ว / ทั้งหมด และก้อนที่เท่าไรจากทั้งหมด — ตัวเลขที่วัดได้จริงทั้งคู่ */}
      {item.chunkCount > 0 && (
        <p className="mt-1.5 text-[11px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('uploadBytesCounter', { done: fmtBytes(item.transferredBytes ?? 0), total: fmtBytes(item.size) })}
          {' · '}
          {t('uploadChunkCounter', { done: Math.min((item.chunkIndex ?? 0) + 1, item.chunkCount), total: item.chunkCount })}
        </p>
      )}

      {typeof progress === 'number' && (
        <div className="mt-2 h-1 rounded-full bg-sunken overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}

      <div className="mt-2 flex justify-end gap-2">
        {cancellable && <button type="button" onClick={() => onCancel(item.id)} className="text-[12px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{t('cancel')}</button>}
        {(item.stage === 'failed' || resumable) && item.file && <button type="button" onClick={() => onRetry(item.id)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><RotateCcw size={12} aria-hidden />{t(resumable ? 'uploadResume' : 'retry')}</button>}
        {dismissible && <button type="button" onClick={() => onDismiss(item.id)} className="text-[12px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{t('dismiss')}</button>}
      </div>
    </div>
  )
}

function UploadSuccessToast({ t, toast, onDismiss }) {
  if (!toast) return null
  return (
    <div role="status" aria-live="polite" className="upload-success-toast fixed right-5 top-5 z-[var(--z-toast)] w-[min(360px,calc(100vw-2rem))] rounded-[var(--r-card)] border border-line bg-card p-4 shadow-[var(--elev-2)]">
      <div className="flex items-start gap-3">
        <span className="size-9 shrink-0 rounded-[10px] flex items-center justify-center" style={{ color: 'var(--ok)', background: 'var(--ok-soft)' }}>
          <CheckCircle2 size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold text-ink">{t('uploadSuccessTitle')}</p>
          <p className="mt-0.5 text-[12px] text-ink-2 break-words">{t('uploadSuccessBody', { name: toast.name })}</p>
        </div>
        <IconBtn label={t('dismiss')} onClick={onDismiss}><X size={15} /></IconBtn>
      </div>
    </div>
  )
}

export function UploadDrawer({
  t,
  open,
  onOpen,
  onClose,
  destination = '/Files',
  recentFiles = [],
  recentLoading = false,
  initialFiles = [],
  requestId = 0,
  initialQueue = [],
  onUploaded,
  runUpload = uploadFileResumable,
  loadLimits = fetchTransferLimits,
}) {
  const [queue, setQueue] = useState(initialQueue)
  const [successToasts, setSuccessToasts] = useState([])
  const [limits, setLimits] = useState(null)
  const inputRef = useRef(null)
  const drawerRef = useRef(null)
  const idRef = useRef(0)
  const controllers = useRef(new Map())
  const notifiedCompletions = useRef(new Set())
  const handledRequests = useRef(new Set())

  const patchItem = (id, patch) => setQueue((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))

  // ⚠️ ไฟล์เดินทางผ่านเส้นทาง V2 แบบ chunk เท่านั้น — ไม่มีจุดใดในลิ้นชักนี้อ่านทั้งไฟล์
  //    เข้าหน่วยความจำอีกต่อไป (เดิม sha256OfFile() เรียก file.arrayBuffer() ทั้งก้อน)
  //    resumeFrom = สถานะจากรอบก่อน ทำให้ปุ่ม "ทำต่อ" ส่งเฉพาะ chunk ที่ยังขาด
  const processFile = async (file, id, resumeFrom = null) => {
    const controller = new AbortController()
    controllers.current.set(id, controller)
    try {
      const result = await runUpload({
        file,
        upload: resumeFrom?.session ?? null,
        sha256: resumeFrom?.sha256 ?? null,
        signal: controller.signal,
        onStage: (stage) => patchItem(id, { stage, reason: null }),
        onHashProgress: ({ hashedBytes, totalBytes }) => patchItem(id, {
          progress: totalBytes === 0 ? 0 : Math.round((hashedBytes / totalBytes) * 1000) / 10,
        }),
        onProgress: ({ transferredBytes, totalBytes, percent, chunkIndex, chunkCount }) => patchItem(id, {
          transferredBytes, size: totalBytes, progress: percent, chunkIndex, chunkCount,
        }),
      })

      if (controller.signal.aborted || result.stage === 'cancelled') {
        patchItem(id, { stage: 'cancelled', progress: null })
        return
      }

      patchItem(id, {
        stage: result.stage,
        reason: result.reason ?? null,
        sha256: result.sha256 ?? null,
        session: result.upload ?? null,
        ...(result.ok ? { progress: 100, transferredBytes: file.size } : {}),
      })

      if (result.ok) {
        if (!notifiedCompletions.current.has(id)) {
          notifiedCompletions.current.add(id)
          setSuccessToasts((current) => [...current, { id, name: file.name }])
        }
        onUploaded?.()
      }
    } catch {
      patchItem(id, { stage: controller.signal.aborted ? 'cancelled' : 'failed', progress: null })
    } finally {
      controllers.current.delete(id)
    }
  }

  const enqueue = (fileList) => {
    for (const file of [...fileList]) {
      const id = `upload-${Date.now()}-${idRef.current++}`
      const item = {
        id, file, name: file.name, size: file.size, stage: 'waiting', progress: null,
        transferredBytes: 0, chunkIndex: 0, chunkCount: 0, session: null,
      }
      // เพดานฝั่ง client เป็นแค่ความสะดวก การบังคับจริงอยู่ที่เซิร์ฟเวอร์เสมอ —
      // ยังอ่านเพดานไม่ได้ = ส่งขึ้นไปให้เซิร์ฟเวอร์ตัดสิน ไม่ใช่ปฏิเสธด้วยค่าที่เดาเอง
      if (limits && file.size > limits.maxLogicalFileBytes) {
        setQueue((current) => [{ ...item, stage: 'failed', reason: 'tooLarge' }, ...current])
      } else {
        setQueue((current) => [item, ...current])
        processFile(file, id)
      }
    }
  }

  useEffect(() => {
    if (initialFiles?.length && !handledRequests.current.has(requestId)) {
      handledRequests.current.add(requestId)
      enqueue(initialFiles)
    }
    // requestId deliberately represents a distinct drag/drop action.
  }, [requestId])

  useEffect(() => {
    if (successToasts.length === 0) return undefined
    const timer = window.setTimeout(() => setSuccessToasts((current) => current.slice(1)), 4500)
    return () => window.clearTimeout(timer)
  }, [successToasts])

  useEffect(() => {
    const controller = new AbortController()
    loadLimits({ signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setLimits(value) })
      .catch(() => { /* อ่านไม่ได้ = ยังไม่รู้ ไม่ใช่ศูนย์ และไม่ใช่ค่าที่แต่งขึ้น */ })
    return () => controller.abort()
  }, [loadLimits])

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort()
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const drawer = drawerRef.current
    drawer?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
        return
      }
      if (event.key !== 'Tab' || !drawer) return
      const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  const cancel = (id) => {
    controllers.current.get(id)?.abort()
    const item = queue.find((candidate) => candidate.id === id)
    // คืนพื้นที่พักฝั่งเซิร์ฟเวอร์ทันที แทนที่จะปล่อยให้ค้างจนหมดอายุ
    if (item?.session?.uploadId) cancelUploadSession(item.session.uploadId).catch(() => {})
    patchItem(id, { stage: 'cancelled', progress: null, session: null })
  }
  // ทำต่อจาก session เดิมถ้ายังมีอยู่ (ส่งเฉพาะ chunk ที่ขาด) ไม่งั้นเริ่มใหม่ทั้งไฟล์
  const retry = (id) => {
    const item = queue.find((candidate) => candidate.id === id)
    if (!item?.file) return
    patchItem(id, { stage: 'waiting', reason: null, progress: null })
    processFile(item.file, id, item.session ? { session: item.session, sha256: item.sha256 } : null)
  }
  const dismiss = (id) => setQueue((current) => current.filter((item) => item.id !== id))
  const cancelAll = () => {
    for (const item of queue) if (ACTIVE_UPLOAD_STAGES.has(item.stage)) cancel(item.id)
  }
  const portal = (content) => typeof document === 'undefined' ? content : createPortal(content, document.body)
  const activeCount = activeUploadCount(queue)
  const failedCount = failedUploadCount(queue)
  const successToast = successToasts[0] ?? null
  const dismissSuccessToast = () => setSuccessToasts((current) => current.slice(1))

  if (!open) {
    if (!shouldShowQueueLauncher(queue) && !successToast) return null
    return portal(
      <>
        <UploadSuccessToast t={t} toast={successToast} onDismiss={dismissSuccessToast} />
        {shouldShowQueueLauncher(queue) && (
          <button type="button" onClick={onOpen} className="fixed bottom-5 right-5 z-[var(--z-toast)] h-11 px-4 rounded-full bg-ink text-card inline-flex items-center gap-2 text-[13px] font-semibold shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {activeCount > 0 ? <UploadCloud size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
            {activeCount > 0 ? t('uploadQueue') : t('uploadNeedsAttention')}
            <span className="min-w-5 h-5 px-1 rounded-full bg-accent text-white inline-flex items-center justify-center text-[11px]">{activeCount || failedCount}</span>
          </button>
        )}
      </>
    )
  }

  return portal(
    <>
      <UploadSuccessToast t={t} toast={successToast} onDismiss={dismissSuccessToast} />
      <div className="fixed inset-0 z-[var(--z-modal)] bg-black/20" aria-hidden />
      <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="upload-drawer-title" className="fixed z-[calc(var(--z-modal)+1)] inset-y-0 right-0 w-full max-w-[440px] bg-canvas border-l border-line shadow-[var(--elev-2)] flex flex-col outline-none">
        <header className="h-17 px-5 border-b border-line flex items-center gap-3 bg-card">
          <div className="min-w-0 flex-1">
            <h2 id="upload-drawer-title" className="text-[17px] font-bold text-ink">{t('uploadFiles')}</h2>
            <p className="text-[11.5px] text-ink-3">{t('destinationFolder')} · <span className="font-mono text-ink-2">{destination}</span></p>
          </div>
          <IconBtn label={t('closeUpload')} onClick={onClose}><X size={17} /></IconBtn>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (event.dataTransfer?.files?.length) enqueue(event.dataTransfer.files) }}
            className="w-full min-h-28 rounded-[var(--r-card)] border-2 border-dashed border-line bg-sunken flex flex-col items-center justify-center gap-1.5 text-center px-4 hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <UploadCloud size={23} className="text-accent" aria-hidden />
            <span className="text-[13.5px] font-semibold text-ink">{t('dropHere')}</span>
            <span className="text-[11.5px] text-ink-3">{t('dropSub')}</span>
          </button>
          <input ref={inputRef} type="file" multiple className="sr-only" aria-label={t('chooseFiles')} onChange={(event) => { if (event.target.files?.length) enqueue(event.target.files); event.target.value = '' }} />

          <section aria-labelledby="queue-title">
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <h3 id="queue-title" className="text-[12px] uppercase tracking-[0.12em] font-bold text-ink-3">{t('uploadQueue')}</h3>
              {queue.some((item) => ACTIVE_UPLOAD_STAGES.has(item.stage)) && <button type="button" onClick={cancelAll} className="text-[12px] font-semibold text-ink-2 hover:text-ink">{t('cancelAll')}</button>}
            </div>
            {queue.length === 0 ? <InlineEmptyState>{t('emptyNoUploads')}</InlineEmptyState> : <div className="space-y-2.5">{queue.map((item) => <QueueRow key={item.id} t={t} item={item} onCancel={cancel} onRetry={retry} onDismiss={dismiss} />)}</div>}
          </section>

          <details className="border-t border-line pt-4" open>
            <summary className="cursor-pointer list-none flex items-center justify-between text-[12px] uppercase tracking-[0.12em] font-bold text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t('recentUploads')}<ChevronDown size={15} aria-hidden />
            </summary>
            <div className="mt-3">
              {recentLoading ? <div className="h-16 skeleton rounded-[var(--r-tile)]" aria-busy="true" /> : recentFiles.length === 0 ? <InlineEmptyState>{t('emptyNoUploads')}</InlineEmptyState> : (
                <div className="divide-y divide-line">{recentFiles.slice(0, 6).map((file) => <div key={file.id} className="py-2.5 flex items-center gap-3"><FileIcon size={14} className="text-ink-3 shrink-0" /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{file.name}</span><span className="text-[11.5px] text-ink-3 whitespace-nowrap">{fmtBytes(file.size)}</span></div>)}</div>
              )}
            </div>
          </details>
        </div>

        <footer className="px-5 py-4 border-t border-line bg-card flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-ink-3">{t('currentFolder')}: <span className="font-mono text-ink-2">{destination}</span></span>
          <Btn variant="outline" onClick={() => inputRef.current?.click()}>{t('chooseFiles')}</Btn>
        </footer>
      </aside>
    </>
  )
}
