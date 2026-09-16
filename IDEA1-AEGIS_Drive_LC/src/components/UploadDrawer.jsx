import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, File as FileIcon, UploadCloud, X } from 'lucide-react'

import { cancelUploadSession, fetchTransferLimits, uploadFileResumable } from '../lib/chunkedUpload.js'
import { fmtBytes } from '../lib/format.js'
import { createRateEstimator } from '../lib/transferRate.js'
import { Btn, IconBtn, InlineEmptyState } from './ui.jsx'
import {
  ACTIVE_UPLOAD_STAGES,
  UploadStatusTray,
  UploadTrayLauncher,
  activeUploadCount,
  failedUploadCount,
  shouldShowQueueLauncher,
} from './UploadStatusTray.jsx'

// ⚠️ เดิมที่นี่มีค่าคงที่ 1 GiB ซ้ำกับ fileStore.js และ Uploads.jsx สามที่ต้องแก้ให้ตรงกัน
//    เอง — ตอนนี้เพดานมาจาก GET /api/files/uploads/limits ของ deployment จริง
//    null = ยังอ่านไม่ได้ ซึ่งแปลว่า "ปล่อยให้เซิร์ฟเวอร์เป็นคนตัดสิน" ไม่ใช่เดาค่าให้
// เพรดิเคตและตัวนับของคิวอยู่กับพื้นผิวที่ใช้มันจริง (UploadStatusTray) — re-export
// ไว้ที่นี่เพื่อให้ผู้เรียกเดิมและชุดทดสอบเดิมยังนำเข้าได้จากที่เดียวกับที่เคยนำเข้า
export { ACTIVE_UPLOAD_STAGES, activeUploadCount, failedUploadCount, shouldShowQueueLauncher }

/** จังหวะที่เดินนาฬิกาให้ตัวประมาณ เพื่อให้ "หยุดนิ่ง" ถูกจับได้ตอนไม่มี progress event */
const STALL_TICK_MS = 1_000

/** นาฬิกาเดียวที่ทั้งไฟล์ใช้ — performance.now() เมื่อมี ไม่งั้นถอยไปใช้นาฬิการะบบ */
const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())

/**
 * ลิ้นชักอัปโหลด + เจ้าของคิว
 *
 * FILES-UPLOAD-UX-1 แยกหน้าที่ของสองพื้นผิวออกจากกัน:
 *
 *   ลิ้นชักใหญ่ (`open`) = **เริ่ม** งาน — ตอบสองคำถามเท่านั้น คืออัปโหลดไปที่ไหน
 *                          และเลือกไฟล์อย่างไร พอไฟล์เข้าคิวแล้วมันปิดตัวเอง
 *   ถาดมุมขวาล่าง        = **เฝ้า** งาน — คิว ความคืบหน้า ความเร็ว ETA และคำสั่ง
 *
 * ⚠️ คอมโพเนนต์นี้ถูก mount ค้างไว้โดย Files.jsx ตลอดอายุของหน้า (ไม่ได้ถูกครอบด้วย
 *    `{uploadOpen && ...}`) นั่นคือเหตุผลเดียวที่ทำให้ "ปิดลิ้นชัก" และ "ปิดถาด" เป็น
 *    เรื่องของการมองเห็นล้วน ๆ และเป็นไปไม่ได้เชิงโครงสร้างที่จะกลายเป็นการยกเลิกงาน
 *    ถ้าวันหนึ่งมีใครย้ายไปครอบด้วยเงื่อนไข คิวจะหายพร้อมกับงานที่กำลังส่งอยู่จริง
 */
