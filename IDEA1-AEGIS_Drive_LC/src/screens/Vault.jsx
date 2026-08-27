import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  TriangleAlert, Lock, LockOpen, FileText, FileImage, File as FileIcon, Plus, Download,
  KeyRound, MoreHorizontal, Trash2,
} from 'lucide-react'
import { Btn, Chip, Modal, ModalClose, ErrorState, EmptyState, SkeletonLoader, Card } from '../components/ui.jsx'
import { useApi, useReducedMotion } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch, apiFetchBytes } from '../lib/api.js'
import { fmtBytes } from '../lib/format.js'
import {
  createVaultSetup, unlockVault, encryptFileEnvelope, decryptBlobMeta,
  decryptFileContent, fileToBytes, ARGON2_DEFAULTS,
} from '../lib/vaultCrypto.js'
import {
  reconcileVaultInventory, addLocalVaultBlob, removeLocalVaultBlob,
  tombstoneVaultBlob, vaultBlobId, lockedVaultEntry,
} from '../lib/vaultInventory.js'

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

/* ── per-tile overflow menu ───────────────────────────────────────
   ภาษาการโต้ตอบเดียวกับจอ Files (MoreHorizontal มุมขวาบน → dropdown ปุ่มจริง)
   แต่ "รายการคำสั่ง" ไม่ใช่ชุดเดียวกัน: Vault ไม่มี Rename / Move / Secure Share /
   ตรวจ SHA เพราะเซิร์ฟเวอร์มองไม่เห็นอะไรเลยนอกจาก ciphertext — การยืมเมนูของ
   Files มาทั้งชุดคือการสัญญาสิ่งที่ระบบทำไม่ได้

   ⚠️ ขณะล็อก เมนูนี้ต้องไม่มีคำที่มาจาก plaintext แม้แต่คำเดียว และไม่มี Download
      เพราะสิ่งที่ดาวน์โหลดได้ตอนล็อกคือ .aegisenc ที่ผู้ใช้เปิดไม่ได้ */
