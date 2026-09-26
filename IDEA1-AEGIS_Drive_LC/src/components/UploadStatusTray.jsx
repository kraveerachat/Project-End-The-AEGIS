// src/components/UploadStatusTray.jsx — AEGIS Drive (IDEA1) · ถาดสถานะการอัปโหลด
//
// หน้าที่ของสองพื้นผิวถูกแยกกันชัดเจนใน FILES-UPLOAD-UX-1:
//
//   UploadDrawer  = "เริ่มงาน"  — เลือก/ลากไฟล์ แล้วปิดตัวเอง
//   UploadStatusTray = "เฝ้างาน" — คิว ความคืบหน้า ความเร็ว ETA และคำสั่งต่อรายการ
//
// ⚠️ ถาดนี้เป็น **พื้นผิวนำเสนออย่างเดียว** ไม่ถือ state ของคิวเอง เจ้าของคิวคือ
//    UploadDrawer ซึ่งถูก mount ค้างไว้ตลอดอายุของหน้า Files ดังนั้น "ปิดถาด" จึงเป็น
//    การซ่อนภาพเท่านั้น ไม่มีทางกลายเป็นการยกเลิกงานได้โดยโครงสร้าง
//
// ⚠️ ตัวเลขทุกตัวที่นี่มาจากไบต์ที่วัดได้จริง ความเร็ว/ETA มาจาก lib/transferRate.js
//    ตัวเดียวกับ Private Vault (ห้ามเขียนอัลกอริทึมความเร็วชุดที่สอง) และจะถูกแสดง
//    **เฉพาะตอน stage === 'uploading'** เท่านั้น ระหว่างแฮชหรือ commit ไม่มีไบต์วิ่ง
//    บนสาย การโชว์ความเร็วค้างไว้ตรงนั้นคือคำโกหกที่แนบเนียนที่สุดของหน้าจอแบบนี้
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, File as FileIcon, RotateCcw, UploadCloud, X } from 'lucide-react'

import { fmtBytes, fmtRate } from '../lib/format.js'
import { etaParts, transferRateLine } from '../lib/transferRate.js'
import { Chip, IconBtn } from './ui.jsx'

/** ขั้นที่ยังนับว่า "งานเดินอยู่" — ชุดเดียวกับที่ UploadDrawer ใช้ตัดสินใจ */
export const ACTIVE_UPLOAD_STAGES = new Set(['waiting', 'preparing', 'hashing', 'processing', 'uploading', 'committing'])

/**
 * ขั้นที่ผู้ใช้ต้องมาจัดการเอง — ยังไม่จบ และยังไม่ถือว่าล้มเหลวถาวรเสมอไป
 * ⚠️ `interrupted` = งานที่เซิร์ฟเวอร์ยังถือ chunk ไว้ให้ แต่แท็บนี้ไม่มีตัวไฟล์แล้ว
 *    (เกิดหลัง reload) มันไม่ใช่งานที่กำลังเดิน และไม่ใช่งานที่ล้มเหลว
 */
const ATTENTION_STAGES = new Set(['paused', 'failed', 'interrupted'])

/** ขั้นเดียวที่มีไบต์วิ่งบนสายจริง จึงเป็นขั้นเดียวที่พูดเรื่องความเร็ว/ETA ได้ */
const MEASURING_STAGE = 'uploading'

/**
 * ขั้นที่ "กำลังทำงานอยู่ แต่ยังไม่มีไบต์วิ่งบนสาย"
 * ⚠️ นี่คือความต่างที่หัวถาดเคยพูดผิด: ไฟล์ 2 GB สี่ไฟล์ที่กำลังแฮชอยู่ถูกสรุปว่า
 *    "Uploading 4 items" ทั้งที่ยังไม่มีไบต์ใดออกจากเครื่องเลยแม้แต่ไบต์เดียว
 */
