import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  TriangleAlert, Lock, LockOpen, FileText, FileImage, FileVideo, File as FileIcon, Plus, Download,
  KeyRound, MoreHorizontal, Trash2, Eye, Info,
} from 'lucide-react'
import { Btn, Chip, Modal, ModalClose, ErrorState, EmptyState, SkeletonLoader, Card } from '../components/ui.jsx'
import { useApi, useReducedMotion } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch, apiFetchBytes } from '../lib/api.js'
import { fmtBytes, fmtDateTime } from '../lib/format.js'
import {
  createVaultSetup, unlockVault, decryptBlobMeta,
  decryptFileContent, ARGON2_DEFAULTS,
} from '../lib/vaultCrypto.js'
/* ⚠️ V2 (chunk) กับ V1 (whole-file) อยู่คนละโมดูลโดยเจตนา และจอนี้เลือกเส้นทางจาก
   `formatVersion` ของ blob เท่านั้น — ไม่ใช่จากขนาด ไม่ใช่จากการเดา
   ⚠️ encryptFileEnvelope/fileToBytes ของ V1 **ไม่ถูก import แล้ว** เพราะการอัปโหลดใหม่
      ทุกครั้งเป็น V2 ทั้งหมด ทั้งสองยังอยู่ในโมดูลเดิมเพื่อรองรับ blob ที่มีอยู่ */
import { decryptVaultV2Meta } from '../lib/vaultChunkCrypto.js'
import { uploadVaultFileChunked } from '../lib/vaultChunkedUpload.js'
import {
  downloadVaultV2, createFileSystemSink, createBufferedSink,
  supportsStreamingFileSink, MAX_BUFFERED_PLAINTEXT_BYTES,
} from '../lib/vaultChunkedDownload.js'
import {
  reconcileVaultInventory, addLocalVaultBlob, removeLocalVaultBlob,
  tombstoneVaultBlob, vaultBlobId, lockedVaultEntry,
} from '../lib/vaultInventory.js'
import { previewKindFor } from '../lib/vaultPreview.js'
// ⚠️ ความเร็ว/เวลาที่เหลือมาจากไบต์จริงเท่านั้น — โมดูลนี้ไม่มี timer ที่เดินเอง
import { createRateEstimator, transferRateLine } from '../lib/transferRate.js'
// ⚠️ เส้นทาง preview วิดีโอใหญ่: ถอดรหัสตามช่วงไบต์ที่ผู้เล่นขอ ใน Service Worker
//    ต้นทางเดียวกัน — ไม่มี plaintext ทั้งไฟล์อยู่ในหน่วยความจำ ณ เวลาใดเลย
import {
  supportsLargeVideoPreview, openPreviewSession,
  closePreviewSession, closeAllPreviewSessions, installPreviewSessionRecovery,
} from '../lib/vaultPreviewSession.js'
import { PREVIEW_FAILURE_REASON, previewFailureCopyKey } from '../lib/vaultPreviewErrors.js'
import { unwrapVaultV2Dek } from '../lib/vaultChunkCrypto.js'

/* ⚠️ Zero-Knowledge จริง:
   - GET /api/vault ให้แค่ salt + พารามิเตอร์ KDF + verifier + envelope ของแต่ละ blob
     (ไม่รวมเนื้อไฟล์ — ต้องขอทีละชิ้นตอนจะเปิดจริง)
   - ปลดล็อก = derive KEK จาก passphrase "ในเบราว์เซอร์" (Argon2id) แล้วลองถอด verifier
     GCM auth ล้มเหลว = passphrase ผิด (ไม่มี oracle ฝั่ง server ให้ยิงเดา)
   - ชื่อไฟล์ถูกเข้ารหัสด้วย DEK เช่นกัน — ขณะล็อก จอนี้จึงแสดงได้แค่ id + ขนาด ciphertext
     เพราะ "ไม่มีใคร" (รวมทั้ง server) รู้มากกว่านั้นจริง ๆ
   - KEK อยู่ใน React state (non-extractable CryptoKey) — กดล็อก / หมดเวลา idle /
     ปิดแท็บ = หาย ไม่มีสำเนาใน localStorage/sessionStorage/IndexedDB ที่ใดเลย */

// ล็อกอัตโนมัติเมื่อไม่มีการใช้งาน — จอที่ปลดล็อกค้างไว้คือกุญแจที่วางทิ้งไว้บนโต๊ะ
const IDLE_LOCK_MS = 10 * 60_000
const MIN_PASSPHRASE = 12

// อ้างอิงคงที่ — ป้องกัน useMemo ด้านล่างถูก invalidate ทุก render เพราะ `?? []` สร้าง array ใหม่
const EMPTY_BLOBS = Object.freeze([])

const EXT_ICONS = { docx: FileText, pdf: FileText, pptx: FileImage, png: FileImage, jpg: FileImage, jpeg: FileImage }
const iconFor = (name = '') => EXT_ICONS[name.split('.').pop()?.toLowerCase()] ?? FileIcon

/** ไอคอนของการ์ดที่ปลดล็อกแล้ว — ชนิดไฟล์ที่ preview ได้ควรดูต่างจากไฟล์ที่เปิดในแอปไม่ได้ */
const tileIconFor = (entry) => {
  const kind = previewKindFor(entry?.type)
  if (kind === 'video') return FileVideo
  if (kind === 'image') return FileImage
  return iconFor(entry?.name ?? '')
}

/* ── per-tile overflow menu ───────────────────────────────────────
   ภาษาการโต้ตอบเดียวกับจอ Files (MoreHorizontal มุมขวาบน → dropdown ปุ่มจริง)
   แต่ "รายการคำสั่ง" ไม่ใช่ชุดเดียวกัน: Vault ไม่มี Rename / Move / Secure Share /
   ตรวจ SHA เพราะเซิร์ฟเวอร์มองไม่เห็นอะไรเลยนอกจาก ciphertext — การยืมเมนูของ
   Files มาทั้งชุดคือการสัญญาสิ่งที่ระบบทำไม่ได้

   ⚠️ นโยบายขณะล็อก (เจ้าของผลิตภัณฑ์เปลี่ยนจาก PR #39):
      ล็อกอยู่ = "ดูข้อมูลทึบได้อย่างเดียว" ไม่มี Delete / Download / Preview / Open
      เหลือเพียง "รายละเอียดรายการที่เข้ารหัส" ซึ่งอ่านจาก blob ทึบล้วน ๆ
      และรายการบอกทางที่กดไม่ได้ เพื่อให้ผู้ใช้รู้ว่าต้องปลดล็อกก่อน ไม่ใช่ว่าเมนูพัง
      คำในเมนูตอนล็อกต้องไม่มีคำใดที่มาจาก plaintext แม้แต่คำเดียว */
function VaultTileMenu({ t, unlocked, previewable, onAction }) {
  const items = unlocked
    ? [
        // Preview มาก่อน Download เพราะมันคือคำสั่งที่ไม่ทำลายอะไรและตอบคำถาม
        // "ไฟล์นี้คืออะไร" ได้ทันที — ปรากฏเฉพาะชนิดที่ render ได้จริงเท่านั้น
        ...(previewable ? [{ id: 'preview', icon: Eye, label: t('preview') }] : []),
        { id: 'details', icon: Info, label: t('fileDetails') },
        { id: 'download', icon: Download, label: t('download') },
        { id: 'delete', icon: Trash2, label: t('delete'), danger: true },
      ]
    : [
        { id: 'details', icon: Info, label: t('vaultEncryptedDetails') },
        { id: 'locked-hint', icon: Lock, label: t('vaultLockedManageHint'), disabled: true },
      ]

  return (
    <div
      role="menu"
      aria-label={t('moreActions')}
      className="absolute right-0 top-9 bg-card border border-line rounded-[var(--r-tile)] py-1.5 min-w-48 fade-in"
      style={{ boxShadow: 'var(--elev-2)', zIndex: 'var(--z-dropdown)' }}
    >
      {items.map(({ id, icon: Icon, label, danger, disabled }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          disabled={disabled}
          aria-disabled={disabled ? 'true' : undefined}
          onClick={disabled ? undefined : () => onAction(id)}
          className={`w-full flex items-center gap-2.5 px-3.5 h-8 text-[13px] font-medium text-left whitespace-nowrap transition-colors duration-[var(--dur-fast)] ${
            disabled ? 'cursor-default' : 'hover:bg-sunken cursor-pointer'
          }`}
          style={{ color: danger ? 'var(--danger)' : disabled ? 'var(--ink-3)' : 'var(--ink-2)' }}
        >
          <Icon size={14} strokeWidth={1.5} />
          {label}
        </button>
      ))}
    </div>
  )
}

/* A vault tile: plaintext rendering sits underneath; the hatch layer covers
   it completely while locked. Unlock peels the hatch away left→right. */
