import { useCallback, useEffect, useRef, useState } from 'react'
import { TriangleAlert, Lock, LockOpen, FileText, FileImage, File as FileIcon, Plus, Download, KeyRound } from 'lucide-react'
import { Btn, Chip, Modal, ModalClose, ErrorState, EmptyState, SkeletonLoader, Card } from '../components/ui.jsx'
import { useApi, useReducedMotion } from '../lib/hooks.js'
import { apiFetch, apiFetchBytes } from '../lib/api.js'
import { fmtBytes } from '../lib/format.js'
import {
  createVaultSetup, unlockVault, encryptFileEnvelope, decryptBlobMeta,
  decryptFileContent, fileToBytes, ARGON2_DEFAULTS,
} from '../lib/vaultCrypto.js'

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

const EXT_ICONS = { docx: FileText, pdf: FileText, pptx: FileImage, png: FileImage, jpg: FileImage, jpeg: FileImage }
const iconFor = (name = '') => EXT_ICONS[name.split('.').pop()?.toLowerCase()] ?? FileIcon

/* A vault tile: plaintext rendering sits underneath; the hatch layer covers
   it completely while locked. Unlock peels the hatch away left→right. */
function VaultTile({ t, entry, unlocked, index, onDownload, busy }) {
  const Icon = unlocked && entry.name ? iconFor(entry.name) : FileIcon
  const delay = `${index * 40}ms`
  return (
    <div className="relative bg-card border border-line rounded-[var(--r-tile)] p-3 overflow-hidden group">
      <div className="h-28 rounded-[9px] bg-sunken flex items-center justify-center">
        <Icon size={34} strokeWidth={1.2} className={unlocked ? 'text-accent' : 'text-ink-3'} />
      </div>
      <p className="mt-2.5 text-[13.5px] font-medium text-ink truncate" title={unlocked ? entry.name : undefined}>
        {unlocked ? (entry.name ?? t('vaultUnnamed')) : `${entry.id}.aegisenc`}
      </p>
      <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmtBytes(entry.plainSize ?? entry.size)}
      </p>

      {/* ปุ่มดาวน์โหลดโผล่เฉพาะตอนปลดล็อก — ตอนล็อกไม่มีอะไรให้ดาวน์โหลดที่มีความหมาย */}
      {unlocked && entry.name && (
        <button
          type="button"
          onClick={() => onDownload(entry)}
          disabled={busy}
          aria-label={`${t('vaultDownload')} ${entry.name}`}
          className="absolute top-4 right-4 h-8 w-8 grid place-items-center rounded-full bg-card/90 border border-line text-ink-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-[var(--dur-fast)] hover:text-accent disabled:opacity-40"
        >
          <Download size={14} strokeWidth={1.8} />
        </button>
      )}

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
    </div>
  )
}

export function Vault({ t }) {
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
  const fileRef = useRef(null)

  const configured = vaultApi.data?.configured === true
  const blobs = vaultApi.data?.blobs ?? []
  const unlocked = Boolean(kek && entries)

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
        out.push({ id: b.id, name: meta.name, plainSize: meta.size, size: b.size, blob: b })
      } catch {
        // blob เสียหาย/ถูกแก้ — แสดงตาม id แทน ไม่ทำให้ทั้งจอล้ม
        out.push({ id: b.id, name: null, plainSize: null, size: b.size, blob: b })
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
      vaultApi.retry()
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
      const decrypted = await decryptEntries(key, blobs)
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
      if (!res.ok) {
        setActionError(true)
        setAddBusy(false)
        return
      }
      const b = res.data.blob
      setEntries((prev) => [
        { id: b.id, name: file.name, plainSize: file.size, size: b.size, blob: b },
        ...(prev ?? []),
      ])
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
      const res = await apiFetchBytes(`/api/vault/blobs/${entry.id}`)
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

  const openModal = (which) => {
    setModal(which)
    setFormError(null)
    setPass('')
    setPass2('')
    setAck(false)
    setAutoLocked(false)
  }

  if (vaultApi.loading) return <SkeletonLoader type="files" />
  if (vaultApi.error) return <Card><ErrorState t={t} kind={vaultApi.error} onRetry={vaultApi.retry} /></Card>

  const list = unlocked ? entries : blobs.map((b) => ({ id: b.id, name: null, size: b.size }))

  return (
    <div>
      {/* persistent, calm callout — this warning never goes away */}
      <div className="flex items-center gap-3 rounded-[var(--r-tile)] px-4 py-3 mb-5" style={{ background: 'var(--warn-soft)' }}>
        <TriangleAlert size={16} strokeWidth={1.8} style={{ color: 'var(--warn)' }} className="shrink-0" />
        <p className="text-[12.5px] font-semibold tracking-[0.04em]" style={{ color: 'var(--warn)' }}>
          {t('vaultWarning')}
        </p>
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

      {list.length === 0 ? (
        <Card>
          <EmptyState icon={Lock} title={t('emptyNoFiles')} hint={t('vaultKeyNote')} />
        </Card>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {list.map((entry, i) => (
            <VaultTile
              key={entry.id} t={t} entry={entry} unlocked={unlocked}
              index={reduced ? 0 : i} onDownload={download} busy={addBusy}
            />
          ))}
        </div>
      )}

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
