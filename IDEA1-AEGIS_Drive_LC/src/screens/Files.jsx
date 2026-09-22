import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LayoutGrid, List, Upload, FolderPlus, MoreHorizontal, Shield, Database, X as XIcon,
  FileText, FileSpreadsheet, FileArchive, FileVideo, FileImage, File as FileIcon,
  Download, PenLine, FolderInput, Link2, ShieldCheck, Trash2, Info, Copy, Check, Search, History,
  Folder, FolderOpen, ChevronRight, Eye,
} from 'lucide-react'
import { Card, Chip, Btn, IconBtn, PillSelect, Th, ScrambleHash, ErrorState, EmptyState, DependencyUnavailableState, SkeletonLoader, Modal, ModalClose, Field, PillInput, AnchoredMenu } from '../components/ui.jsx'
import { useApi, useNow, useReducedMotion } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch, apiUrl } from '../lib/api.js'
import { fmtBytes, fmtRelative, fmtDateTime } from '../lib/format.js'
import { UploadDrawer } from '../components/UploadDrawer.jsx'
import { AEGIS_ITEMS_TYPE, canDropOn, dragPayloadFor, isExternalFileDrag, readDragPayload, writeDragPayload } from '../lib/fileDragDrop.js'
import { DEFAULT_SORT, SORT_LABEL_KEYS, SORT_MODES, filterItems, previewKindFor, previewPathFor, sectionItems } from '../lib/filesView.js'
import { MediaProvider, MediaThumb, useOwnedMediaRuntime } from '../components/MediaThumb.jsx'
import { FileCardCheckbox, FileCardMenuButton, FileCardShell } from '../components/FileCardPresentation.jsx'
import { SelectionAction, SelectionActionBar } from '../components/SelectionActionBar.jsx'
import { readFolderHistory, writeFolderHistory } from '../lib/folderHistory.js'

const EXT_ICONS = {
  xlsx: FileSpreadsheet, docx: FileText, pdf: FileText, zip: FileArchive, 'tar.gz': FileArchive,
  mp4: FileVideo, webm: FileVideo, mov: FileVideo, mkv: FileVideo, pptx: FileImage, log: FileIcon,
  jpg: FileImage, jpeg: FileImage, png: FileImage, gif: FileImage, webp: FileImage, avif: FileImage, bmp: FileImage,
}
// ⚠️ โฟลเดอร์ถูกตัดสินจาก `kind` ไม่ใช่จากนามสกุล — เดิม `EXT_ICONS['']` เป็น undefined
//    ทำให้โฟลเดอร์ได้ไอคอนไฟล์ทั่วไปเหมือนกันหมด ซึ่งคือเหตุผลที่ผู้ใช้แยกไม่ออก
const iconFor = (f) => (f.kind === 'folder' ? Folder : (EXT_ICONS[f.ext] ?? FileIcon))

/** ตัวตนของ "ทรัพยากร preview" ของไฟล์ — id (เส้นทาง) + ชื่อ (MIME ฝั่งเซิร์ฟเวอร์ตัดสินจากนามสกุล) */
const previewIdentityOf = (f) => (f ? `${f.id}\u0000${f.name}` : '')

/** ระยะกดค้างบนจอสัมผัสก่อนที่ "การชี้สื่อ" จะเริ่ม (ms) — ค่าคงที่เล็ก ๆ ค่าเดียว ทดสอบด้วยเวลาจริง */
export const MEDIA_HOLD_MS = 250

/**
 * การชี้สื่อของการ์ด (Pointer Events):
 *   เมาส์/ปากกา: pointer enter → hover, pointer leave → หยุด
 *   สัมผัส: กดค้าง ≥ MEDIA_HOLD_MS → hold (poster ยังอยู่, motion เล่นเมื่อพร้อมและนิ้วยังกดอยู่); ปล่อย/ยกเลิก/ออก → หยุดทันที
 * ⚠️ hold ที่ถูกใช้ไปแล้ว "กิน" click ที่ตามมา (ไม่เปิดไฟล์) และห้ามลากภายใน/เมนูบริบทระหว่างกด — แตะสั้น ๆ ยังเปิดไฟล์ตามเดิม
 * ⚠️ mouseenter/mouseleave ใช้เฉพาะสภาพแวดล้อมที่ไม่มี PointerEvent (เบราว์เซอร์จริงทุกตัวมี) — เหตุการณ์ compat ของจอสัมผัส
 *    (pointerType 'touch') ไม่ถือเป็น hover
 */
function useMediaPointer() {
  const [hover, setHover] = useState(false)
  const [hold, setHold] = useState(false)
  const timer = useRef(null)
  const holdRef = useRef(false)
  const consumedRef = useRef(false)
  const pointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  const endHold = () => {
    clearTimer()
    if (holdRef.current) { holdRef.current = false; consumedRef.current = true; setHold(false) }
  }
  useEffect(() => () => clearTimer(), [])
  const isTouch = (e) => e.pointerType === 'touch'
  return {
    hover: hover || hold,
    holding: hold,
    hoverStyle: hover,
    props: {
      onPointerEnter: (e) => { if (!isTouch(e)) setHover(true) },
      onPointerLeave: (e) => { if (!isTouch(e)) setHover(false); endHold() },
      onPointerDown: (e) => {
        if (!isTouch(e) || e.button > 0) return
        consumedRef.current = false
        clearTimer()
        timer.current = setTimeout(() => { timer.current = null; holdRef.current = true; setHold(true) }, MEDIA_HOLD_MS)
      },
      onPointerUp: () => endHold(),
      onPointerCancel: () => endHold(),
      // สภาพแวดล้อมไม่มี PointerEvent (เช่น jsdom): เมาส์ยังทำงานผ่าน mouseenter/leave
      onMouseEnter: () => { if (!pointerEvents) setHover(true) },
      onMouseLeave: () => { if (!pointerEvents) setHover(false) },
      onContextMenu: (e) => { if (holdRef.current || timer.current) e.preventDefault() },
    },
    /** เรียกจาก onClick ของการ์ด — จริงเมื่อ click นี้เป็นปลายทางของ hold ที่ถูกใช้ไปแล้ว */
    consumeClick: () => { const c = consumedRef.current; consumedRef.current = false; return c },
    /** เรียกจาก onDragStart — ห้ามลากภายในขณะกดค้าง */
    blockDrag: (e) => { if (holdRef.current || timer.current) { e.preventDefault(); return true } return false },
  }
}

/* วิธีจัดเก็บต้องแยกให้ชัด: Vault เป็น ciphertext จริง ส่วน Data Lake ปกติค้นหาได้
   แต่ยังไม่มี encryption at rest — ห้ามใช้โล่/สีเขียวทำให้ดูเหมือนเข้ารหัสแล้ว */
function StorageBadge({ vault, t }) {
  const Icon = vault ? Shield : Database
  return (
    <span
      title={vault ? t('encVault') : t('encServer')}
      className={`inline-flex items-center justify-center size-6 rounded-[7px] shrink-0 border border-line bg-sunken ${vault ? 'hatch hatch-ink3' : ''}`}
    >
      <Icon size={12} strokeWidth={1.8} style={{ color: 'var(--ink-3)' }} />
    </span>
  )
}

/* ── per-file overflow menu ──────────────────────────────────────── */
export function FileMenu({ t, onAction, onClose, file }) {
  const isFolder = file?.kind === 'folder'
  // Preview มีเฉพาะไฟล์ปกติชนิดที่แสดงผลได้ — ไม่มีสำหรับโฟลเดอร์ (ไม่มีไบต์) และไม่มีสำหรับ
  // Private Vault (เซิร์ฟเวอร์ไม่มี plaintext ให้ — Vault มีเส้นทาง preview ของตัวเองในจอ Vault)
  const previewable = previewKindFor(file) !== null
  const items = [
    ...(previewable ? [{ id: 'preview', icon: Eye, label: t('preview') }] : []),
    // โฟลเดอร์ไม่มีไบต์ให้ดาวน์โหลดหรือตรวจ checksum — คำสั่งที่กดแล้วไม่เกิดอะไรคือคำสั่งที่โกหก
    ...(isFolder ? [] : [{ id: 'download', icon: Download, label: t('download') }]),
    { id: 'rename', icon: PenLine, label: t('rename') },
    { id: 'move', icon: FolderInput, label: t('move') },
    ...(isFolder ? [] : [
      { id: 'link', icon: Link2, label: t('createSecureShare') },
      { id: 'history', icon: History, label: t('viewHistory') },
      { id: 'verify', icon: ShieldCheck, label: t('verifySha') },
    ]),
    { id: 'meta', icon: Info, label: t('viewMetadata') },
    { id: 'delete', icon: Trash2, label: t('delete'), danger: true },
  ]
  // ⚠️ ไม่ต้องมี listener ปิดเมนูที่นี่ และไม่ต้องจัดตำแหน่งเอง — AnchoredMenu
  //    เป็นเจ้าของทั้งการวางตำแหน่ง การปิด และชั้นการวาด (ดู components/ui.jsx)
  //    คอมโพเนนต์นี้เหลือหน้าที่เดียวคือ "รายการคำสั่ง"
  return (
    <div onClick={(e) => e.stopPropagation()}>
      {items.map(({ id, icon: Icon, label, danger, disabled }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={() => { if (!disabled) onAction(id); onClose() }}
          className="w-full flex items-center gap-2.5 px-3.5 h-8 text-[13px] font-medium hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: danger ? 'var(--danger)' : 'var(--ink-2)' }}
        >
          <Icon size={14} strokeWidth={1.5} />
          {label}
        </button>
      ))}
    </div>
  )
}

