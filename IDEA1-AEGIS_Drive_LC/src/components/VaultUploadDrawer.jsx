import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { createRateEstimator } from '../lib/transferRate.js'
import { cancelVaultUploadSession } from '../lib/vaultChunkedUpload.js'
import { TREE_UPLOAD_ROUTE_BASE } from '../lib/vaultTreeUpload.js'
import {
  createVaultRecoveryStore, fetchVaultUploadStatus, openVaultRecovery, rebuildVaultResume,
  receivedPlainBytes, sealVaultRecovery, verifyVaultRecoveryFile,
} from '../lib/vaultUploadRecovery.js'
import { UploadEntryPanel } from './UploadEntryPanel.jsx'
import { UploadStatusTray, UploadTrayLauncher } from './UploadStatusTray.jsx'

/** จังหวะเดินนาฬิกาให้ตัวประมาณ — ค่าเดียวกับ UploadDrawer ของ Files (จับ "หยุดนิ่ง" ได้ตอนไม่มี progress) */
const STALL_TICK_MS = 1_000
const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())
const visibleStage = (stage) => stage === 'encrypting' || stage === 'attaching' ? 'processing' : stage
const defaultCancelSession = (uploadId) => cancelVaultUploadSession(uploadId, { routeBase: TREE_UPLOAD_ROUTE_BASE })

/**
 * ลิ้นชัก + คิวอัปโหลดของ Private Vault — วงจรชีวิตเดียวกับ UploadDrawer ของ Files (PR #148):
 *   ลิ้นชักขวา (UploadEntryPanel ตัวเดียวกัน) = เริ่มงาน แล้วปิดตัวเองเมื่อไฟล์เข้าคิว
 *   ถาดมุมขวาล่าง (UploadStatusTray ตัวเดียวกัน) = เฝ้างาน ซ่อน/ย่อ/เปิดกลับได้ ความเร็ว/ETA จริง
 *   refresh = Interrupted / ต้องเลือกไฟล์เดิม → ตรวจตัวตน → ส่งเฉพาะ chunk ที่ขาด / ทิ้งงานได้
 *
 * ต่างจาก Files เฉพาะ adapter:
 *   ⚠️ transport คือ onUpload → uploadTreeFile → /api/vault/tree/uploads เท่านั้น ไม่มีเส้นทาง plaintext
 *   ⚠️ บันทึกกู้คืนมีแค่ตัวเลข/uploadId ทึบ/ciphertext ที่ปิดผนึกด้วย DEK (vaultUploadRecovery.js)
 *      DEK หลัง refresh ถูกสร้างใหม่จากซองที่ห่อไว้ด้วย KEK ของการปลดล็อกครั้งนี้ — ไม่มีกุญแจลง storage
 *   ⚠️ ล็อก/unmount = abort ฝั่ง client เท่านั้น ไม่ยกเลิก session ฝั่งเซิร์ฟเวอร์และไม่ลบบันทึก
 *      ชื่อไฟล์ที่ถอดแล้วอยู่ใน React state ที่ตายพร้อมจอที่ปลดล็อก
 */
