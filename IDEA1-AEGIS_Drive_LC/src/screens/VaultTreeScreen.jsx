// src/screens/VaultTreeScreen.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.3 — the unlocked TREE_V1 hierarchy screen
//
// จอต้นไม้ที่ถอดรหัสแล้ว: การนำทาง การเลือก การย้ายแบบลากวาง ถัง/กู้คืน ไดอะล็อก อัปโหลด ดาวน์โหลด
// ทุกความหมายวิ่งผ่าน useVaultTree (reducer) + session.commit (vaultTreeSync) — จอนี้ไม่มีตรรกะความหมายของตัวเอง
// กติกาจอ:
//   • head ใหม่ทุกใบผ่าน reconcile ของ reducer: selection ที่หายไปถูกตัด, โฟลเดอร์ปัจจุบันที่หายไปถอยไปบรรพบุรุษ
//     (TS-9) และมี announcement ให้แถบ aria-live ประกาศเสมอ
//   • external OS file drop กับ internal move คือ "คนละเส้นทาง" เด็ดขาด (TS-4/TS-5): ไฟล์จากระบบปฏิบัติการ
//     วิ่งเข้า uploadTreeFile เท่านั้น ห้ามยุ่งกับ move intent ของต้นไม้
//   • dialog/pending/announcement ทั้งหมดถือ plaintext จึงลงทะเบียน disposer กับ unlockedState — ล็อก = จอสะอาด
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, FolderPlus, LayoutGrid, List, Lock, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Btn, Card, Chip, EmptyState, ErrorState, IconBtn, Modal, ModalClose, PillSelect } from '../components/ui.jsx'
import { VaultBreadcrumbs } from '../components/vault/VaultBreadcrumbs.jsx'
import { VaultFolderTile } from '../components/vault/VaultFolderTile.jsx'
import { VaultFileTile } from '../components/vault/VaultFileTile.jsx'
import { VaultRecoveryPanel, vaultTreeFolderOptions } from '../components/vault/VaultRecoveryPanel.jsx'
import {
  NewFolderDialog, RenameDialog, MoveDialog, DetailsDialog,
  TrashConfirmDialog, RestoreDialog, ConflictDialog,
} from '../components/vault/VaultDialogs.jsx'
import { useVaultTree, planRun, planDrop } from '../lib/useVaultTree.js'
import { createTreeSession } from '../lib/vaultTreeSync.js'
import { intents } from '../lib/vaultTreeOps.js'
import { uploadTreeFile } from '../lib/vaultTreeUpload.js'
import { previewKindFor } from '../lib/vaultPreview.js'
import { childrenOf, effectiveState } from '../lib/vaultTreeManifest.js'
import { createThumbScheduler } from '../lib/vaultThumbScheduler.js'
import { makeImageThumb } from '../lib/vaultImageThumb.js'
import { gifMotionCapability, openGifMotion } from '../lib/vaultGifPreview.js'
import { openVideoPoster, videoPreviewCapability, VIDEO_CAPABILITY } from '../lib/vaultVideoPreview.js'
import { attachPosterVideo, drawPosterFrame } from '../lib/vaultVideoDom.js'
import { closePreviewSession, openPreviewSession, supportsLargeVideoPreview } from '../lib/vaultPreviewSession.js'
import { normalizeMimeType } from '../lib/vaultPreview.js'
import { useReducedMotion } from '../lib/hooks.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../lib/vaultTreeLimits.js'
import * as treeApi from '../lib/vaultTreeApi.js'
import { fmtBytes } from '../lib/format.js'
import { useApi } from '../lib/hooks.js'
import { apiFetchBytes } from '../lib/api.js'
import { DEFAULT_VAULT_SORT, deriveVaultWorkspace, VAULT_SORT_MODES, VAULT_TYPE_FILTERS } from '../lib/vaultWorkspace.js'
import { readFolderHistory, resolveFolderHistoryTarget, writeFolderHistory } from '../lib/folderHistory.js'
import { useMarqueeSelection } from '../lib/useMarqueeSelection.js'
import { decryptFileContent, decryptBlobMeta } from '../lib/vaultCrypto.js'
import { decryptVaultV2Meta, unwrapVaultV2Dek } from '../lib/vaultChunkCrypto.js'
import {
  downloadVaultV2, createFileSystemSink, createBufferedSink, MAX_BUFFERED_PLAINTEXT_BYTES,
} from '../lib/vaultChunkedDownload.js'
const MAX_PREVIEW_CEILING_BYTES = MAX_BUFFERED_PLAINTEXT_BYTES
import { supportsStreamingFileSink } from '../lib/vaultChunkedDownload.js'

/** blob id ทึบ: '2:id' — key เดียวกับ GET /api/vault inventory ที่จอใช้แมตช์บล็อบจริงของโหนด */
const refKey = (r) => `${r?.formatVersion ?? 1}:${String(r?.id ?? '')}`

/** ตัวเลือกโฟลเดอร์ (ย้ายมาอยู่ที่ VaultRecoveryPanel เพื่อกัน import cycle — จอ re-export ไว้) */
export { vaultTreeFolderOptions }

/** ทางลัด: ชื่อโฟลเดอร์ราก = ป้ายที่แปลแล้ว (root ไม่มีชื่อใน manifest) */
function childCountOf(index, folderId) {
  return childrenOf(index, folderId, { view: 'active' }).length
}

function displayNodeName(t, node, rootId) {
  return node?.nodeId === rootId ? t('vaultTreeRootName') : node?.name ?? null
}

/* ── การดาวน์โหลดของต้นไม้: ชื่อ/ชนิดจาก manifest เสมอ ไม่ใช่จากซอง (TS-13) ──
   แนบทางเดียวกับจอเลกาซี (downloadVaultV2 + sinks, V1 = apiFetchBytes + decryptFileContent)
   ซองถูกพิสูจน์ความถูกต้องด้วย (decrypt meta ยังถูกเรียก — ผลถูกทิ้ง) แต่ไม่ถูกใช้ตั้งชื่อไฟล์ */