/* ── FLIP ghost — the tile morphs into the drawer header ─────────── */
function FlipGhost({ ghost, onDone }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ghost) return
    const el = ref.current
    const { from, to } = ghost
    el.style.transition = 'none'
    el.style.transform = `translate(${from.left}px, ${from.top}px)`
    el.style.width = `${from.width}px`
    el.style.height = `${from.height}px`
    el.style.opacity = '1'
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.transition = 'transform var(--dur-slow) var(--ease), width var(--dur-slow) var(--ease), height var(--dur-slow) var(--ease), opacity var(--dur-slow) var(--ease)'
        el.style.transform = `translate(${to.left}px, ${to.top}px)`
        el.style.width = `${to.width}px`
        el.style.height = `${to.height}px`
        el.style.opacity = '0.35'
      }),
    )
    const id = setTimeout(onDone, 420)
    return () => clearTimeout(id)
  }, [ghost, onDone])
  if (!ghost) return null
  return (
    <div
      ref={ref}
      aria-hidden
      className="fixed top-0 left-0 bg-card border border-accent rounded-[var(--r-tile)] pointer-events-none"
      style={{ zIndex: 'var(--z-drawer)', boxShadow: 'var(--elev-2)' }}
    />
  )
}

/* ── Metadata drawer ─────────────────────────────────────────────── */
function MetaDrawer({ t, lang, file, onClose }) {
  const [verifyState, setVerifyState] = useState('idle') // idle | running | ok | fail | unavailable
  const [copied, setCopied] = useState(false)
  const [jolt, setJolt] = useState(false)
  const Icon = iconFor(file)
  const canVerify = !file.vault && file.type !== 'Folder' && Boolean(file.sha256)

  useEffect(() => {
    setVerifyState(canVerify ? 'idle' : 'unavailable')
    setCopied(false)
  }, [file.id, canVerify])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ⚠️ ต้องรอผล re-hash จากเซิร์ฟเวอร์ก่อนเปลี่ยนเป็น verified/mismatch เสมอ
  //    ห้ามอนุมานจาก file.verified เพราะค่านั้นเป็นเพียงผลตรวจตอนอัปโหลดครั้งแรก
  const verify = async () => {
    if (!canVerify || verifyState === 'running') return
    setVerifyState('running')
    const res = await apiFetch(`/api/files/${encodeURIComponent(file.id)}/verify`, { method: 'POST' })
    if (!res.ok) {
      setVerifyState('unavailable')
      return
    }
    if (res.data?.match) {
      setVerifyState('ok')
    } else {
      setVerifyState('fail')
      setJolt(true)
      setTimeout(() => setJolt(false), 300)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.sha256)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard unavailable — non-fatal */ }
  }

  const hashBg = verifyState === 'ok' ? 'var(--ok-soft)' : verifyState === 'fail' ? 'var(--danger-soft)' : 'var(--card-sunken)'

  return (
    <>
      <div
        className="fixed inset-0 fade-in"
        style={{ background: 'color-mix(in srgb, var(--ink) 18%, transparent)', zIndex: 'var(--z-scrim)' }}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={t('fileDetails')}
        className={`fixed top-0 right-0 bottom-0 w-[400px] max-sm:w-full bg-card border-l border-line overflow-y-auto ${jolt ? 'shake-x' : ''}`}
        style={{ zIndex: 'var(--z-drawer)', boxShadow: 'var(--elev-2)', animation: 'drawer-in var(--dur-slow) var(--ease) both' }}
      >
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-[16px] font-semibold text-ink">{t('fileDetails')}</h2>
            <IconBtn label={t('close')} onClick={onClose}>
              <XIcon size={16} strokeWidth={1.5} />
            </IconBtn>
          </div>

          {/* preview */}
          <div className={`mt-4 h-40 rounded-[var(--r-tile)] border border-line flex items-center justify-center ${file.vault ? 'hatch hatch-ink3 bg-sunken' : 'bg-sunken'}`}>
            <Icon size={44} strokeWidth={1.2} className="text-ink-3" />
          </div>
          <div className="flex items-center gap-2 mt-3">
            <StorageBadge vault={file.vault} t={t} />
            <p className="text-[14px] font-semibold text-ink break-all leading-snug">{file.name}</p>
          </div>
          {file.vault && (
            <p className="font-mono text-[11px] text-ink-3 mt-1">{t('vaultCipherCaption')}</p>
          )}

          {/* definition list */}
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[13px]">
            {[
              [t('size'), fmtBytes(file.size)],
              [t('type'), file.type],
              [t('uploader'), file.uploader],
              [t('uploadedAt'), fmtDateTime(file.modified, lang)],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3 font-medium whitespace-nowrap">{k}</dt>
                <dd className="text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-ink-3 font-medium">{t('storagePath')}</dt>
              <dd className="text-ink-2 font-mono text-[11.5px] text-right break-all">{file.path}</dd>
            </div>
            <div className="contents">
              <dt className="text-ink-3 font-medium">{t('integrity')}</dt>
              <dd className="text-right">
                <Chip tone={verifyState === 'fail' ? 'danger' : verifyState === 'ok' ? 'ok' : 'neutral'}>
                  {verifyState === 'fail' ? t('integrityFail') : verifyState === 'ok' ? t('integrityOk') : t('integrityPending')}
                </Chip>
              </dd>
            </div>
          </dl>

          {/* SHA-256 — the hero element */}
          <p className="mt-6 text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em]">SHA-256</p>
          <div className="mt-2 rounded-[var(--r-tile)] border border-line p-3.5 transition-colors duration-[var(--dur-base)] relative" style={{ background: hashBg }}>
            <ScrambleHash
              hash={file.sha256}
              playing={verifyState === 'running'}
              duration={900}
              groupClass="text-ink-2"
            />
            <button
              type="button"
              onClick={copy}
              aria-label={t('copyHash')}
              title={copied ? t('copied') : t('copyHash')}
              className="absolute top-2 right-2 size-7 flex items-center justify-center rounded-full bg-card border border-line text-ink-3 hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer"
            >
              {copied ? <Check size={13} strokeWidth={2} style={{ color: 'var(--ok)' }} /> : <Copy size={13} strokeWidth={1.5} />}
            </button>
          </div>
          {verifyState === 'ok' && (
            <p role="status" className="mt-2 text-[12px] font-semibold" style={{ color: 'var(--ok)' }}>{t('integrityVerified')}</p>
          )}
          {verifyState === 'fail' && (
            <p role="alert" className="mt-2 text-[12px] font-semibold" style={{ color: 'var(--danger)' }}>{t('integrityMismatch')}</p>
          )}
          {verifyState === 'unavailable' && (
            <p role="status" className="mt-2 text-[12px] text-ink-3 leading-relaxed">
              {file.vault ? t('verifyUnavailableVault') : t('verifyUnavailable')}
            </p>
          )}

          <Btn variant="dark" className="w-full mt-4" onClick={verify} disabled={!canVerify || verifyState === 'running'}>
            <ShieldCheck size={15} strokeWidth={1.5} />
            {verifyState === 'running' ? t('verifying') : t('verifyChecksum')}
          </Btn>
        </div>
      </aside>
    </>
  )
}

/* ── Grid tile ───────────────────────────────────────────────────── */
export function FileTile({ t, file, now, selected, anySelected, onSelect, onOpen, onMenuAction, tileRef, onDragStartItem, onDragEndItem, onDropItems, dragActive }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef(null)
  const media = useMediaPointer()
  const hover = media.hoverStyle
  const [dropTarget, setDropTarget] = useState(false)
  const isFolder = file.kind === 'folder'
  // เปิดโฟลเดอร์ขณะที่มีของลอยอยู่เหนือมัน — ไอคอนที่เปลี่ยนคือคำตอบว่า "วางตรงนี้ได้"
  const Icon = isFolder && dropTarget ? FolderOpen : iconFor(file)
  // ── thumbnail = derivative ฝั่งเซิร์ฟเวอร์ (Tranche B) ─────────────────────
  // ⚠️ กริดไม่แตะต้นฉบับอีกต่อไป: poster/motion มาจาก media-info (URL ทึบ) ผ่าน MediaThumb — การเคลื่อนไหวเฉพาะ
  //    ตอนชี้ (Round 9), poster นิ่งตอน idle (Round 10) และ reduced-motion ปิดการเล่นอัตโนมัติ อยู่ใน state machine
  //    ของไทล์ (lib/mediaTile.js) ไม่ใช่ที่นี่; ต้นฉบับ (/preview) ใช้เฉพาะ FilePreviewModal เมื่อผู้ใช้กด Preview
  // จอสัมผัสไม่มี hover: ปุ่มเลือก/เมนูต้องมองเห็นได้ตั้งแต่แรก
  return (
    <FileCardShell
      ref={tileRef}
      kind="file"
      layout="grid"
      selected={selected}
      menuOpen={menuOpen}
      hovered={hover}
      dropTarget={dropTarget}
      data-file-kind={isFolder ? 'folder' : 'file'}
      data-file-id={file.id}
      data-tile-variant="file-card"
      data-drop-target={dropTarget ? 'yes' : undefined}
      data-media-hold={media.holding ? 'yes' : undefined}
      draggable
      onDragStart={(event) => { if (media.blockDrag(event)) return; onDragStartItem?.(event, file) }}
      onDragEnd={() => { setDropTarget(false); onDragEndItem?.() }}
      onDragOver={(event) => {
        // ⚠️ เฉพาะการลากรายการภายในเท่านั้น การลากไฟล์จากเครื่องต้องไหลขึ้นไปให้หน้า
        //    จัดการเป็นการอัปโหลดตามเดิม ห้ามดักไว้ที่นี่
        if (!isFolder || !dragActive || isExternalFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        if (!isFolder || isExternalFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDropTarget(false)
        onDropItems?.(readDragPayload(event.dataTransfer), file)
      }}
      {...media.props}
      onClick={() => { if (media.consumeClick()) return; onOpen(file) }}
      className="cursor-pointer"
      style={{ WebkitTouchCallout: 'none' }}
    >
      {/* ── media frame: MediaThumb (z-0) + ปุ่มเลือก/เมนู (z-20) วางสัมพัทธ์กับกรอบสื่อ ห่างขอบ 8px ──
          ⚠️ ปุ่มอยู่ "นอก" กล่อง overflow-hidden ของ MediaThumb และมีชั้นซ้อนชัดเจน — poster/video ทับปุ่มไม่ได้
          (Production: กรอบสื่อเคยวาดทับ/ตัดปุ่ม) */}
      <div data-media-frame="" className="relative">
      <MediaThumb
        t={t}
        file={file}
        Icon={Icon}
        hover={media.hover}
        iconProps={{ size: isFolder ? 34 : 30, strokeWidth: 1.2, className: isFolder ? 'text-accent' : 'text-ink-3', ...(isFolder ? { fill: 'var(--accent-soft)' } : {}) }}
        className={`relative z-0 h-24 rounded-[9px] ${file.vault ? 'hatch hatch-ink3 bg-sunken' : 'bg-sunken'}`}
      />
      {/* selection checkbox */}
      <FileCardCheckbox
        selected={selected}
        label={`${t('selected')}: ${file.name}`}
        onClick={(e) => { e.stopPropagation(); onSelect(file.id) }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-2 left-2 z-20"
      />

      {/* overflow */}
      <FileCardMenuButton
        ref={menuBtnRef}
        label={t('moreActions')}
        menuOpen={menuOpen}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-2 right-2 z-20"
      />
      </div>
      {/* ⚠️ เมนูถูก portal ออกไปนอกไทล์ — ไทล์ยกตัวด้วย transform ตอน hover ซึ่ง
          สร้าง stacking context ทำให้ไทล์ถัดไปทับเมนูของไทล์ก่อนหน้าได้ และเมนู
          ที่ชิดขอบขวายังล้นออกนอกจอบนหน้าจอแคบ AnchoredMenu แก้ทั้งสองอย่าง */}
      <AnchoredMenu
        open={menuOpen}
        anchorRef={menuBtnRef}
        onClose={() => setMenuOpen(false)}
        label={t('moreActions')}
      >
        <FileMenu t={t} file={file} onClose={() => setMenuOpen(false)} onAction={(a) => onMenuAction(a, file)} />
      </AnchoredMenu>

      {/* ⚠️ hatch/Shield แปลว่า "ระบบมองไม่เห็นเนื้อใน" (DESIGN.md ข้อ 1) โฟลเดอร์ไม่ใช่แบบนั้น จึงต้องไม่ยืมภาษาภาพนั้น
          ⚠️ ภาพ/วิดีโอปกติแสดง "เนื้อใน" จาก derivative ของเซิร์ฟเวอร์ (เจ้าของเท่านั้น, allowlist ฝั่งเซิร์ฟเวอร์, ไม่ดึงต้นฉบับ
          เข้ากริด) — Vault ยังเป็น hatch เสมอเพราะเซิร์ฟเวอร์ไม่มี plaintext ให้ (กรอบสื่ออยู่ด้านบนในบล็อก media frame) */}

      <div className="mt-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-ink truncate" title={file.name}>{file.name}</p>
          <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtBytes(file.size)} · {fmtRelative(t, file.modified, now)}
          </p>
        </div>
            <StorageBadge vault={file.vault} t={t} />
      </div>
    </FileCardShell>
  )
}

/* ── Compact folder tile ─────────────────────────────────────────── */
// ⚠️ โฟลเดอร์ต้อง "ต่างทางกายภาพ" จากการ์ดไฟล์ ไม่ใช่แค่ไอคอนคนละสี: ไม่มีกล่อง
//    thumbnail (โฟลเดอร์ไม่มีเนื้อในให้ดู) ความสูงกะทัดรัด ไอคอน + ชื่ออยู่แถวเดียว
//    แต่พฤติกรรมทุกอย่างของไทล์ยังอยู่ครบ — เลือกได้ ลากได้ เป็นเป้าวางได้ มีเมนู เปิดได้
export function FolderTile({ t, file, selected, anySelected, onSelect, onOpen, onMenuAction, tileRef, onDragStartItem, onDragEndItem, onDropItems, dragActive }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef(null)
  const [hover, setHover] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  const Icon = dropTarget ? FolderOpen : Folder
  return (
    <FileCardShell
      ref={tileRef}
      kind="folder"
      layout="grid"
      selected={selected}
      menuOpen={menuOpen}
      hovered={hover}
      dropTarget={dropTarget}
      data-file-kind="folder"
      data-file-id={file.id}
      data-tile-variant="folder-compact"
      data-drop-target={dropTarget ? 'yes' : undefined}
      draggable
      onDragStart={(event) => onDragStartItem?.(event, file)}
      onDragEnd={() => { setDropTarget(false); onDragEndItem?.() }}
      onDragOver={(event) => {
        if (!dragActive || isExternalFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        if (isExternalFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        setDropTarget(false)
        onDropItems?.(readDragPayload(event.dataTransfer), file)
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(file)}
      title={t('openFolder')}
      className="cursor-pointer"
    >
      <Icon size={20} strokeWidth={1.4} className="shrink-0 text-accent" fill="var(--accent-soft)" />
      <p className="min-w-0 flex-1 text-[13.5px] font-medium text-ink truncate" title={file.name}>{file.name}</p>

      {/* selection checkbox + overflow — ชิดขวา แทนที่จะลอยอยู่มุมบนเหมือนการ์ด */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        <FileCardCheckbox
          selected={selected}
          label={`${t('selected')}: ${file.name}`}
          onClick={(e) => { e.stopPropagation(); onSelect(file.id) }}
        />
        <FileCardMenuButton
          ref={menuBtnRef}
          label={t('moreActions')}
          menuOpen={menuOpen}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
        />
      </div>
      <AnchoredMenu open={menuOpen} anchorRef={menuBtnRef} onClose={() => setMenuOpen(false)} label={t('moreActions')}>
        <FileMenu t={t} file={file} onClose={() => setMenuOpen(false)} onAction={(a) => onMenuAction(a, file)} />
      </AnchoredMenu>
    </FileCardShell>
  )
}

/* ── Folder-first sections (grid + list) ─────────────────────────── */
// กฎเดียวกันทุกระดับของลำดับชั้น: โฟลเดอร์เป็นส่วนของตัวเองอยู่บน ไฟล์อยู่ล่าง
// ส่วนที่ว่างถูกซ่อน (ผู้เรียกจัดการ Empty State เมื่อทั้งสองว่าง) ดู lib/filesView.js
/* ── Marquee selection (Round 9) ─────────────────────────────────── */
// ⚠️ ลากกรอบเลือกเริ่มได้จาก "พื้นที่ว่าง" ของกริดเท่านั้น — กดบนการ์ด/ไทล์/ปุ่ม/เมนู/ช่องกรอก
//    ต้องไม่เริ่ม เพราะพวกนั้นมีความหมายของตัวเอง (ลากรายการ = ย้าย, ปุ่ม = คำสั่ง)
//    มี threshold เล็ก ๆ ก่อนถือว่าเป็นการลาก คลิกเฉย ๆ บนพื้นที่ว่างจึงไม่ล้างการเลือก
//    listener ทั้งหมดอยู่บน window "เฉพาะระหว่างลาก" และถูกถอดเมื่อจบ/ยกเลิก/unmount
const MARQUEE_THRESHOLD_PX = 4
const MARQUEE_IGNORE = '[data-file-kind], button, input, select, textarea, a, label, [role="menu"], [role="dialog"], [data-marquee-ignore]'
const rectsIntersect = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const sameSet = (a, b) => a.size === b.size && [...a].every((id) => b.has(id))

function useMarqueeSelection({ enabled, canvasRef, tileEls, selectedIds, onSelectionChange }) {
  const [tracking, setTracking] = useState(false)   // ระหว่างกด-ลาก-ปล่อย
  const [box, setBox] = useState(null)              // กรอบที่วาด (พิกัดสัมพัทธ์กับ canvas) หลังผ่าน threshold
  const drag = useRef(null)
  const latest = useRef({ selectedIds, onSelectionChange })
  latest.current = { selectedIds, onSelectionChange }

  const onPointerDown = (event) => {
    if (!enabled || event.button !== 0 || event.pointerType === 'touch') return
    if (event.target?.closest?.(MARQUEE_IGNORE)) return
    drag.current = {
      originX: event.clientX, originY: event.clientY,
      additive: event.ctrlKey || event.metaKey,
      snapshot: new Set(latest.current.selectedIds ?? []),
      active: false,
    }
    setTracking(true)
  }

  useEffect(() => {
    if (!tracking) return undefined
    const finish = (cancelled) => {
      const d = drag.current
      drag.current = null
      if (cancelled && d?.active) latest.current.onSelectionChange?.(new Set(d.snapshot))
      setBox(null)
      setTracking(false)
    }
    const onMove = (event) => {
      const d = drag.current
      if (!d) return
      const dx = event.clientX - d.originX
      const dy = event.clientY - d.originY
      if (!d.active && Math.abs(dx) < MARQUEE_THRESHOLD_PX && Math.abs(dy) < MARQUEE_THRESHOLD_PX) return
      d.active = true
      const area = {
        left: Math.min(d.originX, event.clientX), top: Math.min(d.originY, event.clientY),
        right: Math.max(d.originX, event.clientX), bottom: Math.max(d.originY, event.clientY),
      }
      const canvas = canvasRef.current?.getBoundingClientRect?.() ?? { left: 0, top: 0 }
      setBox({ left: area.left - canvas.left, top: area.top - canvas.top, width: area.right - area.left, height: area.bottom - area.top })
      const hits = new Set(d.additive ? d.snapshot : [])
      for (const [id, el] of tileEls.current) {
        if (el && rectsIntersect(el.getBoundingClientRect(), area)) hits.add(id)
      }
      if (!sameSet(hits, latest.current.selectedIds ?? new Set())) latest.current.onSelectionChange?.(hits)
    }
    const onUp = () => finish(false)
    const onCancel = () => finish(true)
    const onKey = (event) => { if (event.key === 'Escape') finish(true) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [tracking, canvasRef, tileEls])

  return { onPointerDown, tracking, box }
}

function SectionHeading({ children }) {
  // หัวข้อส่วนไม่ใช่พื้นที่ว่างของกริด — ลากจากป้าย "Folders"/"Files" ต้องไม่เริ่มกรอบเลือก
  return (
    <h2 data-marquee-ignore="" className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-3 mb-2.5 select-none">{children}</h2>
  )
}

/* ── List row ────────────────────────────────────────────────────── */
// ⚠️ จุดสามจุดในมุมมองรายการต้องเป็น "เมนูเดียวกัน" กับในกริด (FileMenu ผ่าน AnchoredMenu)
//    ไม่ใช่ทางลัดไปแผงเมทาดาทา — ไม่งั้น Preview/Download/Rename/... จะมีในมุมมองหนึ่ง
//    แต่หายไปในอีกมุมมองหนึ่ง นโยบายคำสั่งมีที่เดียวคือ FileMenu แถวนี้แค่เรียกใช้
//    (แยกเป็นคอมโพเนนต์เพราะต้องถือ state ของเมนู — hook วางใน map() ไม่ได้)
function FileListRow({ t, file, now, index, dragActive, onOpen, onMenuAction, onDragStartItem, onDragEndItem, onDropItems }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef(null)
  const Icon = iconFor(file)
  const isFolder = file.kind === 'folder'
  return (
    <tr
      data-file-kind={isFolder ? 'folder' : 'file'}
      draggable
      onDragStart={(event) => onDragStartItem(event, file)}
      onDragEnd={() => onDragEndItem?.()}
      onDragOver={(event) => {
        if (!isFolder || !dragActive || isExternalFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!isFolder || isExternalFileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        onDropItems(readDragPayload(event.dataTransfer), file)
      }}
      onClick={() => onOpen(file)}
      className="border-b border-line last:border-b-0 hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer rise-in"
      style={{ height: 'var(--row-h)', animationDelay: `${Math.min(index * 25, 300)}ms` }}
    >
      <td className="px-4 pl-5">
        <span className="flex items-center gap-2.5 min-w-0">
          {/* ไอคอนเดียวกับในกริด — โฟลเดอร์ต้องดูออกในทั้งสองมุมมอง */}
          <Icon
            size={16}
            strokeWidth={1.5}
            className={`shrink-0 ${isFolder ? 'text-accent' : 'text-ink-3'}`}
            {...(isFolder ? { fill: 'var(--accent-soft)' } : {})}
          />
          <span className="text-[13.5px] font-medium text-ink truncate max-w-[360px]">{file.name}</span>
        </span>
      </td>
      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(file.size)}</td>
      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{file.type}</td>
      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{fmtRelative(t, file.modified, now)}</td>
      <td className="px-4"><StorageBadge vault={file.vault} t={t} /></td>
      <td className="px-4 text-right">
        <button
          ref={menuBtnRef}
          type="button"
          aria-label={t('moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
          className="inline-flex size-7 items-center justify-center rounded-full border border-line bg-card text-ink-3 hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer"
        >
          <MoreHorizontal size={15} strokeWidth={1.5} />
        </button>
        <AnchoredMenu open={menuOpen} anchorRef={menuBtnRef} onClose={() => setMenuOpen(false)} label={t('moreActions')}>
          <FileMenu t={t} file={file} onClose={() => setMenuOpen(false)} onAction={(a) => onMenuAction(a, file)} />
        </AnchoredMenu>
      </td>
    </tr>
  )
}

export function FilesSections({
  t, view, folders, files, now, selectedIds, draggingIds,
  onSelect, onOpen, onMenuAction, onDragStartItem, onDragEndItem, onDropItems, tileRef, onSelectionChange,
}) {
  const dragActive = draggingIds.length > 0
  // หนึ่ง scheduler + หนึ่ง media-info client ต่อหน้า Files (Tranche B) — ทิ้งตอน unmount
  const mediaRuntime = useOwnedMediaRuntime()
  // ทะเบียน element ของไทล์ (ต่อ id) สำหรับ hit-test ของ marquee — ส่งต่อให้ tileRef ของหน้าด้วย
  const tileEls = useRef(new Map())
  const canvasRef = useRef(null)
  const registerTile = (id) => (el) => {
    if (el) tileEls.current.set(id, el)
    else tileEls.current.delete(id)
    tileRef?.(id)?.(el)
  }
  const marquee = useMarqueeSelection({
    enabled: view === 'grid' && typeof onSelectionChange === 'function',
    canvasRef, tileEls, selectedIds, onSelectionChange,
  })
  if (view !== 'grid') {
    const groupRow = (key, label) => (
      <tr key={`section-${key}`} data-files-section-row={key} className="bg-sunken/60">
        <td colSpan={6} className="px-4 pl-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</td>
      </tr>
    )
    const row = (file, i) => (
      <FileListRow
        key={file.id}
        t={t}
        file={file}
        now={now}
        index={i}
        dragActive={dragActive}
        onOpen={onOpen}
        onMenuAction={onMenuAction}
        onDragStartItem={onDragStartItem}
        onDragEndItem={onDragEndItem}
        onDropItems={onDropItems}
      />
    )
    return (
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                <Th className="pl-5">{t('colName')}</Th>
                <Th>{t('colSize')}</Th>
                <Th>{t('colType')}</Th>
                <Th>{t('colModified')}</Th>
                <Th>{t('colEncryption')}</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {folders.length > 0 && groupRow('folders', t('sectionFolders'))}
              {folders.map(row)}
              {files.length > 0 && groupRow('files', t('sectionFiles'))}
              {files.map((file, i) => row(file, folders.length + i))}
            </tbody>
          </table>
        </div>
      </Card>
    )
  }

  const common = (file) => ({
    t, file, now,
    selected: selectedIds.has(file.id),
    anySelected: selectedIds.size > 0,
    onSelect, onOpen, onMenuAction, onDragStartItem, onDragEndItem, onDropItems, dragActive,
    tileRef: registerTile(file.id),
  })
  return (
    <MediaProvider scheduler={mediaRuntime.scheduler} client={mediaRuntime.client}>
    <div
      ref={canvasRef}
      data-marquee-canvas=""
      onPointerDown={marquee.onPointerDown}
      className="relative flex flex-col gap-6 min-h-[50vh]"
      style={{ userSelect: marquee.tracking ? 'none' : undefined }}
    >
      {marquee.box && (
        <div
          data-marquee-rect=""
          aria-hidden="true"
          className="pointer-events-none absolute z-10 rounded-[4px] border border-accent"
          style={{
            left: `${marquee.box.left}px`, top: `${marquee.box.top}px`,
            width: `${marquee.box.width}px`, height: `${marquee.box.height}px`,
            background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
          }}
        />
      )}
      {folders.length > 0 && (
        <section data-files-section="folders" aria-label={t('sectionFolders')}>
          <SectionHeading>{t('sectionFolders')}</SectionHeading>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {folders.map((file, i) => (
              <div key={file.id} className="rise-in" style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}>
                <FolderTile {...common(file)} />
              </div>
            ))}
          </div>
        </section>
      )}
      {files.length > 0 && (
        <section data-files-section="files" aria-label={t('sectionFiles')}>
          <SectionHeading>{t('sectionFiles')}</SectionHeading>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
            {files.map((file, i) => (
              <div key={file.id} className="rise-in" style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}>
                <FileTile {...common(file)} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
    </MediaProvider>
  )
}

/* ── Preview dialog (normal files only) ──────────────────────────── */
// ⚠️ นี่คือคำสั่ง "ดู" ไม่ใช่ "ดาวน์โหลด": ภาพ/วิดีโอถูกดึงจากเส้นทาง preview ที่เจ้าของ
//    เท่านั้นเข้าถึงได้ วิดีโอเล่นแบบสตรีม (Range) ไม่ดึงทั้งไฟล์ลง RAM ของแท็บ
//    สถานะโหลด/ล้มเหลวพูดความจริง — ไม่มีกล่องว่างเปล่าที่ผู้ใช้ต้องเดาว่าเกิดอะไรขึ้น
export function FilePreviewModal({ t, file, onClose, onDownload }) {
  const [phase, setPhase] = useState('loading') // loading | ready | failed
  // ⚠️ Files.jsx วาง modal นี้ไว้ถาวรและสลับแค่ prop `file` — instance เดิมถูกใช้ซ้ำ
  //    ข้ามไฟล์ ถ้าไม่รีเซ็ต phase ตามตัวตนของไฟล์ สถานะ failed/ready ของไฟล์ก่อนหน้าจะ
  //    ติดมากับไฟล์ถัดไป (B โหลดไม่ได้เพราะ A เคยล้ม) รีเซ็ตระหว่าง render เมื่อตัวตน
  //    เปลี่ยน (แบบแผน "adjust state on prop change" ของ React) — ไม่มีเฟรมที่โกหก
  const identity = previewIdentityOf(file)
  const [seenIdentity, setSeenIdentity] = useState(identity)
  if (identity !== seenIdentity) {
    setSeenIdentity(identity)
    setPhase('loading')
  }
  const kind = file ? previewKindFor(file) : null
  const src = file ? apiUrl(previewPathFor(file)) : ''
  return (
    <Modal open={Boolean(file)} onClose={onClose} width={880} labelledBy="file-preview-title">
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="file-preview-title" className="text-[16px] font-semibold text-ink pr-8 truncate">{file?.name}</h2>
      <p className="text-[12px] text-ink-3 mt-1" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {file?.type} · {fmtBytes(file?.size ?? 0)}
      </p>
      <div
        className="mt-4 rounded-[var(--r-tile)] bg-sunken border border-line flex items-center justify-center overflow-hidden relative"
        style={{ minHeight: 220 }}
        data-file-preview-kind={kind ?? ''}
        data-file-preview-phase={phase}
      >
        {phase === 'loading' && (
          <p role="status" className="absolute text-[13px] text-ink-3">{t('previewLoading')}</p>
        )}
        {phase === 'failed' ? (
          <p role="alert" className="text-[13px] font-medium px-6 py-10 text-center max-w-md" style={{ color: 'var(--danger)' }}>
            {t('previewUnavailable')}
          </p>
        ) : kind === 'video' ? (
          <video
            controls
            preload="metadata"
            playsInline
            src={src}
            onLoadedMetadata={() => setPhase('ready')}
            onError={() => setPhase('failed')}
            className="max-w-full"
            style={{ maxHeight: '68vh', opacity: phase === 'ready' ? 1 : 0 }}
          />
        ) : kind === 'image' ? (
          <img
            src={src}
            alt={file?.name ?? ''}
            decoding="async"
            onLoad={() => setPhase('ready')}
            onError={() => setPhase('failed')}
            className="max-w-full object-contain"
            style={{ maxHeight: '68vh', opacity: phase === 'ready' ? 1 : 0 }}
          />
        ) : null}
      </div>
      <div className="flex gap-2.5 mt-5 justify-end">
        <Btn variant="outline" onClick={onClose}>{t('close')}</Btn>
        <Btn variant="primary" onClick={() => file && onDownload?.(file)}>
          <Download size={14} strokeWidth={1.5} />
          {t('download')}
        </Btn>
      </div>
    </Modal>
  )
}

/* ── Files screen ────────────────────────────────────────────────── */
// ⚠️ ไม่มี fixture ฝั่ง client — รายการไฟล์มาจาก GET /api/files เท่านั้น
// ทุกการกระทำ (สร้างโฟลเดอร์/ลบ) เป็น request จริง + refetch; ไม่มี alert()/prompt()
export function Files({ t, lang, go, userId = null, navigationParams = {}, placeholderMode = false }) {
  const reduced = useReducedMotion()
  const now = useNow(30_000)

  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'list'
  const view = viewMode
  const setView = setViewMode


  // ตำแหน่งปัจจุบันคือ id ของโฟลเดอร์จริง ไม่ใช่รายการสตริงที่จอสะสมไว้เอง
  const initialFolderHistoryRef = useRef(undefined)
  if (initialFolderHistoryRef.current === undefined) {
    initialFolderHistoryRef.current = typeof window === 'undefined' ? null : readFolderHistory(window.history.state, 'files')
  }
  const [folderId, setFolderId] = useState(() => {
    return initialFolderHistoryRef.current?.nodeId ?? null
  })
  const historyNavigationRef = useRef(Boolean(initialFolderHistoryRef.current))
  const filesApi = useApi(folderId == null ? '/api/files' : `/api/files?parentId=${encodeURIComponent(folderId)}`)
  const files = placeholderMode ? [] : (filesApi.data?.files ?? [])
  const ancestors = placeholderMode ? [] : (filesApi.data?.ancestors ?? [])
  // ⚠️ การเลือกต้องอ้างถึงของที่ "มีอยู่จริงในชุดข้อมูลที่โหลดล่าสุด" เท่านั้น: ไฟล์ที่ client
  //    อื่นลบไปแล้วหายจาก refetch ครั้งถัดไป แต่ id ของมันเคยค้างอยู่ใน selectedIds → แถบ
  //    คำสั่งนับผี และ Move/Delete แบบกลุ่มยิงไปที่ของที่ไม่มีแล้ว ตัดออกเมื่อชุดข้อมูลจริง
  //    เปลี่ยน (ผูกกับ payload ที่โหลด ไม่ใช่ผลกรอง/เรียง — ซ่อนด้วยการค้นหา ≠ ถูกลบ)
  const loadedFiles = placeholderMode ? null : filesApi.data?.files
  useEffect(() => {
    if (!loadedFiles) return
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const present = new Set(loadedFiles.map((f) => f.id))
      const next = new Set([...prev].filter((id) => present.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [loadedFiles])
  const fetchError = visibleFetchError(filesApi.error, placeholderMode)

  const [sort, setSort] = useState(DEFAULT_SORT)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [uploadOpen, setUploadOpen] = useState(Boolean(navigationParams.uploadOpen))
  const [dragOver, setDragOver] = useState(false)
  const [dropRequest, setDropRequest] = useState({ files: [], id: 0 })
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [detail, setDetail] = useState(null)
  const [ghost, setGhost] = useState(null)
  const [folderModal, setFolderModal] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [askDelete, setAskDelete] = useState(null) // null | { ids: string[], label: string }
  const [mutating, setMutating] = useState(false)
  const [mutateError, setMutateError] = useState(false)
  const [preview, setPreview] = useState(null)              // null | file (ไฟล์ปกติที่ preview ได้)
  const [renameTarget, setRenameTarget] = useState(null)   // null | file
  const [renameValue, setRenameValue] = useState('')
  const [moveTarget, setMoveTarget] = useState(null)       // null | { ids, label }
  const [actionError, setActionError] = useState(null)     // null | i18n key
  const [draggingIds, setDraggingIds] = useState([])
  const tileRefs = useRef({})

  const goToFolder = useCallback((id, { replace = false, fromHistory = false } = {}) => {
    const next = id == null ? null : String(id)
    historyNavigationRef.current = fromHistory
    setFolderId(next)
    setSelectedIds(new Set())
    setDetail(null)
    if (!fromHistory && typeof window !== 'undefined') {
      writeFolderHistory({ history: window.history, location: window.location, scope: 'files', nodeId: next, replace })
    }
  }, [])

  useEffect(() => {
    if (fetchError && folderId !== null && historyNavigationRef.current) {
      goToFolder(null, { replace: true })
      return
    }
    if (filesApi.data) historyNavigationRef.current = false
  }, [fetchError, filesApi.data, folderId, goToFolder])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!readFolderHistory(window.history.state, 'files')) {
      writeFolderHistory({ history: window.history, location: window.location, scope: 'files', nodeId: folderId, replace: true })
    }
    const onPopState = (event) => {
      const entry = readFolderHistory(event.state, 'files')
      if (!entry) return
      goToFolder(entry.nodeId, { fromHistory: true })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [folderId, goToFolder])

  useEffect(() => {
    if (navigationParams.uploadOpen) setUploadOpen(true)
  }, [navigationParams.uploadOpen])

  // สร้างลิงก์แชร์ = งานของจอ Shares (ฟอร์มเต็ม: expiry/auth/network scope)
  const handleSecureShare = (file) => go?.('shares', file ? { fileId: file.id } : {})
  const handleUpload = () => setUploadOpen(true)

  const createFolder = async () => {
    const name = folderName.trim()
    if (!name || mutating) return
    setMutating(true)
    setMutateError(false)
    const res = await apiFetch('/api/files/folder', { method: 'POST', body: { name, parentId: folderId } })
    setMutating(false)
    if (!res.ok) { setMutateError(true); return }
    setFolderModal(false)
    setFolderName('')
    filesApi.retry()
  }

  /* ── Rename / Move — ทั้งการลากวางและกล่องโต้ตอบเรียกเส้นทางเดียวกันนี้ ────
     ⚠️ ต้องมีจุดเรียก Move จุดเดียวในไฟล์นี้ ถ้าแยกเป็นสองเส้นทางเมื่อไร วันหนึ่ง
        กติกาจะเพี้ยนจากกัน แล้วการลากจะทำสิ่งที่กล่องโต้ตอบไม่ยอมทำ */

  const errorKeyFor = (res) => (
    res.data?.code === 'NAME_TAKEN' ? 'nameTaken'
      : res.data?.code === 'NAME_INVALID' ? 'nameInvalid'
        : res.data?.code === 'MOVE_CYCLE' ? 'moveCycle'
          : res.data?.code === 'ALREADY_THERE' ? 'moveAlreadyThere'
            : res.data?.code === 'FOLDER_NOT_EMPTY' ? 'folderNotEmpty'
              : 'actionFailed'
  )

  const submitRename = async () => {
    const name = renameValue.trim()
    if (!renameTarget || !name || mutating) return
    setMutating(true)
    setActionError(null)
    const res = await apiFetch(`/api/files/${encodeURIComponent(renameTarget.id)}`, {
      method: 'PATCH',
      body: { name },
    })
    setMutating(false)
    if (!res.ok) { setActionError(errorKeyFor(res)); return }
    setRenameTarget(null)
    setDetail((current) => (current && current.id === renameTarget.id ? { ...current, name } : current))
    filesApi.retry()
  }

  /** จุดเรียก Move จุดเดียวของทั้งหน้า */
  const moveItems = async (ids, parentId) => {
    if (ids.length === 0 || mutating) return false
    setMutating(true)
    setActionError(null)
    setDropError(false)
    const res = await apiFetch('/api/files/move', { method: 'POST', body: { ids, parentId } })
    setMutating(false)
    if (!res.ok) { setActionError(errorKeyFor(res)); return false }
    setMoveTarget(null)
    setSelectedIds(new Set())
    filesApi.retry()
    return true
  }

  /* ── การลากภายใน ────────────────────────────────────────────────────────
     ⚠️ ลากรายการที่อยู่ในชุดที่เลือก = ลากทั้งชุด; ลากรายการนอกชุด = ลากตัวเดียว
        และต้องไม่ไปแตะชุดที่เลือกไว้ */
  const startItemDrag = (event, file) => {
    const ids = dragPayloadFor(file.id, selectedIds)
    writeDragPayload(event.dataTransfer, ids)
    event.dataTransfer.effectAllowed = 'move'
    setDraggingIds(ids)
  }

  const dropItemsInto = async (ids, folder) => {
    setDraggingIds([])
    if (!canDropOn(folder, ids)) return
    await moveItems(ids, folder.id)
  }

  /* ── วางบน breadcrumb "Files" = ย้ายกลับราก (Round 10) ─────────────────────
     ⚠️ เส้นทางเดียวกับกล่อง Move ("All files") ทุกประการ: moveItems(ids, null) — ไม่มี
        การย้ายแบบที่สอง เป็นเป้าวางเฉพาะ (1) การลากรายการภายใน ไม่ใช่ไฟล์จาก OS และ
        (2) ขณะอยู่ในโฟลเดอร์เท่านั้น — ที่รากการวางลง "Files" คือ ALREADY_THERE ที่ไร้ความหมาย
        สำเร็จแล้วค่อยพาไปที่ราก ล้มเหลวอยู่ที่เดิม (actionError ตามความหมายเดิม) */
  const [rootDropTarget, setRootDropTarget] = useState(false)
  // ⚠️ actionError ถูกวาดเฉพาะในกล่อง Rename/Move — การวางบน breadcrumb ไม่เปิดกล่องใด
  //    ถ้าเซิร์ฟเวอร์ปฏิเสธ (409 ชื่อซ้ำ ฯลฯ) ผู้ใช้ต้องเห็นเหตุผลตรงที่เขาวาง ไม่ใช่เงียบ
  //    dropError = "โชว์ actionError ล่าสุดใต้ breadcrumb" และหายเมื่อการย้ายครั้งถัดไปเริ่ม
  const [dropError, setDropError] = useState(false)
  const rootDropEligible = folderId != null && draggingIds.length > 0
  const rootDragOver = (event) => {
    if (!rootDropEligible || isExternalFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setRootDropTarget(true)
  }
  const rootDrop = async (event) => {
    if (!rootDropEligible || isExternalFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setRootDropTarget(false)
    const ids = readDragPayload(event.dataTransfer)
    setDraggingIds([])
    if (ids.length === 0) return
    setDropError(false)
    const ok = await moveItems(ids, null)
    if (ok) goToFolder(null)
    else setDropError(true)
  }

  /** เปิดโฟลเดอร์ = เปลี่ยนตำแหน่งจริง; ไฟล์ = เปิดแผงรายละเอียดเหมือนเดิม */
  const openItem = (file) => {
    if (file.kind === 'folder') {
      goToFolder(file.id)
      return
    }
    openDetail(file)
  }

  const confirmDelete = async () => {
    if (!askDelete || mutating) return
    setMutating(true)
    setMutateError(false)
    for (const id of askDelete.ids) {
      await apiFetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
    }
    setMutating(false)
    setAskDelete(null)
    setSelectedIds(new Set())
    if (detail && askDelete.ids.includes(detail.id)) setDetail(null)
    filesApi.retry()
  }

  const availableTypes = [...new Set(files.map((file) => file.type).filter(Boolean))].sort()
  // ⚠️ กรองก่อน แล้วค่อยแยกเป็นสองส่วน (โฟลเดอร์ / ไฟล์) ที่เรียงแยกกัน — การค้นหาหรือ
  //    การเรียงไม่มีทางทำให้โฟลเดอร์ไปปนกับไฟล์ ดู lib/filesView.js
  const filtered = filterItems(files, { query, typeFilter })
  const sections = sectionItems(filtered, sort)

  const toggleSelect = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const openDetail = (file) => {
    const el = tileRefs.current[file.id]
    if (el && !reduced && view === 'grid') {
      const r = el.getBoundingClientRect()
      setGhost({
        from: { left: r.left, top: r.top, width: r.width, height: r.height },
        to: { left: Math.max(0, window.innerWidth - 400 + 24), top: 24, width: 352, height: 160 },
      })
    }
    setDetail(file)
  }

  /** ดาวน์โหลดไฟล์จริงจาก Storage Layer — ปล่อยให้เบราว์เซอร์ stream เอง
   *  (ไฟล์ 500MB ผ่าน fetch = โหลดเข้า memory ของแท็บทั้งก้อนก่อนถึงจะเซฟได้) */
  const downloadFile = (file) => {
    if (file.type === 'Folder') return
    const a = document.createElement('a')
    a.href = apiUrl(`/api/files/${encodeURIComponent(file.id)}/download`)
    a.download = file.name // เซิร์ฟเวอร์ส่ง Content-Disposition มาด้วยอยู่แล้ว — อันนี้เป็น fallback
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const onMenuAction = (action, file) => {
    if (action === 'rename') {
      setRenameTarget(file)
      setRenameValue(file.name)
      setActionError(null)
    } else if (action === 'move') {
      setMoveTarget({ ids: [file.id], label: file.name })
      setActionError(null)
    } else if (action === 'delete') {
      // ลบต้องยืนยันผ่าน Modal เสมอ — ไม่มี confirm() ของเบราว์เซอร์
      setAskDelete({ ids: [file.id], label: file.name })
    } else if (action === 'download') {
      downloadFile(file)
    } else if (action === 'preview') {
      // "ดู" เป็นคำสั่งของตัวเอง — ไม่ใช่ทางลัดไป Download และไม่แตะการคลิกการ์ดเดิม
      if (previewKindFor(file)) setPreview(file)
    } else if (action === 'meta' || action === 'verify') {
      openDetail(file)
    } else if (action === 'link') {
      handleSecureShare(file)
    } else if (action === 'history') {
      go?.('versions', { fileId: file.id })
    }
  }

  const acceptDrop = (event) => {
    // ⚠️ การลากรายการภายในที่ตกลงบนพื้นที่ว่างของหน้าต้องไม่กลายเป็นการอัปโหลดผี
    //    ของไฟล์ที่มีอยู่แล้ว — หน้ารับเฉพาะไฟล์จากเครื่องผู้ใช้จริงเท่านั้น
    if (!isExternalFileDrag(event.dataTransfer)) { setDragOver(false); setDraggingIds([]); return }
    event.preventDefault()
    setDragOver(false)
    const dropped = event.dataTransfer?.files
    if (!dropped?.length) return
    // ⚠️ ลากวางบนหน้านี้ = ผู้ใช้เลือกไฟล์เสร็จแล้ว การเด้งลิ้นชัก "เลือกไฟล์" ขึ้นมา
    //    เพื่อให้มันปิดตัวเองทันทีคือการกะพริบที่ไม่มีประโยชน์ — ส่งเข้าคิวแล้วให้ถาด
    //    สถานะมุมขวาล่างรับช่วงต่อเลย (ดู components/UploadDrawer.jsx)
    setDropRequest({ files: [...dropped], id: Date.now() })
  }

  const deleteSelected = () => {
    if (selectedIds.size === 0) return
    setAskDelete({ ids: [...selectedIds], label: `${selectedIds.size} ${t('selected')}` })
  }

  return (
    <div>
      {/* breadcrumbs — บรรพบุรุษจริงจากเซิร์ฟเวอร์ ไม่ใช่เส้นทางที่จอสะสมเอง
          ⚠️ เดิมเป็นรายการสตริงที่ไม่เคยยาวขึ้น จึงเป็นการตกแต่งที่ไม่ได้บอกตำแหน่งจริง */}
      <nav aria-label={t('breadcrumb')} className="flex items-center gap-1.5 text-[13px] text-ink-3 font-semibold mb-4 select-none flex-wrap">
        <button
          type="button"
          onClick={() => goToFolder(null)}
          onDragOver={rootDragOver}
          onDragEnter={rootDragOver}
          onDragLeave={() => setRootDropTarget(false)}
          onDrop={rootDrop}
          data-drop-target={rootDropTarget ? 'yes' : undefined}
          data-root-drop={rootDropEligible ? 'eligible' : undefined}
          className={`${folderId == null ? 'text-ink cursor-default' : 'hover:text-ink cursor-pointer'} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-[4px] px-1.5 -mx-1.5 transition-[background-color,color,box-shadow] duration-[var(--dur-fast)]`}
          style={rootDropTarget ? { color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', boxShadow: '0 0 0 1px var(--accent)' } : undefined}
          aria-current={folderId == null ? 'page' : undefined}
        >
          {t('filesTitle')}
        </button>
        {ancestors.map((crumb, idx) => {
          const last = idx === ancestors.length - 1
          return (
            <span key={crumb.id} className="flex items-center gap-1.5">
              <ChevronRight size={13} aria-hidden className="text-ink-3/70" />
              <button
                type="button"
                onClick={() => !last && goToFolder(crumb.id)}
                className={`${last ? 'text-ink cursor-default' : 'hover:text-ink cursor-pointer'} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-[4px]`}
                aria-current={last ? 'page' : undefined}
              >
                {crumb.name}
              </button>
            </span>
          )
        })}
      </nav>
      {dropError && actionError && (
        /* ข้อความเดียวกับที่กล่อง Move ใช้ (errorKeyFor) — แค่วาดตรงที่ผู้ใช้เพิ่งวางแทนที่จะเงียบ */
        <p role="alert" className="text-[12.5px] font-medium -mt-2 mb-4" style={{ color: 'var(--danger)' }}>
          {t(actionError)}
        </p>
      )}

      {/* toolbar */}
      <div className="flex items-center gap-2.5 mb-5 flex-wrap">
        <label className="relative flex-1 min-w-[220px] max-w-md">
          <span className="sr-only">{t('searchFilesPlaceholder')}</span>
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchFilesPlaceholder')}
            className="w-full h-10 pl-10 pr-4 rounded-full bg-sunken border border-line text-[13.5px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
        </label>
        <div className="w-40 max-md:flex-1">
          <PillSelect aria-label={t('filter')} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="all">{t('allFileTypes')}</option>
            {availableTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </PillSelect>
        </div>
        <div className="inline-flex items-center gap-0.5 bg-card border border-line rounded-full p-0.5">
          {[{ v: 'grid', icon: LayoutGrid, label: t('gridView') }, { v: 'list', icon: List, label: t('listView') }].map(({ v, icon: I, label }) => (
            <button
               key={v}
              type="button"
              aria-label={label}
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`size-8 flex items-center justify-center rounded-full transition-colors duration-[var(--dur-fast)] cursor-pointer ${view === v ? 'bg-ink text-card' : 'text-ink-3 hover:text-ink'}`}
            >
              <I size={15} strokeWidth={1.5} />
            </button>
          ))}
        </div>
        <div className="w-40">
          <PillSelect aria-label={t('sortBy')} value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORT_MODES.map((mode) => (
              <option key={mode} value={mode}>{t(SORT_LABEL_KEYS[mode])}</option>
            ))}
          </PillSelect>
        </div>
        <Btn variant="outline" onClick={() => { setFolderModal(true); setMutateError(false) }}>
          <FolderPlus size={15} strokeWidth={1.5} />
          {t('newFolder')}
        </Btn>
        <Btn variant="primary" onClick={handleUpload}>
          <Upload size={15} strokeWidth={1.5} />
          {t('upload')}
        </Btn>
      </div>

      <div
        onDragEnter={(event) => {
          if (!isExternalFileDrag(event.dataTransfer)) return
          event.preventDefault(); setDragOver(true)
        }}
        onDragOver={(event) => { if (isExternalFileDrag(event.dataTransfer)) event.preventDefault() }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false) }}
        onDrop={acceptDrop}
        className={`relative rounded-[var(--r-card)] transition-[outline-color,background-color] ${dragOver ? 'outline-2 outline-dashed outline-accent bg-[var(--accent-soft)]' : ''}`}
      >
      <p className="sr-only">{t('filesDropHint')}</p>
      {dragOver && (
        <div className="absolute inset-0 z-20 rounded-[var(--r-card)] border-2 border-dashed border-accent bg-[var(--accent-soft)] flex items-center justify-center pointer-events-none">
          <span className="inline-flex items-center gap-2 rounded-full bg-card px-4 py-2 text-[13px] font-semibold text-accent shadow-[var(--elev-1)]"><Upload size={16} aria-hidden />{t('filesDropHint')}</span>
        </div>
      )}
      {/* สี่สถานะของรายการไฟล์ */}
      {filesApi.loading ? (
        <SkeletonLoader type="files" />
      ) : fetchError ? (
        <Card><ErrorState t={t} kind={fetchError} onRetry={filesApi.retry} /></Card>
      ) : placeholderMode ? (
        <Card><DependencyUnavailableState t={t} title={t('filesUnavailable')} /></Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderPlus}
            title={query || typeFilter !== 'all' ? t('emptyNoFilesFiltered') : t('emptyFolder')}
            action={
              !query && typeFilter === 'all' ? <Btn variant="primary" size="sm" onClick={() => { setFolderModal(true); setMutateError(false) }}>
                <FolderPlus size={14} strokeWidth={1.5} />
                {t('createFirstFolder')}
              </Btn> : null
            }
          />
        </Card>
      ) : (
        /* โฟลเดอร์เป็นส่วนของตัวเองเหนือไฟล์เสมอ — ทุกระดับ ทุกมุมมอง (Round 8) */
        <FilesSections
          t={t}
          view={view}
          folders={sections.folders}
          files={sections.files}
          now={now}
          selectedIds={selectedIds}
          draggingIds={draggingIds}
          onSelect={toggleSelect}
          onOpen={openItem}
          onMenuAction={onMenuAction}
          onDragStartItem={startItemDrag}
          onDragEndItem={() => { setDraggingIds([]); setRootDropTarget(false) }}
          onDropItems={dropItemsInto}
          onSelectionChange={setSelectedIds}
          tileRef={(id) => (el) => { tileRefs.current[id] = el }}
        />
      )}
      </div>

      {/* shared semantic selection surface; actions remain Files-specific */}
      {selectedIds.size > 0 && (
        <SelectionActionBar
          label={`${selectedIds.size} ${t('selected')}`}
          clearLabel={t('close')}
          onClear={() => setSelectedIds(new Set())}
          data-testid="files-selection-bar"
        >
          {/* ⚠️ เดิมปุ่มสองตัวนี้ถูกวาดโดยไม่มี onClick เลย — ปุ่มที่กดแล้วไม่เกิดอะไร
              คือปุ่มที่โกหกผู้ใช้ ตอนนี้ทั้งคู่ผูกกับคำสั่งจริง */}
          <SelectionAction
            onClick={() => {
              for (const id of selectedIds) {
                const picked = files.find((f) => f.id === id)
                if (picked && picked.kind !== 'folder') downloadFile(picked)
              }
            }}
          >
            <Download size={14} strokeWidth={1.5} />
            {t('download')}
          </SelectionAction>
          <SelectionAction
            onClick={() => { setMoveTarget({ ids: [...selectedIds], label: `${selectedIds.size} ${t('selected')}` }); setActionError(null) }}
          >
            <FolderInput size={14} strokeWidth={1.5} />
            {t('move')}
          </SelectionAction>
          <SelectionAction
            onClick={deleteSelected}
            danger
          >
            <Trash2 size={14} strokeWidth={1.5} />
            {t('delete')}
          </SelectionAction>
        </SelectionActionBar>
      )}

      <FlipGhost ghost={ghost} onDone={() => setGhost(null)} />
      {detail && <MetaDrawer t={t} lang={lang} file={detail} onClose={() => setDetail(null)} />}
      <FilePreviewModal t={t} file={preview} onClose={() => setPreview(null)} onDownload={(f) => downloadFile(f)} />

      {/* new folder — Modal จริง ไม่ใช่ prompt() ของเบราว์เซอร์ */}
      {/* ── Rename ────────────────────────────────────────────────────────────
          ⚠️ ใช้ Modal/Field/PillInput ของระบบ ไม่ใช่ window.prompt() ซึ่งไม่มีทาง
             แสดงเหตุผลการปฏิเสธจากเซิร์ฟเวอร์ได้เลย */}
      <Modal open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} width={420} labelledBy="rn-title">
        <ModalClose onClose={() => setRenameTarget(null)} label={t('cancel')} />
        <h2 id="rn-title" className="text-[18px] font-semibold text-ink">{t('renameTitle')}</h2>
        <div className="mt-4">
          <Field id="rn-name" label={t('renameLabel')}>
            <PillInput
              id="rn-name"
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setActionError(null) }}
              onKeyDown={(e) => e.key === 'Enter' && submitRename()}
              autoFocus
              disabled={mutating}
            />
          </Field>
        </div>
        {actionError && (
          <p role="alert" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {t(actionError)}
          </p>
        )}
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setRenameTarget(null)}>{t('cancel')}</Btn>
          <Btn
            variant="primary"
            className="flex-1"
            onClick={submitRename}
            disabled={mutating || !renameValue.trim() || renameValue.trim() === renameTarget?.name}
          >
            {t('renameAction')}
          </Btn>
        </div>
      </Modal>

      {/* ── Move ──────────────────────────────────────────────────────────────
          ⚠️ นี่คือเส้นทางหลักของการย้าย ไม่ใช่ทางสำรอง การลากวางเป็นแค่ทางลัด
             ผู้ใช้คีย์บอร์ดและจอสัมผัสต้องทำได้ครบจากที่นี่ */}
      <Modal open={Boolean(moveTarget)} onClose={() => setMoveTarget(null)} width={460} labelledBy="mv-title">
        <ModalClose onClose={() => setMoveTarget(null)} label={t('cancel')} />
        <h2 id="mv-title" className="text-[18px] font-semibold text-ink">{t('moveTitle')}</h2>
        <p className="text-[12.5px] text-ink-3 mt-1 truncate">{moveTarget?.label}</p>

        <div className="mt-4 border border-line rounded-[var(--r-tile)] divide-y divide-line max-h-64 overflow-y-auto">
          {/* ย้ายขึ้นไปยังราก — ต้องมีเสมอเมื่อยังไม่ได้อยู่ที่ราก */}
          {folderId != null && (
            <button
              type="button"
              onClick={() => moveItems(moveTarget.ids, null)}
              disabled={mutating}
              className="w-full flex items-center gap-2.5 px-3.5 h-11 text-[13px] font-medium text-ink hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer disabled:opacity-50"
            >
              <Folder size={15} strokeWidth={1.5} className="text-accent shrink-0" fill="var(--accent-soft)" />
              {t('moveToRoot')}
            </button>
          )}
          {/* ⚠️ ปลายทางที่ไม่ถูกต้องต้องไม่ถูกแสดงตั้งแต่แรก: ตัวมันเอง และรายการที่กำลังย้าย
              (เซิร์ฟเวอร์ยังกันวงจรซ้ำอีกชั้นเสมอ — อันนี้คือความชัดเจนบนจอ ไม่ใช่ด่านความปลอดภัย) */}
          {files.filter((f) => f.kind === 'folder' && !moveTarget?.ids.includes(f.id)).map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => moveItems(moveTarget.ids, folder.id)}
              disabled={mutating}
              className="w-full flex items-center gap-2.5 px-3.5 h-11 text-[13px] font-medium text-ink hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer disabled:opacity-50"
            >
              <Folder size={15} strokeWidth={1.5} className="text-accent shrink-0" fill="var(--accent-soft)" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
          {files.filter((f) => f.kind === 'folder' && !moveTarget?.ids.includes(f.id)).length === 0 && folderId == null && (
            <p className="px-3.5 py-4 text-[12.5px] text-ink-3">{t('moveEmptyFolder')}</p>
          )}
        </div>

        {actionError && (
          <p role="alert" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {t(actionError)}
          </p>
        )}
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setMoveTarget(null)}>{t('cancel')}</Btn>
        </div>
      </Modal>

      <Modal open={folderModal} onClose={() => setFolderModal(false)} width={420} labelledBy="nf-title">
        <ModalClose onClose={() => setFolderModal(false)} label={t('cancel')} />
        <h2 id="nf-title" className="text-[18px] font-semibold text-ink">{t('newFolder')}</h2>
        <div className="mt-5">
          <Field id="nf-name" label={t('colName')}>
            <PillInput
              id="nf-name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFolder()}
              autoFocus
              disabled={mutating}
            />
          </Field>
        </div>
        {mutateError && (
          <p role="alert" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {t('actionFailed')}
          </p>
        )}
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setFolderModal(false)}>{t('cancel')}</Btn>
          <Btn variant="primary" className="flex-1" onClick={createFolder} disabled={mutating || !folderName.trim()}>
            {t('newFolder')}
          </Btn>
        </div>
      </Modal>

      {/* delete confirm — ระบุเป้าหมายชัดเจนก่อนลบเสมอ */}
      <Modal open={!!askDelete} onClose={() => setAskDelete(null)} width={440} labelledBy="del-title">
        <ModalClose onClose={() => setAskDelete(null)} label={t('cancel')} />
        <h2 id="del-title" className="text-[18px] font-semibold text-ink">{t('confirmDeleteTitle')}</h2>
        <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">
          {askDelete && t('confirmDeleteBody', { name: askDelete.label })}
        </p>
        {mutateError && (
          <p role="alert" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
            {t('actionFailed')}
          </p>
        )}
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setAskDelete(null)}>{t('cancel')}</Btn>
          <Btn variant="danger" className="flex-1" onClick={confirmDelete} disabled={mutating}>
            {t('delete')}
          </Btn>
        </div>
      </Modal>

      {/* ⚠️ ห้ามครอบด้วย `{uploadOpen && ...}` — คอมโพเนนต์นี้เป็นเจ้าของคิวอัปโหลด
          การ unmount ตามสถานะการเปิดลิ้นชักจะฆ่างานที่กำลังส่งอยู่จริง */}
      <UploadDrawer
        t={t}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        destination="/Files"
        recentFiles={files.filter((file) => file.type !== 'Folder')}
        recentLoading={filesApi.loading}
        initialFiles={dropRequest.files}
        requestId={dropRequest.id}
        onUploaded={filesApi.retry}
        // บันทึกกู้คืนถูกผูกกับบัญชีนี้เท่านั้น ผู้ใช้คนถัดไปบนเครื่องเดียวกันอ่านไม่ได้
        recoveryScope={userId}
        // อัปโหลดลงโฟลเดอร์ที่ผู้ใช้กำลังเปิดอยู่ เซิร์ฟเวอร์ตรวจสิทธิ์ซ้ำเสมอ
        parentId={folderId}
      />
    </div>
  )
}