const CHECKING_STAGES = new Set(['waiting', 'preparing', 'hashing', 'processing'])

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
  interrupted: 'upStageInterrupted',
}

// เหตุผลที่แสดงใต้ชื่อไฟล์ — บอกว่าต้องทำอะไรต่อ ไม่ใช่แค่ป้าย "Failed"
const REASON_LABEL = {
  COLLISION: 'vaultUploadNameCollision',
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
  if (stage === 'paused' || stage === 'interrupted') return 'warn'
  if (stage === 'cancelled') return 'neutral'
  return 'accent'
}

export const activeUploadCount = (queue = []) => queue.filter((entry) => ACTIVE_UPLOAD_STAGES.has(entry.stage)).length
export const failedUploadCount = (queue = []) => queue.filter((entry) => entry.stage === 'failed').length
export const attentionUploadCount = (queue = []) => queue.filter((entry) => ATTENTION_STAGES.has(entry.stage)).length
export const completeUploadCount = (queue = []) => queue.filter((entry) => entry.stage === 'complete').length

/**
 * มีอะไรให้ผู้ใช้กลับมาดูไหมหลังซ่อนถาด — งานที่เดินอยู่ หรืองานที่รอการตัดสินใจ
 * ⚠️ เพรดิเคตนี้ต้องมีที่เดียว ชิปเปิดถาดกับตัวที่ที่อื่นเรียกใช้ต้องตอบเหมือนกันเสมอ
 *    ไม่งั้นจะเกิดสถานะที่ "มีงานค้าง แต่ไม่มีทางกลับไปดู"
 */
export const shouldShowQueueLauncher = (queue = []) => activeUploadCount(queue) > 0 || attentionUploadCount(queue) > 0

/**
 * สรุปหัวถาดจากคิวจริง — คืน "คีย์ + ตัวแปร" ไม่ใช่ข้อความ เพื่อให้ทดสอบได้ว่าเลือก
 * ประโยคไหนโดยไม่ผูกกับภาษาใดภาษาหนึ่ง
 *
 * ⚠️ ลำดับความสำคัญคือสาระของฟังก์ชันนี้ทั้งหมด:
 *    งานที่กำลังเดิน > งานที่ต้องตรวจสอบ > งานที่สำเร็จ
 *    การพูดว่า "เสร็จแล้ว" ทั้งที่ยังมีไฟล์ paused/failed ค้างอยู่คือการรายงานเท็จ
 *
 * @param {{ stage: string }[]} queue
 * @returns {{ key: string, vars: { n: number } }}
 */
export function uploadTraySummary(queue = []) {
  const uploading = queue.filter((entry) => entry.stage === MEASURING_STAGE).length
  const checking = queue.filter((entry) => CHECKING_STAGES.has(entry.stage)).length
  const finalizing = queue.filter((entry) => entry.stage === 'committing').length

  // ⚠️ "กำลังส่ง" กับ "กำลังตรวจไฟล์" ต้องไม่ถูกยุบเป็นคำเดียวกัน ไฟล์ 2 GB สี่ไฟล์ที่
  //    ยังแฮชอยู่ไม่ได้ "กำลังอัปโหลด" — และผู้ใช้จะรู้ทันทีว่าโดนโกหกเมื่อตัวนับไบต์
  //    ยังเป็นศูนย์อยู่หลายนาที
  if (uploading > 0 && checking > 0) {
    return { key: 'uploadTrayMixed', vars: { n: uploading, checking } }
  }
  if (uploading > 0) {
    return { key: uploading === 1 ? 'uploadTrayUploadingOne' : 'uploadTrayUploading', vars: { n: uploading } }
  }
  if (checking > 0) {
    return { key: checking === 1 ? 'uploadTrayCheckingOne' : 'uploadTrayChecking', vars: { n: checking } }
  }
  if (finalizing > 0) {
    return { key: finalizing === 1 ? 'uploadTrayFinalizingOne' : 'uploadTrayFinalizing', vars: { n: finalizing } }
  }

  const attention = attentionUploadCount(queue)
  if (attention > 0) return { key: attention === 1 ? 'uploadTrayAttentionOne' : 'uploadTrayAttention', vars: { n: attention } }

  const complete = completeUploadCount(queue)
  if (complete > 0) return { key: complete === 1 ? 'uploadTrayCompleteOne' : 'uploadTrayComplete', vars: { n: complete } }

  return { key: 'uploadTrayTitle', vars: { n: queue.length } }
}

