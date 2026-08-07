import { useState } from 'react'
import { Link2, Plus, ShieldCheck, Globe, Copy } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Modal, ModalClose, PillSelect, PillInput, Field, Segmented, ErrorState, InlineEmptyState, SkeletonLoader } from '../components/ui.jsx'
import { useApi, useNow } from '../lib/hooks.js'
import { visibleFetchError } from '../lib/fetchState.js'
import { apiFetch, apiUrl } from '../lib/api.js'
import { fmtCountdown } from '../lib/format.js'

/* ลิงก์แชร์ทำงานจริงตั้งแต่ต้นจนจบ: สร้าง → ได้ URL → ผู้รับเปิดแล้วได้ไฟล์
   (GET /s/:token — ดู server/routes/share.js) รหัสลิงก์ถูกตรวจด้วย bcrypt จริง
   ตัวนับเพิ่มตอนไถ่สำเร็จจริง และขอบเขตเครือข่ายถูกบังคับในโค้ดจริงตอนไถ่

   ⚠️ ถอด ScopeDiagram (ภาพ VLAN/Guest/Internet + firewall ที่มี packet วิ่งแล้วสลายตัว)
   ออกทั้งชิ้น เดิมมันสื่อว่า "firewall บล็อกคำขอจากโซนที่ไม่อนุญาตให้แล้ว" ซึ่งแอปนี้
   ไม่ได้ทำและไม่มีทางรู้ — ไม่มีโค้ดใดคุย UFW/switch และตอนนั้นยังไม่มีการตรวจ IP
   แม้แต่บรรทัดเดียว ภาพที่อธิบายกลไกที่ไม่มีอยู่คือคำสัญญาเชิงความปลอดภัยที่ผิด
   แบบเดียวกับ "คีย์กู้คืน 12 คำ" ที่ถูกถอดไปก่อนหน้านี้

   ตอนนี้มีการบังคับจริง แต่เป็น "การเทียบ IP ต้นทางที่ชั้นแอป" — แผงด้านล่างจึงพูด
   เท่าที่ทำได้จริง และระบุข้อจำกัดไว้ตรง ๆ ไม่วาดเป็น firewall */

const SCOPE_CHIP = {
  zones: { key: 'chipZoneRestricted', tone: 'accent' },
  vlan: { key: 'chipVlanOnly', tone: 'accent' },   // ค่าเดิมของแถวก่อน migration
  subnet: { key: 'chipSubnet', tone: 'accent' },
  any: { key: 'chipAnyNetwork', tone: 'warn' },
}
const AUTH_LABEL = { password: 'authPassword', otc: 'authOtc', none: 'authNone' }

/* ── Scope panel — พูดเท่าที่บังคับได้จริง ────────────────────────────
   ⚠️ ตั้งใจให้ "น่าเบื่อ" กว่าไดอะแกรมเดิม: ข้อความที่ตรงกับกลไกจริงมีค่ามากกว่าภาพ
   เคลื่อนไหวที่อธิบายกลไกที่ไม่มีอยู่ ผู้ใช้ตัดสินใจแชร์ไฟล์จากสิ่งที่อ่านบนจอนี้ */
function ScopePanel({ t, scope, zonesUnavailable }) {
  const restricted = scope === 'zones'
  return (
    <div className="rounded-[var(--r-tile)] border border-line bg-sunken p-3.5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {restricted ? (
          <ShieldCheck size={15} strokeWidth={1.6} className="text-accent-ink shrink-0" />
        ) : (
          <Globe size={15} strokeWidth={1.6} className="shrink-0" style={{ color: 'var(--warn)' }} />
        )}
        <p className="text-[13px] font-semibold text-ink">
          {restricted ? t('scopeZonesTitle') : t('scopeAnyTitle')}
        </p>
      </div>
      <p className="text-[12.5px] text-ink-2 leading-relaxed">
        {restricted ? t('scopeZonesBody') : t('scopeAnyBody')}
      </p>
      {restricted && (
        // ⚠️ ระบุข้อจำกัดของการบังคับที่ชั้นแอปไว้ตรงนี้ ไม่ซ่อนใน tooltip:
        //    เทียบ IP ต้นทางได้จริง แต่ไม่ใช่การแยกเครือข่ายที่ระดับ firewall/switch
        <p className="text-[11.5px] text-ink-3 leading-relaxed">{t('scopeEnforcementNote')}</p>
      )}
      {restricted && zonesUnavailable && (
        <p role="alert" className="text-[12px] font-medium" style={{ color: 'var(--danger)' }}>
          {t('scopeNoZones')}
        </p>
      )}
    </div>
  )
}

