import { useEffect, useRef, useState } from 'react'
import { Monitor, KeyRound, Database, ShieldCheck, Palette, LogOut, Plus, Trash2, ImagePlus, LayoutTemplate, Check } from 'lucide-react'
import {
  Card, CardTitle, Chip, Btn, Segmented, Field, PillInput,
  ErrorState, EmptyState, SkeletonLoader, NotYetImplemented, Avatar,
  Modal, ModalClose,
} from '../components/ui.jsx'
import { canAdministrate } from '../lib/authz.js'
import { useApi, useNow } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch } from '../lib/api.js'
import { fmtRelative } from '../lib/format.js'
import { LANGS } from '../lib/strings.js'
import { BackupConfiguration, BackupTargetList } from '../components/BackupConfiguration.jsx'

// ⚠️ ถอด "คีย์กู้คืน 12 คำ" ออกทั้งฟีเจอร์ (2026-07-26) — ห้ามเอากลับมาในรูปนี้
//
// ของเดิมเป็น security theater ที่ "โกหกผู้ใช้ตรง ๆ": สุ่ม 12 คำจากลิสต์ 36 คำด้วย
// Math.random() (ไม่ใช่ CSPRNG) ผ่าน .sort(() => 0.5 - Math.random()) ซึ่ง shuffle
// ไม่สม่ำเสมอ แล้ว **ไม่เคยส่งไปไหนและไม่เคยเชื่อมกับ vaultCrypto.js เลย** —
// ไฟล์นี้ไม่ได้ import มันด้วยซ้ำ ไม่มี endpoint ฝั่งเซิร์ฟเวอร์รองรับ
// แต่ UI เขียนว่า "Anyone with these words can decrypt your Vault" และ
// "only this recovery phrase can restore access" ทั้งสองประโยคเป็นเท็จ
//
// อันตรายจริงคือ **ผู้ใช้เชื่อว่ามีทางกู้แล้วเลิกกังวลเรื่องจำ passphrase** →
// ลืม passphrase = ข้อมูลหายถาวรจริง ๆ โดยที่ระบบเคยสัญญาว่าจะกู้ได้
//
// สถาปัตยกรรมที่ตกลงกันไว้คือ **ไม่มีการกู้คืน passphrase และจะไม่มี** เพราะ
// เซิร์ฟเวอร์ไม่มีชิ้นส่วนใดที่ใช้ derive KEK ได้เลย (KEK = Argon2id(passphrase, salt)
// ในเบราว์เซอร์เท่านั้น) — จอ Vault พูดตรงตามนี้อยู่แล้วผ่าน `vaultWarning` และ
// `vaultSetupAck` การ์ดใบนี้เป็นที่เดียวในแอปที่ขัดกับความจริงนั้น จึงถูกถอดออก
// ดู [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] ที่ระบุว่า BIP-39 "ยังไม่ได้ build"
//
// ถ้าวันหนึ่งจะทำ mnemonic ของจริง: จุดต่อคือ vaultCrypto.js (derive KEK จาก
// mnemonic entropy แทน passphrase ที่ผู้ใช้พิมพ์) ต้องใช้ wordlist BIP-39 ครบ 2048 คำ
// + crypto.getRandomValues() + checksum และมันก็ยัง "ไม่ใช่การกู้คืนที่เซิร์ฟเวอร์ช่วยได้"
// อยู่ดี — เป็นแค่การย้ายภาระจากการจำไปเป็นการเก็บกระดาษ

/* ── Profile — ชื่อที่ผู้ใช้ตั้งเอง + รูปโปรไฟล์ (ของจริงทั้งคู่) ──────────────────
   ⚠️ สามชื่อในจอนี้คนละหน้าที่กัน และตั้งใจให้เห็นครบ:
      username     = ตัวระบุที่แก้ไม่ได้ (audit log อ้างอิงค่านี้)
      accountName  = ชื่อที่ Admin ตั้งตอน provision (จอ Access ใช้ยืนยันตัวบุคคล)
      displayName  = ชื่อที่ "เจ้าตัว" ตั้งเอง ทับ accountName ในการแสดงผลทั่วแอป
   การซ่อน username ไว้จะทำให้ผู้ใช้เปลี่ยนชื่อตัวเองเป็นชื่อคนอื่นแล้วแยกไม่ออก */
