import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UploadCloud, X } from 'lucide-react'

import { createRateEstimator } from '../lib/transferRate.js'
import { Btn, IconBtn } from './ui.jsx'
import { UploadStatusTray, UploadTrayLauncher } from './UploadStatusTray.jsx'

const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())
const visibleStage = (stage) => stage === 'encrypting' || stage === 'attaching' ? 'processing' : stage

/**
 * Vault-only upload controller. Queue state is deliberately memory-only: no
 * recovery store, browser storage, or plaintext filename survives lock/unmount.
 */
export const VaultUploadDrawer = forwardRef(function VaultUploadDrawer({
  t, open, onClose, destination = '/', parentNodeId = null, onUpload,
}, ref) {
  const [queue, setQueue] = useState([])
  const [trayHidden, setTrayHidden] = useState(false)
  const [trayCollapsed, setTrayCollapsed] = useState(false)
  const inputRef = useRef(null)
  const idRef = useRef(0)
  const controllers = useRef(new Map())
  const estimators = useRef(new Map())
  const cancelled = useRef(new Set())
  const alive = useRef(true)
  const chainRef = useRef(Promise.resolve())

  const patch = (id, values) => {
    if (!alive.current) return
    setQueue((items) => items.map((item) => item.id === id ? { ...item, ...values } : item))
  }

  const processJob = async (entry) => {
    if (!alive.current || cancelled.current.has(entry.id)) return
    const ctrl = new AbortController()
    const estimator = createRateEstimator()
    controllers.current.set(entry.id, ctrl)
    estimators.current.set(entry.id, estimator)
    estimator.reset(0, now())
    patch(entry.id, { stage: 'preparing', progress: 0, transferredBytes: 0, rate: null })
    try {
      const result = await onUpload(entry.file, {
        parentNodeId: entry.parentNodeId,
        signal: ctrl.signal,
        onStage: (stage) => patch(entry.id, { stage: visibleStage(stage) }),
        onProgress: (progress = {}) => {
          const transferredBytes = Math.max(0, Number(progress.transferredBytes) || 0)
          const totalBytes = Number(progress.totalBytes) || entry.size
          const rate = estimator.sample(transferredBytes, now(), { totalBytes })
          patch(entry.id, {
            stage: visibleStage(progress.phase ?? 'uploading'),
            progress: Number.isFinite(progress.percent) ? progress.percent : totalBytes > 0 ? transferredBytes / totalBytes * 100 : null,
            transferredBytes,
            chunkIndex: progress.chunkIndex ?? null,
            chunkCount: progress.chunkCount ?? 0,
            rate,
          })
        },
      })
      if (result?.ok) {
        patch(entry.id, { stage: 'complete', progress: 100, transferredBytes: entry.size, rate: null, reason: null })
      } else {
        const cancelled = ctrl.signal.aborted || result?.stage === 'cancelled'
        patch(entry.id, { stage: cancelled ? 'cancelled' : 'failed', rate: null, reason: result?.reason ?? 'server' })
      }
    } catch (error) {
      patch(entry.id, { stage: ctrl.signal.aborted ? 'cancelled' : 'failed', rate: null, reason: error?.code ?? 'server' })
    } finally {
      controllers.current.delete(entry.id)
      estimators.current.delete(entry.id)
    }
  }

  const enqueueFiles = (files, options = {}) => {
    const accepted = [...(files ?? [])].filter((file) => file && typeof file.name === 'string')
    if (accepted.length === 0) return
    const target = options.parentNodeId ?? parentNodeId
    const entries = accepted.map((file) => ({
      id: `vault-upload-${++idRef.current}`,
      file,
      name: file.name,
      size: file.size,
      parentNodeId: target,
      stage: 'waiting',
      progress: 0,
      transferredBytes: 0,
      chunkCount: 0,
      rate: null,
      reason: null,
    }))
    setQueue((items) => [...items, ...entries])
    setTrayHidden(false)
    setTrayCollapsed(false)
    onClose?.()
    for (const entry of entries) {
      chainRef.current = chainRef.current.then(() => processJob(entry))
    }
  }

  useImperativeHandle(ref, () => ({ enqueueFiles }), [parentNodeId, onClose, onUpload])

  useEffect(() => () => {
    alive.current = false
    for (const ctrl of controllers.current.values()) ctrl.abort()
    controllers.current.clear()
    estimators.current.clear()
  }, [])

  const cancel = (id) => {
    cancelled.current.add(id)
    const ctrl = controllers.current.get(id)
    if (ctrl) ctrl.abort()
    else patch(id, { stage: 'cancelled', rate: null, reason: null })
  }
  const dismiss = (id) => {
    cancelled.current.add(id)
    setQueue((items) => items.filter((item) => item.id !== id))
  }
  const retry = (id) => {
    cancelled.current.delete(id)
    let entry = null
    setQueue((items) => items.map((item) => {
      if (item.id !== id) return item
      entry = { ...item, stage: 'waiting', progress: 0, transferredBytes: 0, rate: null, reason: null }
      return entry
    }))
    queueMicrotask(() => {
      if (entry) chainRef.current = chainRef.current.then(() => processJob(entry))
    })
  }
  const portal = (content) => typeof document === 'undefined' ? content : createPortal(content, document.body)
  const status = (
    <>
      {!trayHidden && (
        <UploadStatusTray
          t={t}
          queue={queue}
          collapsed={trayCollapsed}
          onToggleCollapse={() => setTrayCollapsed((value) => !value)}
          onHide={() => setTrayHidden(true)}
          onCancel={cancel}
          onRetry={retry}
          onDismiss={dismiss}
        />
      )}
      {trayHidden && <UploadTrayLauncher t={t} queue={queue} onShow={() => setTrayHidden(false)} />}
    </>
  )

  if (!open) return portal(status)
  const pick = () => inputRef.current?.click()
  return portal(
    <>
      {status}
      <div className="fixed inset-0 z-[var(--z-modal)] bg-black/20" aria-hidden />
      <aside data-testid="vault-upload-drawer" role="dialog" aria-modal="true" aria-labelledby="vault-upload-title" className="fixed z-[calc(var(--z-modal)+1)] inset-y-0 right-0 w-full max-w-[420px] bg-canvas border-l border-line shadow-[var(--elev-2)] flex flex-col">
        <header className="px-6 py-5 border-b border-line flex items-start gap-3 bg-card">
          <div className="min-w-0 flex-1">
            <h2 id="vault-upload-title" className="text-[18px] font-bold text-ink tracking-[-0.01em]">{t('uploadFiles')}</h2>
            <p className="mt-1 text-[11.5px] text-ink-3">{t('destinationFolder')} · <span className="font-mono text-ink-2">{destination}</span></p>
          </div>
          <IconBtn label={t('closeUpload')} onClick={onClose}><X size={17} /></IconBtn>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          <button
            type="button"
            onClick={pick}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); enqueueFiles(event.dataTransfer?.files) }}
            className="w-full min-h-44 rounded-[var(--r-card)] border-2 border-dashed border-line bg-sunken flex flex-col items-center justify-center gap-2 text-center px-6 py-8 transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-[var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="size-12 rounded-full bg-card flex items-center justify-center shadow-[var(--elev-1)]"><UploadCloud size={22} className="text-accent" aria-hidden /></span>
            <span className="mt-1 block text-[14px] font-bold text-ink">{t('dropHere')}</span>
            <span className="block max-w-[28ch] text-[11.5px] leading-relaxed text-ink-3">{t('dropSub')}</span>
          </button>
          <input data-testid="vault-upload-input" ref={inputRef} type="file" multiple className="sr-only" aria-label={t('chooseFiles')} onChange={(event) => { enqueueFiles(event.target.files); event.target.value = '' }} />
          <Btn variant="primary" className="w-full" onClick={pick}>{t('chooseFiles')}</Btn>
          <p className="text-[11.5px] leading-relaxed text-ink-3 border-l-2 border-line pl-3">{t('uploadEntryHint')}</p>
        </div>
        <footer className="px-6 py-4 border-t border-line bg-card">
          <span className="text-[11.5px] text-ink-3">{t('currentFolder')}: <span className="font-mono text-ink-2">{destination}</span></span>
        </footer>
      </aside>
    </>,
  )
})