/* ── One active-link row — collapses into hatch on revoke ────────── */
function LinkRow({ t, link, now, revoking, onAskRevoke }) {
  const msLeft = link.expiresAt - now
  const isExpired = msLeft <= 0
  const scopeChip = SCOPE_CHIP[link.scope] ?? SCOPE_CHIP.any
  return (
    <div
      className="overflow-hidden transition-[max-height,opacity] duration-[var(--dur-slow)]"
      style={{ maxHeight: revoking ? 0 : 64, opacity: revoking ? 0 : 1, transitionTimingFunction: 'var(--ease)' }}
    >
      <div
        className={`grid items-center gap-3 px-4 h-14 border-b border-line text-[13px] ${revoking ? 'hatch hatch-ink3' : ''}`}
        style={{
          gridTemplateColumns: 'minmax(150px, 1fr) 104px 100px 84px 36px 88px',
          filter: revoking ? 'saturate(0)' : 'none',
        }}
      >
        <span className="min-w-0">
          <span className="block font-medium text-ink truncate" title={link.fileName}>{link.fileName}</span>
          <span className="block text-[11px] text-ink-3 truncate">{link.createdBy}</span>
        </span>
        <Chip tone={scopeChip.tone}>{t(scopeChip.key)}</Chip>
        <span className="text-ink-2 whitespace-nowrap truncate">{t(AUTH_LABEL[link.authType] ?? 'authNone')}</span>
        <span
          className="font-mono text-[12px] whitespace-nowrap"
          style={{ fontVariantNumeric: 'tabular-nums', color: msLeft < 3_600_000 ? 'var(--warn)' : 'var(--ink-2)' }}
        >
          {isExpired ? t('expired') : fmtCountdown(msLeft, t('expired'))}
        </span>
        <span className="text-ink-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{link.hits ?? 0}</span>
        <Btn variant="dangerSoft" size="sm" className="justify-self-end" onClick={() => onAskRevoke(link)}>{t('revoke')}</Btn>
      </div>
    </div>
  )
}

