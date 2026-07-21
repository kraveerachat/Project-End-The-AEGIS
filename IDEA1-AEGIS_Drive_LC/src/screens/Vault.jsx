import { useRef, useState } from 'react'
import { TriangleAlert, Lock, LockOpen, FileText, FileImage, File as FileIcon, Plus } from 'lucide-react'
import { Btn, Chip, Modal, ModalClose, ErrorState, EmptyState, SkeletonLoader, Card } from '../components/ui.jsx'
import { useApi, useReducedMotion } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'
import { fmtBytes } from '../lib/format.js'
import { deriveVaultKey, decryptVaultJson, encryptVaultJson, fileToB64 } from '../lib/vaultCrypto.js'

/* ⚠️ Zero-Knowledge จริง (Phase 2):
   - GET /api/vault ให้แค่ salt + verifier + ciphertext blobs
   - การปลดล็อก = derive กุญแจจาก passphrase "ในเบราว์เซอร์" (PBKDF2-600k) แล้วลอง
     ถอด verifier — GCM auth ล้มเหลว = passphrase ผิด (ไม่มี oracle ฝั่ง server)
   - ชื่อไฟล์/เนื้อหา อ่านออกเฉพาะหลังถอดรหัสสำเร็จ — ขณะล็อก จอนี้แสดงได้แค่
     ขนาด ciphertext เพราะ "ไม่มีใคร" (รวมทั้ง server) รู้มากกว่านั้นจริง ๆ
   - กุญแจอยู่ใน React state (non-extractable CryptoKey) — กดล็อก/ปิดแท็บ = หาย */

const EXT_ICONS = { docx: FileText, pdf: FileText, pptx: FileImage }
const iconFor = (name = '') => EXT_ICONS[name.split('.').pop()] ?? FileIcon

/* A vault tile: plaintext rendering sits underneath; the hatch layer covers
   it completely while locked. Unlock peels the hatch away left→right. */
function VaultTile({ t, entry, unlocked, index }) {
  const Icon = unlocked && entry.name ? iconFor(entry.name) : FileIcon
  const delay = `${index * 40}ms`
  return (
    <div className="relative bg-card border border-line rounded-[var(--r-tile)] p-3 overflow-hidden">
      <div className="h-28 rounded-[9px] bg-sunken flex items-center justify-center">
        <Icon size={34} strokeWidth={1.2} className={unlocked ? 'text-accent' : 'text-ink-3'} />
      </div>
      <p className="mt-2.5 text-[13.5px] font-medium text-ink truncate" title={unlocked ? entry.name : undefined}>
        {unlocked ? entry.name : `${entry.id}.aegisenc`}
      </p>
      <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(entry.size)}</p>

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
      {/* locked caption sits ON the veil — เท่าที่ระบบ "เห็นจริง": id + ขนาด */}
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

  const [key, setKey] = useState(null)          // CryptoKey — memory เท่านั้น
  const [entries, setEntries] = useState(null)  // [{id, name, size}] หลังถอดรหัส
  const [modalOpen, setModalOpen] = useState(false)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [keyError, setKeyError] = useState(false)
  const [shake, setShake] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState(false)
  const fileRef = useRef(null)

  const unlocked = Boolean(key && entries)
  const blobs = vaultApi.data?.blobs ?? []

  const tryUnlock = async () => {
    if (busy || !pass) return
    setBusy(true)
    setKeyError(false)
    try {
      // ทั้งหมดนี้เกิดในเบราว์เซอร์ — ไม่มี network round-trip ใด ๆ ระหว่างตรวจกุญแจ
      const k = await deriveVaultKey(pass, vaultApi.data.saltB64)
      await decryptVaultJson(k, vaultApi.data.verifier) // ผิด → throw 'wrong-key'
      const decrypted = []
      for (const b of blobs) {
        try {
          const meta = await decryptVaultJson(k, b)
          decrypted.push({ id: b.id, name: meta.name, size: b.size })
        } catch {
          decrypted.push({ id: b.id, name: null, size: b.size }) // blob เสียหาย — แสดงตาม id
        }
      }
      setKey(k)
      setEntries(decrypted)
      setModalOpen(false)
      setPass('')
    } catch {
      setKeyError(true)
      setShake(true)
      setTimeout(() => setShake(false), 300)
    }
    setBusy(false)
  }

  const lock = () => {
    // ทิ้งกุญแจ + plaintext ทั้งหมดจาก memory — เท่ากับสถานะก่อนปลดล็อก
    setKey(null)
    setEntries(null)
  }

  const addFile = async (file) => {
    if (!file || !key || addBusy) return
    if (file.size > 2_000_000) { setAddError(true); return } // เดโม่: ≤2MB (Phase 3: สตรีมเป็นชิ้น)
    setAddBusy(true)
    setAddError(false)
    try {
      const contentB64 = await fileToB64(file)
      // เข้ารหัสทั้ง metadata และเนื้อไฟล์ฝั่ง client — server ได้แค่ ciphertext
      const payload = await encryptVaultJson(key, { name: file.name, size: file.size, contentB64 })
      const res = await apiFetch('/api/vault/blobs', {
        method: 'POST',
        body: { ...payload, size: file.size },
      })
      if (!res.ok) { setAddError(true); setAddBusy(false); return }
      setEntries((prev) => [...(prev ?? []), { id: res.data.blob.id, name: file.name, size: file.size }])
      vaultApi.retry()
    } catch {
      setAddError(true)
    }
    setAddBusy(false)
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
          {unlocked ? t('vaultUnlocked') : t('vaultLocked')}
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
            <Btn variant="outline" onClick={lock}>
              <Lock size={14} strokeWidth={1.5} />
              {t('lockVault')}
            </Btn>
          </>
        ) : (
          <Btn variant="primary" onClick={() => { setModalOpen(true); setKeyError(false) }}>
            <LockOpen size={14} strokeWidth={1.5} />
            {t('unlockVault')}
          </Btn>
        )}
      </div>

      {addError && (
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
            <VaultTile key={entry.id} t={t} entry={entry} unlocked={unlocked} index={reduced ? 0 : i} />
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} width={420} labelledBy="vault-unlock-title">
        <ModalClose onClose={() => setModalOpen(false)} label={t('close')} />
        <div className={shake ? 'shake-x' : ''}>
          <h2 id="vault-unlock-title" className="text-[18px] font-semibold text-ink">{t('unlockVault')}</h2>
          <label htmlFor="vault-key" className="block text-[13px] font-medium text-ink-2 mt-5 mb-1.5">
            {t('vaultKeyLabel')}
          </label>
          <input
            id="vault-key"
            type="password"
            value={pass}
            onChange={(e) => { setPass(e.target.value); setKeyError(false) }}
            onKeyDown={(e) => e.key === 'Enter' && tryUnlock()}
            placeholder="••••••••••••"
            autoComplete="off"
            disabled={busy}
            className="w-full h-12 px-4 rounded-full bg-sunken border font-mono text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            style={{ borderColor: keyError ? 'var(--danger)' : 'var(--line)' }}
          />
          {keyError && (
            <p role="alert" aria-live="assertive" className="text-[12.5px] font-medium mt-2" style={{ color: 'var(--danger)' }}>
              {t('vaultWrongKey')}
            </p>
          )}
          <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">{t('vaultKeyNote')}</p>
          <Btn variant="primary" className="w-full mt-5" onClick={tryUnlock} disabled={!pass || busy}>
            {busy ? t('signingIn') : t('decrypt')}
          </Btn>
        </div>
      </Modal>
    </div>
  )
}