/**
 * ภาพรวมของทั้งชุด — ตอบคำถามเดียวที่ผู้ใช้ลากไฟล์ 2 GB มาสี่ไฟล์อยากรู้: "อีกนานแค่ไหน"
 *
 * ⚠️ สองตัวเลขนี้มาจากคนละกลุ่มกันโดยเจตนา และนี่คือสาระของฟังก์ชันทั้งหมด:
 *
 *    THROUGHPUT ที่วัดได้ — มาจากแถวที่ `uploading` เท่านั้น เพราะมีแต่แถวเหล่านั้นที่
 *      มีไบต์วิ่งบนสายจริงให้วัด แถวที่หยุดนิ่งสมทบ "ศูนย์" ไม่ใช่ความเร็วก้อนสุดท้าย
 *      ของตัวเอง (กติกาเดียวกับที่ transferRate.js บังคับไว้กับรายการเดี่ยว)
 *
 *    ไบต์ที่เหลือของทั้งชุด — มาจาก **ทุกไฟล์ที่ยังต้องวิ่งผ่านสาย** ไม่ใช่เฉพาะไฟล์ที่
 *      กำลังส่งอยู่ ไฟล์ที่ยังแฮชอยู่จะต้องส่งทั้งก้อนในอีกสักครู่ การนับเฉพาะไฟล์ที่
 *      กำลังส่งทำให้ผู้ใช้ที่ลากมาสี่ไฟล์เห็นตัวเลขของสองไฟล์แล้วเข้าใจว่าใกล้เสร็จแล้ว
 *
 * ⚠️ ไฟล์ที่ยังไม่เริ่มส่งเลยสักไบต์ → ไบต์ที่เหลือ = ขนาดเต็มของมัน
 *    ไฟล์ที่กำลังส่ง → ไบต์ที่เหลือ = ขนาด − ไบต์ที่ส่งไปแล้ว
 *
 * ⚠️ ที่ไม่นับ: `committing` (เซิร์ฟเวอร์ทำงานของตัวเอง ไม่มีไบต์บนสาย),
 *    `interrupted` (ยังไม่มีไฟล์ต้นทางในแท็บนี้ จะยังไม่มีไบต์ใดวิ่งจนกว่าผู้ใช้จะเลือกไฟล์)
 *    และทุกสถานะที่จบแล้ว
 *
 * ⚠️ `etaSeconds` คือ **เวลาโอนที่เหลือถ้าอัตราปัจจุบันคงที่** ไม่ใช่ "เวลาจนงานเสร็จ"
 *    เวลาแฮชและขั้น commit ของเซิร์ฟเวอร์ไม่ได้ถูกวัดด้วยอัตรานี้เลย ถ้อยคำที่แสดงผล
 *    จึงต้องพูดว่า "ที่อัตราปัจจุบัน" ไม่ใช่สัญญาว่างานจะเสร็จเมื่อไร
 *
 * @param {{ stage: string, size?: number|null, transferredBytes?: number,
 *           rate?: { bytesPerSecond: number|null, stalled: boolean }|null }[]} queue
 */