export function Shares({ t, placeholderMode = false }) {
  const now = useNow(1000)
  const sharesApi = useApi('/api/shares', { refreshMs: 30_000 })
  const filesApi = useApi('/api/files')
  const shares = placeholderMode ? [] : (sharesApi.data?.shares ?? [])
  const files = placeholderMode ? [] : (filesApi.data?.files ?? []).filter((f) => !f.vault && f.type !== 'Folder')
  const fetchError = visibleFetchError(sharesApi.error, placeholderMode)
  const filesError = visibleFetchError(filesApi.error, placeholderMode)
  const filesUnavailable = Boolean(filesApi.error)

  const [revokingIds, setRevokingIds] = useState(new Set())
  const [askRevoke, setAskRevoke] = useState(null)
  const [fileId, setFileId] = useState('')
  const [expiry, setExpiry] = useState('24h')
  const [auth, setAuth] = useState('password')
  const [linkPassword, setLinkPassword] = useState('')
  const [scope, setScope] = useState('zones')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null) // null | 'input' | 'zones' | 'server'
  // ⚠️ URL ของลิงก์ถูกแสดง "ครั้งเดียว" ตรงนี้ — เซิร์ฟเวอร์เก็บแต่ sha256 ของ token
  //    จึงไม่มีทางแสดงซ้ำได้ (แบบแผนเดียวกับรหัสผ่านชั่วคราวของบัญชีใหม่ในจอ Access)
  const [created, setCreated] = useState(null) // { url, fileName, hasPassword, scopeCidrs } | null
  const [copied, setCopied] = useState(false)

  // ── ตัวกรองของตาราง active links (scope / expiry) ──────────────────────────
  // จอนี้ไม่มีช่องค้นหาระดับระบบโดยเจตนา: คำถามที่คนถามกับตารางลิงก์คือ
  // "อันไหนยังเปิดอยู่ / อันไหนเปิดกว้างเกินไป / อันไหนกำลังจะหมดอายุ" — ไม่ใช่ค้นชื่อไฟล์
  const [fScope, setFScope] = useState('all')
  const [fExpiry, setFExpiry] = useState('all')
  const EXPIRY_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 }

  const visibleShares = shares.filter((s) => {
    const msLeft = s.expiresAt - now
    if (fScope !== 'all' && s.scope !== fScope) return false
    // "หมดอายุภายใน X" = ลิงก์ที่ยังไม่ตายแต่เหลือเวลาน้อยกว่า X
    if (fExpiry !== 'all' && !(msLeft > 0 && msLeft <= EXPIRY_MS[fExpiry])) return false
    return true
  })
  const filtered = fScope !== 'all' || fExpiry !== 'all'

  const selectedFileId = fileId || files[0]?.id || ''

  const passwordTooShort = auth === 'password' && linkPassword.length > 0 && linkPassword.length < 8
  const canCreate = Boolean(selectedFileId) && !creating &&
    (auth !== 'password' || linkPassword.length >= 8)

  const createLink = async () => {
    if (!canCreate) return
    setCreating(true)
    setCreateError(null)
    setCopied(false)
    const res = await apiFetch('/api/shares', {
      method: 'POST',
      body: { fileId: selectedFileId, expiry, authType: auth, scope, password: auth === 'password' ? linkPassword : undefined },
    })
    setCreating(false)
    if (!res.ok) {
      // 400 ตอนเลือก 'zones' แต่ Admin ยังไม่ได้กำหนด zone ใดไว้เลย เป็นกรณีที่พบบ่อยสุด
      // และแก้ได้ด้วยตัวเอง — จึงแยกข้อความออกจาก "คำขอถูกปฏิเสธ" ทั่วไป
      setCreateError(res.status === 400 && scope === 'zones' ? 'zones' : res.status === 400 ? 'input' : 'server')
      return
    }
    // ประกอบ URL เต็มฝั่ง client: origin ของเบราว์เซอร์ + BASE_URL ของ bundle
    // (Express ไม่รู้ prefix '/drive' ของตัวเองเพราะ nginx ตัดออกก่อนถึงมัน)
    setCreated({
      url: `${window.location.origin}${apiUrl(res.data.path)}`,
      fileName: res.data.share.fileName,
      hasPassword: res.data.share.hasPassword,
      scopeCidrs: res.data.share.scopeCidrs ?? [],
    })
    setLinkPassword('')
    sharesApi.retry()
  }

  const confirmRevoke = async () => {
    const id = askRevoke.id
    setAskRevoke(null)
    setRevokingIds((prev) => new Set(prev).add(id))
    // ให้แถวยุบเป็น hatch ก่อน แล้วค่อย refetch — การเพิกถอนจริงเกิดฝั่งเซิร์ฟเวอร์
    await apiFetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setTimeout(() => {
      setRevokingIds((prev) => { const n = new Set(prev); n.delete(id); return n })
      sharesApi.retry()
    }, 450)
  }

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
      {/* creation panel */}
      <div className="col-span-5 max-lg:col-span-12">
        <Card className="p-5">
          <CardTitle sub={t('newShareSub')}>{t('newShare')}</CardTitle>
          <div className="flex flex-col gap-4">
            <Field id="share-file" label={t('shareFile')}>
              {filesError ? (
                <ErrorState t={t} kind={filesError} onRetry={filesApi.retry} />
              ) : (
                <PillSelect id="share-file" value={selectedFileId} onChange={(e) => setFileId(e.target.value)} disabled={filesApi.loading || files.length === 0}>
                  {files.length === 0 && !filesUnavailable && <option value="">{t('emptyNoFiles')}</option>}
                  {files.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </PillSelect>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="share-expiry" label={t('expiry')}>
                <PillSelect id="share-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="1h">{t('hour1')}</option>
                  <option value="24h">{t('hours24')}</option>
                  <option value="7d">{t('days7')}</option>
                  <option value="30d">{t('days30')}</option>
                </PillSelect>
              </Field>
              <Field id="share-auth" label={t('authMethod')}>
                {/* ⚠️ ถอดตัวเลือก 'otc' (one-time code) ออก — ระบบนี้ไม่มีช่องทางส่ง
                    รหัสออกไปให้ผู้รับเลย (ไม่มีอีเมล/SMS) เดิมเลือกได้และเซิร์ฟเวอร์รับค่าไว้
                    แต่ไม่มีรหัสถูกสร้างหรือถูกตรวจที่ไหน = ลิงก์ที่ผู้ใช้เชื่อว่าต้องมีรหัส
                    จึงเปิดได้ กลายเป็นลิงก์ที่ใครถือก็เปิดได้ทันที */}
                <PillSelect id="share-auth" value={auth} onChange={(e) => setAuth(e.target.value)}>
                  <option value="password">{t('authPassword')}</option>
                  <option value="none">{t('authNone')}</option>
                </PillSelect>
              </Field>
            </div>

            {auth === 'password' && (
              <Field id="share-pw" label={t('linkPassword')}>
                <PillInput
                  id="share-pw"
                  type="password"
                  autoComplete="off"
                  value={linkPassword}
                  onChange={(e) => { setLinkPassword(e.target.value); setCreateError(null) }}
                  placeholder={t('linkPasswordPlaceholder')}
                />
                <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">{t('linkPasswordHint')}</p>
                {passwordTooShort && (
                  <p role="alert" className="text-[12px] font-medium mt-1" style={{ color: 'var(--danger)' }}>
                    {t('linkPasswordTooShort')}
                  </p>
                )}
              </Field>
            )}

            <div>
              <p className="text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em] mb-2">{t('networkScope')}</p>
              <Segmented
                ariaLabel={t('networkScope')}
                options={[
                  { value: 'zones', label: t('scopeZones') },
                  { value: 'any', label: t('scopeAny') },
                ]}
                value={scope}
                onChange={(v) => { setScope(v); setCreateError(null) }}
              />
            </div>
            <ScopePanel t={t} scope={scope} zonesUnavailable={createError === 'zones'} />

            {createError && (
              <p role="alert" className="text-[12.5px] font-medium" style={{ color: 'var(--danger)' }}>
                {createError === 'zones' ? t('scopeNoZones') : t('actionFailed')}
              </p>
            )}
            <Btn variant="primary" onClick={createLink} disabled={!canCreate}>
              <Plus size={15} strokeWidth={1.8} />
              {t('createShare')}
            </Btn>

            {/* ── ลิงก์ที่เพิ่งสร้าง — แสดงครั้งเดียว ────────────────────────────
                ⚠️ เซิร์ฟเวอร์เก็บแค่ sha256 ของ token จึงไม่มีทางแสดง URL นี้ซ้ำได้
                ต้องบอกผู้ใช้ตรง ๆ ตรงนี้ ไม่ใช่ให้เขาไปค้นหาในตารางแล้วไม่พบ */}
            {created && (
              <div className="rounded-[var(--r-tile)] border border-line bg-sunken p-4 flex flex-col gap-2.5 fade-in">
                <p className="text-[13px] font-semibold text-ink">{t('shareLinkReady')}</p>
                <p className="font-mono text-[11.5px] text-ink break-all select-all bg-card border border-line rounded-[10px] px-3 py-2.5">
                  {created.url}
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  <Btn
                    variant="outline"
                    size="sm"
                    onClick={() => { navigator.clipboard?.writeText(created.url); setCopied(true) }}
                  >
                    <Copy size={13} strokeWidth={1.6} />
                    {copied ? t('copied') : t('copyLink')}
                  </Btn>
                  <Btn variant="ghost" size="sm" onClick={() => setCreated(null)}>{t('done')}</Btn>
                </div>
                <p className="text-[11.5px] leading-relaxed rounded-[10px] px-3 py-2" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
                  {t('shareLinkOnceWarn')}
                </p>
                {created.hasPassword && (
                  <p className="text-[11.5px] text-ink-3 leading-relaxed">{t('shareLinkPasswordNote')}</p>
                )}
                {created.scopeCidrs.length > 0 && (
                  <p className="text-[11.5px] text-ink-3 leading-relaxed">
                    {t('shareLinkScopeNote')} <span className="font-mono text-ink-2">{created.scopeCidrs.join(', ')}</span>
                  </p>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* active links — สี่สถานะครบ */}
      <div className="col-span-7 max-lg:col-span-12">
        <Card className="overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center gap-2">
            <Link2 size={16} strokeWidth={1.5} className="text-ink-3" />
            <h2 className="text-[16px] font-semibold text-ink">{t('activeLinks')}</h2>
            <Chip tone="neutral" className="ml-auto">
              {filtered ? `${visibleShares.length} / ${shares.length}` : shares.length}
            </Chip>
          </div>

          {/* ตัวกรองของตารางนี้ — แทนที่ช่องค้นหาระดับระบบบนจอนี้ */}
          <div className="px-5 pb-3 flex items-center gap-2.5 flex-wrap">
              <div className="w-[168px]">
                <PillSelect aria-label={t('filterScope')} value={fScope} onChange={(e) => setFScope(e.target.value)}>
                  <option value="all">{t('filterScope')} · {t('filterAll')}</option>
                  <option value="zones">{t('scopeZones')}</option>
                  <option value="any">{t('scopeAny')}</option>
                </PillSelect>
              </div>
              <div className="w-[168px]">
                <PillSelect aria-label={t('filterExpiresWithin')} value={fExpiry} onChange={(e) => setFExpiry(e.target.value)}>
                  <option value="all">{t('filterExpiresWithin')} · {t('filterAll')}</option>
                  <option value="1h">{t('hour1')}</option>
                  <option value="24h">{t('hours24')}</option>
                  <option value="7d">{t('days7')}</option>
                </PillSelect>
              </div>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              <div
                className="grid gap-3 px-4 py-2 border-b border-line text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em]"
                style={{ gridTemplateColumns: 'minmax(150px, 1fr) 104px 100px 84px 36px 88px' }}
              >
                <span>{t('shareFile')}</span>
                <span>{t('colScope')}</span>
                <span>{t('colAuth')}</span>
                <span>{t('colExpiresIn')}</span>
                <span>{t('colHits')}</span>
                <span />
              </div>
              {sharesApi.loading ? (
                <div className="px-5 py-4"><SkeletonLoader type="table" /></div>
              ) : fetchError ? (
                <ErrorState t={t} kind={fetchError} onRetry={sharesApi.retry} />
              ) : shares.length === 0 ? (
                <InlineEmptyState>{t('emptyNoShares')}</InlineEmptyState>
              ) : visibleShares.length === 0 ? (
                <InlineEmptyState>{t('emptyNoSharesFiltered')}</InlineEmptyState>
              ) : (
                visibleShares.map((link) => (
                  <LinkRow key={link.id} t={t} link={link} now={now} revoking={revokingIds.has(link.id)} onAskRevoke={setAskRevoke} />
                ))
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* two-step revoke confirm — the filename is stated explicitly */}
      <Modal open={!!askRevoke} onClose={() => setAskRevoke(null)} width={440} labelledBy="revoke-title">
        <ModalClose onClose={() => setAskRevoke(null)} label={t('cancel')} />
        <h2 id="revoke-title" className="text-[18px] font-semibold text-ink">{t('revokeTitle')}</h2>
        <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">
          {askRevoke && t('revokeBody', { name: askRevoke.fileName })}
        </p>
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setAskRevoke(null)}>{t('cancel')}</Btn>
          <Btn variant="danger" className="flex-1" onClick={confirmRevoke}>{t('confirmRevoke')}</Btn>
        </div>
      </Modal>
    </div>
  )
}