export function UploadDrawer({
  t,
  open,
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
  cancelSession = cancelUploadSession,
}) {
  const [queue, setQueue] = useState(initialQueue)
  const [limits, setLimits] = useState(null)
  // ถาดเริ่มต้นแบบ "เห็นได้" — ผู้ใช้ต้องกดซ่อนเองเท่านั้น และงานใหม่จะพากลับมาเสมอ
  const [trayHidden, setTrayHidden] = useState(false)
  const [trayCollapsed, setTrayCollapsed] = useState(false)
  const inputRef = useRef(null)
  const drawerRef = useRef(null)
  const idRef = useRef(0)
  const controllers = useRef(new Map())
  const handledRequests = useRef(new Set())
  // ⚠️ หนึ่งตัวประมาณต่อหนึ่งรายการ ไม่ใช่ตัวเดียวร่วมกันทั้งคิว — ไฟล์สองไฟล์ที่ส่ง
  //    พร้อมกันจะทำให้ตัวอย่างของกันและกันปนกันทันทีถ้าใช้ตัวเดียว
  const estimators = useRef(new Map())
  const queueRef = useRef(queue)
  queueRef.current = queue

  const patchItem = (id, patch) => setQueue((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))

  /** เปิด/คลี่ถาดกลับมาเสมอเมื่อมีงานใหม่ ไม่ว่าผู้ใช้จะซ่อนหรือย่อมันไว้ก่อนหน้า */
  const revealTray = () => {
    setTrayHidden(false)
    setTrayCollapsed(false)
  }

  // ⚠️ ไฟล์เดินทางผ่านเส้นทาง V2 แบบ chunk เท่านั้น — ไม่มีจุดใดในลิ้นชักนี้อ่านทั้งไฟล์
  //    เข้าหน่วยความจำอีกต่อไป (เดิม sha256OfFile() เรียก file.arrayBuffer() ทั้งก้อน)
  //    resumeFrom = สถานะจากรอบก่อน ทำให้ปุ่ม "ทำต่อ" ส่งเฉพาะ chunk ที่ยังขาด
  const processFile = async (file, id, resumeFrom = null) => {
    const controller = new AbortController()
    controllers.current.set(id, controller)
    // ⚠️ ตัวประมาณตัวใหม่ทุกครั้งที่เริ่มหรือ resume: ไบต์ที่ส่งไปแล้วในเซสชันก่อนต้อง
    //    เป็น "จุดอ้างอิง" ไม่ใช่ไบต์ที่เพิ่งวิ่งผ่านสายในวินาทีนี้ ไม่งั้นตัวอย่างแรก
    //    ของการ resume จะได้ความเร็วระดับ GB/s ที่เป็นไปไม่ได้
    const estimator = createRateEstimator()
    estimators.current.set(id, estimator)
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
          rate: estimator.sample(transferredBytes, now(), { totalBytes }),
        }),
      })

      if (controller.signal.aborted || result.stage === 'cancelled') {
        patchItem(id, { stage: 'cancelled', progress: null, rate: null })
        return
      }

      patchItem(id, {
        stage: result.stage,
        reason: result.reason ?? null,
        sha256: result.sha256 ?? null,
        session: result.upload ?? null,
        rate: null,
        ...(result.ok ? { progress: 100, transferredBytes: file.size } : {}),
      })

      if (result.ok) onUploaded?.()
    } catch {
      patchItem(id, { stage: controller.signal.aborted ? 'cancelled' : 'failed', progress: null, rate: null })
    } finally {
      controllers.current.delete(id)
      estimators.current.delete(id)
    }
  }

  const enqueue = (fileList) => {
    const incoming = [...fileList]
    if (incoming.length === 0) return
    for (const file of incoming) {
      const id = `upload-${Date.now()}-${idRef.current++}`
      const item = {
        id, file, name: file.name, size: file.size, stage: 'waiting', progress: null,
        transferredBytes: 0, chunkIndex: 0, chunkCount: 0, session: null, rate: null,
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
    // งานอยู่ในมือถาดแล้ว ลิ้นชัก "เลือกไฟล์" ไม่มีเหตุผลให้ขวางหน้าจอต่อ — รวมถึงตอน
    // ที่ไฟล์ถูกปฏิเสธเพราะเกินเพดาน ผู้ใช้ต้องไม่ถูกขังอยู่กับลิ้นชักเพื่ออ่านคำปฏิเสธ
    revealTray()
    onClose?.()
  }

  useEffect(() => {
    if (initialFiles?.length && !handledRequests.current.has(requestId)) {
      handledRequests.current.add(requestId)
      enqueue(initialFiles)
    }
    // requestId deliberately represents a distinct drag/drop action.
  }, [requestId])

  // ⚠️ นาฬิกาที่เดินเพื่อ "จับการหยุดนิ่ง" เท่านั้น — มันป้อนไบต์ก้อนเดิมที่วัดได้จริง
  //    กลับเข้าไป ไม่เคยสร้างไบต์ขึ้นเอง และไม่เคยขยับแถบความคืบหน้า ถ้าไม่มีตัวนี้
  //    ตอนเน็ตหลุดจะไม่มี progress event เข้ามาอีกเลย แล้วความเร็วก้อนสุดท้ายจะค้างอยู่
  //    บนจอทั้งที่ไม่มีไบต์ใดวิ่ง ซึ่งเป็นสิ่งที่ transferRate.js ห้ามไว้ชัดเจนที่สุด
  const uploadingCount = queue.reduce((total, item) => item.stage === 'uploading' ? total + 1 : total, 0)
  useEffect(() => {
    if (uploadingCount === 0) return undefined
    const timer = setInterval(() => {
      const at = now()
      const sampled = new Map()
      for (const item of queueRef.current) {
        if (item.stage !== 'uploading') continue
        const estimator = estimators.current.get(item.id)
        if (!estimator) continue
        sampled.set(item.id, estimator.sample(item.transferredBytes ?? 0, at, { totalBytes: item.size }))
      }
      if (sampled.size === 0) return
      setQueue((current) => current.map((item) => sampled.has(item.id) ? { ...item, rate: sampled.get(item.id) } : item))
    }, STALL_TICK_MS)
    return () => clearInterval(timer)
  }, [uploadingCount])

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
    const item = queueRef.current.find((candidate) => candidate.id === id)
    // คืนพื้นที่พักฝั่งเซิร์ฟเวอร์ทันที แทนที่จะปล่อยให้ค้างจนหมดอายุ
    if (item?.session?.uploadId) cancelSession(item.session.uploadId).catch(() => {})
    patchItem(id, { stage: 'cancelled', progress: null, session: null, rate: null })
  }
  // ทำต่อจาก session เดิมถ้ายังมีอยู่ (ส่งเฉพาะ chunk ที่ขาด) ไม่งั้นเริ่มใหม่ทั้งไฟล์
  const retry = (id) => {
    const item = queueRef.current.find((candidate) => candidate.id === id)
    if (!item?.file) return
    // ป้องกันกรณีที่คำสั่ง retry ถูกเรียกโดยตรงกับรายการที่เกินเพดาน deployment — ต้องไม่ส่งต่อเข้า transport
    if (limits && (item.size ?? item.file.size) > limits.maxLogicalFileBytes) {
      patchItem(id, { stage: 'failed', reason: 'tooLarge', rate: null })
      return
    }
    patchItem(id, { stage: 'waiting', reason: null, progress: null, rate: null })
    processFile(item.file, id, item.session ? { session: item.session, sha256: item.sha256 } : null)
  }
  const dismiss = (id) => setQueue((current) => current.filter((item) => item.id !== id))

  const portal = (content) => typeof document === 'undefined' ? content : createPortal(content, document.body)
  const pick = () => inputRef.current?.click()
  const acceptDrop = (event) => {
    event.preventDefault()
    if (event.dataTransfer?.files?.length) enqueue(event.dataTransfer.files)
  }

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
      {/* ⚠️ ซ่อนถาดทั้งที่ยังมีงานเดินอยู่ = ต้องเหลือทางกลับเสมอ ไม่งั้นผู้ใช้จะเชื่อว่า
          งานหายไปแล้วแล้วเริ่มอัปโหลดไฟล์เดิมซ้ำอีกรอบ */}
      {trayHidden && <UploadTrayLauncher t={t} queue={queue} onShow={revealTray} />}
    </>
  )

  if (!open) return portal(status)

  return portal(
    <>
      {status}
      <div className="fixed inset-0 z-[var(--z-modal)] bg-black/20" aria-hidden />
      <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="upload-drawer-title" className="fixed z-[calc(var(--z-modal)+1)] inset-y-0 right-0 w-full max-w-[420px] bg-canvas border-l border-line shadow-[var(--elev-2)] flex flex-col outline-none">
        <header className="px-6 py-5 border-b border-line flex items-start gap-3 bg-card">
          <div className="min-w-0 flex-1">
            <h2 id="upload-drawer-title" className="text-[18px] font-bold text-ink tracking-[-0.01em]">{t('uploadFiles')}</h2>
            <p className="mt-1 text-[11.5px] text-ink-3">
              {t('destinationFolder')} · <span className="font-mono text-ink-2">{destination}</span>
            </p>
          </div>
          <IconBtn label={t('closeUpload')} onClick={onClose}><X size={17} /></IconBtn>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {/* จุดเริ่มงานจุดเดียวของลิ้นชักนี้ — ใหญ่ ชัด และไม่มีอะไรมาแย่งความสนใจ */}
          <button
            type="button"
            onClick={pick}
            onDragOver={(event) => event.preventDefault()}
            onDrop={acceptDrop}
            className="w-full min-h-44 rounded-[var(--r-card)] border-2 border-dashed border-line bg-sunken flex flex-col items-center justify-center gap-2 text-center px-6 py-8 transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-[var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="size-12 rounded-full bg-card flex items-center justify-center shadow-[var(--elev-1)]">
              <UploadCloud size={22} className="text-accent" aria-hidden />
            </span>
            <span className="mt-1 block text-[14px] font-bold text-ink">{t('dropHere')}</span>
            <span className="block max-w-[28ch] text-[11.5px] leading-relaxed text-ink-3">{t('dropSub')}</span>
          </button>
          <input ref={inputRef} type="file" multiple className="sr-only" aria-label={t('chooseFiles')} onChange={(event) => { if (event.target.files?.length) enqueue(event.target.files); event.target.value = '' }} />

          <Btn variant="primary" className="w-full" onClick={pick}>{t('chooseFiles')}</Btn>

          {/* ⚠️ คิวที่กำลังเดินไม่ถูกแสดงซ้ำที่นี่อีกต่อไป ถาดมุมขวาล่างเป็นเจ้าของเรื่องนั้น
              คนเดียว — สองที่ที่พูดเรื่องเดียวกันคือที่มาของตัวเลขที่ขัดกันเองบนจอ */}
          <p className="text-[11.5px] leading-relaxed text-ink-3 border-l-2 border-line pl-3">{t('uploadEntryHint')}</p>

          <details className="border-t border-line pt-5">
            <summary className="cursor-pointer list-none flex items-center justify-between text-[11.5px] uppercase tracking-[0.12em] font-bold text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t('recentUploads')}<ChevronDown size={15} aria-hidden />
            </summary>
            <div className="mt-3">
              {recentLoading ? <div className="h-16 skeleton rounded-[var(--r-tile)]" aria-busy="true" /> : recentFiles.length === 0 ? <InlineEmptyState>{t('emptyNoUploads')}</InlineEmptyState> : (
                <div className="divide-y divide-line">{recentFiles.slice(0, 6).map((file) => <div key={file.id} className="py-2.5 flex items-center gap-3"><FileIcon size={14} className="text-ink-3 shrink-0" /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{file.name}</span><span className="text-[11.5px] text-ink-3 whitespace-nowrap">{fmtBytes(file.size)}</span></div>)}</div>
              )}
            </div>
          </details>
        </div>

        <footer className="px-6 py-4 border-t border-line bg-card">
          <span className="text-[11.5px] text-ink-3">{t('currentFolder')}: <span className="font-mono text-ink-2">{destination}</span></span>
        </footer>
      </aside>
    </>
  )
}
