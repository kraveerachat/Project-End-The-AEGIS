import { useEffect, useRef, useState } from 'react'
import {
  LayoutGrid, List, Upload, FolderPlus, MoreHorizontal, Shield, Database, X as XIcon,
  FileText, FileSpreadsheet, FileArchive, FileVideo, FileImage, File as FileIcon,
  Download, PenLine, FolderInput, Link2, ShieldCheck, Trash2, Info, Copy, Check, Search, History,
} from 'lucide-react'
import { Card, Chip, Btn, IconBtn, PillSelect, Th, ScrambleHash, ErrorState, EmptyState, DependencyUnavailableState, SkeletonLoader, Modal, ModalClose, Field, PillInput } from '../components/ui.jsx'
import { useApi, useNow, useReducedMotion } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch, apiUrl } from '../lib/api.js'
import { fmtBytes, fmtRelative, fmtDateTime } from '../lib/format.js'
import { UploadDrawer } from '../components/UploadDrawer.jsx'

const EXT_ICONS = { xlsx: FileSpreadsheet, docx: FileText, pdf: FileText, zip: FileArchive, 'tar.gz': FileArchive, mp4: FileVideo, pptx: FileImage, log: FileIcon }
const iconFor = (f) => EXT_ICONS[f.ext] ?? FileIcon

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
export function FileMenu({ t, onAction, onClose }) {
  const items = [
    { id: 'download', icon: Download, label: t('download') },
    { id: 'rename', icon: PenLine, label: t('rename'), disabled: true },
    { id: 'move', icon: FolderInput, label: t('move'), disabled: true },
    { id: 'link', icon: Link2, label: t('createSecureShare') },
    { id: 'history', icon: History, label: t('viewHistory') },
    { id: 'verify', icon: ShieldCheck, label: t('verifySha') },
    { id: 'meta', icon: Info, label: t('viewMetadata') },
    { id: 'delete', icon: Trash2, label: t('delete'), danger: true },
  ]
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [onClose])
  return (
    <div
      className="absolute right-2 top-10 bg-card border border-line rounded-[var(--r-tile)] py-1.5 min-w-44 fade-in"
      style={{ boxShadow: 'var(--elev-2)', zIndex: 'var(--z-dropdown)' }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map(({ id, icon: Icon, label, danger, disabled }) => (
        <button
          key={id}
          type="button"
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
function FileTile({ t, file, now, selected, anySelected, onSelect, onOpen, onMenuAction, tileRef }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const Icon = iconFor(file)
  const showControls = hover || selected || anySelected || menuOpen
  return (
    <div
      ref={tileRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(file)}
      className="relative bg-card border rounded-[var(--r-tile)] p-3 cursor-pointer transition-[transform,box-shadow,border-color,background-color] duration-[var(--dur-fast)]"
      style={{
        borderColor: selected ? 'var(--accent)' : hover ? 'var(--accent-soft)' : 'var(--line)',
        background: selected ? 'color-mix(in srgb, var(--accent) 4%, var(--card))' : 'var(--card)',
        transform: hover ? 'translateY(-2px)' : 'none',
        boxShadow: hover ? 'var(--elev-1)' : 'none',
        transitionTimingFunction: 'var(--ease)',
      }}
    >
      {/* selection checkbox */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`${t('selected')}: ${file.name}`}
        onClick={(e) => { e.stopPropagation(); onSelect(file.id) }}
        className="absolute top-2 left-2 size-5 rounded-[6px] border flex items-center justify-center transition-[opacity,background-color,border-color] duration-[var(--dur-fast)] cursor-pointer"
        style={{
          opacity: showControls ? 1 : 0,
          background: selected ? 'var(--accent)' : 'var(--card)',
          borderColor: selected ? 'var(--accent)' : 'var(--line)',
        }}
      >
        {selected && <Check size={12} strokeWidth={2.5} color="#fff" />}
      </button>

      {/* overflow */}
      <button
        type="button"
                    aria-label={t('moreActions')}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
        className="absolute top-2 right-2 size-7 flex items-center justify-center rounded-full bg-card border border-line text-ink-3 hover:text-ink transition-[opacity,color] duration-[var(--dur-fast)] cursor-pointer"
        style={{ opacity: showControls ? 1 : 0 }}
      >
        <MoreHorizontal size={14} strokeWidth={1.5} />
      </button>
      {menuOpen && <FileMenu t={t} onClose={() => setMenuOpen(false)} onAction={(a) => onMenuAction(a, file)} />}

      {/* thumbnail */}
      <div className={`h-24 rounded-[9px] flex items-center justify-center ${file.vault ? 'hatch hatch-ink3 bg-sunken' : 'bg-sunken'}`}>
        <Icon size={30} strokeWidth={1.2} className="text-ink-3" />
      </div>

      <div className="mt-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-ink truncate" title={file.name}>{file.name}</p>
          <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtBytes(file.size)} · {fmtRelative(t, file.modified, now)}
          </p>
        </div>
            <StorageBadge vault={file.vault} t={t} />
      </div>
    </div>
  )
}

/* ── Files screen ────────────────────────────────────────────────── */
// ⚠️ ไม่มี fixture ฝั่ง client — รายการไฟล์มาจาก GET /api/files เท่านั้น
// ทุกการกระทำ (สร้างโฟลเดอร์/ลบ) เป็น request จริง + refetch; ไม่มี alert()/prompt()
export function Files({ t, lang, go, navigationParams = {}, placeholderMode = false }) {
  const reduced = useReducedMotion()
  const now = useNow(30_000)

  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'list'
  const view = viewMode
  const setView = setViewMode

  const [currentPath, setCurrentPath] = useState([t('filesTitle')])

  const filesApi = useApi('/api/files')
  const files = placeholderMode ? [] : (filesApi.data?.files ?? [])
  const fetchError = visibleFetchError(filesApi.error, placeholderMode)

  const [sort, setSort] = useState('modified')
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
  const tileRefs = useRef({})

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
    const res = await apiFetch('/api/files/folder', { method: 'POST', body: { name } })
    setMutating(false)
    if (!res.ok) { setMutateError(true); return }
    setFolderModal(false)
    setFolderName('')
    filesApi.retry()
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
  const filtered = files.filter((file) => {
    const matchesQuery = file.name.toLowerCase().includes(query.trim().toLowerCase())
    const matchesType = typeFilter === 'all' || file.type === typeFilter
    return matchesQuery && matchesType
  })
  const sorted = [...filtered].sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size : b.modified - a.modified,
  )

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
    if (action === 'delete') {
      // ลบต้องยืนยันผ่าน Modal เสมอ — ไม่มี confirm() ของเบราว์เซอร์
      setAskDelete({ ids: [file.id], label: file.name })
    } else if (action === 'download') {
      downloadFile(file)
    } else if (action === 'meta' || action === 'verify') {
      openDetail(file)
    } else if (action === 'link') {
      handleSecureShare(file)
    } else if (action === 'history') {
      go?.('versions', { fileId: file.id })
    }
  }

  const acceptDrop = (event) => {
    event.preventDefault()
    setDragOver(false)
    const dropped = event.dataTransfer?.files
    if (!dropped?.length) return
    setDropRequest({ files: [...dropped], id: Date.now() })
    setUploadOpen(true)
  }

  const deleteSelected = () => {
    if (selectedIds.size === 0) return
    setAskDelete({ ids: [...selectedIds], label: `${selectedIds.size} ${t('selected')}` })
  }

  return (
    <div>
      {/* breadcrumbs */}
      <div className="flex items-center gap-1.5 text-[13px] text-ink-3 font-semibold mb-4 select-none">
        {currentPath.map((p, idx) => (
          <span key={idx} className="flex items-center gap-1.5">
            {idx > 0 && <span>/</span>}
            <span className={idx === currentPath.length - 1 ? 'text-ink' : 'hover:text-ink cursor-pointer'} onClick={() => {
              if (idx < currentPath.length - 1) {
                setCurrentPath(currentPath.slice(0, idx + 1));
              }
            }}>
              {p}
            </span>
          </span>
        ))}
      </div>

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
            <option value="modified">{t('sortModified')}</option>
            <option value="name">{t('sortName')}</option>
            <option value="size">{t('sortSize')}</option>
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
        onDragEnter={(event) => { event.preventDefault(); setDragOver(true) }}
        onDragOver={(event) => event.preventDefault()}
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
      ) : sorted.length === 0 ? (
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
      ) : view === 'grid' ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
          {sorted.map((file, i) => (
            <div key={file.id} className="rise-in" style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}>
              <FileTile
                t={t}
                file={file}
                now={now}
                selected={selectedIds.has(file.id)}
                anySelected={selectedIds.size > 0}
                onSelect={toggleSelect}
                onOpen={openDetail}
                onMenuAction={onMenuAction}
                tileRef={(el) => { tileRefs.current[file.id] = el }}
              />
            </div>
          ))}
        </div>
      ) : (
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
                {sorted.map((file, i) => {
                  const Icon = iconFor(file)
                  return (
                    <tr
                      key={file.id}
                      onClick={() => openDetail(file)}
                      className="border-b border-line last:border-b-0 hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer rise-in"
                      style={{ height: 'var(--row-h)', animationDelay: `${Math.min(i * 25, 300)}ms` }}
                    >
                      <td className="px-4 pl-5">
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Icon size={16} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                          <span className="text-[13.5px] font-medium text-ink truncate max-w-[360px]">{file.name}</span>
                        </span>
                      </td>
                      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(file.size)}</td>
                      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{file.type}</td>
                      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{fmtRelative(t, file.modified, now)}</td>
                      <td className="px-4"><StorageBadge vault={file.vault} t={t} /></td>
                      <td className="px-4 text-right">
                        <IconBtn label={t('viewMetadata')} onClick={(e) => { e.stopPropagation(); openDetail(file) }}>
                          <MoreHorizontal size={15} strokeWidth={1.5} />
                        </IconBtn>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      </div>

      {/* floating multi-select action bar — black pill, slides up */}
      {selectedIds.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-ink text-card rounded-full pl-4 pr-1.5 h-12"
          style={{ zIndex: 'var(--z-toast)', boxShadow: 'var(--elev-2)', animation: 'bar-up var(--dur-base) var(--ease) both' }}
        >
          <span className="text-[13px] font-semibold mr-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {selectedIds.size} {t('selected')}
          </span>
          {[
            { id: 'download', icon: Download, label: t('download') },
            { id: 'move', icon: FolderInput, label: t('move') },
          ].map(({ id, icon: I, label }) => (
            <button key={id} type="button" className="flex items-center gap-1.5 h-9 px-3 rounded-full text-[13px] font-medium hover:bg-white/12 transition-colors duration-[var(--dur-fast)] cursor-pointer">
              <I size={14} strokeWidth={1.5} />
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={deleteSelected}
            className="flex items-center gap-1.5 h-9 px-3 rounded-full text-[13px] font-medium hover:bg-white/12 transition-colors duration-[var(--dur-fast)] cursor-pointer"
            style={{ color: '#fca5a5' }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
            {t('delete')}
          </button>
          <button
            type="button"
            aria-label={t('close')}
            onClick={() => setSelectedIds(new Set())}
            className="size-9 flex items-center justify-center rounded-full hover:bg-white/12 transition-colors duration-[var(--dur-fast)] cursor-pointer"
          >
            <XIcon size={15} strokeWidth={1.5} />
          </button>
        </div>
      )}

      <FlipGhost ghost={ghost} onDone={() => setGhost(null)} />
      {detail && <MetaDrawer t={t} lang={lang} file={detail} onClose={() => setDetail(null)} />}

      {/* new folder — Modal จริง ไม่ใช่ prompt() ของเบราว์เซอร์ */}
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

      <UploadDrawer
        t={t}
        open={uploadOpen}
        onOpen={() => setUploadOpen(true)}
        onClose={() => setUploadOpen(false)}
        destination="/Files"
        recentFiles={files.filter((file) => file.type !== 'Folder')}
        recentLoading={filesApi.loading}
        initialFiles={dropRequest.files}
        requestId={dropRequest.id}
        onUploaded={filesApi.retry}
      />
    </div>
  )
}