export const VaultUploadDrawer = forwardRef(function VaultUploadDrawer({
  t, open, onClose, destination = '/', parentNodeId = null, onUpload,
  kek = null, recoveryScope = null, recoveryStorage,
  loadStatus = fetchVaultUploadStatus, cancelSession = defaultCancelSession,
}, ref) {
  const [queue, setQueue] = useState([])
  const [trayHidden, setTrayHidden] = useState(false)
  const [trayCollapsed, setTrayCollapsed] = useState(false)
  const idRef = useRef(0)
  const controllers = useRef(new Map())
  const estimators = useRef(new Map())
  const userCancelled = useRef(new Set())
  const alive = useRef(true)
  const chainRef = useRef(Promise.resolve())
  const queueRef = useRef(queue)
  queueRef.current = queue
  const recoverInputRef = useRef(null)
  const recoverTargetRef = useRef(null)

  // ร้านผูกกับบัญชีที่ล็อกอิน สร้างใหม่เมื่อบัญชีเปลี่ยนเท่านั้น (แบบแผนเดียวกับ Files)
  const recoveryRef = useRef(null)
  if (recoveryRef.current?.scope !== recoveryScope) {
    recoveryRef.current = { scope: recoveryScope, store: createVaultRecoveryStore({ storage: recoveryStorage, scope: recoveryScope }) }
  }
  const recovery = recoveryRef.current.store

  const patch = (id, values) => {
    if (!alive.current) return
    setQueue((items) => items.map((item) => item.id === id ? { ...item, ...values } : item))
  }
  const revealTray = () => { setTrayHidden(false); setTrayCollapsed(false) }

  const processJob = async (entry, resume = null) => {
    if (!alive.current || userCancelled.current.has(entry.id)) return
    const ctrl = new AbortController()
    const estimator = createRateEstimator()
    controllers.current.set(entry.id, ctrl)
    estimators.current.set(entry.id, estimator)
    let sealing = null
    let settled = false
    patch(entry.id, { stage: 'preparing', rate: null, reason: null })
    try {
      const result = await onUpload(entry.file, {
        parentNodeId: entry.parentNodeId,
        resume,
        ...(entry.recovery ? { name: entry.recovery.opened.name ?? entry.file.name, mediaType: entry.recovery.opened.mediaType } : {}),
        signal: ctrl.signal,
        onStage: (stage) => patch(entry.id, { stage: visibleStage(stage) }),
        // ⚠️ จดทันทีที่ session มีจริง ไม่ใช่ตอนจบ — ช่วงที่ผู้ใช้กด refresh คือช่วงที่ยาวที่สุดของไฟล์ใหญ่
        onSession: (state) => {
          const uploadId = state?.upload?.uploadId
          if (!uploadId || !state.dek || !state.plan) return
          patch(entry.id, { session: { uploadId } })
          // ⚠️ ไม่ผูกกับ ctrl.signal: ล็อกระหว่างปิดผนึกต้องยังเหลือบันทึกให้กู้ได้ (ล็อก ≠ ยกเลิก)
          sealing = sealVaultRecovery({ dek: state.dek, uploadId, file: entry.file, plan: state.plan, parentNodeId: entry.parentNodeId })
            .then((record) => { if (!settled && !userCancelled.current.has(entry.id)) recovery.save(record) })
            .catch(() => { /* กู้ข้าม reload ไม่ได้ ≠ อัปโหลดไม่ได้ */ })
        },
        onProgress: (progress = {}) => {
          const transferredBytes = Math.max(0, Number(progress.transferredBytes) || 0)
          const totalBytes = Number(progress.totalBytes) || entry.size
          patch(entry.id, {
            stage: visibleStage(progress.phase ?? 'uploading'),
            progress: Number.isFinite(progress.percent) ? progress.percent : totalBytes > 0 ? transferredBytes / totalBytes * 100 : null,
            transferredBytes,
            chunkIndex: progress.chunkIndex ?? null,
            chunkCount: progress.chunkCount ?? 0,
            rate: estimator.sample(transferredBytes, now(), { totalBytes }),
          })
        },
      })
      const uploadId = result?.resume?.upload?.uploadId ?? queueRef.current.find((item) => item.id === entry.id)?.session?.uploadId ?? resume?.upload?.uploadId ?? null
      if (result?.ok) {
        settled = true
        await sealing
        if (uploadId) recovery.remove(uploadId)
        patch(entry.id, { stage: 'complete', progress: 100, transferredBytes: entry.size, rate: null, reason: null, resume: null })
        return
      }
      const cancelled = ctrl.signal.aborted || result?.stage === 'cancelled'
      patch(entry.id, {
        stage: cancelled ? 'cancelled' : result?.stage === 'paused' ? 'paused' : 'failed',
        rate: null,
        reason: cancelled ? null : result?.reason ?? 'server',
        // resume ในหน่วยความจำ (มี DEK) ใช้กับ Retry ในแท็บนี้เท่านั้น — ไม่เคยลง storage
        resume: result?.resume ?? null,
        session: result?.resume?.upload?.uploadId ? { uploadId: result.resume.upload.uploadId } : (uploadId ? { uploadId } : null),
      })
    } catch (error) {
      patch(entry.id, { stage: ctrl.signal.aborted ? 'cancelled' : 'failed', rate: null, reason: error?.code ?? 'server' })
    } finally {
      controllers.current.delete(entry.id)
      estimators.current.delete(entry.id)
    }
  }

  const schedule = (entry, resume = null) => {
    // TREE commit เป็น CAS บน manifest เดียว — ส่งทีละไฟล์ตามลำดับเพื่อไม่ให้แนบชนกันเอง
    chainRef.current = chainRef.current.then(() => processJob(entry, resume))
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
      session: null,
    }))
    setQueue((items) => [...entries.slice().reverse(), ...items])
    revealTray()
    onClose?.()
    for (const entry of entries) schedule(entry)
  }

  useImperativeHandle(ref, () => ({ enqueueFiles }), [parentNodeId, onClose, onUpload])

  // ⚠️ หน้าถูกทำลาย/ล็อก ≠ ผู้ใช้ยกเลิก: หยุดแค่ request ในเครื่อง ห้าม cancelSession ห้ามลบบันทึก
  useEffect(() => () => {
    alive.current = false
    for (const ctrl of controllers.current.values()) ctrl.abort()
    controllers.current.clear()
    estimators.current.clear()
  }, [])

  // นาฬิกาจับการหยุดนิ่ง — ป้อนไบต์ที่วัดได้จริงกลับเข้าตัวประมาณ ไม่เคยสร้างไบต์เอง (แบบเดียวกับ Files)
  const uploadingCount = queue.reduce((total, item) => item.stage === 'uploading' ? total + 1 : total, 0)
  useEffect(() => {
    if (uploadingCount === 0) return undefined
    const timer = setInterval(() => {
      const at = now()
      const sampled = new Map()
      for (const item of queueRef.current) {
        if (item.stage !== 'uploading') continue
        const estimator = estimators.current.get(item.id)
        if (estimator) sampled.set(item.id, estimator.sample(item.transferredBytes ?? 0, at, { totalBytes: item.size }))
      }
      if (sampled.size > 0) setQueue((current) => current.map((item) => sampled.has(item.id) ? { ...item, rate: sampled.get(item.id) } : item))
    }, STALL_TICK_MS)
    return () => clearInterval(timer)
  }, [uploadingCount])

  // ── คืนสภาพคิวหลัง reload + ปลดล็อก ──────────────────────────────────────────
  // ⚠️ เซิร์ฟเวอร์เป็นผู้ตัดสินเสมอว่า session ยังอยู่และขาด chunk ไหน; ต้องมี KEK ของการปลดล็อกนี้
  useEffect(() => {
    if (!kek) return undefined
    const records = recovery.list()
    if (records.length === 0) return undefined
    let cancelled = false
    const controller = new AbortController()
    ;(async () => {
      for (const record of records) {
        const status = await loadStatus(record.uploadId, { signal: controller.signal })
        if (cancelled) return
        if (!status.ok) {
          // เซิร์ฟเวอร์ยืนยันว่าไม่มีแล้วเท่านั้นที่ทิ้งได้ — เน็ตล่ม = ยังไม่รู้
          if (status.reason === 'expired') recovery.remove(record.uploadId)
          continue
        }
        let opened
        try {
          opened = await openVaultRecovery({ kek, record, status })
        } catch {
          continue // ซองไม่ตรง/กุญแจเปลี่ยน — ไม่แสดงสิ่งที่พิสูจน์ไม่ได้ และไม่ทำลายบันทึกด้วยการเดา
        }
        if (cancelled) return
        setQueue((current) => {
          if (current.some((entry) => entry.session?.uploadId === record.uploadId)) return current
          return [{
            id: `recovered-${record.uploadId}`,
            file: null,
            name: opened.name ?? t('vaultUnnamed'),
            size: opened.plainSize,
            parentNodeId: opened.parentNodeId,
            recovery: { record, opened, status },
            session: { uploadId: record.uploadId },
            // ⚠️ ห้ามเป็น 'uploading' — ไม่มีไบต์ใดวิ่งอยู่ในแท็บนี้จนกว่าผู้ใช้จะชี้ไฟล์เดิมกลับมา
            stage: 'interrupted',
            reason: null,
            progress: null,
            transferredBytes: receivedPlainBytes(status.upload, opened.plainSize),
            chunkIndex: 0,
            chunkCount: status.upload.chunkCount ?? record.chunkCount ?? 0,
            rate: null,
          }, ...current]
        })
        revealTray()
      }
    })().catch(() => { /* คืนสภาพไม่สำเร็จ = คิวว่าง ไม่ใช่จอพัง */ })
    return () => { cancelled = true; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kek, recoveryScope])

  // ⚠️ คำสั่งของผู้ใช้ — ต่างจาก unmount: คืนพื้นที่พักฝั่งเซิร์ฟเวอร์และลบบันทึกทันที
  const cancel = (id) => {
    userCancelled.current.add(id)
    const ctrl = controllers.current.get(id)
    if (ctrl) ctrl.abort()
    const uploadId = queueRef.current.find((item) => item.id === id)?.session?.uploadId
    if (uploadId) {
      cancelSession(uploadId).catch?.(() => {})
      recovery.remove(uploadId)
    }
    patch(id, { stage: 'cancelled', rate: null, reason: null, session: null, resume: null })
  }
  const dismiss = (id) => {
    userCancelled.current.add(id)
    setQueue((items) => items.filter((item) => item.id !== id))
  }
  const retry = (id) => {
    const item = queueRef.current.find((candidate) => candidate.id === id)
    if (!item?.file) return
    userCancelled.current.delete(id)
    patch(id, { stage: 'waiting', reason: null, rate: null })
    // paused ในแท็บนี้ = resume ในหน่วยความจำ → ส่งเฉพาะ chunk ที่ขาด; ไม่งั้นเริ่มใหม่
    schedule({ ...item }, item.resume ?? null)
  }
  const discard = (id) => {
    const uploadId = queueRef.current.find((candidate) => candidate.id === id)?.session?.uploadId
    if (uploadId) {
      cancelSession(uploadId).catch?.(() => {})
      recovery.remove(uploadId)
    }
    setQueue((current) => current.filter((entry) => entry.id !== id))
  }
  const requestRecover = (id) => {
    recoverTargetRef.current = id
    patch(id, { recoverError: null })
    recoverInputRef.current?.click()
  }

  /**
   * ผู้ใช้ชี้ไฟล์ต้นทางกลับมา — พิสูจน์ตัวตน (ขนาด + ลายนิ้วมือที่ปิดผนึกด้วย DEK) ก่อนส่งก้อนใด
   * แล้วต่อเข้า session เดิมด้วย DEK ที่สร้างใหม่จากซอง: transport ถามสถานะเซิร์ฟเวอร์อีกรอบแล้วส่งเฉพาะก้อนที่ขาด
   */
  const acceptRecoverFile = async (id, file) => {
    const item = queueRef.current.find((candidate) => candidate.id === id)
    if (!item?.recovery || !file) return
    patch(id, { verifying: true, recoverError: null })
    const verdict = await verifyVaultRecoveryFile({ record: item.recovery.record, opened: item.recovery.opened, file })
    if (!verdict.ok) {
      patch(id, { verifying: false, recoverError: verdict.reason === 'cancelled' ? null : verdict.reason })
      return
    }
    const resume = rebuildVaultResume({ opened: item.recovery.opened, status: item.recovery.status, file })
    patch(id, { verifying: false, recoverError: null, file, stage: 'waiting', rate: null })
    schedule({ ...item, file, size: file.size, parentNodeId: item.recovery.opened.parentNodeId ?? parentNodeId }, resume)
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
          onRecover={requestRecover}
          onDiscard={discard}
        />
      )}
      <input
        ref={recoverInputRef}
        data-upload-recover-input=""
        type="file"
        className="sr-only"
        aria-label={t('uploadRecoverSelect')}
        onChange={(event) => {
          const file = event.target.files?.[0]
          const id = recoverTargetRef.current
          event.target.value = ''
          if (file && id) void acceptRecoverFile(id, file)
        }}
      />
      {trayHidden && <UploadTrayLauncher t={t} queue={queue} onShow={revealTray} />}
    </>
  )

  if (!open) return portal(status)
  return portal(
    <>
      {status}
      <UploadEntryPanel
        t={t}
        onClose={onClose}
        onFiles={(files) => enqueueFiles(files)}
        destination={destination}
        titleId="vault-upload-title"
        testId="vault-upload-drawer"
        inputTestId="vault-upload-input"
      />
    </>,
  )
})
