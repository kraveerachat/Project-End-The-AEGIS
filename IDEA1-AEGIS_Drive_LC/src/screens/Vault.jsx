import { useState } from 'react'
import { TriangleAlert, Lock, LockOpen, FileText, FileImage, File as FileIcon } from 'lucide-react'
import { Btn, Chip, Modal, ModalClose } from '../components/ui.jsx'
import { useReducedMotion } from '../lib/hooks.js'
import { fmtBytes } from '../lib/format.js'
import { VAULT_FILES, VAULT_DEMO_KEY } from '../lib/data.js'

const EXT_ICONS = { docx: FileText, pdf: FileText, pptx: FileImage }

/* A vault tile: the plaintext rendering sits underneath; the hatch layer
   covers it completely while locked. Unlock peels the hatch away left→right,
   tile by tile — the system rendering what it can finally read. */
function VaultTile({ t, file, unlocked, index }) {
  const Icon = EXT_ICONS[file.ext] ?? FileIcon
  const delay = `${index * 40}ms`
  return (
    <div className="relative bg-card border border-line rounded-[var(--r-tile)] p-3 overflow-hidden">
      {/* plaintext (what decryption reveals) */}
      <div className="h-28 rounded-[9px] bg-sunken flex items-center justify-center">
        <Icon size={34} strokeWidth={1.2} className={unlocked ? 'text-accent' : 'text-ink-3'} />
      </div>
      <p className="mt-2.5 text-[13.5px] font-medium text-ink truncate" title={file.name}>{file.name}</p>
      <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(file.size)}</p>

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
      {/* locked caption sits ON the veil */}
      <div
        className="absolute inset-x-0 bottom-0 p-3 transition-opacity duration-300 pointer-events-none"
        style={{ opacity: unlocked ? 0 : 1, transitionDelay: delay }}
      >
        <p className="text-[13px] font-medium text-ink truncate bg-card/90 rounded-[6px] px-2 py-1" title={file.name}>{file.name}</p>
        <p className="font-mono text-[10px] text-ink-3 mt-1.5 tracking-[0.02em]">{t('vaultCipherCaption')}</p>
      </div>
    </div>
  )
}

export function Vault({ t }) {
  const reduced = useReducedMotion()
  const [unlocked, setUnlocked] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState(false)
  const [shake, setShake] = useState(false)

  // กุญแจถูกตรวจ "ในเบราว์เซอร์" เท่านั้น — ไม่มี network call ตรงนี้โดยเจตนา
  // ระบบจริง: ใช้กุญแจ derive ผ่าน PBKDF2/Argon2 แล้วถอดรหัส AES-GCM ฝั่ง client
  // เซิร์ฟเวอร์ไม่เคยเห็นทั้งกุญแจและ plaintext — Zero-Knowledge โดยสถาปัตยกรรม
  const tryUnlock = () => {
    if (key === VAULT_DEMO_KEY) {
      setModalOpen(false)
      setKey('')
      setKeyError(false)
      setUnlocked(true)
    } else {
      setKeyError(true)
      setShake(true)
      setTimeout(() => setShake(false), 300)
    }
  }

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
          <Btn variant="outline" onClick={() => setUnlocked(false)}>
            <Lock size={14} strokeWidth={1.5} />
            {t('lockVault')}
          </Btn>
        ) : (
          <Btn variant="primary" onClick={() => { setModalOpen(true); setKeyError(false) }}>
            <LockOpen size={14} strokeWidth={1.5} />
            {t('unlockVault')}
          </Btn>
        )}
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {VAULT_FILES.map((file, i) => (
          <VaultTile key={file.id} t={t} file={file} unlocked={unlocked} index={reduced ? 0 : i} />
        ))}
      </div>

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
            value={key}
            onChange={(e) => { setKey(e.target.value); setKeyError(false) }}
            onKeyDown={(e) => e.key === 'Enter' && tryUnlock()}
            placeholder="••••••••••••"
            autoComplete="off"
            className="w-full h-12 px-4 rounded-full bg-sunken border font-mono text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            style={{ borderColor: keyError ? 'var(--danger)' : 'var(--line)' }}
          />
          {keyError && (
            <p role="alert" aria-live="assertive" className="text-[12.5px] font-medium mt-2" style={{ color: 'var(--danger)' }}>
              {t('vaultWrongKey')}
            </p>
          )}
          <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">{t('vaultKeyNote')}</p>
          <Btn variant="primary" className="w-full mt-5" onClick={tryUnlock} disabled={!key}>
            {t('decrypt')}
          </Btn>
          <p className="text-[11px] text-ink-3 mt-3 text-center font-mono">demo key · {VAULT_DEMO_KEY}</p>
        </div>
      </Modal>
    </div>
  )
}