export async function treeDownloadEntry({
  t, lang, kek, node, blob, unlockedState = null, onFailed,
}) {
  if (!node?.blobRef || !blob) { onFailed?.('NOT_FOUND'); return }
  const ref = { formatVersion: node.blobRef.formatVersion, id: String(node.blobRef.id) }
  const name = node.name ?? `${ref.id}.bin`
  const type = node.mediaType ?? ''
  const ctrl = new AbortController()
  unlockedState?.registerAbort?.(ctrl)
  try {
    if (ref.formatVersion === 2) {
      // พิสูจน์ซองก่อน (ผลถูกทิ้ง — ชื่อมาจาก manifest เท่านั้น)
      await decryptVaultV2Meta(kek, blob)
      const plainSize = node.plainSize ?? Math.max(0, blob.size - blob.chunkCount * 16)
      let sink = null
      if (supportsStreamingFileSink()) {
        try {
          const handle = await globalThis.showSaveFilePicker({ suggestedName: name })
          sink = createFileSystemSink(await handle.createWritable())
        } catch (err) {
          if (err?.name === 'AbortError') return
          onFailed?.('PICKER')
          return
        }
      } else if (plainSize > MAX_BUFFERED_PLAINTEXT_BYTES) {
        onFailed?.('TOO_LARGE')
        return
      } else {
        sink = createBufferedSink()
      }
      const res = await downloadVaultV2({ kek, blob, sink, signal: ctrl.signal })
      if (!res.ok) {
        if (res.reason === 'cancelled') return
        onFailed?.('DOWNLOAD')
        return
      }
      if (sink.kind === 'buffered') {
        const url = URL.createObjectURL(new Blob(res.result, { type: type || 'application/octet-stream' }))
        unlockedState?.registerObjectUrl?.(url)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      return
    }
    // V1: ทั้งไฟล์ผ่าน apiFetchBytes — GCM ตรวจ integrity ในตัว
    const res = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(ref.id)}`)
    if (!res.ok) { onFailed?.('DOWNLOAD'); return }
    await decryptBlobMeta(kek, blob)
    const plain = await decryptFileContent(kek, blob, res.bytes)
    const url = URL.createObjectURL(new Blob([plain], { type: type || 'application/octet-stream' }))
    unlockedState?.registerObjectUrl?.(url)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch {
    onFailed?.('DOWNLOAD')
  }
}

/* ── TS-11 rollback surface: TREE_V1 + treeUiEnabled=false → read/export-only list ──
   อ่านอย่างเดียว: ชื่อที่ถอดรหัส + Download + Details — ไม่มีควบคุมการแก้ไขใด ๆ เด็ดขาด */
export function VaultTreeRollback({ t, lang = 'en', kek, unlockedState = null, sessionFactory = createTreeSession, defaultApi = treeApi }) {
  const session = useMemo(() => (kek ? sessionFactory({ kek, api: defaultApi, unlockedState }) : null), [kek, unlockedState, sessionFactory, defaultApi])
  const [head, setHead] = useState(null)
  const [state, setState] = useState('loading')
  const [details, setDetails] = useState(null)
  const blobApi = useApi('/api/vault')
  const blobIndex = useMemo(() => new Map((blobApi.data?.blobs ?? []).map((b) => [refKey({ formatVersion: b.formatVersion ?? 1, id: b.id }), b])), [blobApi.data])

  useEffect(() => {
    if (!session) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const h = await session.loadHead()
        if (!cancelled) { setHead(h); setState('ready') }
      } catch {
        if (!cancelled) setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [session])

  if (state === 'loading') return <p className="text-[12.5px] text-ink-3 mb-4">{t('vaultTreeLoading')}</p>
  if (state === 'error') return <p className="text-[12.5px] text-ink-3 mb-4">{t('vaultTreeLoadError')}</p>
  const index = head?.index
  const rows = []
  if (index) {
    const rootId = head.manifest.rootNodeId
    const walk = (parentId) => {
      for (const c of childrenOf(index, parentId, { view: 'active' })) {
        rows.push({ ...c, displayName: displayNodeName(t, c, rootId) })
        if (c.kind === 'folder') walk(c.nodeId)
      }
    }
    walk(rootId)
  }
  return (
    <div data-testid="vault-tree-rollback" className="mb-4">
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">{t('vaultTreeEmptyFolderView')}</p>
      ) : (
        <div className="rounded-[var(--r-tile)] border border-line divide-y divide-line">
          {rows.map((n) => (
            <div key={n.nodeId} data-testid="vault-tree-rollback-row" className="flex items-center gap-3 px-3 h-11">
              <span className="truncate text-[13px] text-ink flex-1">{n.displayName}</span>
              {n.kind === 'file' && (
                <Btn
                  size="sm"
                  variant="outline"
                  data-testid="vault-tree-rollback-download"
                  onClick={() => treeDownloadEntry({ t, lang, kek, node: n, blob: blobIndex.get(refKey(n.blobRef)), unlockedState, onFailed: () => {} })}
                >
                  {t('vaultTreeMenuDownload')}
                </Btn>
              )}
              <Btn size="sm" variant="ghost" data-testid="vault-tree-rollback-details" onClick={() => setDetails(n)}>
                {t('vaultTreeMenuDetails')}
              </Btn>
            </div>
          ))}
        </div>
      )}
      <DetailsDialog t={t} lang={lang} open={Boolean(details)} onClose={() => setDetails(null)} node={details} cipherSize={null} unlockedState={unlockedState} />
    </div>
  )
}

/* ── จอหลัก ──────────────────────────────────────────────────────────────────── */
export function VaultTreeScreen({
  t, lang = 'en', kek, treeState = null, unlockedState = null, onLock,
  sessionFactory = createTreeSession, defaultApi = treeApi, mediaPreviewEnabled = false,
}) {
  const session = useMemo(
    () => (kek ? sessionFactory({ kek, api: defaultApi, unlockedState }) : null),
    [kek, unlockedState, sessionFactory, defaultApi],
  )
  const tree = useVaultTree({ session, unlockedState })
  const vaultApi = useApi('/api/vault')
  const [loadState, setLoadState] = useState('idle')
  const [loadErrorCode, setLoadErrorCode] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [notice, setNotice] = useState(null)
  const [uploadState, setUploadState] = useState(null)
  const [preview, setPreview] = useState(null)
  const [detailsCipher, setDetailsCipher] = useState(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [sort, setSort] = useState(DEFAULT_VAULT_SORT)
  const [layout, setLayout] = useState('grid')
  const purgeRef = useRef(() => {})
  const fileRef = useRef(null)
  const head = tree.state.head

  /* plaintext บนจอทั้งหมด (dialog/pending/notice/upload/preview/orphans) ตายพร้อมกุญแจ (TS-10) */
  useEffect(() => {
    if (!unlockedState?.registerDisposer) return undefined
    try {
      unlockedState.registerDisposer(() => {
        purgeRef.current()
      })
    } catch { /* purged already */ }
    return undefined
  }, [unlockedState])
  purgeRef.current = () => {
    setDialog(null)
    setNotice(null)
    setUploadState(null)
    setPreview(null)
    setDetailsCipher(null)
    setQuery('')
    setTypeFilter('all')
    setMediaMap(new Map())
    setMotionState(null)
  }

  /* โหลด head ครั้งแรก + หลัง refresh (TS-1/TS-9); KEY_DEGRADED หนึ่งช่อง = ยังโหลดได้ แต่ mutation ปิด
     ⚠️ tree.refreshHead/setKeyStatus เป็นฟังก์ชันใหม่ทุก render — ถ้าผูกเป็น dependency ตรง ๆ load จะมี
     identity ใหม่ทุก render แล้ว effect นี้ยิง loadHead วนไม่รู้จบ (act ไม่มีวัน settle) — อ่านผ่าน ref เท่านั้น */
  const treeRef = useRef(null)
  treeRef.current = tree
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!session) return
    if (!quiet) setLoadState('loading')
    try {
      const h = await session.loadHead()
      treeRef.current.refreshHead(h)
      if (session.keyStatus === 'DEGRADED') treeRef.current.setKeyStatus('DEGRADED', session.keyBadSlot)
      setLoadState('ready')
    } catch (e) {
      if (e?.code === 'KEY_DEGRADED') {
        // หนึ่งช่องเสีย = ยังโหลดได้ (อ่านอย่างเดียวจนกว่าจะซ่อม); สองช่องเสีย = fail closed (RP-2)
        const bothBad = String(e?.detail ?? e?.message ?? '') === 'TRK_UNRECOVERABLE'
        treeRef.current.setKeyStatus('DEGRADED', session.keyBadSlot)
        setLoadState(bothBad ? 'degraded' : 'ready')
      } else if (e?.code !== 'ABORTED') {
        setLoadErrorCode(e?.code ?? 'TRANSPORT')
        setLoadState('error')
      }
    }
  }, [session])
  useEffect(() => { void load() }, [load])

  /* ── handlers ─────────────────────────────────────────────────────────────── */
  const announce = (key, vars = null) => setNotice({ key, vars })
  const run = useCallback(async (intent, { successKey = null } = {}) => {
    const res = await tree.run(intent)
    if (res?.conflict) return res
    if (res && successKey) announce(successKey)
    return res
  }, [tree])
  const refreshAfter = () => { void load({ quiet: true }) }

  const historyReadyRef = useRef(false)
  const navigateTo = useCallback((nodeId, { replace = false, fromHistory = false } = {}) => {
    treeRef.current?.open(nodeId)
    if (!fromHistory && typeof window !== 'undefined') {
      writeFolderHistory({ history: window.history, location: window.location, scope: 'vault', nodeId, replace })
    }
  }, [])

  useEffect(() => {
    if (!head || historyReadyRef.current || typeof window === 'undefined') return undefined
    historyReadyRef.current = true
    const rootId = head.manifest.rootNodeId
    const validIds = new Set(head.manifest.nodes.keys())
    const saved = readFolderHistory(window.history.state, 'vault')
    const target = resolveFolderHistoryTarget(saved?.nodeId, validIds, rootId)
    navigateTo(target, { replace: true, fromHistory: Boolean(saved) })
    if (!saved || target !== saved.nodeId) {
      writeFolderHistory({ history: window.history, location: window.location, scope: 'vault', nodeId: target, replace: true })
    }
    return undefined
  }, [head, navigateTo])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onPopState = (event) => {
      const currentHead = treeRef.current?.state?.head
      if (!currentHead) return
      const entry = readFolderHistory(event.state, 'vault')
      if (!entry) return
      const ids = new Set(currentHead.manifest.nodes.keys())
      const next = resolveFolderHistoryTarget(entry.nodeId, ids, currentHead.manifest.rootNodeId)
      navigateTo(next, { fromHistory: true })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [navigateTo])

  const actionFor = (node, id) => {
    const rootId = head?.manifest.rootNodeId
    if (id === 'open') navigateTo(node.nodeId)
    else if (id === 'preview') {
      void actionPreview(node)
    } else if (id === 'details') {
      setDialog({ kind: 'details', node })
      setDetailsCipher(null)
    } else if (id === 'download') void startBulkDownload([node])
    else if (id === 'rename') setDialog({ kind: 'rename', node })
    else if (id === 'move') setDialog({ kind: 'move', nodeIds: [node.nodeId], names: [node.name] })
    else if (id === 'trash') setDialog({ kind: 'trash', count: 1, nodeIds: [node.nodeId] })
    else if (id === 'restore') {
      // เดิม: กู้ที่เดิมให้ทันทีถ้าทำได้; ชน/ปลายทางหาย = ไดอะล็อกเลือกที่ (DG-6)
      void runRestore(node.nodeId, null, node)
    }
  }

  /* ── อัปโหลด (external OS drop และปุ่ม Upload — เส้นทางเดียวกัน TS-5) ────── */
  const uploadFiles = async (files, parentNodeId = tree.current) => {
    if (!kek || !tree.state.head) return
    for (const file of files) {
      setUploadState({ name: file.name, stage: 'preparing', percent: 0 })
      try {
        const res = await uploadTreeFile({
          kek, file, parentNodeId, session, unlockedState,
          onStage: (stage) => setUploadState((prev) => (prev ? { ...prev, stage } : prev)),
          onProgress: (p) => setUploadState((prev) => (prev ? { ...prev, percent: p.percent ?? 0 } : prev)),
        })
        if (res?.ok) announce('vaultTreeUploadComplete', { name: file.name })
        else if (res && res.ok === false && res.stage !== 'cancelled') announce('vaultTreeUploadFailed')
      } catch {
        // a thrown transfer never stays silent — the blob may still be recoverable (Task 4.3)
        announce('vaultTreeUploadFailed')
      }
    }
    setUploadState(null)
    refreshAfter()
  }

  /* ── ดาวน์โหลด: ไฟล์เท่านั้น, ทีละไฟล์, ล็อก = หยุด (TS-14) ──────────────── */
  const [downloadBusy, setDownloadBusy] = useState(false)
  const startBulkDownload = async (nodes) => {
    if (downloadBusy || !kek) return
    setDownloadBusy(true)
    try {
      const files = nodes.filter((n) => n.kind === 'file')
      for (const n of files) {
        if (unlockedState?.isPurged?.()) return // ล็อก = หยุดทันที
        const blob = blobIndex.get(refKey(n.blobRef))
        await treeDownloadEntry({
          t, lang, kek, node: n, blob, unlockedState,
          onFailed: () => announce('vaultTreeDownloadFailed'),
        })
      }
    } finally {
      setDownloadBusy(false)
    }
  }

  /* Preview (Task 6.3 minimal): decrypt to a bounded object URL; the Phase 7 work extends video to the
     range-decryption session. Every failure is announced truthfully; the URL is registered with the
     unlocked state so a lock revokes it. */
  const actionPreview = (node) => {
    const kind = previewKindFor(node.mediaType)
    if (kind) void openPreviewModal(node, kind)
  }

  const openPreviewModal = async (node, kind) => {
    if (!kek || !node?.blobRef) return
    const blob = blobIndex.get(refKey(node.blobRef))
    const ref = { formatVersion: node.blobRef.formatVersion, id: String(node.blobRef.id) }
    try {
      let bytes = null
      if (ref.formatVersion === 2) {
        const plainSize = node.plainSize ?? Math.max(0, (blob?.size ?? 0) - (blob?.chunkCount ?? 0) * 16)
        if (plainSize > MAX_PREVIEW_CEILING_BYTES) { announce('vaultTreePreviewTooLarge'); return }
        const sink = createBufferedSink()
        const res = await downloadVaultV2({ kek, blob, sink })
        if (!res.ok) { announce('vaultTreePreviewFailed'); return }
        bytes = res.result
      } else {
        const r = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(ref.id)}`)
        if (!r.ok) { announce('vaultTreePreviewFailed'); return }
        bytes = await decryptFileContent(kek, blob, r.bytes)
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: node.mediaType || 'application/octet-stream' }))
      unlockedState?.registerObjectUrl?.(url)
      setPreview({ node, kind, url })
    } catch {
      announce('vaultTreePreviewFailed')
    }
  }
  /* ── กู้คืน (DG-6): ที่เดิมถ้าแผนผ่าน; ถูกปฏิเสธฝั่ง client = เปิดตัวเลือกที่ให้ผู้ใช้ตัดสิน ── */
  const runRestore = async (nodeId, destinationNodeId, node) => {
    if (destinationNodeId !== null && destinationNodeId !== undefined) {
      return run(intents.restore({ nodeId, destinationNodeId }))
    }
    const plan = planRun(tree.state, intents.restore({ nodeId, destinationNodeId: null }))
    if (plan.ok) {
      return run(plan.intent)
    }
    setDialog({ kind: 'restore', node })
    return null
  }

  /* blob inventory จาก GET /api/vault — จับคู่ blobRef ของโหนดกับซองจริงเพื่อดาวน์โหลด/พิสูจน์ซอง */
  const serverBlobs = vaultApi.data?.blobs ?? []
  const blobIndex = useMemo(
    () => new Map(serverBlobs.map((b) => [refKey({ formatVersion: b.formatVersion ?? 1, id: b.id }), b])),
    [serverBlobs],
  )

  /* ── media previews (Tasks 7.2-7.4) — client-only, behind VAULT_MEDIA_PREVIEW_ENABLED ──
     posters via the bounded scheduler; GIF hover decrypts whole only under the limits;
     videos ride the existing preview session (RANGE_V2). Every failure is a truthful reason. */
  const mediaEnabled = Boolean(treeState?.flags?.mediaPreviewEnabled) && Boolean(unlockedState)
  const reducedMotion = useReducedMotion()
  const [mediaMap, setMediaMap] = useState(() => new Map())
  const [motionState, setMotionState] = useState(null)
  const mediaLimitsRef = useRef(VAULT_TREE_CLIENT_LIMITS)
  const schedulerRef = useRef(null)

  const readNodeBytes = useCallback(async ({ node, blob, signal }) => {
    const variant = node.blobRef?.formatVersion ?? 1
    const ref = { formatVersion: variant, id: String(node.blobRef.id) }
    if (variant === 2) {
      const sink = createBufferedSink({ limitBytes: mediaLimitsRef.current.imageMaxInputBytes })
      const res = await downloadVaultV2({ kek, blob, sink, signal })
      if (!res.ok) throw new Error(res.reason ?? 'DOWNLOAD')
      const parts = await sink.close()
      const total = parts.reduce((t, q) => t + q.length, 0)
      const out = new Uint8Array(total)
      let at = 0
      for (const part of parts) { out.set(part, at); at += part.length }
      return out
    }
    const r = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(ref.id)}`, { signal })
    if (!r.ok) throw new Error('DOWNLOAD')
    return decryptFileContent(kek, blob, r.bytes)
  }, [kek])

  const scheduler = useMemo(() => {
    if (!mediaEnabled || !unlockedState || !head) return null
    return createThumbScheduler({
      limits: mediaLimitsRef.current,
      unlockedState,
      load: async (key, { signal } = {}) => {
        const node = head.index.nodes.get(key)
        if (!node?.blobRef) throw new Error('NOT_FOUND')
        const blob = blobIndex.get(refKey(node.blobRef))
        const kind = previewKindFor(node.mediaType)
        if (kind === 'video') {
          const variant = node.blobRef.formatVersion ?? 1
          const plainSize = node.plainSize ?? 0
          const supportsLarge = variant === 2 && supportsLargeVideoPreview()
          const localUrls = new Set()
          const poster = await openVideoPoster({
            variant, plainSize, mediaType: node.mediaType, supportsLarge,
            maxPreviewBytes: MAX_PREVIEW_CEILING_BYTES, signal, returnBytes: true,
            openSession: async () => {
              if (supportsLarge) {
                const dek = await unwrapVaultV2Dek(kek, blob)
                const session = await openPreviewSession({
                  dek, blob, contentType: node.mediaType, plainSize,
                  isUnlocked: () => !unlockedState?.isPurged?.(), unlockedState,
                })
                if (!session.ok) throw new Error(session.reason ?? 'PREVIEW_SESSION')
                return session
              }
              if (plainSize > MAX_PREVIEW_CEILING_BYTES) throw new Error('TOO_LARGE')
              const bytes = await readNodeBytes({ node, blob, signal })
              const url = URL.createObjectURL(new Blob([bytes], { type: node.mediaType || 'video/mp4' }))
              localUrls.add(url)
              unlockedState?.registerObjectUrl?.(url)
              return { token: `local:${url}`, url }
            },
            closeSession: async (token) => {
              if (String(token).startsWith('local:')) {
                const url = String(token).slice(6)
                localUrls.delete(url)
                URL.revokeObjectURL(url)
                return
              }
              await closePreviewSession(token)
            },
            attachVideo: attachPosterVideo,
            drawFrame: drawPosterFrame,
          })
          for (const url of localUrls) URL.revokeObjectURL(url)
          if (!poster.ok) throw new Error(poster.unsupported ?? 'VIDEO_POSTER')
          return { width: 640, height: 360, bytes: poster.posterBytes, mime: 'image/jpeg' }
        }
        const bytes = await readNodeBytes({ node, blob, signal })
        const thumb = await makeImageThumb({
          plainSize: node.plainSize ?? bytes.length, limits: mediaLimitsRef.current,
          variant: node.blobRef?.formatVersion ?? 1, readWhole: async () => bytes,
          unlockedState, signal, skipUrl: true,
        })
        if (!thumb.ok) throw new Error(thumb.unsupported)
        return { width: thumb.width, height: thumb.height, bytes: thumb.posterBytes }
      },
      onChange: () => setMediaMap(schedulerRef.current?.snapshot() ?? new Map()),
    })
  }, [mediaEnabled, unlockedState, head, kek, blobIndex, readNodeBytes])
  schedulerRef.current = scheduler

  const prevFolderRef = useRef(null)
  useEffect(() => {
    if (!scheduler || !head) return
    if (prevFolderRef.current !== null && prevFolderRef.current !== tree.current) {
      scheduler.releaseFolder(prevFolderRef.current)
    }
    prevFolderRef.current = tree.current
    for (const n of tree.children) {
      if (n.kind === 'file' && (previewKindFor(n.mediaType) === 'image' || previewKindFor(n.mediaType) === 'video')) {
        scheduler.observe(n.nodeId, { folderId: tree.current, estimateBytes: n.plainSize ?? 0 })
      }
    }
  }, [scheduler, head, tree.children, tree.current])

  const gifHoverStart = useCallback(async (node) => {
    if (!mediaEnabled || reducedMotion || node.kind !== 'file' || normalizeMimeType(node.mediaType) !== 'image/gif') return
    const cap = gifMotionCapability({ plainSize: node.plainSize ?? 0, limits: mediaLimitsRef.current, schedulerMemBytes: schedulerRef.current?.stats().estMemBytes ?? 0 })
    if (!cap.ok) { setMediaMap((prev) => new Map(prev).set(node.nodeId, { state: 'failed', url: null, failed: true, reason: cap.unsupported })); return }
    try {
      const node0 = head.index.nodes.get(node.nodeId)
      const blob = blobIndex.get(refKey(node.blobRef))
      const bytes = await readNodeBytes({ node: node0, blob })
      const res = await openGifMotion({ plainSize: node.plainSize ?? 0, limits: mediaLimitsRef.current, readWhole: async () => bytes, unlockedState })
      if (!res.ok) { setMediaMap((prev) => new Map(prev).set(node.nodeId, { state: 'failed', url: null, failed: true, reason: res.unsupported })); return }
      setMotionState({ nodeId: node.nodeId, url: res.url, release: res.release })
    } catch {
      setMediaMap((prev) => new Map(prev).set(node.nodeId, { state: 'failed', url: null, failed: true, reason: 'INTEGRITY' }))
    }
  }, [mediaEnabled, reducedMotion, head, blobIndex, readNodeBytes, unlockedState])
  const gifHoverEnd = useCallback(() => {
    setMotionState((prev) => { try { prev?.release?.() } catch { /* best effort */ } return null })
  }, [])

  const mediaFor = (node) => {
    if (!mediaEnabled || node.kind !== 'file') return null
    const mime = normalizeMimeType(node.mediaType)
    const entry = mediaMap.get(node.nodeId)
    const isGif = mime === 'image/gif'
    const isVideo = previewKindFor(mime) === 'video'
    if (entry?.failed && !entry.url) return { reason: entry.reason ?? 'THUMB_FAILED' }
    return {
      posterUrl: entry?.url ?? null,
      reason: null,
      hoverEnabled: Boolean(isGif && !reducedMotion),
      motionUrl: motionState?.nodeId === node.nodeId ? motionState.url : null,
      onHoverStart: isGif ? () => void gifHoverStart(node) : undefined,
      onHoverEnd: isGif ? () => gifHoverEnd() : undefined,
      videoCapability: isVideo ? videoPreviewCapability({ variant: node.blobRef?.formatVersion ?? 1, mediaType: mime, supportsLarge: false, plainSize: node.plainSize ?? 0, maxPreviewBytes: MAX_PREVIEW_CEILING_BYTES }).capability : null,
    }
  }

  /* ── dialog submit handlers ─────────────────────────────────────────────── */
  const siblingNamesOf = (parentNodeId, exceptNodeId = null) => {
    if (!head) return []
    const out = []
    for (const c of childrenOf(head.index, parentNodeId, { view: 'active' })) {
      if (c.nodeId !== exceptNodeId) out.push(c.name)
    }
    return out
  }
  const onDialogSubmit = {
    createFolder: async (name) => {
      await run(intents.createFolder({ parentNodeId: tree.current, name }), { successKey: null })
    },
    rename: async (name) => {
      await run(intents.rename({ nodeId: dialog.node.nodeId, name }))
    },
    move: async (destinationNodeId) => {
      await run(intents.move({ nodeIds: dialog.nodeIds, destinationNodeId }))
    },
    trash: async () => {
      await run(intents.trash({ nodeIds: dialog.nodeIds }))
    },
    restore: async (destinationNodeId) => {
      await run(intents.restore({ nodeId: dialog.node.nodeId, destinationNodeId }))
    },
  }

  /* ── ป้าย/announcements ─────────────────────────────────────────────────── */
  const REJECT_COPY = {
    CYCLE: 'vaultTreeDropCycle', NOT_FOLDER: 'vaultTreeDropNotFolder', EFFECTIVELY_TRASHED: 'vaultTreeDropTrashed',
  }
  const announcementText = (() => {
    const a = tree.announcement
    if (a?.kind === 'rejected') {
      const k = REJECT_COPY[a.reason] ?? 'vaultTreeDropDefault'
      return t(k, a.reason ? { reason: a.reason } : undefined)
    }
    if (a?.kind === 'reconciled') return t('vaultTreeReconcile')
    if (a?.kind === 'failed') return t('vaultTreeLoadError')
    return notice ? t(notice.key, notice.vars ?? undefined) : null
  })()

  const caps = tree.capabilities()
  const workspace = useMemo(
    () => deriveVaultWorkspace(tree.children, { query, typeFilter, sort }),
    [tree.children, query, typeFilter, sort],
  )
  const marqueeCanvasRef = useRef(null)
  const marqueeTilesRef = useRef(new Map())
  const registerMarqueeTile = (nodeId) => (element) => {
    if (element) marqueeTilesRef.current.set(nodeId, element)
    else marqueeTilesRef.current.delete(nodeId)
  }
  const setMarqueeSelection = useCallback((nodeIds) => {
    const controller = treeRef.current
    if (!controller) return
    controller.setSelection(nodeIds)
  }, [])
  const marquee = useMarqueeSelection({
    enabled: layout === 'grid',
    canvasRef: marqueeCanvasRef,
    tileEls: marqueeTilesRef,
    selectedIds: tree.selection,
    onSelectionChange: setMarqueeSelection,
  })
  const selectionRoots = head && tree.selection.size ? (() => {
    try {
      return normalizeRootsSafe(head.index, [...tree.selection])
    } catch { return [] }
  })() : []
  const selectionNames = selectionRoots.map((n) => displayNodeName(t, n, head?.manifest.rootNodeId))

  /* เลือกรากของ selection อย่างปลอดภัย (ลูกหลานถูกตัดโดย normalizeSelectionRoots แล้ว) */
  function normalizeRootsSafe(index, ids) {
    try {
      return ids.map((id) => index.nodes.get(id)).filter(Boolean)
    } catch {
      return []
    }
  }

  const folderOptions = useMemo(() => {
    if (!head) return []
    const rootId = head.manifest.rootNodeId
    const excluded = dialog?.kind === 'move' ? dialog.nodeIds : tree.selection
    const options = vaultTreeFolderOptions(head.index, rootId, [...excluded])
    return [{ nodeId: rootId, name: t('vaultTreeRootName'), depth: 0 }, ...options]
  }, [head, dialog, tree.selection, t])

  const dragPropsFor = (node) => ({
    draggable: true,
    onDragStart: (e) => {
      tree.dragStart(node.nodeId)
      try {
        e.dataTransfer.setData('text/plain', 'aegis-internal-move')
        e.dataTransfer.effectAllowed = 'move'
      } catch { /* jsdom has no DataTransfer behaviors beyond setters */ }
    },
    onDragEnd: () => tree.dragEnd(),
  })
  const dropPropsFor = (node) => ({
    onDragOver: (e) => {
      const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
      const hasFiles = [...(dt?.types ?? [])].includes('Files')
      if ((hasFiles && node.kind === 'folder') || tree.drag) e.preventDefault()
    },
    onDrop: (e) => {
      const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
      const hasFiles = [...(dt?.types ?? [])].includes('Files')
      if (hasFiles) {
        if (node.kind !== 'folder') return
        // external OS files → the upload path, NEVER the tree move path (TS-5)
        e.preventDefault()
        e.stopPropagation()
        const files = [...(dt.files ?? [])]
        if (files.length) void uploadFiles(files, node.nodeId)
        return
      }
      // internal move: ONE commit path — planDrop decides, tree.run commits; an invalid
      // target goes through the reducer's reject path so the announcement fires with zero CAS
      e.preventDefault()
      const plan = planDrop(tree.state, node.nodeId)
      if (plan.ok) void tree.run(plan.intent)
      else {
        // announce through the screen channel too — the reducer's reject is the source of truth,
        // the local notice makes the reason visible immediately (TS-4)
        const k = REJECT_COPY[plan.reason] ?? 'vaultTreeDropDefault'
        announce(k, REJECT_COPY[plan.reason] ? undefined : { reason: plan.reason })
        tree.drop(node.nodeId)
      }
    },
  })

  /* ── render ──────────────────────────────────────────────────────────────── */
  const rootId = head?.manifest.rootNodeId ?? null
  const isTrashView = tree.view === 'trash'
  return (
    <div
      data-testid="vault-tree-screen"
      className="mb-6"
      onDragOver={(e) => {
        const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
        if ([...(dt?.types ?? [])].includes('Files') && !isTrashView) e.preventDefault()
      }}
      onDrop={(e) => {
        const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
        if (![...(dt?.types ?? [])].includes('Files') || isTrashView) return
        e.preventDefault()
        const files = [...(dt.files ?? [])]
        if (files.length) void uploadFiles(files)
      }}
    >
      {/* aria-live: การนำทาง/ถูกปฏิเสธ/reconcile ประกาศที่นี่เสมอ (TS-4/TS-9) */}
      <p role="status" aria-live="polite" data-testid="vault-tree-announce" className="sr-only">
        {announcementText ?? ''}
      </p>
      <p role="alert" data-testid="vault-tree-notice" className="text-[12.5px] text-ink-3 mb-3 min-h-[16px]">
        {announcementText ?? ''}
      </p>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {head && (
          <VaultBreadcrumbs
            t={t}
            items={tree.breadcrumbs.map((c) => ({ nodeId: c.nodeId, name: displayNodeName(t, c, rootId) }))}
            onNavigate={(id) => navigateTo(id)}
            canDrop={Boolean(tree.drag)}
            onDropTarget={(nodeId) => {
              const plan = planDrop(tree.state, nodeId)
              if (plan.ok) void tree.run(plan.intent)
              else tree.drop(nodeId)
            }}
          />
        )}
        <div className="flex-1" />
        <IconBtn label={t('vaultTreeRefresh')} onClick={() => void load()} data-testid="vault-tree-refresh">
          <RefreshCw size={15} strokeWidth={1.6} />
        </IconBtn>
        <Btn variant="outline" size="sm" onClick={() => tree.setView('trash')} aria-pressed={isTrashView}>
          {t('vaultTreeMenuTrash')}
        </Btn>
        <Btn variant="outline" size="sm" onClick={() => tree.setView('active')} aria-pressed={!isTrashView}>
          {t('vaultTreeViewActive')}
        </Btn>
        <Btn variant="outline" size="sm" onClick={() => onLock?.()}>
          <Lock size={14} strokeWidth={1.5} />
          {t('lockVault')}
        </Btn>
      </div>

      <div data-testid="vault-workspace-toolbar" className="flex items-center gap-2.5 mb-5 flex-wrap">
        <label className="relative flex-1 min-w-[220px] max-w-md">
          <span className="sr-only">{t('searchFilesPlaceholder')}</span>
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" aria-hidden="true" />
          <input
            data-testid="vault-workspace-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchFilesPlaceholder')}
            spellCheck="false"
            className="w-full h-10 pl-10 pr-4 rounded-full bg-sunken border border-line text-[16px] md:text-[13.5px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
        </label>
        <div className="w-40 max-md:flex-1">
          <PillSelect data-testid="vault-workspace-type-filter" aria-label={t('filter')} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            {VAULT_TYPE_FILTERS.map((value) => (
              <option key={value} value={value}>{t({ all: 'allFileTypes', images: 'vaultFilterImages', videos: 'vaultFilterVideos', documents: 'vaultFilterDocuments', archives: 'archives', other: 'other' }[value])}</option>
            ))}
          </PillSelect>
        </div>
        <div className="inline-flex items-center gap-0.5 bg-card border border-line rounded-full p-0.5">
          <button
            data-testid="vault-workspace-grid"
            type="button"
            aria-label={t('gridView')}
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
            className={`size-8 flex items-center justify-center rounded-full transition-colors duration-[var(--dur-fast)] cursor-pointer ${layout === 'grid' ? 'bg-ink text-card' : 'text-ink-3 hover:text-ink'}`}
          >
            <LayoutGrid size={15} strokeWidth={1.5} />
          </button>
          <button
            data-testid="vault-workspace-list"
            type="button"
            aria-label={t('listView')}
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
            className={`size-8 flex items-center justify-center rounded-full transition-colors duration-[var(--dur-fast)] cursor-pointer ${layout === 'list' ? 'bg-ink text-card' : 'text-ink-3 hover:text-ink'}`}
          >
            <List size={15} strokeWidth={1.5} />
          </button>
        </div>
        <div className="w-44 max-md:flex-1">
          <PillSelect data-testid="vault-workspace-sort" aria-label={t('sortBy')} value={sort} onChange={(event) => setSort(event.target.value)}>
            {VAULT_SORT_MODES.map((value) => (
              <option key={value} value={value}>{t({
                'name-asc': 'sortNameAsc', 'name-desc': 'sortNameDesc',
                'uploaded-desc': 'sortUploadedNewest', 'uploaded-asc': 'sortUploadedOldest',
                'modified-desc': 'sortModifiedNewest', 'modified-asc': 'sortModifiedOldest',
                'size-desc': 'sortSizeLargest', 'size-asc': 'sortSizeSmallest',
              }[value])}</option>
            ))}
          </PillSelect>
        </div>
        {tree.keyDegraded === false && !isTrashView && (
          <Btn variant="outline" data-testid="vault-tree-new-folder" onClick={() => setDialog({ kind: 'createFolder' })}>
            <FolderPlus size={15} strokeWidth={1.6} />
            {t('vaultTreeNewFolderTitle')}
          </Btn>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => { if (e.target.files?.length) void uploadFiles([...e.target.files]); e.target.value = '' }}
        />
        <Btn variant="primary" onClick={() => fileRef.current?.click()} data-testid="vault-tree-upload">
          <Plus size={15} strokeWidth={1.8} />
          {t('upload')}
        </Btn>
      </div>

      {loadState === 'loading' && <p className="text-[12.5px] text-ink-3 mb-4">{t('vaultTreeLoading')}</p>}
      {loadState === 'error' && (
        <Card className="p-5">
          <ErrorState t={t} kind="server" onRetry={() => void load()} />
        </Card>
      )}
      {(loadState === 'ready' || loadState === 'degraded') && (
        <VaultRecoveryPanel
          t={t}
          kek={kek}
          session={session}
          tree={tree}
          unlockedState={unlockedState}
          bothBad={loadState === 'degraded'}
          onRepaired={() => void load({ quiet: true })}
        />
      )}
      {uploadState && (
        <p data-testid="vault-tree-upload-progress" className="text-[12.5px] text-ink-2 mb-3">
          {t('vaultTreeUploadRunning', { name: uploadState.name, p: uploadState.percent })}
        </p>
      )}
      {tree.selection.size > 0 && (
        <div data-testid="vault-tree-selection-bar" role="region" aria-label={t('selected')} className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-2rem)] flex items-center justify-center gap-2 flex-wrap rounded-full border border-line bg-ink p-2 shadow-[var(--elev-2)]">
          <Chip tone="ok" data-testid="vault-tree-selection-count">
            {tree.selection.size === 1 ? t('vaultTreeSelectedCountOne') : t('vaultTreeSelectedCount', { n: tree.selection.size })}
          </Chip>
          {caps?.move && (
            <Btn size="sm" variant="outline" data-testid="vault-tree-bulk-move" onClick={() => setDialog({ kind: 'move', nodeIds: selectionRoots.map((n) => n.nodeId), names: selectionNames })}>
              {t('vaultTreeMenuMove')}
            </Btn>
          )}
          {caps?.trash && (
            <Btn size="sm" variant="outline" data-testid="vault-tree-bulk-trash" onClick={() => setDialog({ kind: 'trash', nodeIds: selectionRoots.map((n) => n.nodeId), count: selectionRoots.length })}>
              {t('vaultTreeMenuTrash')}
            </Btn>
          )}
          {caps?.download && (
            <Btn size="sm" variant="outline" data-testid="vault-tree-bulk-download" onClick={() => void startBulkDownload(selectionRoots)}>
              {t('vaultTreeMenuDownload')}
            </Btn>
          )}
          {caps?.restore && (
            <Btn size="sm" variant="outline" data-testid="vault-tree-bulk-restore" onClick={() => { const n = selectionRoots[0]; if (n) void runRestore(n.nodeId, null, n) }}>
              {t('vaultTreeMenuRestore')}
            </Btn>
          )}
          <Btn size="sm" variant="ghost" className="text-card hover:bg-white/10" onClick={() => tree.clear()}>
            {t('vaultTreeClearSelection')}
          </Btn>
        </div>
      )}
      {loadState === 'ready' && head && (
        workspace.folders.length === 0 && workspace.files.length === 0 ? (
          <Card>
            <EmptyState
              icon={FolderPlus}
              title={query || typeFilter !== 'all' ? t('emptyNoFilesFiltered') : isTrashView ? t('vaultTreeEmptyTrash') : t('vaultTreeEmptyFolderView')}
              action={!query && typeFilter === 'all' && !isTrashView && !tree.keyDegraded ? (
                <Btn variant="primary" size="sm" data-testid="vault-tree-new-folder-empty" onClick={() => setDialog({ kind: 'createFolder' })}>
                  {t('vaultTreeNewFolderTitle')}
                </Btn>
              ) : undefined}
            />
          </Card>
        ) : (
          <div
            ref={marqueeCanvasRef}
            data-testid="vault-tree-grid"
            data-vault-marquee-canvas=""
            data-layout={layout}
            onPointerDown={marquee.onPointerDown}
            className="relative space-y-6 min-h-[40vh]"
            style={{ userSelect: marquee.tracking ? 'none' : undefined }}
          >
            {marquee.box && (
              <div
                data-testid="vault-marquee-rect"
                aria-hidden="true"
                className="pointer-events-none absolute z-10 rounded-[4px] border border-accent"
                style={{
                  left: `${marquee.box.left}px`, top: `${marquee.box.top}px`,
                  width: `${marquee.box.width}px`, height: `${marquee.box.height}px`,
                  background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                }}
              />
            )}
            {workspace.folders.length > 0 && (
              <section data-testid="vault-folders-section" aria-labelledby="vault-folders-heading">
                <h2 id="vault-folders-heading" data-marquee-ignore="" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2.5">
                  {t('sectionFolders')}
                </h2>
                <div className={layout === 'grid' ? 'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]' : 'flex flex-col gap-2'}>
                  {workspace.folders.map((n) => (
                <VaultFolderTile
                  key={n.nodeId}
                  t={t}
                  node={n}
                  tileRef={registerMarqueeTile(n.nodeId)}
                  layout={layout}
                  view={tree.view}
                  childCount={childCountOf(head.index, n.nodeId)}
                  selected={tree.selection.has(n.nodeId)}
                  onSelect={tree.select}
                  onOpen={navigateTo}
                  onAction={actionFor}
                  keyDegraded={tree.keyDegraded}
                  {...dragPropsFor(n)}
                  {...dropPropsFor(n)}
                />
                  ))}
                </div>
              </section>
            )}
            {workspace.files.length > 0 && (
              <section data-testid="vault-files-section" aria-labelledby="vault-files-heading">
                <h2 id="vault-files-heading" data-marquee-ignore="" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2.5">
                  {t('sectionFiles')}
                </h2>
                <div data-testid={layout === 'list' ? 'vault-tree-list' : undefined} className={layout === 'grid' ? 'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]' : 'flex flex-col gap-2'}>
                  {workspace.files.map((n) => (
                <VaultFileTile
                  key={n.nodeId}
                  t={t}
                  node={n}
                  tileRef={registerMarqueeTile(n.nodeId)}
                  layout={layout}
                  view={tree.view}
                  previewKind={previewKindFor(n.mediaType)}
                  media={mediaFor(n)}
                  selected={tree.selection.has(n.nodeId)}
                  onSelect={tree.select}
                  onPreview={actionPreview}
                  onAction={actionFor}
                  keyDegraded={tree.keyDegraded}
                  {...dragPropsFor(n)}
                  {...dropPropsFor(n)}
                />
                  ))}
                </div>
              </section>
            )}
          </div>
        )
      )}

      {/* ── dialogs ─────────────────────────────────────────────────────────── */}
      {dialog?.kind === 'createFolder' && (
        <NewFolderDialog
          t={t} open onClose={() => setDialog(null)} siblingNames={siblingNamesOf(tree.current)}
          onSubmit={(name) => void onDialogSubmit.createFolder(name)} unlockedState={unlockedState}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameDialog
          t={t} open onClose={() => setDialog(null)} currentName={dialog.node.name}
          siblingNames={siblingNamesOf(dialog.node.parentNodeId, dialog.node.nodeId)}
          onSubmit={(name) => void onDialogSubmit.rename(name)} unlockedState={unlockedState}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          t={t} open onClose={() => setDialog(null)} folders={folderOptions}
          movingNames={dialog.names} currentParentNodeId={null}
          onMove={(dest) => void onDialogSubmit.move(dest)} unlockedState={unlockedState}
        />
      )}
      {dialog?.kind === 'details' && (
        <DetailsDialog
          t={t} lang={lang} open onClose={() => setDialog(null)} node={dialog.node}
          cipherSize={detailsCipher} unlockedState={unlockedState}
        />
      )}
      {dialog?.kind === 'trash' && (
        <TrashConfirmDialog
          t={t} open onClose={() => setDialog(null)} count={dialog.count}
          onConfirm={() => void onDialogSubmit.trash()} unlockedState={unlockedState}
        />
      )}
      {dialog?.kind === 'restore' && (
        <RestoreDialog
          t={t} open onClose={() => setDialog(null)} node={dialog.node} folders={folderOptions}
          originalParentAvailable={false} collisionForced={false}
          onRestore={(dest) => void onDialogSubmit.restore(dest)} unlockedState={unlockedState}
        />
      )}
      {preview && (
        <Modal open onClose={() => { URL.revokeObjectURL(preview.url); setPreview(null) }} width={720} labelledBy="vault-tree-preview-title">
          <ModalClose onClose={() => { URL.revokeObjectURL(preview.url); setPreview(null) }} label={t('close')} />
          <h2 id="vault-tree-preview-title" className="text-[15px] font-semibold mb-3 truncate">{preview.node.name}</h2>
          <div data-testid="vault-tree-preview" className="flex items-center justify-center">
            {preview.kind === 'image' ? (
              <img src={preview.url} alt={preview.node.name} className="max-h-[60vh] rounded-[10px]" />
            ) : (
              <video src={preview.url} controls muted playsInline className="max-h-[60vh] rounded-[10px]" />
            )}
          </div>
        </Modal>
      )}
      {tree.conflict && (
        <ConflictDialog
          t={t} open onClose={() => tree.resolveConflict('discard')}
          conflict={tree.conflict} choices={tree.conflict.choices}
          onChoice={(choice, extra = {}) => tree.resolveConflict(choice, extra)} unlockedState={unlockedState}
        />
      )}
    </div>
  )
}
