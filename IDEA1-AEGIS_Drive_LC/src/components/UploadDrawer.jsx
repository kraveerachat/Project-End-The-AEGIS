import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, File as FileIcon, RotateCcw, UploadCloud, X } from 'lucide-react'

import { apiUpload } from '../lib/api.js'
import { fmtBytes } from '../lib/format.js'
import { Btn, Chip, IconBtn, InlineEmptyState } from './ui.jsx'

const MAX_UPLOAD_BYTES = 1_073_741_824

const STAGE_LABEL = {
  waiting: 'uploadWaiting',
  processing: 'uploadProcessing',
  uploading: 'stTransferring',
  complete: 'uploadComplete',
  failed: 'uploadFailed',
  cancelled: 'uploadCancelled',
}

const stageTone = (stage) => {
  if (stage === 'complete') return 'ok'
  if (stage === 'failed') return 'danger'
  if (stage === 'cancelled') return 'neutral'
  return 'accent'
}

export async function sha256OfFile(file) {
  const bytes = await file.arrayBuffer()
  const digest = await window.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function QueueRow({ t, item, onCancel, onRetry, onDismiss }) {
  const cancellable = ['waiting', 'processing', 'uploading'].includes(item.stage)
  const dismissible = ['complete', 'failed', 'cancelled'].includes(item.stage)
  const progress = item.stage === 'complete' ? 100 : item.progress

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

      {item.reason === 'tooLarge' && (
        <p role="alert" className="mt-2 text-[11.5px] font-medium" style={{ color: 'var(--danger)' }}>{t('uploadTooLarge')}</p>
      )}

      {typeof progress === 'number' && (
        <div className="mt-2 h-1 rounded-full bg-sunken overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}

      <div className="mt-2 flex justify-end gap-2">
        {cancellable && <button type="button" onClick={() => onCancel(item.id)} className="text-[12px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{t('cancel')}</button>}
        {item.stage === 'failed' && item.file && <button type="button" onClick={() => onRetry(item.id)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><RotateCcw size={12} aria-hidden />{t('retry')}</button>}
        {dismissible && <button type="button" onClick={() => onDismiss(item.id)} className="text-[12px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{t('dismiss')}</button>}
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
  uploadFile = apiUpload,
  hashFile = sha256OfFile,
}) {
  const [queue, setQueue] = useState(initialQueue)
  const inputRef = useRef(null)
  const drawerRef = useRef(null)
  const idRef = useRef(0)
  const controllers = useRef(new Map())

  const patchItem = (id, patch) => setQueue((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))

  const processFile = async (file, id) => {
    const controller = new AbortController()
    controllers.current.set(id, controller)
    try {
      patchItem(id, { stage: 'processing', progress: null })
      const sha256 = await hashFile(file)
      if (controller.signal.aborted) {
        patchItem(id, { stage: 'cancelled', progress: null })
        return
      }
      patchItem(id, { stage: 'uploading', progress: 0, sha256 })
      const form = new FormData()
      form.append('sha256', sha256)
      form.append('file', file, file.name)
      const response = await uploadFile('/api/files/upload', {
        method: 'POST',
        body: form,
        signal: controller.signal,
        onProgress: ({ percent }) => patchItem(id, { progress: percent }),
        timeoutMs: 10 * 60_000,
      })
      if (controller.signal.aborted) patchItem(id, { stage: 'cancelled', progress: null })
      else if (response.ok) {
        patchItem(id, { stage: 'complete', progress: 100 })
        onUploaded?.()
      } else patchItem(id, { stage: 'failed', progress: null })
    } catch {
      patchItem(id, { stage: controller.signal.aborted ? 'cancelled' : 'failed', progress: null })
    } finally {
      controllers.current.delete(id)
    }
  }

  const enqueue = (fileList) => {
    for (const file of [...fileList]) {
      const id = `upload-${Date.now()}-${idRef.current++}`
      const item = { id, file, name: file.name, size: file.size, stage: 'waiting', progress: null }
      if (file.size > MAX_UPLOAD_BYTES) {
        setQueue((current) => [{ ...item, stage: 'failed', reason: 'tooLarge' }, ...current])
      } else {
        setQueue((current) => [item, ...current])
        processFile(file, id)
      }
    }
  }

  useEffect(() => {
    if (initialFiles?.length) enqueue(initialFiles)
    // requestId deliberately represents a distinct drag/drop action.
  }, [requestId])

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
    patchItem(id, { stage: 'cancelled', progress: null })
  }
  const retry = (id) => {
    const item = queue.find((candidate) => candidate.id === id)
    if (!item?.file) return
    patchItem(id, { stage: 'waiting', reason: null, progress: null })
    processFile(item.file, id)
  }
  const dismiss = (id) => setQueue((current) => current.filter((item) => item.id !== id))
  const cancelAll = () => {
    for (const item of queue) if (['waiting', 'processing', 'uploading'].includes(item.stage)) cancel(item.id)
  }
  const portal = (content) => typeof document === 'undefined' ? content : createPortal(content, document.body)

  if (!open) {
    if (queue.length === 0) return null
    return portal(
      <button type="button" onClick={onOpen} className="fixed bottom-5 right-5 z-[var(--z-toast)] h-11 px-4 rounded-full bg-ink text-card inline-flex items-center gap-2 text-[13px] font-semibold shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <UploadCloud size={15} aria-hidden />
        {t('uploadQueue')}
        <span className="min-w-5 h-5 px-1 rounded-full bg-accent text-white inline-flex items-center justify-center text-[11px]">{queue.length}</span>
      </button>
    )
  }

  return portal(
    <>
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
              {queue.some((item) => ['waiting', 'processing', 'uploading'].includes(item.stage)) && <button type="button" onClick={cancelAll} className="text-[12px] font-semibold text-ink-2 hover:text-ink">{t('cancelAll')}</button>}
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