function VaultTile({ t, entry, unlocked, index, onPreview, onDetails, onDownload, onDelete, busy }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const menuRef = useRef(null)
  const named = unlocked && Boolean(entry.name)
  const Icon = named ? tileIconFor(entry) : FileIcon
  const delay = `${index * 40}ms`
  // ⚠️ ล็อกอยู่ = ไม่รู้ชนิดไฟล์ ดังนั้น previewable เป็น false เสมอโดยโครงสร้าง
  //    ไม่ใช่เพราะบังเอิญไม่มี type ใน entry
  const previewable = unlocked && previewKindFor(entry.type) !== null

  /* click-away + Escape. การตรวจ `contains` คือสิ่งที่ทำให้คลิกที่เปิดเมนูไม่ปิดเมนู
     ตัวเองทันที — ไม่ต้องพึ่งจังหวะการ flush effect ของ React ซึ่งไม่ใช่สัญญาที่
     เชื่อถือได้ และเป็นเหตุผลเดียวกับที่ mobile/touch ใช้เมนูนี้ได้จริง */
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('click', onDocClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onDocClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const runAction = (action) => {
    setMenuOpen(false)
    if (action === 'preview') onPreview(entry)
    else if (action === 'details') onDetails(entry)
    else if (action === 'download') onDownload(entry)
    else if (action === 'delete') onDelete(entry)
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative bg-card border border-line rounded-[var(--r-tile)] p-3 overflow-hidden"
    >
      {/* คลิกที่ตัวการ์ดเพื่อ Preview เป็นทางลัด ไม่ใช่ทางเดียว — เมนูสามจุดยังเป็น
          คำสั่งที่ถือสิทธิ์อย่างเป็นทางการ และปุ่มนี้ถูก render เป็น <button> จริง
          เฉพาะตอนที่ "มี preview ให้เปิดจริง" เท่านั้น ไฟล์ที่เปิดในแอปไม่ได้จะไม่มี
          พื้นที่กดได้ที่ไม่ทำอะไร (และต้องไม่แอบดาวน์โหลดเมื่อถูกคลิก) */}
      {previewable ? (
        <button
          type="button"
          aria-label={`${t('preview')} — ${entry.name}`}
          onClick={() => onPreview(entry)}
          disabled={busy}
          className="w-full h-28 rounded-[9px] bg-sunken flex items-center justify-center cursor-pointer transition-colors duration-[var(--dur-fast)] hover:bg-accent-soft disabled:cursor-not-allowed"
        >
          <Icon size={34} strokeWidth={1.2} className="text-accent" />
        </button>
      ) : (
        <div className="h-28 rounded-[9px] bg-sunken flex items-center justify-center">
          <Icon size={34} strokeWidth={1.2} className={unlocked ? 'text-accent' : 'text-ink-3'} />
        </div>
      )}
      <p className="mt-2.5 text-[13.5px] font-medium text-ink truncate" title={named ? entry.name : undefined}>
        {unlocked ? (entry.name ?? t('vaultUnnamed')) : `${entry.id}.aegisenc`}
      </p>
      <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmtBytes(entry.plainSize ?? entry.size)}
      </p>

      {/* ciphertext veil — a wipe, not a fade */}
      <div
        aria-hidden
        className="absolute inset-0 hatch hatch-ink3 bg-sunken transition-[clip-path] duration-500 pointer-events-none"
        style={{
          clipPath: unlocked ? 'inset(0 0 0 100%)' : 'inset(0 0 0 0)',
          transitionDelay: delay,
          transitionTimingFunction: 'var(--ease)',
        }}
      />
      {/* locked caption sits ON the veil — เท่าที่ระบบ "เห็นจริง": id + ขนาด ciphertext */}
      <div
        className="absolute inset-x-0 bottom-0 p-3 transition-opacity duration-300 pointer-events-none"
        style={{ opacity: unlocked ? 0 : 1, transitionDelay: delay }}
      >
        <p className="text-[13px] font-medium text-ink truncate bg-card/90 rounded-[6px] px-2 py-1 font-mono">{entry.id}.aegisenc · {fmtBytes(entry.size)}</p>
        <p className="font-mono text-[10px] text-ink-3 mt-1.5 tracking-[0.02em]">{t('vaultCipherCaption')}</p>
      </div>

      {/* ⚠️ วางไว้ "หลัง" ชั้น hatch ใน DOM และยก z-index ขึ้น 1 ชั้น เพื่อให้ปุ่มยัง
          กดได้และมองเห็นตอนล็อก — hatch เป็น pointer-events-none อยู่แล้ว
          aria-label ผูกชื่อไฟล์เฉพาะตอนปลดล็อกเท่านั้น ตอนล็อกเป็นคำกลางล้วน */}
      <div ref={menuRef} className="absolute top-2 right-2" style={{ zIndex: 2 }}>
        <button
          type="button"
          aria-label={named ? `${t('moreActions')} — ${entry.name}` : t('moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          data-vault-tile-menu={entry.id}
          data-visible={hover || menuOpen ? 'true' : 'false'}
          onClick={() => setMenuOpen((v) => !v)}
          className="tile-hover-control size-7 flex items-center justify-center rounded-full bg-card border border-line text-ink-3 hover:text-ink transition-[opacity,color] duration-[var(--dur-fast)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <MoreHorizontal size={14} strokeWidth={1.5} />
        </button>
        {menuOpen && <VaultTileMenu t={t} unlocked={unlocked} previewable={previewable} onAction={runAction} />}
      </div>
    </div>
  )
}

/* ── แถบสถานะการโอนของ Vault V2 ──────────────────────────────────────
   ⚠️ กติกาข้อเดียวที่คอมโพเนนต์นี้มีไว้รักษา: **ทุกตัวเลขบนแถบนี้ต้องมาจากงานจริง**
      เปอร์เซ็นต์คำนวณจากไบต์ที่ผ่านไปแล้ว และ "ส่วนที่ X จาก N" คือดัชนี chunk จริง
      ไม่มี setInterval ที่ขยับแถบเอง — แถบที่เดินต่อขณะเน็ตหยุดคือการโกหกผู้ใช้ว่างาน
      ยังคืบหน้า แล้วเขาจะรอต่อไปแทนที่จะกดทำต่อหรือแก้ปัญหาเครือข่าย
   ⚠️ สถานะ 'unsupported' ไม่ใช่ความล้มเหลวและไม่มีปุ่มลองใหม่ — มันคือความจริงเกี่ยวกับ
      เบราว์เซอร์ที่ใช้อยู่ ปุ่ม "ลองใหม่" ตรงนั้นจะทำให้ผู้ใช้กดวนไปเรื่อย ๆ โดยไม่มีทางสำเร็จ */
function VaultTransferPanel({ t, transfer, onResume, onCancel, onDismiss }) {
  if (!transfer) return null

  const { kind, stage, chunkIndex = 0, chunkCount = 0, transferredBytes = 0, totalBytes = 0, percent = 0 } = transfer
  const humanIndex = Math.min(chunkCount, chunkIndex + 1)
  const vars = { index: humanIndex, count: chunkCount }

  const label = stage === 'preparing' ? t('vaultXferPreparing')
    : stage === 'encrypting' ? t('vaultXferEncrypting', vars)
      : stage === 'uploading' ? t('vaultXferUploading', vars)
        : stage === 'committing' ? t('vaultXferCommitting')
          : stage === 'downloading' ? t('vaultXferDownloading', vars)
            : stage === 'paused' ? t('vaultXferPaused')
              : stage === 'unsupported' ? t('vaultXferUnsupported')
                : t('vaultXferFailed')

  const reasonKey = {
    network: 'vaultXferReasonNetwork',
    server: 'vaultXferReasonServer',
    tooLarge: 'vaultXferReasonTooLarge',
    noSpace: 'vaultXferReasonNoSpace',
    integrity: 'vaultXferReasonIntegrity',
    expired: 'vaultXferReasonExpired',
    'auth-failed': 'vaultXferReasonAuth',
  }[transfer.reason]

  // ⚠️ ความเร็วมีความหมายเฉพาะช่วงที่ไบต์กำลังวิ่งจริง ระหว่าง 'committing' เซิร์ฟเวอร์
  //    กำลังตรวจไบต์ของตัวเองอยู่ ไม่มีอะไรวิ่งบนสาย — การขึ้น "กำลังรอเครือข่าย" ตรงนั้น
  //    จะเป็นคำเตือนปลอมที่ทำให้ผู้ใช้กดยกเลิก commit ที่กำลังทำงานปกติ
  const measuring = stage === 'uploading' || stage === 'encrypting' || stage === 'downloading'
  const rateLine = transferRateLine(t, transfer.rate)
  const rateBps = transfer.rate?.bytesPerSecond ?? null
  const etaSeconds = transfer.rate?.etaSeconds ?? null

  const active = stage === 'preparing' || stage === 'encrypting' || stage === 'uploading'
    || stage === 'committing' || stage === 'downloading'
  const stopped = stage === 'failed' || stage === 'paused' || stage === 'unsupported'
  const tone = stage === 'failed' ? 'var(--danger)' : stage === 'paused' ? 'var(--warn)' : 'var(--ink-2)'

  return (
    <div
      className="rounded-[var(--r-tile)] border border-line bg-sunken px-4 py-3 mb-4"
      data-vault-transfer={kind}
      data-vault-transfer-stage={stage}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <p role="status" aria-live="polite" className="text-[12.5px] font-medium" style={{ color: tone }}>
          {label}
        </p>
        <div className="flex-1" />
        {/* ⚠️ ตัวเลขนี้เป็นหน่วยเดียวกับขนาดไฟล์ที่ผู้ใช้เห็นในการ์ด (plaintext)
            ไม่ใช่ขนาด ciphertext ที่วิ่งบนสาย — ผู้ใช้ไม่ควรต้องแปลหน่วยเอง */}
        {stage !== 'unsupported' && (
          <p
            className="text-[12px] text-ink-3 font-mono"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            data-vault-transfer-bytes={String(transferredBytes)}
            data-vault-transfer-total={String(totalBytes)}
          >
            {t('vaultXferProgress', {
              done: fmtBytes(transferredBytes), total: fmtBytes(totalBytes), percent,
            })}
          </p>
        )}
      </div>

      {stage !== 'unsupported' && (
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
          <div
            className="h-full rounded-full transition-[width] duration-[var(--dur-fast)]"
            style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: stage === 'failed' ? 'var(--danger)' : 'var(--accent)' }}
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}

      {/* ⚠️ พื้นที่นี้ถูกจองความสูงไว้ตลอดช่วงที่กำลังโอน แม้ตอนที่ยังวัดความเร็วไม่ได้ —
          ไม่งั้นแผงจะกระตุกขึ้นลงทุกครั้งที่ตัวเลขปรากฏหรือหายไป */}
      {measuring && (
        <div className="mt-1.5 flex justify-end min-h-[16px]">
          <p
            className="text-[12px] text-ink-3 font-mono"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            data-vault-transfer-rate={rateBps === null ? '' : String(Math.round(rateBps))}
            data-vault-transfer-eta={etaSeconds === null ? '' : String(Math.round(etaSeconds))}
            data-vault-transfer-stalled={transfer.rate?.stalled ? 'yes' : 'no'}
          >
            {rateLine}
          </p>
        </div>
      )}

      {reasonKey && (
        <p className="text-[12px] text-ink-3 mt-2">{t(reasonKey)}</p>
      )}

      <div className="flex gap-2 mt-3">
        {stage === 'paused' && (
          <Btn variant="primary" size="sm" onClick={onResume}>{t('vaultXferResume')}</Btn>
        )}
        {active && (
          <Btn variant="outline" size="sm" onClick={onCancel}>{t('vaultXferCancel')}</Btn>
        )}
        {stopped && (
          <Btn variant="outline" size="sm" onClick={onDismiss}>{t('vaultXferDismiss')}</Btn>
        )}
      </div>
    </div>
  )
}

export function Vault({ t, lang = 'en', placeholderMode = false }) {
  const reduced = useReducedMotion()
  const vaultApi = useApi('/api/vault')

  const [kek, setKek] = useState(null)          // CryptoKey — memory เท่านั้น
  const [entries, setEntries] = useState(null)  // [{id, name, size, plainSize}] หลังถอดรหัส
  const [modal, setModal] = useState(null)      // null | 'unlock' | 'setup'
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null) // key ของข้อความ error
  const [shake, setShake] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [actionError, setActionError] = useState(false)
  const [autoLocked, setAutoLocked] = useState(false)
  /* ── สถานะการโอนที่ "อ่านจากงานจริง" เท่านั้น (LFT-V2-B) ─────────────────
     ทุกตัวเลขในนี้มาจากไบต์ที่ผ่านไปจริงและจาก chunk ที่เซิร์ฟเวอร์ยืนยันแล้ว
     ⚠️ ห้ามมี timer ที่ขยับแถบเอง: แถบที่เดินต่อขณะเน็ตหยุดคือการโกหกผู้ใช้ว่างาน
        ยังคืบหน้า แล้วเขาจะรอต่อไปแทนที่จะกด Resume */
  const [transfer, setTransfer] = useState(null)
  /* งานที่ยังทำต่อได้หลังล้มเหลวชั่วคราว — ถือไว้ใน ref ไม่ใช่ state เพราะมันมี CryptoKey
     (DEK) อยู่ข้างใน และต้องหายไปพร้อมการล็อกเสมอ ไม่ใช่ค้างอยู่ใน render tree */
  const resumable = useRef(null)
  /* ตัวยกเลิกของงานที่กำลังวิ่งอยู่ — ถูกดึงทันทีที่ผู้ใช้กดล็อกหรือหมดเวลา idle */
  const transferAbort = useRef(null)
  // ⚠️ ตัวประมาณความเร็วหนึ่งตัวต่อหนึ่งการโอน — สร้างใหม่ทุกครั้งที่เริ่ม/ทำต่อ เพื่อไม่ให้
  //    ไบต์ของเซสชันก่อนถูกนับเป็นความเร็วของเซสชันนี้ (ดู transferRate.js)
  const transferRate = useRef(null)
  /* บัญชี blob ทึบฝั่ง client — ดู src/lib/vaultInventory.js สำหรับเหตุผลเต็ม
     โดยย่อ: ผลของ POST ที่สำเร็จแล้วเป็นความจริงที่รู้แน่ทันที ไม่ควรต้องรอ GET
     รอบถัดไปมายืนยัน เพราะผู้ใช้กด Lock ชนะ refetch ได้เสมอ */
  const [localBlobs, setLocalBlobs] = useState([])
  const [removedIds, setRemovedIds] = useState(() => new Set())
  const [askDelete, setAskDelete] = useState(null) // { id, name|null, size, opaque }
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  /* Preview / Details — สองกล่องนี้ "ถือ plaintext ไว้ในมือ" จึงต้องถูกเก็บกวาด
     พร้อมกุญแจเสมอ ไม่ใช่ตอนที่ผู้ใช้นึกได้ว่าจะปิด (ดู releasePreview + lock) */
  const [preview, setPreview] = useState(null) // { entry, kind, url, loading, failed }
  const [details, setDetails] = useState(null) // { locked, id, name?, type?, plainSize?, size, createdAt }
  const previewUrlRef = useRef(null)
  /* ทุกครั้งที่เปิด/ปิด preview ตัวนับนี้จะเดินหน้า งานถอดรหัสที่ยังค้างอยู่ในสาย
     จะเทียบ token ของตัวเองก่อนสร้าง object URL — ถ้าไม่ตรงแปลว่ามันถูกแทนที่หรือ
     ถูกล็อกไปแล้ว และ "ห้าม" สร้าง URL ที่ไม่มีใครถืออ้างอิงไว้ปล่อยคืน */
  const previewToken = useRef(0)
  /* token ของเซสชันสตรีมใน Service Worker — ต้องถูกเพิกถอนพร้อมกุญแจเสมอ
     ⚠️ เก็บใน ref ไม่ใช่ state โดยเจตนา: มันถูกอ่านจากเส้นทางการล็อก ซึ่งต้องทำงาน
        ได้แม้ในจังหวะที่ React ยังไม่ได้ render รอบใหม่ */
  const previewStreamToken = useRef(null)
  const fileRef = useRef(null)

  const configured = vaultApi.data?.configured === true
  const serverBlobs = vaultApi.data?.blobs ?? EMPTY_BLOBS
  const unlocked = Boolean(kek && entries)
  const unlockedRef = useRef(unlocked)
  unlockedRef.current = unlocked

  /* รายการ blob ทึบที่ "เป็นจริงตอนนี้" = server + POST ที่สำเร็จแล้ว − ที่ลบสำเร็จแล้ว
     dedupe ด้วย id เข้มงวด GET ที่ตามมาทีหลังจึงไม่สร้างการ์ดใบที่สอง */
  const inventory = useMemo(
    () => reconcileVaultInventory({ serverBlobs, localBlobs, removedIds }),
    [serverBlobs, localBlobs, removedIds],
  )

  /* ── object URL ของ preview: อายุสั้นที่สุดเท่าที่ทำได้ ─────────────────
     object URL คือ "ตัวชี้ไปยัง plaintext ที่ยังอยู่ใน memory ของแท็บ" ตราบใดที่ยัง
     ไม่ revoke เบราว์เซอร์ต้องกันบัฟเฟอร์นั้นไว้ และใครก็ตามที่เดา/อ่าน URL ได้ก็อ่าน
     ไฟล์ได้ การ revoke จึงไม่ใช่เรื่องความสะอาดของหน่วยความจำ แต่เป็นเรื่องความลับ */
  const releasePreview = useCallback(() => {
    previewToken.current += 1 // งานถอดรหัสที่ยังค้างอยู่จะกลายเป็นโมฆะทันที
    // ★ เพิกถอนเซสชันสตรีมก่อนอย่างอื่น — ตราบใดที่ worker ยังถือ DEK อยู่ URL เสมือน
    //   ใบนั้นยังถอดไฟล์ได้ การลบมันออกจาก Map ของ worker คือความหมายทั้งหมดของ "ปิด"
    if (previewStreamToken.current) {
      const token = previewStreamToken.current
      previewStreamToken.current = null
      closePreviewSession(token)
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [])

  const closePreview = useCallback(() => {
    releasePreview()
    setPreview(null)
  }, [releasePreview])

  // ปิดแท็บ / เปลี่ยนหน้าจอ = unmount — ต้องปล่อย URL เหมือนกดปิดเอง
  useEffect(() => releasePreview, [releasePreview])

  /* ── worker แจ้งว่าสตรีมหยุดเพราะอะไร ────────────────────────────────────
     ⚠️ ต้องมีเส้นทางนี้จริง ไม่ใช่ปล่อยให้ <video> ขึ้น error ของตัวเอง: ผู้ใช้ต้องรู้
        ต่างกันระหว่าง "เน็ตหลุด" กับ "ก้อนนี้พิสูจน์ความถูกต้องไม่ผ่าน" — อย่างหลังคือ
        สัญญาณว่ามีบางอย่างผิดปกติกับไบต์ที่เก็บไว้ ไม่ใช่เรื่องชั่วคราวที่ลองใหม่ได้ */
  useEffect(() => {
    const container = globalThis.navigator?.serviceWorker
    if (!container?.addEventListener) return undefined
    const onMessage = (event) => {
      const data = event?.data
      if (data?.type !== 'vault-preview-failed') return
      if (!previewStreamToken.current || data.token !== previewStreamToken.current) return
      const reason = data.reason === 'integrity'
        ? PREVIEW_FAILURE_REASON.INTEGRITY_FAILED
        : data.reason
      setPreview((prev) => (prev
        ? { ...prev, loading: false, failed: true, failureReason: reason }
        : prev))
    }
    container.addEventListener('message', onMessage)
    return () => container.removeEventListener('message', onMessage)
  }, [])

  // The page retains the exact active non-extractable DEK in module memory so
  // an ephemeral worker can recover while (and only while) this Vault remains
  // unlocked. No storage API participates in this path.
  useEffect(() => installPreviewSessionRecovery({
    isUnlocked: () => unlockedRef.current,
  }), [])

  /* ── ล็อก: ทิ้งกุญแจ + plaintext ทั้งหมดจาก memory ─────────────────────
     ตั้ง state กลับเป็น null ตรง ๆ — ไม่มี "สำเนาสำรอง" ที่ไหนให้ต้องตามล้าง
     เพราะไม่เคยเขียนกุญแจลง storage ใดตั้งแต่ต้น */
  const lock = useCallback((auto = false) => {
    /* ⚠️ ยกเลิก "งานที่กำลังเข้ารหัส/ถอดรหัสอยู่" ก่อนอย่างอื่นทั้งหมด
       การล็อกที่ปล่อยให้การอัปโหลดเบื้องหลังเข้ารหัส chunk ต่อไปคือการล็อกในนามเท่านั้น:
       DEK ยังถูกใช้งานอยู่ และ plaintext ของก้อนถัดไปยังถูกอ่านเข้าหน่วยความจำต่อ
       ⚠️ ciphertext ที่ส่งไปแล้วยังค้างเป็น session ฝั่งเซิร์ฟเวอร์ได้ — นั่นไม่ใช่การรั่ว
          (ciphertext ไม่ใช่ plaintext) และมันจะถูกเก็บกวาดเมื่อหมดอายุ */
    transferAbort.current?.abort()
    transferAbort.current = null
    resumable.current = null
    setTransfer(null)
    setKek(null)
    setEntries(null)
    setPass('')
    setPass2('')
    setActionError(false)
    setAutoLocked(auto)
    // ⚠️ กล่องยืนยันลบขณะปลดล็อกถือ "ชื่อไฟล์ plaintext" อยู่ในมือ ปล่อยค้างไว้หลังล็อก
    //    = ชื่อไฟล์ยังอยู่บนจอทั้งที่ระบบประกาศว่าล็อกแล้ว ต้องปิดไปพร้อมกุญแจ
    setAskDelete(null)
    setDeleteError(false)
    // ⚠️ เช่นเดียวกับ Preview (ถือทั้งชื่อไฟล์และ "เนื้อไฟล์" ที่ถอดแล้ว) และ Details
    //    ที่ถือชื่อไฟล์/MIME/ขนาดจริง ทั้งสองต้องหายไปพร้อมกุญแจในจังหวะเดียวกัน
    //    — ทั้งตอนกดล็อกเองและตอน auto-lock ครบ 10 นาที (ทางเดียวกันเป๊ะ)
    closePreview()
    // ⚠️ ล็อก = ไม่มีเซสชันใดรอด แม้ใบที่หน้านี้ลืมไปแล้ว (เช่นหลังรีเฟรชบางกรณี)
    closeAllPreviewSessions()
    setDetails(null)
  }, [closePreview])

  /* ── idle auto-lock ────────────────────────────────────────────────
     นับเฉพาะตอนปลดล็อกอยู่ — ทุก interaction รีเซ็ตนาฬิกา ครบ 10 นาทีเงียบ = ล็อก
     (ใช้ passive listener + capture เพื่อจับ event ก่อนถึง component ใด ๆ) */
  useEffect(() => {
    if (!unlocked) return
    let timer = setTimeout(() => lock(true), IDLE_LOCK_MS)
    const bump = () => {
      clearTimeout(timer)
      timer = setTimeout(() => lock(true), IDLE_LOCK_MS)
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart']
    events.forEach((e) => window.addEventListener(e, bump, { passive: true, capture: true }))
    return () => {
      clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, bump, { capture: true }))
    }
  }, [unlocked, lock])

  /** ถอด metadata ของทุก blob ด้วย KEK ที่เพิ่งได้ — เนื้อไฟล์ยังไม่ถูกดึงลงมา
   *  ⚠️ `type` ถูกเก็บไว้ด้วยตั้งแต่ตรงนี้: มันถูกเข้ารหัสมาพร้อมชื่อไฟล์อยู่แล้ว
   *     (ดู encryptFileEnvelope) การทิ้งไปแล้วเดาจากนามสกุลภายหลังคือการเดาในสิ่งที่
   *     ระบบ "รู้จริง" อยู่แล้ว และเป็นการเดาที่ตัดสินว่าไฟล์ไหนถูก render ในหน้าเว็บ */
  const decryptEntries = async (key, list) => {
    const out = []
    for (const b of list) {
      try {
        // ⚠️ เลือกเส้นทางจาก formatVersion ที่เซิร์ฟเวอร์ประกาศมาอย่างชัดแจ้ง ไม่ใช่จาก
        //    การมี/ไม่มีฟิลด์ ("ไม่มีฟิลด์" แยกไม่ออกระหว่าง 'ไม่มี' กับ 'ลืมส่ง')
        const meta = b.formatVersion === 2
          ? await decryptVaultV2Meta(key, b)
          : await decryptBlobMeta(key, b)
        out.push({
          id: vaultBlobId(b),
          name: meta.name,
          type: meta.type ?? null,
          // V1 เก็บฟิลด์ชื่อ `size`, V2 เก็บ `plainSize` — ทั้งคู่คือขนาด plaintext จริง
          plainSize: meta.plainSize ?? meta.size ?? null,
          size: b.size,
          blob: b,
        })
      } catch {
        // blob เสียหาย/ถูกแก้ — แสดงตาม id แทน ไม่ทำให้ทั้งจอล้ม
        out.push({ id: vaultBlobId(b), name: null, type: null, plainSize: null, size: b.size, blob: b })
      }
    }
    return out
  }

  /* ── ตั้งค่า vault ครั้งแรก ─────────────────────────────────────────
     salt + verifier ถูกสร้าง "ในเบราว์เซอร์" แล้วส่งเฉพาะผลลัพธ์ขึ้น server
     passphrase ไม่เคยอยู่ใน body ของ request ใดเลย */
  const doSetup = async () => {
    if (busy) return
    if (pass.length < MIN_PASSPHRASE) return setFormError('vaultKeyTooShort')
    if (pass !== pass2) return setFormError('vaultKeyMismatch')
    if (!ack) return
    setBusy(true)
    setFormError(null)
    try {
      const { saltB64, params, verifier, kek: newKek } = await createVaultSetup(pass, ARGON2_DEFAULTS)
      const res = await apiFetch('/api/vault/setup', {
        method: 'POST',
        body: { saltB64, params, verifier }, // ← ไม่มี passphrase/KEK ในนี้
        timeoutMs: 20_000,
      })
      if (!res.ok) {
        setFormError('actionFailed')
        setBusy(false)
        return
      }
      setKek(newKek)
      setEntries([])
      setModal(null)
      setPass('')
      setPass2('')
      setAck(false)
      vaultApi.refresh()
    } catch {
      setFormError('actionFailed')
    }
    setBusy(false)
  }

  /* ── ปลดล็อก ────────────────────────────────────────────────────
     derive + พิสูจน์เกิดในเบราว์เซอร์ทั้งหมด — ไม่มี network round-trip ระหว่างตรวจกุญแจ
     request ที่ยิงหลังจากนั้นคือ audit อย่างเดียว และส่งไปแค่ boolean */
  const tryUnlock = async () => {
    if (busy || !pass) return
    setBusy(true)
    setFormError(null)
    setAutoLocked(false)
    try {
      const key = await unlockVault(pass, {
        saltB64: vaultApi.data.saltB64,
        params: vaultApi.data.params,
        verifier: vaultApi.data.verifier,
      })
      const decrypted = await decryptEntries(key, inventory)
      setKek(key)
      setEntries(decrypted)
      setModal(null)
      setPass('')
      reportUnlock(true)
    } catch (err) {
      // ⚠️ "กุญแจผิด" กับ "ระบบเข้ารหัสทำงานไม่ได้" ไม่ใช่เรื่องเดียวกัน
      //    vaultCrypto โยน Error('wrong-key') เฉพาะตอนพิสูจน์ verifier ไม่ผ่าน
      //    (รวมกรณี passphrase ว่างที่ถูก normalize มาเป็น 'wrong-key' โดยเจตนา
      //     เพื่อไม่ให้แยกแยะได้ว่าไปไม่ถึงขั้นตอนตรวจ — ดู deriveKek ใน vaultCrypto.js
      //     กรณีนั้น "เป็นเรื่องของกุญแจจริง ๆ" จึงถูกต้องแล้วที่แสดง vaultWrongKey)
      //
      //    แต่ Argon2id ทำงานไม่ได้ (hash-wasm โหลดไม่ขึ้นเพราะ CSP ไม่มี
      //    'wasm-unsafe-eval' / หน่วยความจำไม่พอที่ m=64MiB) จะโยน error คนละตัว —
      //    บอกผู้ใช้ว่า "กุญแจนี้เปิดห้องนิรภัยนี้ไม่ได้" คือการโกหก และทำให้เขา
      //    ไล่พิมพ์กุญแจใหม่ตลอดกาลทั้งที่กุญแจถูกต้องมาแต่แรก
      const wrongKey = err?.message === 'wrong-key'
      setFormError(wrongKey ? 'vaultWrongKey' : 'vaultUnlockUnavailable')
      setShake(true)
      setTimeout(() => setShake(false), 300)
      // ลง audit ว่า "ปลดล็อกไม่สำเร็จ" เฉพาะความพยายามที่ถูกตรวจจริงเท่านั้น —
      // ความล้มเหลวของสภาพแวดล้อมไม่ใช่เหตุการณ์ความปลอดภัย ปนเข้าไปจะทำให้
      // สัญญาณเชิง forensics ("มีคนเดากุญแจ") เจือจางจนใช้ไม่ได้
      if (wrongKey) reportUnlock(false)
      else console.error('[aegis-drive] vault unlock unavailable', err)
    }
    setBusy(false)
  }

  /** แจ้งผลปลดล็อกเพื่อลง audit — ส่งแค่ boolean ไม่มีชิ้นส่วนของกุญแจใด ๆ
   *  ล้มเหลวก็ไม่กระทบผู้ใช้ (fire-and-forget) — audit ไม่ควรบล็อกการเข้าถึงไฟล์ตัวเอง */
  const reportUnlock = (ok) => {
    apiFetch('/api/vault/unlock-attempt', { method: 'POST', body: { ok } }).catch(() => {})
  }

  /* ── อัปโหลด V2: เข้ารหัสทีละก้อน ส่งทีละก้อน ────────────────────────
     ⚠️ ไม่มีจุดใดในเส้นทางนี้ที่อ่านไฟล์ทั้งก้อนเข้าหน่วยความจำ — ดู vaultChunkedUpload.js
        (ทั้ง `file.arrayBuffer()` ทั้งไฟล์ และ `fileToBytes()` ของ V1 ถูกห้ามที่นั่น)
     ⚠️ ทุกอย่างที่เป็นความลับถูกปิดผนึกก่อน network call แรกเสมอ เหมือน V1 ทุกประการ */
  const addFile = async (file, resumeState = null) => {
    if (!file || !kek || addBusy) return
    setAddBusy(true)
    setActionError(false)

    const ctrl = new AbortController()
    transferAbort.current = ctrl
    // ⚠️ resume เริ่มจากไบต์ที่ไม่ใช่ศูนย์ — ตัวประมาณตัวใหม่ถือว่าไบต์ก้อนนั้นเป็น
    //    "จุดอ้างอิง" ไม่ใช่ไบต์ที่เพิ่งวิ่งผ่านสาย ไม่งั้นตัวอย่างแรกจะได้ความเร็วลวง
    transferRate.current = createRateEstimator()
    setTransfer({
      kind: 'upload', stage: 'preparing', phase: 'preparing', name: file.name,
      transferredBytes: 0, totalBytes: file.size, percent: 0, chunkIndex: 0, chunkCount: 0,
      rate: null,
    })

    const res = await uploadVaultFileChunked({
      kek,
      file,
      resume: resumeState,
      signal: ctrl.signal,
      onStage: (stage) => setTransfer((prev) => (prev ? { ...prev, stage } : prev)),
      onProgress: (p) => {
        // ⚠️ เก็บตัวอย่างนอก state updater โดยเจตนา — updater ถูกเรียกซ้ำได้ใน StrictMode
        //    การเก็บซ้ำจะใส่จุดปลอมที่เวลาเดียวกันลงหน้าต่างเลื่อนแล้วความเร็วจะเพี้ยน
        const rate = transferRate.current?.sample(
          p.transferredBytes, performance.now(), { totalBytes: p.totalBytes },
        ) ?? null
        setTransfer((prev) => (prev ? { ...prev, ...p, rate } : prev))
      },
    })

    transferAbort.current = null

    if (res.ok) {
      const b = res.blob
      const id = vaultBlobId(b)
      // ★ สองบรรทัดนี้ต้องเกิด "ก่อน" การ refetch ใด ๆ: ผู้ใช้กด Lock ได้ทันทีในจังหวะนี้
      //   และ blob ที่เพิ่งอัปโหลดต้องยังอยู่บนจอในรูป ciphertext (ดู vaultInventory.js)
      setLocalBlobs((prev) => addLocalVaultBlob(prev, b))
      setEntries((prev) => (prev ? [
        { id, name: file.name, type: file.type || null, plainSize: file.size, size: b.size, blob: b },
        ...prev.filter((e) => vaultBlobId(e) !== id),
      ] : prev))
      resumable.current = null
      setTransfer(null)
      vaultApi.refresh()
    } else if (res.stage === 'cancelled') {
      // ผู้ใช้กดล็อก/ยกเลิกเอง — ไม่ใช่ความล้มเหลว ไม่ต้องมี error บนจอ
      resumable.current = null
      setTransfer(null)
    } else if (res.stage === 'paused') {
      // ⚠️ ล้มเหลวชั่วคราวหนึ่งก้อน ≠ ต้องเริ่มไฟล์ใหม่ทั้งก้อน session ยังอยู่ฝั่งเซิร์ฟเวอร์
      //    และก้อนที่ส่งไปแล้วยังนับอยู่ — จอจึงเสนอ "ทำต่อ" ไม่ใช่ "เริ่มใหม่"
      resumable.current = { file, resume: res.resume }
      setTransfer((prev) => (prev ? { ...prev, stage: 'paused', reason: res.reason } : prev))
    } else {
      resumable.current = null
      setActionError(true)
      setTransfer((prev) => (prev ? { ...prev, stage: 'failed', reason: res.reason } : prev))
    }
    setAddBusy(false)
  }

  /** กด "ทำต่อ" — ส่งเฉพาะก้อนที่ยังขาด ด้วย IV ใหม่ทุกก้อน (ดู vaultChunkCrypto.js) */
  const resumeUpload = () => {
    const pending = resumable.current
    if (!pending || addBusy) return
    addFile(pending.file, pending.resume)
  }

  /** ปิดแถบสถานะที่จบแล้ว (ล้มเหลว/หยุดค้าง) — ไม่แตะงานฝั่งเซิร์ฟเวอร์ */
  const dismissTransfer = () => {
    if (transfer?.stage === 'uploading' || transfer?.stage === 'encrypting') return
    resumable.current = null
    setTransfer(null)
  }

  /* ── ดาวน์โหลด V1: ดึง ciphertext ทั้งก้อน → แกะ DEK → ถอด → ส่งให้เบราว์เซอร์เซฟ ──
     ⚠️ เส้นทางนี้ "ยังเป็น whole-file ตามนิยามของ V1" และจะเป็นอย่างนั้นตลอดไป — blob
        ที่มีอยู่คือข้อความ GCM หนึ่งข้อความ ไม่มีทางถอดทีละส่วนได้ ไม่ว่าจะเขียนโค้ดอย่างไร
        เพดาน 64 MiB ของ V1 จึงคุ้มครองเส้นทางนี้อยู่แล้ว */
  const downloadV1 = async (entry) => {
    let url = null
    try {
      const res = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(entry.id)}`)
      if (!res.ok) { setActionError(true); return }
      // GCM ตรวจ integrity ให้ในตัว — ciphertext ที่ถูกแก้ระหว่างทางจะ throw ที่นี่
      const plain = await decryptFileContent(kek, entry.blob, res.bytes)
      url = URL.createObjectURL(new Blob([plain]))
      const a = document.createElement('a')
      a.href = url
      a.download = entry.name ?? `${entry.id}.bin`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch {
      setActionError(true)
    } finally {
      // ปล่อย blob URL ทันทีที่เบราว์เซอร์คว้าไปแล้ว — ไม่ทิ้ง plaintext ค้างใน memory
      if (url) setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
  }

  /* ── ดาวน์โหลด V2: ขอทีละก้อน ถอดทีละก้อน เขียนลงไฟล์ทีละก้อน ──────────
     หน่วยความจำสูงสุด = O(ขนาด chunk) ไม่ใช่ O(ขนาดไฟล์) ดู vaultChunkedDownload.js

     ⚠️ showSaveFilePicker() ต้องถูกเรียก "ก่อน await ตัวแรก" ของเส้นทางนี้เสมอ —
        เบราว์เซอร์ยอมเปิดตัวเลือกไฟล์เฉพาะเมื่อมันสืบย้อนไปถึงการกดของผู้ใช้ได้จริง
        ถ้าเราไปดึง metadata หรือ chunk แรกมาก่อน ตัวเลือกไฟล์จะถูกปฏิเสธทั้งที่ผู้ใช้กดเอง
     ⚠️ เบราว์เซอร์ที่ไม่มี API นี้ **ไม่ถูกปล่อยให้บัฟเฟอร์ตามยถากรรม**: ไฟล์ที่เล็กพอ
        ใช้ทางสำรองที่มีเพดานบังคับ ส่วนไฟล์ที่ใหญ่กว่านั้นได้ข้อความที่บอกความจริง
        แทนที่จะได้แท็บที่ค้างแล้วตาย */
  const downloadV2 = async (entry) => {
    const blob = entry.blob
    const plainSize = entry.plainSize ?? Math.max(0, blob.size - blob.chunkCount * 16)
    const streaming = supportsStreamingFileSink()

    let sink = null
    if (streaming) {
      try {
        const handle = await globalThis.showSaveFilePicker({ suggestedName: entry.name ?? `${entry.id}.bin` })
        sink = createFileSystemSink(await handle.createWritable())
      } catch (err) {
        // ผู้ใช้กดยกเลิกตัวเลือกไฟล์ = ไม่ใช่ความล้มเหลว เงียบแล้วจบ
        if (err?.name === 'AbortError') return
        setActionError(true)
        return
      }
    } else if (plainSize > MAX_BUFFERED_PLAINTEXT_BYTES) {
      // บอกความจริง: เบราว์เซอร์นี้ทำไม่ได้ ไม่ใช่ "ลองใหม่แล้วจะได้"
      setTransfer({
        kind: 'download', stage: 'unsupported', name: entry.name ?? null,
        totalBytes: plainSize, transferredBytes: 0, percent: 0,
        chunkIndex: 0, chunkCount: blob.chunkCount,
      })
      return
    } else {
      sink = createBufferedSink()
    }

    const ctrl = new AbortController()
    transferAbort.current = ctrl
    transferRate.current = createRateEstimator()
    setTransfer({
      kind: 'download', stage: 'downloading', name: entry.name ?? null,
      transferredBytes: 0, totalBytes: plainSize, percent: 0,
      chunkIndex: 0, chunkCount: blob.chunkCount, rate: null,
    })

    const res = await downloadVaultV2({
      kek, blob, sink, signal: ctrl.signal,
      // ⚠️ ดาวน์โหลดนับเป็น bytesWritten (ไบต์ที่ "เขียนออกไปแล้ว") ส่วนอัปโหลดนับ
      //    transferredBytes — แปลให้เป็นคำเดียวกันตรงนี้ ไม่งั้นตัวนับไบต์จะค้างที่ศูนย์
      //    ตลอดการดาวน์โหลด ทั้งที่เปอร์เซ็นต์เดิน (= แถบโกหกผู้ใช้สองตัวเลขที่ขัดกันเอง)
      onProgress: (p) => {
        const done = p.bytesWritten ?? null
        const rate = done === null ? null : (transferRate.current?.sample(
          done, performance.now(), { totalBytes: plainSize },
        ) ?? null)
        setTransfer((prev) => (
          // ⚠️ เหตุการณ์ที่ไม่มีไบต์ใหม่ (เช่นรายงานเฟส) ต้องไม่ล้างผลการวัดล่าสุดทิ้ง
          //    ไม่งั้นบรรทัดความเร็วจะกะพริบหายทุกครั้งที่ไม่มีตัวอย่างใหม่
          prev ? { ...prev, ...p, transferredBytes: done ?? prev.transferredBytes, rate: rate ?? prev.rate } : prev
        ))
      },
    })
    transferAbort.current = null

    if (!res.ok) {
      // ⚠️ ไม่มีการส่งมอบไฟล์ใด ๆ ในเส้นทางนี้ — sink ถูก abort() ไปแล้วใน downloadVaultV2
      if (res.reason === 'cancelled') { setTransfer(null); return }
      setActionError(true)
      setTransfer((prev) => (prev ? { ...prev, stage: 'failed', reason: res.reason } : prev))
      return
    }

    if (sink.kind === 'buffered') {
      // ทางสำรองที่มีเพดาน — ประกอบเป็น Blob แล้วให้เบราว์เซอร์เซฟตามปกติ
      const url = URL.createObjectURL(new Blob(res.result, { type: entry.type || 'application/octet-stream' }))
      const a = document.createElement('a')
      a.href = url
      a.download = entry.name ?? `${entry.id}.bin`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
    setTransfer(null)
  }

  /** ปุ่ม Download ของการ์ด — เลือกเส้นทางจาก formatVersion เท่านั้น */
  const download = async (entry) => {
    if (!kek || !unlocked || addBusy) return // ล็อกอยู่ = ไม่มีคำสั่งนี้ให้กด
    setActionError(false)
    if (entry.blob?.formatVersion === 2) {
      // ⚠️ ห้าม await อะไรก่อนถึงบรรทัดนี้ — downloadV2 ต้องเปิดตัวเลือกไฟล์ให้ทัน
      //    ภายใน user gesture เดียวกับการกดปุ่ม
      return downloadV2(entry)
    }
    setAddBusy(true)
    await downloadV1(entry)
    setAddBusy(false)
    return undefined
  }

  /* ── Preview: ถอดรหัสในเบราว์เซอร์ แล้ว render จาก object URL ในเครื่อง ──
     เส้นทางเดียวกับ Download ทุกประการ ต่างกันแค่ปลายทางของ bytes:

       ciphertext → ถอดในเบราว์เซอร์เท่านั้น → object URL หรือ media element ชั่วคราว

     ⚠️ เซิร์ฟเวอร์ไม่เคยได้รับหรือสร้าง plaintext, thumbnail, ชื่อไฟล์, MIME, KEK
        หรือ DEK เลย ไม่มี endpoint ใหม่ ไม่มี transcode ฝั่งเซิร์ฟเวอร์
     ⚠️ Preview แบบบัฟเฟอร์ต้องมี plaintext ทั้งก้อนใน memory จึงบังคับเพดาน 64 MiB
        ส่วนวิดีโอ V2 ที่ใหญ่กว่านั้นใช้ Service Worker ถอดตาม Range แบบ on-demand และ
        ห้ามถอยกลับไปประกอบทั้งไฟล์ใน RAM */
  const openPreview = async (entry) => {
    if (!kek || !unlocked) return
    const kind = previewKindFor(entry.type)
    if (!kind) return // ชนิดที่ไม่อยู่ใน allowlist ไม่มีคำสั่งนี้ในเมนูอยู่แล้ว

    setDetails(null)
    releasePreview() // preview ใบก่อนถูกแทนที่ = ปล่อย URL ใบก่อนทันที
    const token = previewToken.current

    const isV2 = entry.blob?.formatVersion === 2
    const plainSize = entry.plainSize ?? entry.size

    // ── วิดีโอ V2 ที่ใหญ่เกินกว่าจะบัฟเฟอร์: สตรีมตามช่วงไบต์ผ่าน Service Worker ──
    //
    // ⚠️ เงื่อนไขต้องเป็น "วิดีโอ" เท่านั้น ภาพนิ่งไม่ได้ประโยชน์จากการสตรีมตามช่วง
    //    (image element ขอทั้งไฟล์อยู่ดี) และเพดาน 64 MiB ของเส้นทางบัฟเฟอร์ยังคงบังคับ
    // ⚠️ ไม่มีการยกเพดาน MAX_BUFFERED_PLAINTEXT_BYTES ที่ใดเลย — เส้นทางนี้เป็นคนละ
    //    เส้นทางกัน ไม่ใช่การผ่อนเพดานเดิม
    if (isV2 && kind === 'video' && plainSize > MAX_BUFFERED_PLAINTEXT_BYTES) {
      if (!supportsLargeVideoPreview()) {
        // บอกความจริงว่าเบราว์เซอร์นี้ทำไม่ได้ แล้วเสนอ Download —
        // ไม่ถอยไปประกอบทั้งไฟล์ใน RAM เงียบ ๆ ซึ่งจะทำให้แท็บตาย
        setPreview({
          entry, kind, url: null, loading: false, failed: false, tooLarge: true, unsupported: true,
          failureReason: PREVIEW_FAILURE_REASON.UNSUPPORTED_BROWSER,
        })
        return
      }
      setPreview({ entry, kind, url: null, loading: true, failed: false, tooLarge: false })
      try {
        // ★ DEK ถูกแกะที่นี่ ในหน้าเว็บ แล้วส่งเป็น CryptoKey ที่ export ไม่ได้ ไปยัง
        //   worker ต้นทางเดียวกัน ไม่มีไบต์ของกุญแจออกไปที่ใดทั้งสิ้น
        const dek = await unwrapVaultV2Dek(kek, entry.blob)
        if (token !== previewToken.current) return

        // ⚠️ isUnlocked is read live, not captured: claim recovery can take
        //    seconds and a Vault locked inside that window must never receive a
        //    preview session, key or virtual URL.
        const session = await openPreviewSession({
          dek, blob: entry.blob, contentType: entry.type || 'video/mp4', plainSize,
          isUnlocked: () => unlockedRef.current,
        })
        if (token !== previewToken.current) {
          if (session) closePreviewSession(session.token)
          return
        }
        if (!session.ok) {
          setPreview({
            entry, kind, url: null, loading: false, failed: true, tooLarge: false,
            failureReason: session.reason,
          })
          return
        }
        previewStreamToken.current = session.token
        setPreview((prev) => (prev?.entry.id === entry.id
          ? { ...prev, url: session.url, loading: false, streamed: true }
          : prev))
      } catch {
        if (token !== previewToken.current) return
        setPreview((prev) => (prev?.entry.id === entry.id
          ? { ...prev, loading: false, failed: true, failureReason: PREVIEW_FAILURE_REASON.INTEGRITY_FAILED }
          : prev))
      }
      return
    }

    if (isV2 && plainSize > MAX_BUFFERED_PLAINTEXT_BYTES) {
      // ⚠️ สถานะนี้เป็นความจริงเชิงสถาปัตยกรรม ไม่ใช่ error ชั่วคราว — ข้อความจึงต้อง
      //    บอกทางออกที่ใช้ได้จริง (ดาวน์โหลดไปเปิด) ไม่ใช่ "ลองใหม่อีกครั้ง"
      setPreview({ entry, kind, url: null, loading: false, failed: false, tooLarge: true })
      return
    }
    setPreview({ entry, kind, url: null, loading: true, failed: false, tooLarge: false })

    try {
      let plain
      if (isV2) {
        const sink = createBufferedSink()
        const res = await downloadVaultV2({ kek, blob: entry.blob, sink })
        if (!res.ok) throw new Error(res.reason)
        plain = new Blob(res.result, { type: entry.type || 'application/octet-stream' })
      } else {
        const res = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(entry.id)}`)
        if (token !== previewToken.current) return
        if (!res.ok) throw new Error('fetch-failed')
        // GCM ตรวจ integrity ให้ในตัว — ciphertext ที่ถูกแก้ระหว่างทางจะ throw ที่นี่
        const bytes = await decryptFileContent(kek, entry.blob, res.bytes)
        plain = new Blob([bytes], { type: entry.type || 'application/octet-stream' })
      }
      // ⚠️ ตรวจอีกครั้งหลังถอดเสร็จ: ผู้ใช้อาจกดล็อกระหว่างที่ถอดอยู่ ถ้าสร้าง URL
      //    ตอนนี้จะได้ object URL ที่ไม่มีใครถืออ้างอิงไว้ปล่อยคืน = plaintext ค้าง
      if (token !== previewToken.current) return
      const url = URL.createObjectURL(plain)
      previewUrlRef.current = url
      setPreview((prev) => (prev?.entry.id === entry.id ? { ...prev, url, loading: false } : prev))
    } catch {
      if (token !== previewToken.current) return
      setPreview((prev) => (prev?.entry.id === entry.id ? { ...prev, loading: false, failed: true } : prev))
    }
  }

  /* ── Details: กล่องเดียว สองสถานะที่ "จริงคนละแบบ" ──────────────────
     ปลดล็อก = พูดถึงไฟล์ต้นฉบับได้ตามจริง (ชื่อ / MIME / ขนาด plaintext)
     ล็อก = พูดได้เฉพาะสิ่งที่เซิร์ฟเวอร์เห็นอยู่แล้ว (id ทึบ / ขนาด ciphertext / เวลา)
     ⚠️ กิ่งของสถานะล็อกต้องไม่แตะ entry.name / entry.type / entry.plainSize เลย
        แม้ค่าเหล่านั้นจะเป็น null อยู่แล้วจาก lockedVaultEntry — เขียนให้ "อ่านแล้ว
        เห็นว่าไม่มีทางรั่ว" สำคัญกว่าเขียนให้สั้น และไม่มีการถอดรหัสใด ๆ ที่นี่ */
  const openDetails = (entry) => {
    closePreview()
    const createdAt = entry.createdAt ?? entry.blob?.createdAt ?? null
    setDetails(unlocked
      ? {
          locked: false,
          id: vaultBlobId(entry),
          name: entry.name ?? null,
          type: entry.type ?? null,
          plainSize: entry.plainSize ?? null,
          size: entry.size,
          createdAt,
        }
      : { locked: true, id: vaultBlobId(entry), size: entry.size, createdAt })
  }

  /* ── ลบไฟล์ในห้องนิรภัย ─────────────────────────────────────────
     ใช้ DELETE /api/vault/blobs/:id ที่มีอยู่แล้ว — ไม่มี endpoint ใหม่ และ
     ⚠️ ไม่มี user id ใด ๆ ใน request: สิทธิ์มาจาก req.user ฝั่ง server เท่านั้น

     นโยบาย (เจ้าของผลิตภัณฑ์เปลี่ยนจาก PR #39): "ลบได้เฉพาะตอนปลดล็อก"
     PR #39 เปิดให้ลบขณะล็อกโดยเจตนา เหตุผลตอนนั้นคือ vault ที่กุญแจหายจะเหลือ
     blob ที่ลบไม่ได้ตลอดไป — เจ้าของผลิตภัณฑ์รับข้อแลกเปลี่ยนนั้นแล้วและเลือก
     "ล็อก = ดูข้อมูลทึบอย่างเดียว" แทน: การกดลบสิ่งที่ระบุตัวไม่ได้คือการทำลาย
     ข้อมูลโดยไม่รู้ว่ากำลังทำลายอะไร ทางออกของผู้ใช้คือปลดล็อกก่อน
     ⚠️ นี่คือนโยบายฝั่ง client เท่านั้น — route DELETE ฝั่ง server ไม่ถูกแตะต้อง
        และยังคุมสิทธิ์ด้วย req.user เหมือนเดิม UI ที่ซ่อนปุ่มไม่ใช่ระบบสิทธิ์

     ยังมี "รูปแบบทึบ" ของกล่องยืนยันอยู่ แต่เหตุผลเปลี่ยนไป: มันใช้กับ entry ที่
     ปลดล็อกแล้วแต่ metadata ถอดไม่ออก (envelope เสีย) — กล่องนั้นจึงต้องไม่พูดว่า
     "ห้องนิรภัยล็อกอยู่" ซึ่งไม่จริง แต่พูดว่าอ่าน metadata ของรายการนี้ไม่ได้ */
  const requestDelete = (entry) => {
    if (!unlocked) return // ล็อกอยู่ = ไม่มีเส้นทางไปถึงกล่องนี้เลย
    const named = Boolean(entry.name)
    setDeleteError(false)
    setAskDelete({
      id: vaultBlobId(entry),
      name: named ? entry.name : null,
      size: entry.size,
      opaque: !named,
    })
  }

  const closeDelete = () => {
    if (deleteBusy) return
    setAskDelete(null)
    setDeleteError(false)
  }

  const confirmDelete = async () => {
    if (!askDelete || deleteBusy) return
    const id = askDelete.id
    setDeleteBusy(true)
    setDeleteError(false)
    const res = await apiFetch(`/api/vault/blobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setDeleteBusy(false)
    if (!res.ok) {
      // ⚠️ ไม่มี optimistic removal: การ์ดต้องอยู่ต่อ เพราะ ciphertext ยังอยู่จริงบน server
      setDeleteError(true)
      return
    }
    // 204 แล้วเท่านั้นจึงเอาออกจากทุกมุมมองพร้อมกัน + ปักป้ายหลุมศพกัน GET เก่าปลุกคืน
    setRemovedIds((prev) => tombstoneVaultBlob(prev, id))
    setLocalBlobs((prev) => removeLocalVaultBlob(prev, id))
    setEntries((prev) => (prev ? prev.filter((e) => vaultBlobId(e) !== id) : prev))
    setAskDelete(null)
    vaultApi.refresh()
  }

  const openModal = (which) => {
    setModal(which)
    setFormError(null)
    setPass('')
    setPass2('')
    setAck(false)
    setAutoLocked(false)
  }

  /* ปลดล็อก = รายการที่ถอดแล้ว (กรอง tombstone ซ้ำอีกชั้นกันการ์ดผี)
     ล็อก = บัญชี blob ทึบล้วน ไม่มีฟิลด์ใดที่มาจาก plaintext เลย */
  const list = placeholderMode
    ? []
    : unlocked
      ? reconcileVaultInventory({ serverBlobs: entries ?? [], removedIds })
      : inventory.map(lockedVaultEntry)
  const fetchError = visibleFetchError(vaultApi.error, placeholderMode)
  const openEmptyAction = () => {
    if (!configured) openModal('setup')
    else if (!unlocked) openModal('unlock')
    else fileRef.current?.click()
  }

  return (
    <div>
      {/* persistent, calm callout — this warning never goes away */}
      <div className="flex items-center gap-3 rounded-[var(--r-tile)] px-4 py-3 mb-5" style={{ background: 'var(--warn-soft)' }}>
        <TriangleAlert size={16} strokeWidth={1.8} style={{ color: 'var(--warn)' }} className="shrink-0" />
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold tracking-[0.04em]" style={{ color: 'var(--warn)' }}>
            {t('vaultWarning')}
          </p>
          <p className="text-[12px] text-ink-2 mt-0.5">{t('vaultSecurityBanner')}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <Chip tone={unlocked ? 'ok' : 'neutral'}>
          {unlocked ? <LockOpen size={11} strokeWidth={2} /> : <Lock size={11} strokeWidth={2} />}
          {unlocked ? t('vaultUnlocked') : (configured ? t('vaultLocked') : t('vaultSetupNeeded'))}
        </Chip>
        <p className="text-[13px] text-ink-3">{t('vaultNoSearch')}</p>
        <div className="flex-1" />
        {unlocked ? (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = '' }}
            />
            <Btn variant="primary" onClick={() => fileRef.current?.click()} disabled={addBusy}>
              <Plus size={14} strokeWidth={1.8} />
              {t('upload')}
            </Btn>
            <Btn variant="outline" onClick={() => lock(false)}>
              <Lock size={14} strokeWidth={1.5} />
              {t('lockVault')}
            </Btn>
          </>
        ) : configured ? (
          <Btn variant="primary" onClick={() => openModal('unlock')}>
            <LockOpen size={14} strokeWidth={1.5} />
            {t('unlockVault')}
          </Btn>
        ) : (
          <Btn variant="primary" onClick={() => openModal('setup')}>
            <KeyRound size={14} strokeWidth={1.5} />
            {t('vaultSetupCta')}
          </Btn>
        )}
      </div>

      {autoLocked && (
        <p role="status" className="text-[12.5px] text-ink-3 mb-4">{t('vaultAutoLocked')}</p>
      )}
      {actionError && (
        <p role="alert" className="text-[12.5px] font-medium mb-4" style={{ color: 'var(--danger)' }}>
          {t('actionFailed')}
        </p>
      )}

      {/* ⚠️ แถบนี้ปรากฏเฉพาะตอนปลดล็อกอยู่ — งานเข้ารหัส/ถอดรหัสมีอยู่ได้เฉพาะตอนนั้น
          และมันถูกเคลียร์พร้อมกุญแจใน lock() ไม่ใช่ค้างไว้ให้ผู้ใช้เห็นชื่อไฟล์หลังล็อก */}
      {unlocked && (
        <VaultTransferPanel
          t={t}
          transfer={transfer}
          onResume={resumeUpload}
          onCancel={() => transferAbort.current?.abort()}
          onDismiss={dismissTransfer}
        />
      )}

      {vaultApi.loading ? (
        <Card className="p-5"><SkeletonLoader type="files" /></Card>
      ) : fetchError ? (
        <Card><ErrorState t={t} kind={fetchError} onRetry={vaultApi.retry} /></Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Lock}
            title={t('emptyVault')}
            hint={t('vaultKeyNote')}
            action={
              <Btn variant="primary" size="sm" onClick={openEmptyAction} disabled={addBusy}>
                <Plus size={14} strokeWidth={1.8} />
                {t('encryptFirstFile')}
              </Btn>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {list.map((entry, i) => (
            <VaultTile
              key={entry.id} t={t} entry={entry} unlocked={unlocked}
              index={reduced ? 0 : i}
              onPreview={openPreview} onDetails={openDetails}
              onDownload={download} onDelete={requestDelete}
              busy={addBusy}
            />
          ))}
        </div>
      )}

      {/* ── ยืนยันการลบ ─────────────────────────────────────────────
          เปิดได้เฉพาะตอนปลดล็อกเท่านั้น (ดู requestDelete) สองโหมด:
          metadata ถอดได้ = เอ่ยชื่อไฟล์ที่ถอดแล้วได้ตามจริง
          metadata ถอดไม่ได้ = ระบุด้วย id ทึบ + ขนาด ciphertext ไม่แต่งชื่อขึ้นมาเอง */}
      <Modal open={!!askDelete} onClose={closeDelete} width={440} labelledBy="vault-del-title">
        <ModalClose onClose={closeDelete} label={t('cancel')} />
        <h2 id="vault-del-title" className="text-[18px] font-semibold text-ink pr-8">
          {askDelete?.opaque
            ? t('vaultDeleteOpaqueTitle', { id: `${askDelete?.id}.aegisenc` })
            : t('vaultDeleteTitle', { name: askDelete?.name ?? '' })}
        </h2>
        <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">
          {askDelete?.opaque ? t('vaultDeleteOpaqueBody') : t('vaultDeleteBody')}
        </p>

        {/* แสดง "เท่าที่ระบบเห็นจริง" เท่านั้น — id ทึบ + ขนาด ciphertext */}
        {askDelete?.opaque && (
          <dl className="mt-4 rounded-[var(--r-tile)] bg-sunken border border-line px-3.5 py-3 text-[12.5px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3">{t('vaultOpaqueId')}</dt>
              <dd className="font-mono text-ink truncate">{askDelete?.id}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 mt-1.5">
              <dt className="text-ink-3">{t('vaultCiphertextSize')}</dt>
              <dd className="font-mono text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(askDelete?.size ?? 0)}</dd>
            </div>
          </dl>
        )}

        {deleteError && (
          <p role="alert" aria-live="assertive" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {t('vaultDeleteFailed')}
          </p>
        )}

        <div className="flex gap-2.5 mt-6">
          {/* โฟกัสแรกลงที่ทางออกที่ไม่ทำลายข้อมูล ไม่ใช่ปุ่มลบ */}
          <Btn variant="outline" className="flex-1" data-modal-autofocus onClick={closeDelete} disabled={deleteBusy}>
            {t('cancel')}
          </Btn>
          <Btn variant="danger" className="flex-1" onClick={confirmDelete} disabled={deleteBusy}>
            {deleteBusy ? t('vaultDeleting') : t('vaultDeleteConfirm')}
          </Btn>
        </div>
      </Modal>

      {/* ── Preview ─────────────────────────────────────────────────
          plaintext ที่ถอดแล้วอยู่หลัง object URL ในเครื่องเท่านั้น ไม่มี src ที่ชี้ไป
          เซิร์ฟเวอร์ ไม่มี <iframe>/<object>/<embed> และไม่มีการตีความ HTML/SVG
          ของผู้ใช้ — รองรับเฉพาะ raster image และวิดีโอตาม allowlist ใน
          src/lib/vaultPreview.js เท่านั้น */}
      <Modal open={!!preview} onClose={closePreview} width={880} labelledBy="vault-preview-title">
        <ModalClose onClose={closePreview} label={t('close')} />
        <h2 id="vault-preview-title" className="text-[16px] font-semibold text-ink pr-8 truncate">
          {preview?.entry.name ?? t('vaultUnnamed')}
        </h2>
        {/* หัวเรื่องพูดความจริงสองอย่างที่ต่างกันจริง ๆ: ขนาดต้นฉบับ กับ ขนาดที่เก็บจริง */}
        <p className="text-[12px] text-ink-3 mt-1" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {preview?.entry.type} · {t('vaultPlaintextSize')} {fmtBytes(preview?.entry.plainSize ?? 0)}
          {' · '}{t('vaultCiphertextSize')} {fmtBytes(preview?.entry.size ?? 0)}
        </p>

        <div
          className="mt-4 rounded-[var(--r-tile)] bg-sunken border border-line flex items-center justify-center overflow-hidden"
          style={{ minHeight: 220 }}
          data-vault-preview-stage={preview?.kind ?? ''}
        >
          {preview?.tooLarge ? (
            /* ⚠️ สถานะนี้ไม่ใช่ error และไม่ใช่สิ่งที่ "ลองใหม่แล้วจะหาย" — มันคือ
               ข้อจำกัดที่ตั้งใจ: Preview ต้องมี plaintext ทั้งก้อนใน RAM เพื่อสร้าง
               object URL การประกอบวิดีโอหลายกิกะไบต์ในแท็บเพื่อให้ปุ่มนี้ดูใช้งานได้
               คือการนำปัญหาที่ V2 เพิ่งแก้ไปกลับเข้ามาทางประตูหลัง */
            <p
              role="status"
              data-vault-preview-too-large="1"
              data-vault-preview-unsupported={preview.unsupported ? '1' : '0'}
              className="text-[13px] text-ink-2 px-6 py-10 text-center max-w-md"
            >
              {preview.unsupported ? t('vaultPreviewUnsupportedBrowser') : t('vaultPreviewTooLarge')}
            </p>
          ) : preview?.failed ? (
            /* ⚠️ สองข้อความนี้ต้องไม่ถูกยุบเป็นข้อความเดียว: "เปิดไม่ได้" คือเรื่องชั่วคราว
               ส่วน "พิสูจน์ความถูกต้องไม่ผ่าน" แปลว่าไบต์ที่เก็บไว้ไม่ตรงกับที่ปิดผนึกไว้
               ซึ่งผู้ใช้ต้องรู้ ไม่ใช่ถูกกลบด้วยคำว่า error */
            <p
              role="alert"
              data-vault-preview-integrity={preview.failureReason === PREVIEW_FAILURE_REASON.INTEGRITY_FAILED ? '1' : '0'}
              data-vault-preview-failure={preview.failureReason ?? ''}
              className="text-[13px] font-medium px-6 py-10 text-center max-w-md"
              style={{ color: 'var(--danger)' }}
            >
              {preview.failureReason
                ? t(previewFailureCopyKey(preview.failureReason))
                : t('vaultPreviewUnavailable')}
            </p>
          ) : preview?.url ? (
            preview.kind === 'video' ? (
              /* ⚠️ controls ใช่, autoPlay ไม่ — ไฟล์ในห้องนิรภัยต้องไม่เริ่มเล่นเสียง
                 ขึ้นมาเองในที่สาธารณะ และ preload="none" ไม่มีประโยชน์ที่นี่เพราะ
                 bytes ถูกถอดครบแล้วอยู่ในเครื่อง */
              <video
                controls
                /* ⚠️ preload="metadata" สำหรับเส้นทางสตรีม: ค่าปริยาย "auto" ชวนให้
                   เบราว์เซอร์ไล่ดึงล่วงหน้าไปเรื่อย ๆ ซึ่งกับไฟล์หลายกิกะไบต์เท่ากับ
                   ดาวน์โหลดทั้งไฟล์โดยที่ผู้ใช้แค่เปิดดู ค่านี้ทำให้มันขอเท่าที่ต้องเล่นจริง */
                preload={preview.streamed ? 'metadata' : 'auto'}
                data-vault-preview-streamed={preview.streamed ? '1' : '0'}
                src={preview.url}
                onError={() => setPreview((prev) => (prev?.streamed
                  ? { ...prev, failed: true, failureReason: PREVIEW_FAILURE_REASON.MEDIA_PLAYBACK_FAILED }
                  : prev))}
                className="max-w-full"
                style={{ maxHeight: '68vh' }}
              />
            ) : (
              /* contain + aspect ratio เดิม ไม่ crop: ห้องนิรภัยไม่ควรตัดภาพของผู้ใช้ทิ้ง
                 เพียงเพื่อให้กรอบสวย */
              <img
                src={preview.url}
                alt={preview.entry.name ?? ''}
                className="max-w-full object-contain"
                style={{ maxHeight: '68vh' }}
              />
            )
          ) : (
            <p role="status" className="text-[13px] text-ink-3 px-6 py-10">{t('vaultDecrypting')}</p>
          )}
        </div>

        <div className="flex gap-2.5 mt-5 justify-end">
          <Btn variant="outline" onClick={closePreview}>{t('close')}</Btn>
          <Btn
            variant="primary"
            onClick={() => preview && download(preview.entry)}
            disabled={addBusy || !preview}
          >
            <Download size={14} strokeWidth={1.5} />
            {t('download')}
          </Btn>
        </div>
      </Modal>

      {/* ── Details ─────────────────────────────────────────────────
          กล่องเดียว สองสถานะที่จริงคนละแบบ ปลดล็อก = พูดถึงไฟล์ต้นฉบับได้
          ล็อก = พูดได้เฉพาะสิ่งที่เซิร์ฟเวอร์เห็นอยู่แล้ว และบอกตรง ๆ ว่าต้องปลดล็อกก่อน
          ⚠️ ทั้งสองสถานะไม่แสดง path บนดิสก์ / storage_key / รายละเอียดภายในของเซิร์ฟเวอร์ */}
      <Modal open={!!details} onClose={() => setDetails(null)} width={460} labelledBy="vault-details-title">
        <ModalClose onClose={() => setDetails(null)} label={t('close')} />
        <h2 id="vault-details-title" className="text-[18px] font-semibold text-ink pr-8">
          {details?.locked ? t('vaultEncryptedDetails') : t('fileDetails')}
        </h2>
        {details?.locked && (
          <p className="text-[13px] text-ink-2 mt-2.5 leading-relaxed">{t('vaultLockedDetailsBody')}</p>
        )}

        <dl className="mt-4 rounded-[var(--r-tile)] bg-sunken border border-line px-3.5 py-3 text-[12.5px] space-y-1.5">
          {!details?.locked && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3 shrink-0">{t('colName')}</dt>
              <dd className="text-ink truncate text-right">{details?.name ?? t('vaultUnnamed')}</dd>
            </div>
          )}
          {!details?.locked && details?.type && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3 shrink-0">{t('type')}</dt>
              <dd className="font-mono text-ink truncate text-right">{details.type}</dd>
            </div>
          )}
          {!details?.locked && details?.plainSize != null && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3 shrink-0">{t('vaultPlaintextSize')}</dt>
              <dd className="font-mono text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(details.plainSize)}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-3 shrink-0">{t('vaultCiphertextSize')}</dt>
            <dd className="font-mono text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(details?.size ?? 0)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-3 shrink-0">{t('vaultOpaqueId')}</dt>
            <dd className="font-mono text-ink truncate text-right">{details?.id}</dd>
          </div>
          {/* เวลาที่แถวถูกบันทึกเป็นข้อมูลฝั่งเซิร์ฟเวอร์ล้วน — แสดงได้ทั้งสองสถานะ
              และถ้าเซิร์ฟเวอร์ไม่ได้ส่งมา ก็ไม่แต่งขึ้นมาเอง */}
          {details?.createdAt != null && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3 shrink-0">{t('uploadedAt')}</dt>
              <dd className="text-ink text-right">{fmtDateTime(details.createdAt, lang)}</dd>
            </div>
          )}
        </dl>

        <Btn variant="outline" className="w-full mt-5" data-modal-autofocus onClick={() => setDetails(null)}>
          {t('close')}
        </Btn>
      </Modal>

      {/* ── ปลดล็อก ─────────────────────────────────────────────── */}
      <Modal open={modal === 'unlock'} onClose={() => setModal(null)} width={420} labelledBy="vault-unlock-title">
        <ModalClose onClose={() => setModal(null)} label={t('close')} />
        <div className={shake ? 'shake-x' : ''}>
          <h2 id="vault-unlock-title" className="text-[18px] font-semibold text-ink">{t('unlockVault')}</h2>
          <label htmlFor="vault-key" className="block text-[13px] font-medium text-ink-2 mt-5 mb-1.5">
            {t('vaultKeyLabel')}
          </label>
          <input
            id="vault-key"
            data-modal-autofocus
            type="password"
            value={pass}
            onChange={(e) => { setPass(e.target.value); setFormError(null) }}
            onKeyDown={(e) => e.key === 'Enter' && tryUnlock()}
            placeholder="••••••••••••"
            autoComplete="off"
            disabled={busy}
            className="w-full h-12 px-4 rounded-full bg-sunken border font-mono text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            style={{ borderColor: formError ? 'var(--danger)' : 'var(--line)' }}
          />
          {formError && (
            <p role="alert" aria-live="assertive" className="text-[12.5px] font-medium mt-2" style={{ color: 'var(--danger)' }}>
              {t(formError)}
            </p>
          )}
          <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">{t('vaultKeyNote')}</p>
          <Btn variant="primary" className="w-full mt-5" onClick={tryUnlock} disabled={!pass || busy}>
            {busy ? t('vaultDeriving') : t('decrypt')}
          </Btn>
        </div>
      </Modal>

      {/* ── ตั้งค่าครั้งแรก ───────────────────────────────────────── */}
      <Modal open={modal === 'setup'} onClose={() => setModal(null)} width={460} labelledBy="vault-setup-title">
        <ModalClose onClose={() => setModal(null)} label={t('close')} />
        <h2 id="vault-setup-title" className="text-[18px] font-semibold text-ink">{t('vaultSetupTitle')}</h2>
        <p className="text-[12.5px] text-ink-3 mt-2 leading-relaxed">{t('vaultSetupIntro')}</p>

        <label htmlFor="vault-new-key" className="block text-[13px] font-medium text-ink-2 mt-5 mb-1.5">
          {t('vaultKeyLabel')}
        </label>
        <input
          id="vault-new-key"
          data-modal-autofocus
          type="password"
          value={pass}
          onChange={(e) => { setPass(e.target.value); setFormError(null) }}
          autoComplete="new-password"
          disabled={busy}
          className="w-full h-12 px-4 rounded-full bg-sunken border border-line font-mono text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />

        <label htmlFor="vault-new-key2" className="block text-[13px] font-medium text-ink-2 mt-4 mb-1.5">
          {t('vaultKeyConfirmLabel')}
        </label>
        <input
          id="vault-new-key2"
          type="password"
          value={pass2}
          onChange={(e) => { setPass2(e.target.value); setFormError(null) }}
          onKeyDown={(e) => e.key === 'Enter' && doSetup()}
          autoComplete="new-password"
          disabled={busy}
          className="w-full h-12 px-4 rounded-full bg-sunken border border-line font-mono text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />

        {formError && (
          <p role="alert" aria-live="assertive" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {t(formError)}
          </p>
        )}

        {/* การยอมรับความเสี่ยงเป็นขั้นตอนบังคับ ไม่ใช่ข้อความประกอบ — ไม่มีปุ่มกู้คืนอยู่จริง */}
        <label className="flex items-start gap-2.5 mt-5 cursor-pointer">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            disabled={busy}
            className="mt-0.5 accent-[var(--accent)] h-4 w-4 shrink-0"
          />
          <span className="text-[12.5px] text-ink-2 leading-relaxed">{t('vaultSetupAck')}</span>
        </label>

        <Btn variant="primary" className="w-full mt-5" onClick={doSetup} disabled={busy || !ack || !pass || !pass2}>
          {busy ? t('vaultDeriving') : t('vaultSetupCreate')}
        </Btn>
      </Modal>
    </div>
  )
}
