import { useState } from 'react'
import { UserPlus, Info, Search } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Th, Modal, ModalClose, Field, PillInput, ErrorState, InlineEmptyState, DependencyUnavailableState, SkeletonLoader, Avatar } from '../components/ui.jsx'
import { useApi, useNow } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch } from '../lib/api.js'
import { fmtRelative } from '../lib/format.js'

/* บัญชีผู้ใช้มาจาก GET /api/users ซึ่งอ่านตาราง users จริง (Admin เท่านั้น — requireRole ฝั่งเซิร์ฟเวอร์)
   เพิ่มบัญชีผ่าน Modal จริง → POST /api/users (ไม่มี prompt()/confirm() ของเบราว์เซอร์)

   ตารางสิทธิ์ด้านล่างเป็น "คำอธิบายความสามารถของ role" (นโยบายที่ตายตัวของระบบ:
   ทั้งสอง role จัดการไฟล์ได้เท่ากัน; Admin เพิ่มเฉพาะจอ governance) — ไม่ใช่ข้อมูล
   และไม่ใช่สวิตช์: การแก้สิทธิ์รายคนไม่มีในสถาปัตยกรรมนี้โดยเจตนา (สอง role คงที่) */
const CAPABILITIES = [
  { key: 'permUploadDl', admin: true, user: true },
  { key: 'permShare', admin: true, user: true },
  { key: 'permVault', admin: true, user: true },
  // ⚠️ ทั้งสอง role กู้คืนได้ "เฉพาะไฟล์ของตัวเอง" — ไม่มีใครกู้ไฟล์ของคนอื่นได้
  //    รวมถึง Admin (ดูด่านใน /files/:id/versions/:versionId/restore)
  { key: 'permSnapRestore', admin: true, user: true },
  { key: 'permAudit', admin: true, user: false },
  { key: 'permManageUsers', admin: true, user: false },
]

