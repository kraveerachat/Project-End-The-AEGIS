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
import { Btn, Card, EmptyState, ErrorState, IconBtn, Modal, ModalClose, PillSelect } from '../components/ui.jsx'
import { SelectionAction, SelectionActionBar } from '../components/SelectionActionBar.jsx'
import { VaultBreadcrumbs } from '../components/vault/VaultBreadcrumbs.jsx'
import { VaultFolderTile } from '../components/vault/VaultFolderTile.jsx'
import { VaultFileTile } from '../components/vault/VaultFileTile.jsx'
import { VaultUploadDrawer } from '../components/VaultUploadDrawer.jsx'
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
import { createImageDecodeAdmission } from '../lib/vaultImageDecodeAdmission.js'
import { gifMotionCapability, openGifMotion } from '../lib/vaultGifPreview.js'
import { openVideoMotion, openVideoPoster, videoPosterEstimateBytes, videoPreviewCapability, VIDEO_CAPABILITY } from '../lib/vaultVideoPreview.js'
import { attachPosterVideo, drawPosterFrame } from '../lib/vaultVideoDom.js'
import { closePreviewSession, openPreviewSession, supportsLargeVideoPreview } from '../lib/vaultPreviewSession.js'
import { createVaultPreviewBlob } from '../lib/vaultPreviewBlob.js'
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
import { isInternalItemDrag, isExternalFileDrag, writeDragPayload, readDragPayload } from '../lib/fileDragDrop.js'
import { decryptFileContent, decryptBlobMeta } from '../lib/vaultCrypto.js'
import { decryptVaultV2Meta, unwrapVaultV2Dek } from '../lib/vaultChunkCrypto.js'
import { reconcileVaultAfterUpload } from '../lib/vaultPostUploadReconcile.js'
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
  t, lang = 'en', kek, treeState = null, unlockedState = null, onLock, recoveryScope = null,
  sessionFactory = createTreeSession, defaultApi = treeApi, mediaPreviewEnabled = false,
  marqueeSurfaceRef = null, registerMarqueePointerDown = null,
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
  const [uploadOpen, setUploadOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const previewUrlRef = useRef(null)
  const previewStreamToken = useRef(null)
  const previewRequestRef = useRef(0)
  const [detailsCipher, setDetailsCipher] = useState(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [sort, setSort] = useState(DEFAULT_VAULT_SORT)
  const [layout, setLayout] = useState('grid')
  const purgeRef = useRef(() => {})
  const uploadQueueRef = useRef(null)
  const head = tree.state.head

  const releaseTreePreview = useCallback(() => {
    previewRequestRef.current += 1
    if (previewStreamToken.current) {
      const token = previewStreamToken.current
      previewStreamToken.current = null
      void closePreviewSession(token)
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreview(null)
  }, [])

  useEffect(() => releaseTreePreview, [releaseTreePreview])

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
    setUploadOpen(false)
    releaseTreePreview()
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
  const runVaultUpload = useCallback(async (file, { parentNodeId, signal, onStage, onProgress, onSession, resume = null, name = file.name, mediaType = file.type ?? '' }) => {
    if (!kek || !treeRef.current?.state?.head) return { ok: false, stage: 'failed', reason: 'NOT_READY' }
    try {
      const res = await uploadTreeFile({ kek, file, parentNodeId, session, unlockedState, signal, onStage, onProgress, onSession, resume, name, mediaType })
      if (!res?.ok) {
        if (res && res.stage !== 'cancelled') announce('vaultTreeUploadFailed')
        return res
      }
      // Manifest CAS and opaque blob inventory are separate authoritative facts.
      // Do not mark this upload complete until both converge in this session.
      await reconcileVaultAfterUpload({
        reloadHead: async () => {
          const nextHead = await session.loadHead()
          treeRef.current.refreshHead(nextHead)
          return nextHead
        },
        reloadInventory: () => vaultApi.refresh(),
      })
      announce('vaultTreeUploadComplete', { name })
      return res
    } catch (error) {
      if (error?.name !== 'AbortError' && error?.code !== 'ABORTED') announce('vaultTreeUploadFailed')
      throw error
    }
  }, [kek, session, unlockedState, vaultApi.refresh])

  const enqueueVaultFiles = useCallback((files, parentNodeId = treeRef.current?.current) => {
    uploadQueueRef.current?.enqueueFiles(files, { parentNodeId })
  }, [])

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
    if (!blob) { announce('vaultTreePreviewFailed'); return }
    const ref = { formatVersion: node.blobRef.formatVersion, id: String(node.blobRef.id) }
    releaseTreePreview()
    const request = previewRequestRef.current
    const plainSize = node.plainSize ?? Math.max(0, (blob?.size ?? 0) - (blob?.chunkCount ?? 0) * 16)
    setPreview({ node, kind, url: null, loading: true, failed: false, tooLarge: false, streamed: false })
    try {
      // Preserve the proven PR157 range-decryption path for large V2 video.
      // The worker receives a non-extractable key and serves only requested ranges;
      // no plaintext route or whole-file fallback is introduced.
      if (ref.formatVersion === 2 && kind === 'video' && plainSize > MAX_PREVIEW_CEILING_BYTES) {
        if (!supportsLargeVideoPreview()) {
          if (request === previewRequestRef.current) setPreview({ node, kind, url: null, loading: false, failed: false, tooLarge: true, streamed: false })
          return
        }
        const dek = await unwrapVaultV2Dek(kek, blob)
        if (request !== previewRequestRef.current) return
        const secureSession = await openPreviewSession({
          dek, blob, contentType: node.mediaType || 'video/mp4', plainSize,
          isUnlocked: () => !unlockedState?.isPurged?.(), unlockedState,
        })
        if (request !== previewRequestRef.current || unlockedState?.isPurged?.()) {
          if (secureSession?.token) await closePreviewSession(secureSession.token)
          return
        }
        if (!secureSession?.ok) throw new Error(secureSession?.reason ?? 'PREVIEW_SESSION')
        previewStreamToken.current = secureSession.token
        setPreview({ node, kind, url: secureSession.url, loading: false, failed: false, tooLarge: false, streamed: true })
        return
      }
      if (ref.formatVersion === 2 && plainSize > MAX_PREVIEW_CEILING_BYTES) {
        if (request === previewRequestRef.current) setPreview({ node, kind, url: null, loading: false, failed: false, tooLarge: true, streamed: false })
        return
      }
      let bytes = null
      if (ref.formatVersion === 2) {
        const sink = createBufferedSink()
        const res = await downloadVaultV2({ kek, blob, sink })
        if (!res.ok) throw new Error(res.reason ?? 'PREVIEW')
        bytes = res.result
      } else {
        const r = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(ref.id)}`)
        if (!r.ok) throw new Error('PREVIEW')
        bytes = await decryptFileContent(kek, blob, r.bytes)
      }
      if (request !== previewRequestRef.current || unlockedState?.isPurged?.()) return
      const url = URL.createObjectURL(createVaultPreviewBlob(bytes, node.mediaType || 'application/octet-stream'))
      unlockedState?.registerObjectUrl?.(url)
      previewUrlRef.current = url
      setPreview({ node, kind, url, loading: false, failed: false, tooLarge: false, streamed: false })
    } catch {
      if (request === previewRequestRef.current) setPreview({ node, kind, url: null, loading: false, failed: true, tooLarge: false, streamed: false })
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
  const admission = useMemo(() => {
    if (!mediaEnabled || !unlockedState || !head) return null
    return createImageDecodeAdmission({
      limits: mediaLimitsRef.current,
      liveMemoryBytes: () => schedulerRef.current?.stats().estMemBytes ?? 0,
    })
  }, [mediaEnabled, unlockedState, Boolean(head)])

  useEffect(() => () => { void admission?.releaseAll?.() }, [admission])

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

  // Inventory and manifest refresh independently after upload. Keep one bounded
  // scheduler alive and let its jobs read the latest render state; rebuilding it
  // for every inventory response would revoke ready posters and requeue the
  // whole folder ahead of the newly uploaded video.
  const mediaHeadRef = useRef(head)
  const mediaBlobIndexRef = useRef(blobIndex)
  const readNodeBytesRef = useRef(readNodeBytes)
  mediaHeadRef.current = head
  mediaBlobIndexRef.current = blobIndex
  readNodeBytesRef.current = readNodeBytes

  const scheduler = useMemo(() => {
    if (!mediaEnabled || !unlockedState || !head) return null
    const nextScheduler = createThumbScheduler({
      limits: mediaLimitsRef.current,
      unlockedState,
      load: async (key, { signal } = {}) => {
        const node = mediaHeadRef.current?.index.nodes.get(key)
        if (!node?.blobRef) throw new Error('NOT_FOUND')
        const blob = mediaBlobIndexRef.current.get(refKey(node.blobRef))
        if (!blob) throw Object.assign(new Error('BLOB_NOT_READY'), { code: 'BLOB_NOT_READY' })
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
              const bytes = await readNodeBytesRef.current({ node, blob, signal })
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
        const thumb = await makeImageThumb({
          plainSize: node.plainSize ?? 0, limits: mediaLimitsRef.current,
          variant: node.blobRef?.formatVersion ?? 1,
          chunkCount: 1,
          readChunk: () => readNodeBytesRef.current({ node, blob, signal }),
          readWhole: () => readNodeBytesRef.current({ node, blob, signal }),
          admission, signal, skipUrl: true,
        })
        if (!thumb.ok) throw new Error(thumb.unsupported)
        return { width: thumb.width, height: thumb.height, bytes: thumb.posterBytes }
      },
      onChange: () => setMediaMap(nextScheduler.snapshot()),
    })
    return nextScheduler
  }, [mediaEnabled, unlockedState, Boolean(head), kek, admission])
  schedulerRef.current = scheduler

  useEffect(() => () => { void scheduler?.releaseAll?.() }, [scheduler])

  const prevFolderRef = useRef(null)
  useEffect(() => {
    if (!scheduler || !head) return
    if (prevFolderRef.current !== null && prevFolderRef.current !== tree.current) {
      scheduler.releaseFolder(prevFolderRef.current)
    }
    prevFolderRef.current = tree.current
    for (const n of tree.children) {
      if (n.kind === 'file' && (previewKindFor(n.mediaType) === 'image' || previewKindFor(n.mediaType) === 'video')) {
        const kind = previewKindFor(n.mediaType)
        scheduler.observe(n.nodeId, {
          folderId: tree.current,
          estimateBytes: kind === 'video'
            ? videoPosterEstimateBytes({
              variant: n.blobRef?.formatVersion ?? 1,
              supportsLarge: supportsLargeVideoPreview(),
              plainSize: n.plainSize ?? 0,
            })
            : n.plainSize ?? 0,
          eligible: Boolean(n.blobRef && blobIndex.has(refKey(n.blobRef))),
        })
      }
    }
  }, [scheduler, head, tree.children, tree.current, blobIndex])

  const motionRequestRef = useRef(0)
  useEffect(() => () => { void motionState?.release?.() }, [motionState])

  const openNodeVideoSession = useCallback(async (node, blob, signal = null) => {
    const variant = node.blobRef?.formatVersion ?? 1
    const plainSize = node.plainSize ?? 0
    if (variant === 2 && supportsLargeVideoPreview()) {
      const dek = await unwrapVaultV2Dek(kek, blob)
      const secureSession = await openPreviewSession({
        dek, blob, contentType: node.mediaType || 'video/mp4', plainSize,
        isUnlocked: () => !unlockedState?.isPurged?.(), unlockedState,
      })
      if (!secureSession?.ok) throw new Error(secureSession?.reason ?? 'PREVIEW_SESSION')
      return secureSession
    }
    if (plainSize > MAX_PREVIEW_CEILING_BYTES) throw new Error('TOO_LARGE')
    const bytes = await readNodeBytes({ node, blob, signal })
    const url = URL.createObjectURL(new Blob([bytes], { type: node.mediaType || 'video/mp4' }))
    unlockedState?.registerObjectUrl?.(url)
    return { ok: true, token: `local:${url}`, url }
  }, [kek, readNodeBytes, unlockedState])

  const closeNodeVideoSession = useCallback(async (token) => {
    if (String(token).startsWith('local:')) {
      URL.revokeObjectURL(String(token).slice(6))
      return
    }
    await closePreviewSession(token)
  }, [])

  const mediaMotionStart = useCallback(async (node) => {
    if (!mediaEnabled || reducedMotion || node.kind !== 'file') return
    const mime = normalizeMimeType(node.mediaType)
    const isGif = mime === 'image/gif'
    const isVideo = previewKindFor(mime) === 'video'
    if (!isGif && !isVideo) return
    const request = ++motionRequestRef.current
    setMotionState(null)
    try {
      const node0 = head.index.nodes.get(node.nodeId)
      const blob = blobIndex.get(refKey(node.blobRef))
      if (!node0 || !blob) return
      let res
      if (isGif) {
        const cap = gifMotionCapability({ plainSize: node.plainSize ?? 0, limits: mediaLimitsRef.current, schedulerMemBytes: schedulerRef.current?.stats().estMemBytes ?? 0 })
        if (!cap.ok) return
        const bytes = await readNodeBytes({ node: node0, blob })
        res = await openGifMotion({ plainSize: node.plainSize ?? 0, limits: mediaLimitsRef.current, readWhole: async () => bytes, unlockedState })
      } else {
        res = await openVideoMotion({
          variant: node.blobRef?.formatVersion ?? 1,
          mediaType: mime,
          openSession: ({ signal } = {}) => openNodeVideoSession(node0, blob, signal),
          closeSession: closeNodeVideoSession,
        })
      }
      if (!res?.ok) return
      if (request !== motionRequestRef.current || unlockedState?.isPurged?.()) {
        await res.release?.()
        return
      }
      setMotionState({ nodeId: node.nodeId, kind: isVideo ? 'video' : 'gif', url: res.url, release: res.release })
    } catch { /* poster remains the truthful fallback */ }
  }, [mediaEnabled, reducedMotion, head, blobIndex, readNodeBytes, unlockedState, openNodeVideoSession, closeNodeVideoSession])
  const mediaMotionEnd = useCallback(() => {
    motionRequestRef.current += 1
    setMotionState(null)
  }, [])

  const mediaFor = (node) => {
    if (!mediaEnabled || node.kind !== 'file') return null
    const mime = normalizeMimeType(node.mediaType)
    const entry = mediaMap.get(node.nodeId)
    const isGif = mime === 'image/gif'
    const isVideo = previewKindFor(mime) === 'video'
    if (entry?.failed && !entry.url) {
      const reason = entry.reason ?? 'THUMB_FAILED'
      return {
        reason,
        reasonLabel: reason === 'HIGH_RES_TOO_LARGE' ? t('vaultHighResPreviewTooLarge') : null,
      }
    }
    return {
      posterUrl: entry?.url ?? null,
      reason: null,
      hoverEnabled: Boolean((isGif || isVideo) && !reducedMotion),
      motionUrl: motionState?.nodeId === node.nodeId ? motionState.url : null,
      motionKind: motionState?.nodeId === node.nodeId ? motionState.kind : null,
      onHoverStart: (isGif || isVideo) ? () => void mediaMotionStart(node) : undefined,
      onHoverEnd: (isGif || isVideo) ? () => mediaMotionEnd() : undefined,
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
  const localMarqueeCanvasRef = useRef(null)
  const marqueeCanvasRef = marqueeSurfaceRef ?? localMarqueeCanvasRef
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
  useEffect(() => {
    if (!registerMarqueePointerDown) return undefined
    registerMarqueePointerDown(marquee.onPointerDown)
    return () => registerMarqueePointerDown(null)
  }, [registerMarqueePointerDown, marquee.onPointerDown])
  useEffect(() => {
    const surface = marqueeCanvasRef.current
    if (!surface) return undefined
    surface.style.userSelect = marquee.tracking ? 'none' : ''
    return () => { surface.style.userSelect = '' }
  }, [marquee.tracking, marqueeCanvasRef])
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
    const rootCopy = dialog?.kind === 'move' ? t('vaultTreeMoveRootName') : t('vaultTreeRootName')
    return [{ nodeId: rootId, name: rootCopy, depth: 0 }, ...options]
  }, [head, dialog, tree.selection, t])

  const executeDropMove = useCallback(async (destinationNodeId, dt) => {
    let nodeIds = readDragPayload(dt)
    if (!nodeIds.length && tree.drag?.nodeIds) {
      nodeIds = tree.drag.nodeIds
    }
    if (!nodeIds.length && tree.selection.size) {
      nodeIds = [...tree.selection]
    }
    if (!nodeIds.length) return false
    const validRoots = normalizeRootsSafe(head?.index, nodeIds).map((n) => n.nodeId)
    if (!validRoots.length) return false
    const intent = intents.move({ nodeIds: validRoots, destinationNodeId })
    const plan = planDrop(tree.state, destinationNodeId, { intentOverride: intent })
    if (!plan.ok) {
      if (plan.reason !== 'NO_OP') {
        const reason = plan.reason ?? 'INVALID'
        const k = REJECT_COPY[reason] ?? 'vaultTreeDropDefault'
        announce(k, REJECT_COPY[reason] ? undefined : { reason })
      }
      tree.drop(destinationNodeId)
      return false
    }
    try {
      tree.drop(destinationNodeId, plan.intent)
      const res = await tree.run(plan.intent)
      tree.clear()
      return Boolean(res && !res.conflict)
    } catch {
      return false
    }
  }, [head, tree, announce])

  const dragPropsFor = (node) => ({
    draggable: true,
    onDragStart: (e) => {
      const selected = tree.selection.has(node.nodeId) ? [...tree.selection] : [node.nodeId]
      const nodeIds = normalizeRootsSafe(head?.index, selected).map((n) => n.nodeId)
      try {
        writeDragPayload(e.dataTransfer, nodeIds)
        e.dataTransfer.setData('text/plain', 'aegis-internal-move')
        e.dataTransfer.effectAllowed = 'move'
      } catch { /* jsdom has no DataTransfer behaviors beyond setters */ }
      tree.dragStart(node.nodeId)
    },
    onDragEnd: () => tree.dragEnd(),
  })
  const dropPropsFor = (node) => ({
    onDragOver: (e) => {
      const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
      if (isInternalItemDrag(dt) || tree.drag) {
        if (node.kind === 'folder') {
          e.preventDefault()
          if (dt) dt.dropEffect = 'move'
        }
        return
      }
      const hasFiles = isExternalFileDrag(dt)
      if (hasFiles && node.kind === 'folder') e.preventDefault()
    },
    onDrop: (e) => {
      const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
      if (isInternalItemDrag(dt) || tree.drag) {
        e.preventDefault()
        e.stopPropagation()
        if (node.kind !== 'folder') return
        void executeDropMove(node.nodeId, dt)
        return
      }
      if (isExternalFileDrag(dt)) {
        if (node.kind !== 'folder') return
        e.preventDefault()
        e.stopPropagation()
        const files = [...(dt.files ?? [])]
        if (files.length) enqueueVaultFiles(files, node.nodeId)
      }
    },
  })

  /* ── render ──────────────────────────────────────────────────────────────── */
  const rootId = head?.manifest.rootNodeId ?? null
  const isTrashView = tree.view === 'trash'
  const ownsMarqueeSurface = !marqueeSurfaceRef
  return (
    <div
      ref={ownsMarqueeSurface ? marqueeCanvasRef : null}
      data-testid="vault-tree-screen"
      data-vault-marquee-surface={ownsMarqueeSurface ? '' : undefined}
      data-vault-marquee-canvas={ownsMarqueeSurface ? '' : undefined}
      onPointerDown={ownsMarqueeSurface ? marquee.onPointerDown : undefined}
      className={ownsMarqueeSurface
        ? 'vault-full-pane-surface vault-pane-content vault-tree-content relative flex-1'
        : 'vault-pane-content vault-tree-content flex-1'}
      style={{ userSelect: marquee.tracking ? 'none' : undefined }}
      onDragOver={(e) => {
        const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
        if (!isInternalItemDrag(dt) && isExternalFileDrag(dt) && !isTrashView) e.preventDefault()
      }}
      onDrop={(e) => {
        const dt = e.dataTransfer ?? e.nativeEvent?.dataTransfer
        if (isInternalItemDrag(dt) || !isExternalFileDrag(dt) || isTrashView) return
        e.preventDefault()
        const files = [...(dt.files ?? [])]
        if (files.length) enqueueVaultFiles(files)
      }}
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
      {/* aria-live: การนำทาง/ถูกปฏิเสธ/reconcile ประกาศที่นี่เสมอ (TS-4/TS-9) */}
      <p role="status" aria-live="polite" data-testid="vault-tree-announce" data-marquee-ignore="" className="sr-only">
        {announcementText ?? ''}
      </p>
      <p role="alert" data-testid="vault-tree-notice" data-marquee-ignore="" className="text-[12.5px] text-ink-3 mb-3 min-h-[16px]">
        {announcementText ?? ''}
      </p>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {head && (
          <VaultBreadcrumbs
            t={t}
            items={tree.breadcrumbs.map((c) => ({ nodeId: c.nodeId, name: displayNodeName(t, c, rootId) }))}
            onNavigate={(id) => navigateTo(id)}
            canDrop={Boolean(tree.drag)}
            onDropTarget={(nodeId, dt) => {
              void executeDropMove(nodeId, dt)
            }}
          />
        )}
        <div className="flex-1" />
        <IconBtn label={t('vaultTreeRefresh')} onClick={() => void load()} data-testid="vault-tree-refresh">
          <RefreshCw size={15} strokeWidth={1.6} />
        </IconBtn>
        <Btn variant="outline" size="sm" onClick={() => onLock?.()}>
          <Lock size={14} strokeWidth={1.5} />
          {t('lockVault')}
        </Btn>
      </div>

      <div data-testid="vault-workspace-toolbar" data-marquee-ignore="" className="flex items-center gap-2.5 mb-5 flex-wrap">
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
        <div className="w-36 max-md:flex-1">
          <PillSelect
            data-testid="vault-workspace-view"
            aria-label={t('vaultTreeViewActive')}
            value={tree.view}
            onChange={(event) => tree.setView(event.target.value)}
          >
            <option value="active">{t('vaultTreeViewActive')}</option>
            <option value="trash">{t('vaultTreeMenuTrash')}</option>
          </PillSelect>
        </div>
        {tree.keyDegraded === false && !isTrashView && (
          <Btn variant="outline" data-testid="vault-tree-new-folder" onClick={() => setDialog({ kind: 'createFolder' })}>
            <FolderPlus size={15} strokeWidth={1.6} />
            {t('vaultTreeNewFolderTitle')}
          </Btn>
        )}
        <Btn variant="primary" onClick={() => setUploadOpen(true)} data-testid="vault-tree-upload">
          <Plus size={15} strokeWidth={1.8} />
          {t('upload')}
        </Btn>
      </div>

      {loadState === 'loading' && <p data-marquee-ignore="" className="text-[12.5px] text-ink-3 mb-4">{t('vaultTreeLoading')}</p>}
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
      {tree.selection.size > 0 && (
        <SelectionActionBar
          data-testid="vault-tree-selection-bar"
          data-marquee-ignore=""
          label={tree.selection.size === 1 ? t('vaultTreeSelectedCountOne') : t('vaultTreeSelectedCount', { n: tree.selection.size })}
          clearLabel={t('vaultTreeClearSelection')}
          onClear={() => tree.clear()}
        >
          <span className="sr-only" data-testid="vault-tree-selection-count">
            {tree.selection.size === 1 ? t('vaultTreeSelectedCountOne') : t('vaultTreeSelectedCount', { n: tree.selection.size })}
          </span>
          {caps?.move && (
            <SelectionAction data-testid="vault-tree-bulk-move" onClick={() => setDialog({ kind: 'move', nodeIds: selectionRoots.map((n) => n.nodeId), names: selectionNames })}>
              {t('vaultTreeMenuMove')}
            </SelectionAction>
          )}
          {caps?.trash && (
            <SelectionAction danger data-testid="vault-tree-bulk-trash" onClick={() => setDialog({ kind: 'trash', nodeIds: selectionRoots.map((n) => n.nodeId), count: selectionRoots.length })}>
              {t('vaultTreeMenuTrash')}
            </SelectionAction>
          )}
          {caps?.download && (
            <SelectionAction data-testid="vault-tree-bulk-download" onClick={() => void startBulkDownload(selectionRoots)}>
              {t('vaultTreeMenuDownload')}
            </SelectionAction>
          )}
          {caps?.restore && (
            <SelectionAction data-testid="vault-tree-bulk-restore" onClick={() => { const n = selectionRoots[0]; if (n) void runRestore(n.nodeId, null, n) }}>
              {t('vaultTreeMenuRestore')}
            </SelectionAction>
          )}
        </SelectionActionBar>
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
            data-testid="vault-tree-workspace"
            className="min-h-[60vh] pb-24"
          >
            <div
              data-testid="vault-tree-grid"
              data-layout={layout}
              className="space-y-6"
            >
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
          </div>
        )
      )}

      {/* ── dialogs ─────────────────────────────────────────────────────────── */}
      <VaultUploadDrawer
        ref={uploadQueueRef}
        t={t}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        destination={`/${(tree.breadcrumbs ?? []).map((node) => displayNodeName(t, node, head?.manifest?.rootNodeId)).filter(Boolean).join('/')}`}
        parentNodeId={tree.current}
        onUpload={runVaultUpload}
        kek={kek}
        recoveryScope={recoveryScope}
      />

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
        <Modal open onClose={releaseTreePreview} width={720} labelledBy="vault-tree-preview-title">
          <ModalClose onClose={releaseTreePreview} label={t('close')} />
          <h2 id="vault-tree-preview-title" className="text-[15px] font-semibold mb-3 truncate">{preview.node.name}</h2>
          <div data-testid="vault-tree-preview" className="min-h-56 rounded-[var(--r-tile)] border border-line bg-sunken flex items-center justify-center overflow-hidden">
            {preview.loading ? (
              <p role="status" className="text-[13px] text-ink-3 px-6 py-10">{t('vaultDecrypting')}</p>
            ) : preview.tooLarge ? (
              <p role="status" data-vault-preview-too-large="1" className="text-[13px] text-ink-2 px-6 py-10 text-center max-w-md">{t('vaultPreviewTooLarge')}</p>
            ) : preview.failed ? (
              <p role="alert" className="text-[13px] font-medium px-6 py-10 text-center max-w-md" style={{ color: 'var(--danger)' }}>{t('vaultPreviewUnavailable')}</p>
            ) : preview.kind === 'image' ? (
              <img src={preview.url} alt={preview.node.name} className="max-h-[60vh] rounded-[10px]" />
            ) : (
              <video
                src={preview.url}
                controls
                muted
                playsInline
                preload={preview.streamed ? 'metadata' : 'auto'}
                data-vault-preview-streamed={preview.streamed ? '1' : '0'}
                className="max-h-[60vh] rounded-[10px]"
              />
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