export function uploadTrayAggregate(queue = []) {
  const uploading = queue.filter((entry) => entry.stage === MEASURING_STAGE)
  const checking = queue.filter((entry) => CHECKING_STAGES.has(entry.stage))
  // ทุกไฟล์ที่ยังต้องใช้เครือข่ายในอีกสักครู่ — คือขอบเขตของ "ไบต์ที่เหลือของทั้งชุด"
  const transferable = [...checking, ...uploading]

  let bytesPerSecond = null
  let stalledCount = 0

  for (const entry of uploading) {
    const rate = entry.rate ?? null
    if (rate?.stalled) { stalledCount += 1; continue }
    if (typeof rate?.bytesPerSecond === 'number' && Number.isFinite(rate.bytesPerSecond)) {
      bytesPerSecond = (bytesPerSecond ?? 0) + rate.bytesPerSecond
    }
  }

  let remainingBytes = 0
  let remainingKnown = transferable.length > 0
  for (const entry of transferable) {
    const total = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size > 0 ? entry.size : null
    // ⚠️ ไฟล์เดียวที่ไม่รู้ขนาดทำให้ผลรวมของทั้งชุดไม่มีความหมาย — ยอมไม่บอกดีกว่าบอกผิด
    if (total === null) { remainingKnown = false; break }
    const sent = entry.stage === MEASURING_STAGE ? (entry.transferredBytes ?? 0) : 0
    remainingBytes += Math.max(0, total - sent)
  }

  const remaining = remainingKnown ? remainingBytes : null
  const etaSeconds = remaining !== null && bytesPerSecond !== null && bytesPerSecond > 0
    ? remaining / bytesPerSecond
    : null

  return {
    uploadingCount: uploading.length,
    checkingCount: checking.length,
    transferableCount: transferable.length,
    stalledCount,
    bytesPerSecond,
    remainingBytes: remaining,
    etaSeconds,
  }
}

/**
 * บรรทัดความเร็ว/ETA ของหนึ่งรายการ — คืน null เมื่อ "ยังไม่มีอะไรจริงให้พูด"
 * ⚠️ ประตูบานแรกคือ stage ไม่ใช่ข้อมูล: ต่อให้ rate ก้อนล่าสุดยังติดอยู่กับรายการ
 *    การเปลี่ยนไป hashing/committing/paused ต้องทำให้บรรทัดนี้หายทันที
 */
function measuredRateLine(t, entry) {
  if (entry.stage !== MEASURING_STAGE) return null
  return transferRateLine(t, entry.rate ?? null)
}