/* One matrix cell — read-only: solid = granted, hatch = not present (แกรมมาร์เดิม) */
function PermCell({ granted, label }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${granted ? '✓' : '—'}`}
      className="relative inline-block size-7 rounded-[8px] border overflow-hidden"
      style={{
        background: granted ? 'var(--accent)' : 'var(--card-sunken)',
        borderColor: granted ? 'var(--accent)' : 'var(--line)',
      }}
    >
      {!granted && <span aria-hidden className="absolute inset-0 hatch hatch-ink3" />}
      {granted && (
        <span className="absolute inset-0 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </span>
  )
}

export function Access({ t, user, placeholderMode = false }) {
  const now = useNow(30_000)
  const usersApi = useApi('/api/users')
  const allUsers = usersApi.data?.users ?? []
  const apiCurrent = allUsers.find((u) => String(u.id) === String(user?.id))
  const currentAccount = user ? {
    ...apiCurrent,
    id: String(user.id),
    name: user.displayName,
    accountName: user.accountName ?? user.displayName,
    username: user.username,
    role: user.role,
    mustResetPassword: Boolean(user.mustResetPassword),
    activeSessions: apiCurrent?.activeSessions ?? 1,
    isCurrent: true,
  } : null
  // The memory fallback contains login fixtures, not provisioned production accounts.
  // Keep only the authenticated account there; PostgreSQL rows remain authoritative.
  const additionalUsers = placeholderMode
    ? []
    : allUsers.filter((u) => String(u.id) !== String(user?.id))
  const identityRows = currentAccount ? [currentAccount, ...additionalUsers] : allUsers
  const fetchError = visibleFetchError(usersApi.error, placeholderMode)

  // ตัวกรองของ "ตารางนี้" โดยเฉพาะ — ไม่ใช่ช่องค้นหาระดับระบบ
  // จอนี้ตอบคำถามเดียว: "บัญชีชื่อนี้มีสิทธิ์อะไร" ค้นชื่อในที่ตรงนี้ตรงประเด็นกว่า
  const [filter, setFilter] = useState('')
  const fq = filter.trim().toLowerCase()
  // ค้นทั้งชื่อที่ผู้ใช้ตั้งเอง ชื่อที่ Admin ตั้ง และ username — Admin ที่จำได้แค่ชื่อ
  // ที่ตัวเองตั้งให้ตอน provision ต้องหาบัญชีนั้นเจอ แม้เจ้าตัวจะเปลี่ยนชื่อแสดงไปแล้ว
  const users = fq
    ? identityRows.filter((u) => `${u.name} ${u.accountName ?? ''} ${u.username}`.toLowerCase().includes(fq))
    : identityRows

  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const role = 'DataLake-User' // provisioning เส้นนี้สร้างได้แค่ role นี้เท่านั้น (ดูเหตุผลในหมายเหตุใต้ Modal)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  // ⚠️ tempPassword มาจากผลลัพธ์ของ POST /api/users ครั้งเดียว — ไม่ถูกเก็บไว้ที่ไหนอีก
  // (ไม่มีทาง GET กลับมาดูซ้ำ) ถ้า Admin ปิด modal นี้ไปโดยไม่คัดลอก ต้องรีเซ็ตบัญชีนั้นใหม่
  const [reveal, setReveal] = useState(null) // { username, tempPassword } | null
  const [copied, setCopied] = useState(false)

  const addUser = async () => {
    if (saving || !name.trim() || !username.trim()) return
    setSaving(true)
    setSaveError(false)
    const res = await apiFetch('/api/users', {
      method: 'POST',
      body: { name: name.trim(), username: username.trim(), role },
    })
    setSaving(false)
    if (!res.ok) { setSaveError(true); return }
    setName('')
    setUsername('')
    usersApi.retry()
    // แสดงรหัสผ่านชั่วคราวแทนการปิด modal ทันที — Admin ต้องส่งต่อให้ user นอกช่องทางนี้
    setReveal({ username: res.data.user.username, tempPassword: res.data.tempPassword })
    setCopied(false)
  }

  const closeAddModal = () => {
    setAddOpen(false)
    setReveal(null)
    setSaveError(false)
  }

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
      {/* user table — สี่สถานะครบ */}
      <div className="col-span-12">
        <Card className="overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center gap-3 flex-wrap">
            <h2 className="text-[16px] font-semibold text-ink">{t('accessTitle')}</h2>
            <div className="flex-1" />
            <div className="relative w-[240px] max-sm:w-full">
              <Search size={14} strokeWidth={1.5} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('accessFilter')}
                aria-label={t('accessFilter')}
                className="w-full h-8 pl-9 pr-3 rounded-full bg-sunken border border-line text-[13px] text-ink placeholder:text-ink-3 outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-45"
              />
            </div>
            <Btn variant="primary" size="sm" onClick={() => { setAddOpen(true); setSaveError(false) }}>
              <UserPlus size={14} strokeWidth={1.5} />
              {t('addUser')}
            </Btn>
          </div>
          <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line bg-sunken">
                    <Th className="pl-5">{t('colUser')}</Th>
                    <Th>{t('colRole')}</Th>
                    <Th>{t('colStatus')}</Th>
                    <Th>{t('colLastLogin')}</Th>
                    <Th>{t('sessionsThisInstance')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={u.id} className="border-b border-line last:border-b-0 hover:bg-sunken transition-colors duration-[var(--dur-fast)] rise-in" style={{ height: 'var(--row-h)', animationDelay: `${i * 25}ms` }}>
                      <td className="px-4 pl-5">
                        <span className="flex items-center gap-2.5">
                          <Avatar userId={u.id} name={u.name} size={28} />
                          <span className="min-w-0">
                            <span className="block text-[13.5px] font-medium text-ink truncate">{u.name}</span>
                            <span className="block font-mono text-[11px] text-ink-3 truncate">{u.username}</span>
                            {/* ⚠️ ชื่อที่แสดง (u.name) คือชื่อที่ "เจ้าตัวตั้งเอง" ถ้าเขาตั้งไว้ —
                                ซ้ำกับชื่อคนอื่นได้ จอนี้เป็นจอที่ Admin ใช้ตอบว่า "ใครเข้าถึง
                                ระบบนี้ได้" จึงต้องเห็นชื่อที่ Admin ตั้งเองด้วยเมื่อสองค่าไม่ตรงกัน
                                ไม่งั้นผู้ใช้เปลี่ยนชื่อตัวเองเป็นชื่อเพื่อนร่วมงานแล้วแถวนี้
                                อ่านเหมือนเป็นคนนั้นจริง ๆ (username ยังกำกับอยู่ แต่คนอ่าน
                                ตารางเร็ว ๆ มองชื่อก่อน) */}
                            {u.accountName && u.accountName !== u.name && (
                              <span className="block text-[11px] text-ink-3 truncate" title={t('accessAssignedName')}>
                                {t('accessAssignedName')}: {u.accountName}
                              </span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="px-4">
                        {/* role chip = RBAC role จากเซิร์ฟเวอร์ — ไม่ใช่ตำแหน่งงาน */}
                        <Chip tone={u.role === 'Admin' ? 'violet' : 'accent'}>{u.role === 'Admin' ? t('roleAdmin') : t('roleUser')}</Chip>
                      </td>
                      <td className="px-4">
                        {/* สถานะเดียวที่ตาราง users มีจริง: บัญชีที่ยังติดรหัสผ่านชั่วคราว
                            ถูกด่าน must_reset_password ปิดกั้นทุก endpoint อยู่ (ของจริง
                            ที่บังคับใน requireRole.js) — ไม่ใช่ป้าย active/suspended ที่
                            เคยแสดงจากอาเรย์เดโม่ทั้งที่ไม่มีคอลัมน์นั้นในฐานข้อมูลเลย */}
                        {u.mustResetPassword ? (
                          <span title={t('pendingResetHint')}>
                            <Chip tone="warn">{t('pendingReset')}</Chip>
                          </span>
                        ) : (
                          <Chip tone="ok">{t('accountReady')}</Chip>
                        )}
                      </td>
                      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">
                        {u.lastLogin ? fmtRelative(t, u.lastLogin, now) : t('neverLoggedIn')}
                      </td>
                      <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">
                        {u.activeSessions == null
                          ? t('notAvailable')
                          : u.isCurrent
                            ? (u.activeSessions === 1
                              ? t('currentDeviceSession')
                              : t('sessionCountCurrent', { n: u.activeSessions }))
                            : t('sessionCount', { n: u.activeSessions })}
                      </td>
                    </tr>
                  ))}
                  {usersApi.loading && (
                    <tr><td colSpan={5} className="px-5 py-4"><SkeletonLoader type="table" /></td></tr>
                  )}
                  {fetchError && (
                    <tr><td colSpan={5}><ErrorState t={t} kind={fetchError} onRetry={usersApi.retry} /></td></tr>
                  )}
                  {!usersApi.loading && !fetchError && placeholderMode && (
                    <tr><td colSpan={5}><DependencyUnavailableState t={t} title={t('accessUnavailable')} compact /></td></tr>
                  )}
                  {!usersApi.loading && !fetchError && !placeholderMode && fq && users.length === 0 && (
                    <tr><td colSpan={5}><InlineEmptyState>{t('accessFilterNone', { q: filter.trim() })}</InlineEmptyState></td></tr>
                  )}
                  {!usersApi.loading && !fetchError && !placeholderMode && !fq && additionalUsers.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <InlineEmptyState
                          action={
                            <Btn variant="outline" size="sm" onClick={() => { setAddOpen(true); setSaveError(false) }}>
                              <UserPlus size={13} strokeWidth={1.5} />
                              {t('addUser')}
                            </Btn>
                          }
                        >
                          {t('noOtherUsers')}
                        </InlineEmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
        </Card>
      </div>

      {/* permission matrix — the shape of a role, visible as texture (read-only policy) */}
      <div className="col-span-8 max-lg:col-span-12">
        <Card className="p-5">
          <CardTitle>{t('permMatrix')}</CardTitle>
          <div className="grid" style={{ gridTemplateColumns: '1fr auto auto', columnGap: 28, rowGap: 10 }}>
            <span />
            <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em] text-center w-16">{t('roleAdmin')}</span>
            <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em] text-center w-16">{t('roleUser')}</span>
            {CAPABILITIES.map((p) => (
              <div key={p.key} className="contents">
                <span className="text-[13.5px] font-medium text-ink-2 py-0.5">{t(p.key)}</span>
                <span className="flex justify-center">
                  <PermCell granted={p.admin} label={`${t(p.key)} · ${t('roleAdmin')}`} />
                </span>
                <span className="flex justify-center">
                  <PermCell granted={p.user} label={`${t(p.key)} · ${t('roleUser')}`} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* firewall privileges live on the edge node, not here */}
      <div className="col-span-4 max-lg:col-span-12">
        <div className="rounded-[var(--r-tile)] p-4 flex gap-3" style={{ background: 'var(--warn-soft)' }}>
          <Info size={16} strokeWidth={1.8} style={{ color: 'var(--warn)' }} className="shrink-0 mt-0.5" />
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--warn)' }}>{t('firewallNote')}</p>
        </div>
      </div>

      {/* add user — Modal จริง
          ⚠️ provisioning เส้นนี้สร้างได้แค่ 'DataLake-User' เท่านั้น (ตัดสินใจฝั่งเซิร์ฟเวอร์
          ใน routes/api.js เพื่อลด blast radius หาก session ของ Admin ถูกยึด) — จึงไม่มี
          ตัวเลือก role ให้กดเลย ไม่ใช่แค่ซ่อน */}
      <Modal open={addOpen} onClose={closeAddModal} width={440} labelledBy="au-title">
        <ModalClose onClose={closeAddModal} label={t('cancel')} />
        <h2 id="au-title" className="text-[18px] font-semibold text-ink">{t('addUser')}</h2>

        {reveal ? (
          <div className="mt-5 flex flex-col gap-4">
            <p className="text-[13px] text-ink-2">{t('tempPasswordIntro')}</p>
            <div>
              <p className="text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em] mb-1.5">{t('colUser')}</p>
              <p className="font-mono text-[13.5px] text-ink px-4 py-2.5 rounded-full bg-sunken border border-line">{reveal.username}</p>
            </div>
            <div>
              <p className="text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em] mb-1.5">{t('tempPasswordLabel')}</p>
              <p className="font-mono text-[15px] font-semibold text-ink tracking-wide px-4 py-2.5 rounded-full bg-sunken border border-line select-all">
                {reveal.tempPassword}
              </p>
            </div>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(reveal.tempPassword); setCopied(true) }}
              className="text-left text-[13px] text-accent-ink hover:underline font-bold cursor-pointer w-fit"
            >
              📋 {copied ? t('copied') : t('copyTempPassword')}
            </button>
            <div className="rounded-[var(--r-tile)] p-3.5 flex gap-2.5" style={{ background: 'var(--warn-soft)' }}>
              <Info size={15} strokeWidth={1.8} style={{ color: 'var(--warn)' }} className="shrink-0 mt-0.5" />
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--warn)' }}>{t('tempPasswordWarn')}</p>
            </div>
            <Btn variant="primary" onClick={closeAddModal}>{t('done')}</Btn>
          </div>
        ) : (
          <>
            <div className="mt-5 flex flex-col gap-4">
              <Field id="au-name" label={t('colUser')}>
                <PillInput id="au-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus disabled={saving} />
              </Field>
              <Field id="au-username" label={t('username')}>
                <PillInput id="au-username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={saving} />
              </Field>
              <div>
                <p className="text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em] mb-2">{t('colRole')}</p>
                <Chip tone="accent">{t('roleUser')}</Chip>
              </div>
            </div>
            {saveError && (
              <p role="alert" className="text-[12.5px] font-medium mt-3" style={{ color: 'var(--danger)' }}>
                {t('actionFailed')}
              </p>
            )}
            <div className="flex gap-2.5 mt-6">
              <Btn variant="outline" className="flex-1" onClick={closeAddModal}>{t('cancel')}</Btn>
              <Btn variant="primary" className="flex-1" onClick={addUser} disabled={saving || !name.trim() || !username.trim()}>
                {t('addUser')}
              </Btn>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