function VaultTileMenu({ t, unlocked, onAction }) {
  const items = unlocked
    ? [
        { id: 'download', icon: Download, label: t('download') },
        { id: 'delete', icon: Trash2, label: t('delete'), danger: true },
      ]
    : [{ id: 'delete', icon: Trash2, label: t('vaultDeleteLockedAction'), danger: true }]

  return (
    <div
      role="menu"
      aria-label={t('moreActions')}
      className="absolute right-0 top-9 bg-card border border-line rounded-[var(--r-tile)] py-1.5 min-w-48 fade-in"
      style={{ boxShadow: 'var(--elev-2)', zIndex: 'var(--z-dropdown)' }}
    >
      {items.map(({ id, icon: Icon, label, danger }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          onClick={() => onAction(id)}
          className="w-full flex items-center gap-2.5 px-3.5 h-8 text-[13px] font-medium hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer text-left whitespace-nowrap"
          style={{ color: danger ? 'var(--danger)' : 'var(--ink-2)' }}
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
function VaultTile({ t, entry, unlocked, index, onDownload, onDelete, busy }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const menuRef = useRef(null)
  const named = unlocked && Boolean(entry.name)
  const Icon = named ? iconFor(entry.name) : FileIcon
  const delay = `${index * 40}ms`

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
    if (action === 'download') onDownload(entry)
    else if (action === 'delete') onDelete(entry)
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative bg-card border border-line rounded-[var(--r-tile)] p-3 overflow-hidden"
    >
      <div className="h-28 rounded-[9px] bg-sunken flex items-center justify-center">
        <Icon size={34} strokeWidth={1.2} className={unlocked ? 'text-accent' : 'text-ink-3'} />
      </div>
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
        {menuOpen && <VaultTileMenu t={t} unlocked={unlocked} onAction={runAction} />}
      </div>
    </div>
  )
}

export function Vault({ t, placeholderMode = false }) {
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
  /* บัญชี blob ทึบฝั่ง client — ดู src/lib/vaultInventory.js สำหรับเหตุผลเต็ม
     โดยย่อ: ผลของ POST ที่สำเร็จแล้วเป็นความจริงที่รู้แน่ทันที ไม่ควรต้องรอ GET
     รอบถัดไปมายืนยัน เพราะผู้ใช้กด Lock ชนะ refetch ได้เสมอ */
  const [localBlobs, setLocalBlobs] = useState([])
  const [removedIds, setRemovedIds] = useState(() => new Set())
  const [askDelete, setAskDelete] = useState(null) // { id, name|null, size, locked }
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  const fileRef = useRef(null)

  const configured = vaultApi.data?.configured === true
  const serverBlobs = vaultApi.data?.blobs ?? EMPTY_BLOBS
  const unlocked = Boolean(kek && entries)

  /* รายการ blob ทึบที่ "เป็นจริงตอนนี้" = server + POST ที่สำเร็จแล้ว − ที่ลบสำเร็จแล้ว
     dedupe ด้วย id เข้มงวด GET ที่ตามมาทีหลังจึงไม่สร้างการ์ดใบที่สอง */
  const inventory = useMemo(
    () => reconcileVaultInventory({ serverBlobs, localBlobs, removedIds }),
    [serverBlobs, localBlobs, removedIds],
  )

  /* ── ล็อก: ทิ้งกุญแจ + plaintext ทั้งหมดจาก memory ─────────────────────
     ตั้ง state กลับเป็น null ตรง ๆ — ไม่มี "สำเนาสำรอง" ที่ไหนให้ต้องตามล้าง
     เพราะไม่เคยเขียนกุญแจลง storage ใดตั้งแต่ต้น */
  const lock = useCallback((auto = false) => {
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
  }, [])

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

  /** ถอด metadata ของทุก blob ด้วย KEK ที่เพิ่งได้ — เนื้อไฟล์ยังไม่ถูกดึงลงมา */
  const decryptEntries = async (key, list) => {
    const out = []
    for (const b of list) {
      try {
        const meta = await decryptBlobMeta(key, b)
        out.push({ id: vaultBlobId(b), name: meta.name, plainSize: meta.size, size: b.size, blob: b })
      } catch {
        // blob เสียหาย/ถูกแก้ — แสดงตาม id แทน ไม่ทำให้ทั้งจอล้ม
        out.push({ id: vaultBlobId(b), name: null, plainSize: null, size: b.size, blob: b })
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

  /* ── อัปโหลด: เข้ารหัสก่อน แล้วค่อยมี network call ─────────────────── */
  const addFile = async (file) => {
    if (!file || !kek || addBusy) return
    setAddBusy(true)
    setActionError(false)
    try {
      const bytes = await fileToBytes(file)
      // ★ ทุกอย่างถูกเข้ารหัสตรงนี้ — บรรทัดถัดไปคือ network call แรกที่เกิดขึ้น
      const env = await encryptFileEnvelope(kek, {
        name: file.name, type: file.type, size: file.size, bytes,
      })

      const form = new FormData()
      // ชื่อไฟล์ใน multipart เป็นค่าทึบโดยเจตนา — ชื่อจริงอยู่ใน metaB64 ที่เข้ารหัสแล้ว
      form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
      form.append('ivB64', env.ivB64)
      form.append('wrappedDekB64', env.wrappedDekB64)
      form.append('wrapIvB64', env.wrapIvB64)
      form.append('metaIvB64', env.metaIvB64)
      form.append('metaB64', env.metaB64)

      const res = await apiFetch('/api/vault/blobs', { method: 'POST', body: form, timeoutMs: 120_000 })
      const b = res.ok ? res.data?.blob : null
      // ⚠️ อัปโหลดล้มเหลว = ไม่มีอะไรถูกเพิ่ม ทั้งในบัญชีทึบและใน entries ที่ถอดแล้ว
      //    การ์ดผีที่หายไปเองตอน refetch คือการโกหกผู้ใช้ว่าไฟล์ถูกเก็บแล้ว
      if (!b || b.id === undefined || b.id === null) {
        setActionError(true)
        setAddBusy(false)
        return
      }
      const id = vaultBlobId(b)
      // ★ สองบรรทัดนี้ต้องเกิด "ก่อน" การ refetch ใด ๆ: ผู้ใช้กด Lock ได้ทันทีในจังหวะนี้
      //   และ blob ที่เพิ่งอัปโหลดต้องยังอยู่บนจอในรูป ciphertext
      setLocalBlobs((prev) => addLocalVaultBlob(prev, b))
      setEntries((prev) => (prev ? [
        { id, name: file.name, plainSize: file.size, size: b.size, blob: b },
        ...prev.filter((e) => vaultBlobId(e) !== id),
      ] : prev))
      // reconcile กับสถานะจริงของ server แบบเงียบ ๆ — dedupe ด้วย id ทำให้ไม่เกิดการ์ดซ้ำ
      vaultApi.refresh()
    } catch {
      setActionError(true)
    }
    setAddBusy(false)
  }

  /* ── ดาวน์โหลด: ดึง ciphertext → แกะ DEK → ถอด → ค่อยส่งให้เบราว์เซอร์เซฟ ──
     ไม่ใช้ <a href> ตรงไปที่ endpoint เพราะผู้ใช้จะได้ .aegisenc ที่เปิดไม่ได้ */
  const download = async (entry) => {
    if (!kek || addBusy) return
    setAddBusy(true)
    setActionError(false)
    let url = null
    try {
      const res = await apiFetchBytes(`/api/vault/blobs/${encodeURIComponent(entry.id)}`)
      if (!res.ok) {
        setActionError(true)
        setAddBusy(false)
        return
      }
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
      // ของแท็บนานกว่าที่จำเป็น
      if (url) setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setAddBusy(false)
    }
  }

  /* ── ลบไฟล์ในห้องนิรภัย ─────────────────────────────────────────
     ใช้ DELETE /api/vault/blobs/:id ที่มีอยู่แล้ว — ไม่มี endpoint ใหม่ และ
     ⚠️ ไม่มี user id ใด ๆ ใน request: สิทธิ์มาจาก req.user ฝั่ง server เท่านั้น

     นโยบายที่เลือก: "ลบได้ขณะล็อก" พร้อมคำยืนยันที่หนักกว่า
     เหตุผล — ห้องนิรภัยที่กุญแจหายคือสภาวะที่ตั้งใจให้กู้คืนไม่ได้ ถ้าปิดการลบ
     ขณะล็อก ผู้ใช้ที่ลืมกุญแจจะเหลือ blob ที่ทั้งเปิดไม่ได้และลบไม่ได้ตลอดไป
     สิทธิ์ฝั่ง server เท่ากันทั้งสองกรณีอยู่แล้ว สิ่งที่ต่างคือผู้ใช้ระบุไฟล์ไม่ได้
     กล่องยืนยันตอนล็อกจึงพูดตรง ๆ ว่า AEGIS แสดงชื่อไฟล์เดิมให้ไม่ได้ และแสดง
     เฉพาะสิ่งที่ระบบเห็นจริง: opaque id + ขนาด ciphertext
     ⚠️ ห้ามถอดรหัส metadata เพียงเพื่อเติมข้อความในกล่องนี้เด็ดขาด */
  const requestDelete = (entry) => {
    const named = unlocked && Boolean(entry.name)
    setDeleteError(false)
    setAskDelete({
      id: vaultBlobId(entry),
      name: named ? entry.name : null,
      size: entry.size,
      locked: !named,
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
              index={reduced ? 0 : i} onDownload={download} onDelete={requestDelete}
              busy={addBusy}
            />
          ))}
        </div>
      )}

      {/* ── ยืนยันการลบ ─────────────────────────────────────────────
          กล่องเดียว สองโหมด: ปลดล็อกอยู่ = เอ่ยชื่อไฟล์ที่ถอดแล้วได้ตามจริง
          ล็อกอยู่ = ห้ามมีชื่อไฟล์ / MIME / นามสกุลเดิม แม้ใน aria ใด ๆ */}
      <Modal open={!!askDelete} onClose={closeDelete} width={440} labelledBy="vault-del-title">
        <ModalClose onClose={closeDelete} label={t('cancel')} />
        <h2 id="vault-del-title" className="text-[18px] font-semibold text-ink pr-8">
          {askDelete?.locked
            ? t('vaultDeleteLockedTitle', { id: `${askDelete?.id}.aegisenc` })
            : t('vaultDeleteTitle', { name: askDelete?.name ?? '' })}
        </h2>
        <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">
          {askDelete?.locked ? t('vaultDeleteLockedBody') : t('vaultDeleteBody')}
        </p>

        {/* ตอนล็อก แสดง "เท่าที่ระบบเห็นจริง" เท่านั้น — id ทึบ + ขนาด ciphertext */}
        {askDelete?.locked && (
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