export function UploadStatusRow({ t, entry, onCancel, onRetry, onDismiss, onRecover, onDiscard }) {
  const cancellable = ACTIVE_UPLOAD_STAGES.has(entry.stage)
  // ⚠️ `interrupted` ไม่อยู่ในรายการนี้โดยเจตนา: Dismiss เอาแถวออกจากคิวในหน่วยความจำ
  //    เท่านั้น บันทึกกู้คืนยังอยู่ แถวเดิมจึงกลับมาเองตอน reload ครั้งหน้า ปุ่มที่ทำให้
  //    ของหายแล้วกลับมาเองคือปุ่มที่โกหก — งานที่กู้ได้ใช้ "ทิ้งงานนี้" ที่ลบของจริงแทน
  const dismissible = ['complete', 'failed', 'cancelled'].includes(entry.stage)
  // ⚠️ งานที่ค้างจาก reload: เซิร์ฟเวอร์ยังถือ chunk ไว้ให้ แต่เบราว์เซอร์คืน File object
  //    ของ <input type=file> ให้เราไม่ได้ ผู้ใช้จึงต้องชี้ไฟล์ต้นทางเดิมกลับมาเอง
  const recoverable = entry.stage === 'interrupted' && Boolean(entry.session?.uploadId)
  const progress = entry.stage === 'complete' ? 100 : entry.progress
  // หยุดชั่วคราวแล้วยังมี session อยู่ = ทำต่อได้ ไม่ต้องเริ่มไฟล์ใหม่ทั้งก้อน
  const resumable = entry.stage === 'paused' && Boolean(entry.session)
  // ⚠️ ไฟล์ที่เกินเพดานของ deployment ถูกปฏิเสธตั้งแต่แรก — การกด retry ไม่ช่วยให้ผ่าน
  //    และต้องไม่มีปุ่ม retry ให้ผู้ใช้กดส่งซ้ำ
  const retryable = ((entry.stage === 'failed' && entry.reason !== 'tooLarge') || resumable) && Boolean(entry.file)
  const reasonLabel = REASON_LABEL[entry.reason]
  const rateLine = measuredRateLine(t, entry)
  // ⚠️ "0 B of 10.2 GB" ใต้ไฟล์ที่ถูกปฏิเสธเพราะเกินเพดานคือตัวเลขที่ไม่มีความหมาย —
  //    ไม่มีไบต์ใดถูกส่ง และแถวนั้นบอกเหตุผลจริงไว้แล้ว ตัวนับไบต์จึงขึ้นเฉพาะตอนที่
  //    มีการโอนเกิดขึ้นจริงหรือเคยเกิดขึ้นเท่านั้น
  const showBytes = entry.stage === 'complete' || entry.chunkCount > 0 || (entry.transferredBytes ?? 0) > 0

  return (
    <li
      data-upload-row={entry.id}
      data-upload-stage={entry.stage}
      data-upload-reason={entry.reason ?? ''}
      className="px-3.5 py-3 border-t border-line first:border-t-0"
    >
      <div className="flex items-center gap-2.5">
        <span className="size-7 rounded-[8px] bg-sunken flex items-center justify-center shrink-0">
          {entry.stage === 'complete'
            ? <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden style={{ color: 'var(--ok)' }} />
            : entry.stage === 'failed'
              ? <AlertTriangle size={14} strokeWidth={1.75} aria-hidden style={{ color: 'var(--danger)' }} />
              : <FileIcon size={14} strokeWidth={1.5} className="text-ink-2" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-semibold text-ink truncate" title={entry.name}>{entry.name}</span>
          {/* ขนาดไฟล์อยู่ตรงนี้เฉพาะตอนที่ยังไม่มีตัวนับ "x จาก y" ด้านล่าง — ไม่งั้น
              ผู้ใช้จะเห็นขนาดเดียวกันสองครั้งในการ์ดใบเดียว */}
          {!showBytes && (
            <span className="block text-[11px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(entry.size)}</span>
          )}
        </span>
        <Chip tone={stageTone(entry.stage)}>{t(STAGE_LABEL[entry.stage] ?? 'uploadWaiting')}</Chip>
      </div>

      {reasonLabel && (
        <p role="alert" className="mt-1.5 text-[11px] font-medium leading-snug" style={{ color: entry.stage === 'paused' ? 'var(--warn)' : 'var(--danger)' }}>
          {t(reasonLabel)}
        </p>
      )}

      {/* งานที่ค้างจาก reload อธิบายตัวเองว่าต้องทำอะไรต่อ ไม่ใช่แค่ติดป้ายว่าค้าง */}
      {recoverable && (
        <p className="mt-1.5 text-[11px] font-medium leading-snug" style={{ color: 'var(--warn)' }}>
          {t(entry.recoverError === 'content' ? 'uploadRecoverWrongFile'
            : entry.recoverError === 'size' ? 'uploadRecoverWrongSize'
              : entry.recoverError === 'unreadable' ? 'uploadRecoverUnreadable'
                : entry.verifying ? 'uploadRecoverVerifying'
                  : 'uploadRecoverHint')}
        </p>
      )}

      {typeof progress === 'number' && (
        <div
          className="mt-2 h-1 rounded-full bg-sunken overflow-hidden"
          role="progressbar"
          aria-label={entry.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, progress))}%`, background: entry.stage === 'complete' ? 'var(--ok)' : 'var(--accent)' }}
          />
        </div>
      )}

      {/* ไบต์ที่ส่งไปแล้ว / ทั้งหมด คือข้อมูลที่ผู้ใช้อ่านก่อน — จำนวนก้อนเป็นรายละเอียดรอง */}
      {showBytes && (
        <p className="mt-1.5 text-[11px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('uploadBytesCounter', { done: fmtBytes(entry.transferredBytes ?? 0), total: fmtBytes(entry.size) })}
          {rateLine && <span className="text-ink-2"> · {rateLine}</span>}
        </p>
      )}
      {entry.chunkCount > 0 && entry.stage === MEASURING_STAGE && (
        <p className="mt-0.5 text-[10.5px] text-ink-3/80" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('uploadChunkCounter', { done: Math.min((entry.chunkIndex ?? 0) + 1, entry.chunkCount), total: entry.chunkCount })}
        </p>
      )}

      {(cancellable || retryable || dismissible || recoverable) && (
        <div className="mt-2 flex justify-end gap-3">
          {cancellable && (
            <button type="button" data-upload-cancel={entry.id} onClick={() => onCancel(entry.id)} className="text-[11.5px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t('cancel')}
            </button>
          )}
          {recoverable && (
            <button type="button" data-upload-recover={entry.id} disabled={Boolean(entry.verifying)} onClick={() => onRecover?.(entry.id)} className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <RotateCcw size={11} aria-hidden />{t('uploadRecoverSelect')}
            </button>
          )}
          {retryable && (
            <button type="button" data-upload-retry={entry.id} onClick={() => onRetry(entry.id)} className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <RotateCcw size={11} aria-hidden />{t(resumable ? 'uploadResume' : 'retry')}
            </button>
          )}
          {dismissible && (
            <button type="button" data-upload-dismiss={entry.id} onClick={() => onDismiss(entry.id)} className="text-[11.5px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t('dismiss')}
            </button>
          )}
          {recoverable && (
            <button type="button" data-upload-discard={entry.id} onClick={() => onDiscard?.(entry.id)} className="text-[11.5px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t('uploadRecoverDiscard')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * บรรทัดสรุปของทั้งชุด: "<ไบต์ที่เหลือ> · <อัตรารวม> · <เวลาโอนที่เหลือ>"
 *
 * ⚠️ แต่ละท่อนหายได้อิสระจากกัน ไม่ใช่ทั้งหมดหรือไม่มีเลย — รู้ไบต์ที่เหลือแต่ยังวัด
 *    อัตราไม่ได้ ก็บอกไบต์ที่เหลืออย่างเดียว การรอให้ครบทุกท่อนแปลว่าช่วงต้นของทุกคิว
 *    จะว่างเปล่าทั้งที่เรารู้ตัวเลขจริงอยู่ตัวหนึ่งแล้ว
 */
function aggregateLine(t, batch) {
  const parts = []
  if (batch.remainingBytes !== null) parts.push(t('uploadTrayRemaining', { size: fmtBytes(batch.remainingBytes) }))

  const speed = fmtRate(batch.bytesPerSecond)
  if (speed) parts.push(speed)

  const eta = etaParts(batch.etaSeconds)
  if (eta) {
    // ⚠️ คีย์ชุดของถาดเอง ไม่ใช่ของ Vault: ของ Vault ลงท้ายว่า "remaining" ซึ่งอ่านแล้ว
    //    เหมือนสัญญาว่างานจะเสร็จเมื่อไร ส่วนตัวเลขนี้เป็นแค่การหารด้วยอัตราที่วัดได้
    //    ณ วินาทีนี้ และไม่รวมเวลาแฮชหรือเวลา commit เลย
    const key = eta.unit === 'seconds' ? 'uploadTrayEtaSeconds'
      : eta.unit === 'minutes' ? 'uploadTrayEtaMinutes'
        : 'uploadTrayEtaHours'
    parts.push(t(key, { n: eta.value }))
  }

  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * ถาดลอยมุมขวาล่าง — กว้างพอบนเดสก์ท็อป และหดตามความกว้างจอเล็กเสมอ
 *
 * ⚠️ `onHide` กับ `onCancel` เป็นคนละคำสั่งกันโดยเจตนา และต้องไม่ถูกรวมเป็นปุ่มเดียว
 *    ไม่ว่าจะด้วยเหตุผลด้านพื้นที่บนจอก็ตาม
 */
export function UploadStatusTray({ t, queue = [], collapsed = false, onToggleCollapse, onHide, onCancel, onRetry, onDismiss, onRecover, onDiscard }) {
  if (queue.length === 0) return null

  const summary = uploadTraySummary(queue)
  const attention = attentionUploadCount(queue)
  const active = activeUploadCount(queue)
  const batch = uploadTrayAggregate(queue)
  // ⚠️ ไฟล์เดียวไม่ต้องมีบรรทัดสรุปรวม มันจะพูดซ้ำกับแถวของตัวเองคำต่อคำ
  const batchLine = batch.transferableCount > 1 ? aggregateLine(t, batch) : null

  return (
    <section
      data-upload-tray={collapsed ? 'collapsed' : 'expanded'}
      aria-label={t('uploadTrayTitle')}
      className="fixed z-[var(--z-toast)] bottom-4 right-4 left-4 sm:left-auto sm:bottom-5 sm:right-5 sm:w-[min(400px,calc(100vw-2.5rem))] max-h-[min(60vh,28rem)] flex flex-col rounded-[var(--r-card)] border border-line bg-card shadow-[var(--elev-2)] overflow-hidden"
    >
      <header className="flex items-center gap-2 px-3.5 py-2.5 bg-sunken border-b border-line">
        <span className="size-6 rounded-[7px] flex items-center justify-center shrink-0" style={{ color: active > 0 ? 'var(--accent)' : attention > 0 ? 'var(--warn)' : 'var(--ok)' }}>
          {active > 0 ? <UploadCloud size={14} aria-hidden /> : attention > 0 ? <AlertTriangle size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
        </span>
        {/* ⚠️ polite + ข้อความระดับ "สรุป" เท่านั้น — ไบต์เปลี่ยนวินาทีละหลายครั้ง
            การประกาศทุกการเปลี่ยนแปลงจะทำให้ screen reader ใช้งานหน้านี้ไม่ได้เลย */}
        <div className="min-w-0 flex-1">
          <p role="status" aria-live="polite" className="text-[12.5px] font-bold text-ink truncate">
            {t(summary.key, summary.vars)}
          </p>
          {/* ⚠️ อยู่นอก role="status" โดยเจตนา: ตัวเลขนี้ขยับทุกวินาที การประกาศมันคือ
              การทำให้ screen reader พูดทับตัวเองไม่หยุด */}
          {batchLine && (
            <p data-upload-tray-batch="" className="text-[11px] text-ink-3 truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {batchLine}
            </p>
          )}
        </div>
        <IconBtn
          label={t(collapsed ? 'uploadTrayExpand' : 'uploadTrayCollapse')}
          aria-expanded={!collapsed}
          data-upload-tray-collapse=""
          onClick={onToggleCollapse}
        >
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </IconBtn>
        <IconBtn label={t('uploadTrayHide')} title={t('uploadTrayHideNote')} data-upload-tray-hide="" onClick={onHide}>
          <X size={15} />
        </IconBtn>
      </header>

      {!collapsed && (
        <ul className="flex-1 overflow-y-auto">
          {queue.map((entry) => (
            <UploadStatusRow key={entry.id} t={t} entry={entry} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} onRecover={onRecover} onDiscard={onDiscard} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** ชิปเล็กมุมขวาล่างที่เปิดถาดกลับมา — มีอยู่เฉพาะตอนที่ยังมีงานให้ดูจริง ๆ */
export function UploadTrayLauncher({ t, queue = [], onShow }) {
  if (!shouldShowQueueLauncher(queue)) return null
  const active = activeUploadCount(queue)
  const attention = attentionUploadCount(queue)

  return (
    <button
      type="button"
      data-upload-tray-launcher=""
      onClick={onShow}
      aria-label={t('uploadTrayShow')}
      className="fixed bottom-5 right-5 z-[var(--z-toast)] h-11 px-4 rounded-full bg-ink text-card inline-flex items-center gap-2 text-[13px] font-semibold shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {active > 0 ? <UploadCloud size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
      {active > 0 ? t('uploadQueue') : t('uploadNeedsAttention')}
      <span className="min-w-5 h-5 px-1 rounded-full bg-accent text-white inline-flex items-center justify-center text-[11px]">{active || attention}</span>
    </button>
  )
}

/**
 * แถวของงานที่เสร็จแล้วแบบกระชับ — ชื่อไฟล์ + เครื่องหมายเสร็จ + Dismiss เท่านั้น
 * ⚠️ ใช้ในส่วนคิวของลิ้นชัก ที่พื้นที่แนวตั้งเป็นของปุ่มเลือกไฟล์ก่อน งานที่จบแล้วไม่มีอะไรให้เฝ้าอีก
 */
export function UploadCompactRow({ t, entry, onDismiss }) {
  return (
    <li
      data-upload-row={entry.id}
      data-upload-stage={entry.stage}
      data-upload-compact="true"
      className="px-3.5 py-2 border-t border-line first:border-t-0 flex items-center gap-2.5"
    >
      <CheckCircle2 data-upload-complete-icon="" size={14} strokeWidth={1.75} aria-hidden style={{ color: 'var(--ok)' }} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink" title={entry.name}>{entry.name}</span>
      <span className="sr-only">{t(STAGE_LABEL.complete)}</span>
      <button type="button" data-upload-dismiss={entry.id} onClick={() => onDismiss?.(entry.id)} className="text-[11.5px] font-semibold text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        {t('dismiss')}
      </button>
    </li>
  )
}

/**
 * คิวเดียวกับถาด แต่วาดในส่วนล่างของลิ้นชักอัปโหลด
 *
 * ⚠️ ผู้เรียกต้องวาด "อย่างใดอย่างหนึ่ง" เท่านั้น: ลิ้นชักเปิด = ส่วนนี้, ลิ้นชักปิด = UploadStatusTray
 *    ทั้งสองอ่าน queue ก้อนเดียวกันและเรียก handler ชุดเดียวกัน ไม่มีสถานะคิวหรือตัวควบคุมชุดที่สอง
 */
export function UploadQueueSection({ t, queue = [], onCancel, onRetry, onDismiss, onRecover, onDiscard }) {
  if (queue.length === 0) return null
  const summary = uploadTraySummary(queue)
  const batch = uploadTrayAggregate(queue)
  const batchLine = batch.transferableCount > 1 ? aggregateLine(t, batch) : null
  return (
    <section data-upload-drawer-queue="" aria-label={t('uploadTrayTitle')} className="border-t border-line pt-5">
      <p role="status" aria-live="polite" className="text-[11.5px] uppercase tracking-[0.12em] font-bold text-ink-3">
        {t(summary.key, summary.vars)}
      </p>
      {batchLine && (
        <p data-upload-tray-batch="" className="mt-1 text-[11px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{batchLine}</p>
      )}
      <ul className="mt-3 rounded-[var(--r-tile)] border border-line bg-card overflow-hidden">
        {queue.map((entry) => (entry.stage === 'complete'
          ? <UploadCompactRow key={entry.id} t={t} entry={entry} onDismiss={onDismiss} />
          : <UploadStatusRow key={entry.id} t={t} entry={entry} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} onRecover={onRecover} onDiscard={onDiscard} />))}
      </ul>
    </section>
  )
}