function ProfileCard({ t, user, role, onSaved }) {
  const [name, setName] = useState(user.displayName ?? '')
  const [saving, setSaving] = useState(false)
  const [state, setState] = useState(null) // null | 'saved' | 'error'
  const [avatarBust, setAvatarBust] = useState(0)
  const [avatarErr, setAvatarErr] = useState(null) // null | 'size' | 'type' | 'failed'
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const dirty = name.trim() !== (user.displayName ?? '').trim()

  const save = async (e) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setState(null)
    const res = await apiFetch('/api/profile', { method: 'PATCH', body: { displayName: name } })
    setSaving(false)
    if (!res.ok) { setState('error'); return }
    setState('saved')
    onSaved?.(res.data.user)
  }

  const pickAvatar = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // เลือกไฟล์เดิมซ้ำได้ (input file ไม่ยิง change ถ้าค่าไม่เปลี่ยน)
    if (!file || busy) return
    setAvatarErr(null)
    // เช็คขนาดฝั่ง client เพื่อบอกผู้ใช้ทันทีโดยไม่ต้องอัปโหลดขึ้นไปให้ถูกปฏิเสธ —
    // ⚠️ นี่คือความสะดวก ไม่ใช่การควบคุม: เพดานจริงบังคับที่เซิร์ฟเวอร์ (multer + sanitize)
    if (file.size > 2 * 1024 * 1024) { setAvatarErr('size'); return }

    setBusy(true)
    const form = new FormData()
    form.append('avatar', file)
    const res = await apiFetch('/api/profile/avatar', { method: 'POST', body: form, timeoutMs: 30_000 })
    setBusy(false)
    if (!res.ok) {
      setAvatarErr(res.status === 413 ? 'size' : res.status === 415 ? 'type' : 'failed')
      return
    }
    setAvatarBust((n) => n + 1) // บังคับ Avatar โหลดใหม่ (URL เดิม เนื้อหาใหม่)
  }

  const removeAvatar = async () => {
    if (busy) return
    setBusy(true)
    setAvatarErr(null)
    const res = await apiFetch('/api/profile/avatar', { method: 'DELETE' })
    setBusy(false)
    if (res.ok || res.status === 404) setAvatarBust((n) => n + 1)
    else setAvatarErr('failed')
  }

  return (
    <Card className="p-5">
      <CardTitle>{t('profile')}</CardTitle>

      <div className="flex items-start gap-4 flex-wrap">
        <Avatar key={avatarBust} userId={user.id} name={user.displayName} size={56} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">{user.displayName}</p>
          <p className="font-mono text-[12px] text-ink-3">
            {user.username} · {canAdministrate(role) ? t('roleAdmin') : t('roleUser')}
          </p>
          {user.accountName && user.accountName !== user.displayName && (
            <p className="text-[12px] text-ink-3 mt-1">{t('profileAccountName')}: {user.accountName}</p>
          )}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <Btn variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <ImagePlus size={14} strokeWidth={1.5} />
              {t('avatarUpload')}
            </Btn>
            <Btn variant="dangerSoft" size="sm" onClick={removeAvatar} disabled={busy}>
              {t('avatarRemove')}
            </Btn>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={pickAvatar}
              className="hidden"
              aria-label={t('avatarUpload')}
            />
          </div>
          <p className="text-[11.5px] text-ink-3 mt-2 max-w-[52ch] leading-relaxed">{t('avatarHint')}</p>
          {avatarErr && (
            <p role="alert" className="text-[12.5px] font-medium mt-1.5" style={{ color: 'var(--danger)' }}>
              {avatarErr === 'size' ? t('avatarTooLarge') : avatarErr === 'type' ? t('avatarUnsupported') : t('actionFailed')}
            </p>
          )}
        </div>
      </div>

      <form onSubmit={save} className="mt-5 pt-4 border-t border-line">
        <Field id="profile-name" label={t('profileName')}>
          <PillInput
            id="profile-name"
            value={name}
            maxLength={80}
            placeholder={user.accountName ?? ''}
            onChange={(e) => { setName(e.target.value); setState(null) }}
          />
        </Field>
        <p className="text-[11.5px] text-ink-3 mt-1.5 max-w-[56ch] leading-relaxed">{t('profileNameHint')}</p>
        <div className="flex items-center gap-3 mt-3">
          <Btn variant="primary" size="sm" type="submit" disabled={saving || !dirty}>
            {saving ? t('saving') : t('saveProfile')}
          </Btn>
          {state === 'saved' && <span className="text-[12.5px] font-medium" style={{ color: 'var(--ok)' }}>{t('saved')}</span>}
          {state === 'error' && <span role="alert" className="text-[12.5px] font-medium" style={{ color: 'var(--danger)' }}>{t('actionFailed')}</span>}
        </div>
      </form>
    </Card>
  )
}

/* ── Change password — เดิมเป็นฟอร์มที่ปุ่มไม่ผูกกับอะไรเลย (กดแล้วไม่เกิดอะไร) ──
   ตอนนี้ยิง POST /api/password/reset ซึ่งเป็น endpoint เดียวกับที่ด่าน force-reset ใช้ */
function ChangePasswordCard({ t }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // null | 'ok' | 'weak' | 'wrong' | 'error'

  const submit = async (e) => {
    e.preventDefault()
    if (busy || !cur || !next) return
    setBusy(true)
    setResult(null)
    const res = await apiFetch('/api/password/reset', {
      method: 'POST',
      body: { currentPassword: cur, newPassword: next },
    })
    setBusy(false)
    if (res.ok) { setResult('ok'); setCur(''); setNext(''); return }
    // แยกสามกรณีให้ผู้ใช้แก้ถูกจุด: รหัสเดิมผิด / รหัสใหม่ไม่ผ่านนโยบาย / ระบบพัง
    setResult(res.status === 401 ? 'wrong' : res.status === 400 ? 'weak' : 'error')
  }

  const MSG = { ok: ['ok', 'pwUpdated'], weak: ['danger', 'pwWeak'], wrong: ['danger', 'pwWrongCurrent'], error: ['danger', 'actionFailed'] }
  const msg = result ? MSG[result] : null

  return (
    <Card className="p-5">
      <CardTitle>{t('changePassword')}</CardTitle>
      <form onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field id="pw-cur" label={t('currentPassword')}>
            <PillInput id="pw-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => { setCur(e.target.value); setResult(null) }} />
          </Field>
          <Field id="pw-new" label={t('newPassword')}>
            <PillInput id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => { setNext(e.target.value); setResult(null) }} />
          </Field>
        </div>
        <p className="text-[11.5px] text-ink-3 mt-2">{t('pwPolicyHint')}</p>
        <div className="flex items-center gap-3 mt-4">
          <Btn variant="primary" type="submit" disabled={busy || !cur || !next}>
            {busy ? t('saving') : t('updatePassword')}
          </Btn>
          {msg && (
            <span
              role={msg[0] === 'danger' ? 'alert' : 'status'}
              className="text-[12.5px] font-medium"
              style={{ color: msg[0] === 'ok' ? 'var(--ok)' : 'var(--danger)' }}
            >
              {t(msg[1])}
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}

/* ── Active sessions — อ่านจาก session store จริง และเพิกถอนได้จริง ───────────────
   ⚠️ เดิมจอนี้แสดงแถวคงที่หนึ่งแถว ('This browser' / ip '—') ที่เซิร์ฟเวอร์แต่งขึ้นทุกครั้ง
   ตอนนี้เป็น ip/User-Agent/เวลาจริงของทุกเซสชันที่ยังมีชีวิตของบัญชีนี้
   ⚠️ volatile = session store เป็น MemoryStore: รายการหายทั้งหมดเมื่อเซิร์ฟเวอร์รีสตาร์ท
   (ทุกคนถูก log out พร้อมกัน) — บอกผู้ใช้ตรง ๆ ดีกว่าให้เข้าใจว่าเป็นทะเบียนถาวร */
function SessionsCard({ t, api, now, placeholderMode = false }) {
  const sessions = api.data?.sessions ?? []
  const fetchError = visibleFetchError(api.error, placeholderMode)
  const [revoking, setRevoking] = useState(null)

  const revoke = async (ref) => {
    setRevoking(ref)
    await apiFetch(`/api/sessions/${encodeURIComponent(ref)}`, { method: 'DELETE' })
    setRevoking(null)
    api.retry()
  }

  return (
    <Card className="p-5">
      <CardTitle sub={api.data?.volatile ? t('sessionsVolatileNote') : undefined}>{t('activeSessions')}</CardTitle>
      {api.loading ? (
        <SkeletonLoader type="table" />
      ) : fetchError ? (
        <ErrorState t={t} kind={fetchError} onRetry={api.retry} />
      ) : sessions.length === 0 ? (
        <EmptyState icon={Monitor} title={t('emptyNoSessions')} hint={t('emptyNoSessionsHint')} />
      ) : (
        <div className="flex flex-col">
          {sessions.map((s) => (
            <div key={s.ref ?? s.lastSeenAt} className="flex items-center gap-3 py-3 border-b border-line last:border-b-0 flex-wrap">
              <Monitor size={16} strokeWidth={1.5} className="text-ink-3 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink flex items-center gap-2 flex-wrap">
                  {/* User-Agent ดิบไม่ใช่ชื่ออุปกรณ์ — แสดงแบบย่อและกำกับว่ามาจาก UA */}
                  <span className="truncate max-w-[42ch]" title={s.userAgent ?? undefined}>
                    {s.userAgent ? shortDevice(s.userAgent) : t('deviceUnknown')}
                  </span>
                  {s.current && <Chip tone="accent">{t('thisDevice')}</Chip>}
                </p>
                <p className="font-mono text-[11.5px] text-ink-3 mt-0.5">
                  {s.ip ?? '—'} · {t('lastActive')} {s.lastSeenAt ? fmtRelative(t, s.lastSeenAt, now) : '—'}
                </p>
              </div>
              {!s.current && s.ref && (
                <Btn variant="dangerSoft" size="sm" onClick={() => revoke(s.ref)} disabled={revoking === s.ref}>
                  <LogOut size={13} strokeWidth={1.5} />
                  {t('revokeSession')}
                </Btn>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** ชื่อเบราว์เซอร์/ระบบปฏิบัติการแบบคร่าว ๆ จาก User-Agent
 *  ⚠️ UA เป็นค่าที่ client ตั้งเองได้ — ค่านี้เป็น "สิ่งที่เบราว์เซอร์อ้าง" ไม่ใช่ข้อเท็จจริง
 *     ที่ตรวจสอบได้ จึงใช้ช่วยผู้ใช้จำอุปกรณ์ของตัวเองเท่านั้น ห้ามใช้เชิงความปลอดภัย */
function shortDevice(ua) {
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : null
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox' : null
  if (browser && os) return `${browser} · ${os}`
  return browser ?? os ?? ua.slice(0, 40)
}

function Row({ label, children, note }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5 border-b border-line last:border-b-0 flex-wrap">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-ink">{label}</p>
        {note && <p className="text-[12px] text-ink-3 mt-0.5 max-w-[46ch] leading-relaxed">{note}</p>}
      </div>
      {children}
    </div>
  )
}

function InterfaceStylePreview({ value, label, description, active, onSelect, disabled }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      disabled={disabled}
      className={`interface-style-preview ${active ? 'is-active' : ''}`}
    >
      <span className={`interface-style-preview__canvas is-${value}`} aria-hidden>
        <span className="interface-style-preview__sidebar" />
        <span className="interface-style-preview__content">
          <span className="interface-style-preview__bar" />
          <span className="interface-style-preview__cards"><i /><i /><i /></span>
        </span>
        {active && <span className="interface-style-preview__check"><Check size={11} strokeWidth={2.5} /></span>}
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-[13px] font-semibold text-ink">{label}</span>
        <span className="block text-[11.5px] text-ink-3 leading-snug mt-0.5">{description}</span>
      </span>
    </button>
  )
}

export function Settings({ t, lang, setLang, theme, setTheme, density, setDensity, interfaceStyle = 'classic', onInterfaceStyleChange, role, user, onProfileSaved, initialTab = 'appearance', preferenceSaving = false, preferenceError = false, placeholderMode = false }) {
  const now = useNow(30_000)
  const [tab, setTab] = useState(initialTab)
  const [pendingInterfaceStyle, setPendingInterfaceStyle] = useState(null)
  useEffect(() => setTab(initialTab), [initialTab])
  // เซสชันที่ยัง active ของ "ผู้ใช้ปัจจุบัน" — จาก session store จริงฝั่งเซิร์ฟเวอร์
  const sessionsApi = useApi('/api/sessions')

  // Admin governance — Network zones (Admin เท่านั้น ดู server/rbac)
  // ⚠️ การ์ด "Encryption keys / rotate" ถูกถอดออกทั้งใบ พร้อม /api/keys ทั้งสอง endpoint:
  //    มันรายงานกุญแจ master AES-256-GCM ที่ไม่มีอยู่จริงในระบบนี้ และปุ่ม rotate ก็แค่
  //    เขียนเวลาใหม่ทับตัวแปรในหน่วยความจำ (ไฟล์ Data Lake เก็บเป็น plaintext บนดิสก์;
  //    ไฟล์ Vault เข้ารหัสด้วยกุญแจที่ derive ในเบราว์เซอร์ซึ่งเซิร์ฟเวอร์ไม่มีชิ้นส่วนเลย)
  //    เหตุผลเต็มอยู่ที่หัวหมวด Network zones ใน server/db/store.js
  const zonesApi = useApi('/api/zones')
  const zones = zonesApi.data?.zones ?? []
  const zonesError = visibleFetchError(zonesApi.error, placeholderMode)
  const [zoneName, setZoneName] = useState('')
  const [zoneCidr, setZoneCidr] = useState('')
  const [zoneErr, setZoneErr] = useState(false)

  const addZone = async (e) => {
    e.preventDefault()
    const { ok } = await apiFetch('/api/zones', { method: 'POST', body: { name: zoneName, cidr: zoneCidr } })
    if (!ok) { setZoneErr(true); return }
    setZoneErr(false)
    setZoneName('')
    setZoneCidr('')
    zonesApi.retry()
  }

  const removeZone = async (id) => {
    const { ok } = await apiFetch(`/api/zones/${id}`, { method: 'DELETE' })
    if (ok) zonesApi.retry()
  }

  // Administration ปรากฏ "เฉพาะ" เมื่อ role เป็น admin — filter ก่อน .map()
  // role อื่นต้องไม่พบร่องรอยของกลุ่มนี้ใน DOM เลย (Information Disclosure)
  const groups = [
    { id: 'appearance', icon: Palette, labelKey: 'setAppearance' },
    { id: 'account', icon: Monitor, labelKey: 'setAccount' },
    { id: 'security', icon: KeyRound, labelKey: 'setSecurity' },
    { id: 'storagedata', icon: Database, labelKey: 'setStorageData' },
    ...(canAdministrate(role) ? [{ id: 'admin', icon: ShieldCheck, labelKey: 'setAdmin' }] : []),
  ]
  const activeTab = groups.some((g) => g.id === tab) ? tab : 'appearance'

  const closeStyleConfirmation = () => {
    if (!preferenceSaving) setPendingInterfaceStyle(null)
  }

  const confirmStyleChange = async () => {
    if (!pendingInterfaceStyle || preferenceSaving) return
    const saved = await onInterfaceStyleChange?.(pendingInterfaceStyle)
    if (saved) setPendingInterfaceStyle(null)
  }

  return (
    <>
    <div className="settings-layout grid grid-cols-12 gap-6 max-lg:gap-5">
      {/* sub-nav */}
      <div className="col-span-3 max-lg:col-span-12">
        <nav className="flex flex-col gap-1 max-lg:flex-row max-lg:flex-wrap" aria-label={t('settingsTitle')}>
          {groups.map(({ id, icon: Icon, labelKey }) => {
            const active = activeTab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={active ? 'page' : undefined}
                className={`settings-section-button flex items-center gap-2.5 h-10 px-4 rounded-full text-[13.5px] font-medium transition-[background-color,color,transform,box-shadow] duration-[var(--dur-fast)] cursor-pointer ${
                  active ? 'is-active bg-ink text-card' : 'text-ink-2 hover:bg-card'
                }`}
              >
                <Icon size={15} strokeWidth={1.5} />
                {t(labelKey)}
              </button>
            )
          })}
        </nav>
      </div>

      <div className="col-span-9 max-lg:col-span-12">
        {activeTab === 'appearance' && (
          <Card className="p-5 fade-in">
            <CardTitle>{t('setAppearance')}</CardTitle>
            {preferenceSaving && <p role="status" className="mb-2 text-xs text-ink-3">{t('preferencesSaving')}</p>}
            {preferenceError && <p role="alert" className="mb-2 text-xs text-danger">{t('preferencesSaveFailed')}</p>}
            <Row label={t('theme')}>
              <Segmented
                ariaLabel={t('theme')}
                options={[
                  { value: 'light', label: t('themeLight') },
                  { value: 'dark', label: t('themeDark') },
                  { value: 'system', label: t('themeSystem') },
                ]}
                value={theme}
                onChange={setTheme}
                disabled={preferenceSaving}
              />
            </Row>
            <Row label={t('language')}>
              <Segmented ariaLabel={t('language')} options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))} value={lang} onChange={setLang} disabled={preferenceSaving} />
            </Row>
            <Row label={t('interfaceStyle')} note={t('interfaceStyleDescription')}>
              <div className="w-full sm:w-auto sm:max-w-[540px]">
                <div role="radiogroup" aria-label={t('interfaceStyle')} className="interface-style-grid">
                  <InterfaceStylePreview
                    value="classic"
                    label={t('interfaceStyleClassic')}
                    description={t('interfaceStyleClassicDescription')}
                    active={interfaceStyle === 'classic'}
                    disabled={preferenceSaving}
                    onSelect={() => interfaceStyle !== 'classic' && setPendingInterfaceStyle('classic')}
                  />
                  <InterfaceStylePreview
                    value="neo"
                    label={t('interfaceStyleNeo')}
                    description={t('interfaceStyleNeoDescription')}
                    active={interfaceStyle === 'neo'}
                    disabled={preferenceSaving}
                    onSelect={() => interfaceStyle !== 'neo' && setPendingInterfaceStyle('neo')}
                  />
                </div>
                <p className="interface-style-warning mt-2 text-[11.5px] text-warn leading-relaxed">{t('interfaceStyleWarning')}</p>
              </div>
            </Row>
            <Row label={t('density')}>
              <Segmented
                ariaLabel={t('density')}
                options={[
                  { value: 'comfortable', label: t('densityComfortable') },
                  { value: 'compact', label: t('densityCompact') },
                ]}
                value={density}
                onChange={setDensity}
                disabled={preferenceSaving}
              />
            </Row>
          </Card>
        )}

        {activeTab === 'account' && (
          <div className="flex flex-col gap-5 fade-in">
            <ProfileCard t={t} user={user} role={role} onSaved={onProfileSaved} />
            <ChangePasswordCard t={t} />
            <SessionsCard t={t} api={sessionsApi} now={now} placeholderMode={placeholderMode} />
          </div>
        )}

        {activeTab === 'security' && (
          <div className="flex flex-col gap-5 fade-in">
            <Card className="p-5">
              <CardTitle>{t('vaultKeyMgmt')}</CardTitle>
              <p className="text-[13px] text-ink-2 leading-relaxed max-w-[56ch]">{t('vaultKeyMgmtNote')}</p>
              <div className="mt-3 rounded-[var(--r-tile)] hatch hatch-ink3 bg-sunken border border-line px-4 py-3">
                <p className="font-mono text-[11px] text-ink-3">{t('vaultCipherCaption')}</p>
              </div>
            </Card>
            <Card className="p-5">
              <CardTitle>{t('vaultRecoveryTitle')}</CardTitle>
              <div className="rounded-[var(--r-tile)] border border-dashed border-line bg-sunken px-4 py-4 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <Chip tone="neutral">{t('notConnected')}</Chip>
                  <p className="text-[12.5px] text-ink-3 mt-2 max-w-[58ch] leading-relaxed">{t('vaultRecoveryNotConnected')}</p>
                </div>
                <Btn variant="outline" size="sm" disabled title={t('vaultRecoveryUnavailable')}>
                  <KeyRound size={13} strokeWidth={1.5} />
                  {t('generateRecoveryPhrase')}
                </Btn>
              </div>
            </Card>
            <Card className="p-5">
              <CardTitle>{t('shareDefaults')}</CardTitle>
              {/* เดิมเป็น <select> สองอันที่ไม่ผูกกับ state ใดและไม่เคยถูกส่งไปที่ไหน —
                  ผู้ใช้เลือกค่า กดออกจากหน้า แล้วค่าก็หายไปเงียบ ๆ ไม่มีผลต่อฟอร์มสร้าง
                  ลิงก์แชร์เลย ตอนนี้บอกตรง ๆ ว่ายังไม่มี ดีกว่าปุ่มที่แกล้งทำงาน */}
              <NotYetImplemented label={t('notImplemented')}>{t('shareDefaultsTodo')}</NotYetImplemented>
            </Card>

            {/* Twingate is the only documented remote channel. There is no connector
                health integration yet, so Inactive is the only honest default. */}
            <Card className="p-5">
              <CardTitle sub={t('remoteAccessDocNote')}>
                {t('remoteAccessTitle')}
              </CardTitle>

              <div className="grid grid-cols-1 gap-4 mt-2">
                <Card className="p-5 flex flex-col gap-4 bg-card-sunken border border-line">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-ink text-[14.5px]">Zero Trust Access · Twingate</h3>
                      <p className="text-[12px] text-ink-3 mt-0.5">{t('remoteLeastPrivilege')}</p>
                    </div>
                    <Chip tone="neutral">{t('remoteInactive')}</Chip>
                  </div>
                  <div className="flex flex-col gap-2 mt-2">
                    <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                      <span className="text-ink-2">{t('remoteConnectorStatus')}</span>
                      <span className="font-mono text-ink-3">{t('remoteInactive')}</span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                      <span className="text-ink-2">{t('remoteReachableResource')}</span>
                      <span className="font-mono text-ink">AEGIS Drive · NAS :443 only</span>
                    </div>
                  </div>
                  <p className="text-[11.5px] text-ink-3 leading-relaxed mt-1">{t('remoteInactiveHint')}</p>
                </Card>
              </div>

              {canAdministrate(role) && (
                <div className="mt-5">
                  <p className="text-[13px] font-semibold text-ink mb-2.5">{lang === 'th' ? 'นโยบายการเข้าถึง (Access Policy)' : 'Access Policy'}</p>
                  <div className="overflow-x-auto rounded-xl border border-line bg-card">
                    <table className="w-full text-left text-[12.5px]">
                      <thead>
                        <tr className="bg-sunken border-b border-line">
                          <th className="px-4 py-2 font-semibold text-ink-2">{lang === 'th' ? 'บทบาท (Role)' : 'Role'}</th>
                          <th className="px-4 py-2 font-semibold text-ink-2">{lang === 'th' ? 'ช่องทางเชื่อมต่อ (Channel)' : 'Channel'}</th>
                          <th className="px-4 py-2 font-semibold text-ink-2">{lang === 'th' ? 'รีซอร์สที่เข้าถึงได้ (Reachable)' : 'Reachable'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-line last:border-b-0">
                          <td className="px-4 py-2.5 font-medium text-ink">DataLake-User</td>
                          <td className="px-4 py-2.5 font-mono text-ink">Twingate</td>
                          <td className="px-4 py-2.5 font-mono text-ink">AEGIS Drive :443</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'storagedata' && (
          <div className="flex flex-col gap-5 fade-in">
            {/* ⚠️ ของเดิมเป็น <select> ตารางเวลา snapshot ที่ไม่ผูกกับอะไรเลย — ถูกถอดออก
                ตอนนี้ตัวเลือกทุกอย่างในการ์ดนี้เป็น "รหัส" จากรายการที่ host backup agent
                ประกาศ (ปลายทาง/ตาราง/การเก็บรักษา) และถูกส่งต่อให้ agent ตัดสินอีกชั้น —
                ไม่มี path, host, หรือคำสั่งใดจากเบราว์เซอร์ และถ้า agent ไม่ได้เชื่อมต่อ
                การ์ดจะบอกตรง ๆ แทนที่จะแสดงฟอร์มที่บันทึกไปไหนไม่ได้ (server/routes/api.js) */}
            {canAdministrate(role)
              ? <BackupConfiguration t={t} placeholderMode={placeholderMode} />
              : (
                <Card className="p-5">
                  <CardTitle>{t('backupConfigTitle')}</CardTitle>
                  <p className="text-[13px] text-ink-2 leading-relaxed max-w-[60ch]">{t('backupConfigUserNote')}</p>
                </Card>
              )}
            <Card className="p-5">
              <CardTitle>{t('setStorageData')}</CardTitle>
              {/* snapshot ระดับระบบไฟล์ยังทำไม่ได้จริงใน deployment นี้ (ext4 ธรรมดา) —
                  ประกาศไว้ตรง ๆ ต่อไป ส่วน "สำรองข้อมูล" ของจริงอยู่การ์ดด้านบน */}
              <NotYetImplemented label={t('notImplemented')}>{t('snapScheduleTodo')}</NotYetImplemented>
            </Card>
          </div>
        )}

        {/* Administration — rendered only for admin; ไม่มี DOM trace สำหรับ role อื่น */}
        {activeTab === 'admin' && canAdministrate(role) && (
          <div className="flex flex-col gap-5 fade-in">
            <Card className="p-5">
              <CardTitle>{t('encAtRest')}</CardTitle>
              {/* พูดถึงสิ่งที่มีอยู่จริงเท่านั้น: Vault เข้ารหัสฝั่งเบราว์เซอร์ (ของจริง
                  ตรวจสอบได้ ดูจอ Vault) ส่วนไฟล์ Data Lake ยังเป็น plaintext บนดิสก์
                  ไม่มีกุญแจ master ให้ rotate เพราะไม่มีกุญแจ master */}
              <p className="text-[13px] text-ink-2 leading-relaxed max-w-[60ch]">{t('encAtRestVault')}</p>
              <div className="mt-3">
                <NotYetImplemented label={t('notImplemented')}>{t('encAtRestTodo')}</NotYetImplemented>
              </div>
            </Card>
            <Card className="p-5">
              <CardTitle sub={t('zonesNote')}>{t('networkZones')}</CardTitle>
              {zonesApi.loading ? (
                <SkeletonLoader />
              ) : zonesError ? (
                <ErrorState t={t} kind={zonesError} onRetry={zonesApi.retry} />
              ) : zones.length === 0 ? (
                <EmptyState icon={ShieldCheck} title={t('emptyNoZones')} />
              ) : (
              <div className="flex flex-col gap-2">
                {zones.map((z) => (
                  <div key={z.id ?? z.cidr} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
                    {/* ชื่อ zone เป็นข้อความที่ผู้ดูแลพิมพ์เอง — ไม่ใช่ key ของตารางแปลภาษา
                        (เดิมเรียก t(z.name) ซึ่งทำให้ชื่อที่เพิ่มใหม่ทุกชื่อแสดงเป็น key ดิบ) */}
                    <Chip tone="neutral">{z.name}</Chip>
                    <span className="font-mono text-[12px] text-ink-2 flex-1">{z.cidr}</span>
                    {z.id && (
                      <button
                        type="button"
                        aria-label={t('removeZone')}
                        className="text-ink-3 hover:text-danger transition-colors duration-[var(--dur-fast)]"
                        onClick={() => removeZone(z.id)}
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              )}
              <form onSubmit={addZone} className="grid grid-cols-[1fr_1fr_auto] gap-2 mt-3 max-md:grid-cols-1">
                <PillInput
                  aria-label={t('zoneName')}
                  placeholder={t('zoneNamePlaceholder')}
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                />
                <PillInput
                  aria-label={t('zoneCidr')}
                  placeholder={t('zoneCidrPlaceholder')}
                  value={zoneCidr}
                  onChange={(e) => setZoneCidr(e.target.value)}
                />
                <Btn variant="outline" size="sm" type="submit">
                  <Plus size={14} strokeWidth={1.5} />
                  {t('addZone')}
                </Btn>
              </form>
              {zoneErr && (
                <p className="text-[12px] mt-2" style={{ color: 'var(--danger)' }}>{t('invalidZone')}</p>
              )}
              <p className="text-[12px] mt-3 rounded-[10px] px-3 py-2 leading-relaxed" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
                {t('firewallNote')}
              </p>
            </Card>
            <Card className="p-5">
              <CardTitle>{t('backupTargets')}</CardTitle>
              {/* เดิมเป็นสองบรรทัดที่ hard-code ไว้ ('edge-site-B /backup rsync+ssh',
                  'offsite-tape LTO-9') ซึ่งอ่านเหมือนรายการปลายทางสำรองข้อมูลที่ตั้งค่าไว้จริง
                  ตอนนี้รายการมาจาก allowlist บนโฮสต์ผ่าน backup agent เท่านั้น พร้อมผลจำแนก
                  failure domain ของแต่ละปลายทาง — ถ้า agent ไม่ได้เชื่อมต่อ ก็บอกว่าไม่ได้เชื่อมต่อ */}
              <BackupTargetList t={t} placeholderMode={placeholderMode} />
            </Card>
          </div>
        )}
      </div>
    </div>
    <Modal
      open={Boolean(pendingInterfaceStyle)}
      onClose={closeStyleConfirmation}
      labelledBy="interface-style-confirm-title"
      width={500}
    >
      <ModalClose onClose={closeStyleConfirmation} label={t('close')} />
      <div className="size-11 rounded-[var(--r-tile)] bg-accent-soft text-accent flex items-center justify-center mb-4">
        <LayoutTemplate size={20} strokeWidth={1.7} />
      </div>
      <h2 id="interface-style-confirm-title" className="text-lg font-semibold text-ink pr-10">
        {t('interfaceStyleConfirmTitle', { style: pendingInterfaceStyle === 'neo' ? t('interfaceStyleNeo') : t('interfaceStyleClassic') })}
      </h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{t('interfaceStyleConfirmBody')}</p>
      {preferenceError && <p role="alert" className="mt-3 text-[12.5px] text-danger">{t('interfaceStyleSaveFailed')}</p>}
      <div className="mt-6 flex justify-end gap-2 flex-wrap">
        <Btn variant="ghost" onClick={closeStyleConfirmation} disabled={preferenceSaving} data-modal-autofocus>
          {t('cancel')}
        </Btn>
        <Btn variant="primary" onClick={confirmStyleChange} disabled={preferenceSaving}>
          {preferenceSaving ? t('preferencesSaving') : t('interfaceStyleConfirmAction')}
        </Btn>
      </div>
    </Modal>
    </>
  )
}
