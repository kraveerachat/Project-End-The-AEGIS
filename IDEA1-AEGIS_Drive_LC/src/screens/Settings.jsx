import { useState } from 'react'
import { Monitor, KeyRound, Database, ShieldCheck, Palette, LogOut, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Segmented, Field, PillInput, PillSelect, ErrorState, EmptyState, SkeletonLoader } from '../components/ui.jsx'
import { canAdministrate } from '../lib/authz.js'
import { useApi, useNow } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'
import { fmtRelative, fmtDateTime } from '../lib/format.js'
import { LANGS } from '../lib/strings.js'

const WORD_LIST = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident",
  "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
  "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance", "advice", "aerobic", "affair", "afford"
]

const generate12Words = () => {
  const shuffled = [...WORD_LIST].sort(() => 0.5 - Math.random())
  return shuffled.slice(0, 12)
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

export function Settings({ t, lang, setLang, theme, setTheme, density, setDensity, role, user }) {
  const now = useNow(30_000)
  const [tab, setTab] = useState('appearance')
  // เซสชันที่ยัง active ของ "ผู้ใช้ปัจจุบัน" — จากเซิร์ฟเวอร์เท่านั้น
  const sessionsApi = useApi('/api/sessions')
  const sessions = sessionsApi.data?.sessions ?? []

  // Admin governance — Encryption keys & Network zones (ทั้งคู่ Admin เท่านั้น ดู server/rbac)
  const keysApi = useApi('/api/keys')
  const zonesApi = useApi('/api/zones')
  const zones = zonesApi.data?.zones ?? []
  const [rotating, setRotating] = useState(false)
  const [zoneName, setZoneName] = useState('')
  const [zoneCidr, setZoneCidr] = useState('')
  const [zoneErr, setZoneErr] = useState(false)

  const rotateKeys = async () => {
    setRotating(true)
    const { ok } = await apiFetch('/api/keys/rotate', { method: 'POST' })
    setRotating(false)
    if (ok) keysApi.retry()
  }

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

  // Vault Recovery Key Mnemonic states
  const [recoveryStatus, setRecoveryStatus] = useState('none') // 'none' | 'generating' | 'active'
  const [words, setWords] = useState([])
  const [revealed, setRevealed] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

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

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
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
                className={`flex items-center gap-2.5 h-10 px-4 rounded-full text-[13.5px] font-medium transition-colors duration-[var(--dur-fast)] cursor-pointer ${
                  active ? 'bg-ink text-card' : 'text-ink-2 hover:bg-card'
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
              />
            </Row>
            <Row label={t('language')}>
              <Segmented ariaLabel={t('language')} options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))} value={lang} onChange={setLang} />
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
              />
            </Row>
          </Card>
        )}

        {activeTab === 'account' && (
          <div className="flex flex-col gap-5 fade-in">
            <Card className="p-5">
              <CardTitle>{t('profile')}</CardTitle>
              <div className="flex items-center gap-3.5">
                <span className="size-12 rounded-full bg-ink text-card text-[15px] font-bold flex items-center justify-center">
                  {user.displayName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <div>
                  <p className="text-[15px] font-semibold text-ink">{user.displayName}</p>
                  <p className="font-mono text-[12px] text-ink-3">{user.username} · {canAdministrate(role) ? t('roleAdmin') : t('roleUser')}</p>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <CardTitle>{t('changePassword')}</CardTitle>
              <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                <Field id="pw-cur" label={t('currentPassword')}>
                  <PillInput id="pw-cur" type="password" autoComplete="current-password" />
                </Field>
                <Field id="pw-new" label={t('newPassword')}>
                  <PillInput id="pw-new" type="password" autoComplete="new-password" />
                </Field>
              </div>
              <Btn variant="primary" className="mt-4">{t('updatePassword')}</Btn>
            </Card>

            <Card className="p-5">
              <CardTitle>{t('activeSessions')}</CardTitle>
              {sessionsApi.loading ? (
                <SkeletonLoader type="table" />
              ) : sessionsApi.error ? (
                <ErrorState t={t} kind={sessionsApi.error} onRetry={sessionsApi.retry} />
              ) : sessions.length === 0 ? (
                <EmptyState icon={Monitor} title={t('emptyNoSessions')} hint={t('emptyNoSessionsHint')} />
              ) : (
                <div className="flex flex-col">
                  {sessions.map((s) => (
                    <div key={s.id} className="flex items-center gap-3 py-3 border-b border-line last:border-b-0 flex-wrap">
                      <Monitor size={16} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium text-ink flex items-center gap-2">
                          {s.device}
                          {s.current && <Chip tone="accent">{t('thisDevice')}</Chip>}
                        </p>
                        <p className="font-mono text-[11.5px] text-ink-3 mt-0.5">
                          {s.ip} · {t('lastActive')} {fmtRelative(t, s.lastActive, now)}
                        </p>
                      </div>
                      {/* การเพิกถอนเซสชันอื่นระยะไกล = endpoint ใน Phase 3
                          (DELETE /api/sessions/:id — ดู docs/api-contracts.md) */}
                    </div>
                  ))}
                </div>
              )}
            </Card>
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
              <CardTitle>{t('shareDefaults')}</CardTitle>
              <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                <Field id="def-expiry" label={t('defaultExpiry')}>
                  <PillSelect id="def-expiry" defaultValue="24h">
                    <option value="1h">{t('hour1')}</option>
                    <option value="24h">{t('hours24')}</option>
                    <option value="7d">{t('days7')}</option>
                  </PillSelect>
                </Field>
                <Field id="def-scope" label={t('defaultScope')}>
                  <PillSelect id="def-scope" defaultValue="vlan">
                    <option value="vlan">{t('scopeVlan')}</option>
                    <option value="subnet">{t('scopeSubnet')}</option>
                    <option value="any">{t('scopeAny')}</option>
                  </PillSelect>
                </Field>
              </div>
            </Card>

            {/* SECTION 1 — Remote Access & Devices */}
            <Card className="p-5">
              <CardTitle sub={lang === 'th' ? 'สถานะการเชื่อมต่อระยะไกลแบบไฮบริด (Hybrid Gate-0)' : 'Hybrid Gate-0 remote access status & channels'}>
                {lang === 'th' ? 'การเข้าถึงระยะไกลและอุปกรณ์' : 'Remote Access & Devices'}
              </CardTitle>
              
              <div className={`grid gap-4 mt-2 ${canAdministrate(role) ? 'grid-cols-2 max-md:grid-cols-1' : 'grid-cols-1'}`}>
                {canAdministrate(role) && (
                  <Card className="p-5 flex flex-col gap-4 bg-card-sunken border border-line">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-ink text-[14.5px]">VPN + VLAN (Gate 0-A)</h3>
                        <p className="text-[12px] text-ink-3 mt-0.5">{lang === 'th' ? 'การเข้าถึงเครือข่ายเต็มรูปแบบ · แอดมิน / พีซีที่ลงทะเบียน' : 'Full network access · Admin / registered PCs'}</p>
                      </div>
                      <Chip tone="ok">{lang === 'th' ? 'เปิดใช้งาน' : 'Active'}</Chip>
                    </div>
                    <div className="flex flex-col gap-2 mt-2">
                      <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                        <span className="text-ink-2">{lang === 'th' ? 'ประเภทไคลเอนต์ที่อนุญาต' : 'Allowed client type'}</span>
                        <span className="font-mono text-ink">Registered PC only</span>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                        <span className="text-ink-2">{lang === 'th' ? 'ขอบเขตเครือข่าย' : 'Scope'}</span>
                        <span className="font-mono text-ink">Full L3 (all services + Mgmt VLAN)</span>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                        <span className="text-ink-2">{lang === 'th' ? 'พอร์ตที่เปิดเผย' : 'Visible ports'}</span>
                        <span className="font-mono text-accent-ink">80/443, 9870, 10002</span>
                      </div>
                    </div>
                    <p className="text-[11.5px] text-ink-3 leading-relaxed mt-1">
                      {lang === 'th' 
                        ? 'ออกแบบมาสำหรับงานผู้ดูแลระบบที่ต้องการการเข้าถึงหลายบริการและ Management VLAN' 
                        : 'Intended for administrative tasks that require multi-service and Management VLAN access.'}
                    </p>
                  </Card>
                )}
                
                <Card className="p-5 flex flex-col gap-4 bg-card-sunken border border-line">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-ink text-[14.5px]">Zero Trust Access · Twingate (Gate 0-B)</h3>
                      <p className="text-[12px] text-ink-3 mt-0.5">{lang === 'th' ? 'สิทธิ์ขั้นต่ำ · มือถือ / นอกสถานที่' : 'Least-privilege · Mobile / off-site'}</p>
                    </div>
                    <Chip tone="ok">{lang === 'th' ? 'เปิดใช้งาน' : 'Active'}</Chip>
                  </div>
                  <div className="flex flex-col gap-2 mt-2">
                    <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                      <span className="text-ink-2">{lang === 'th' ? 'สถานะคอนเนคเตอร์' : 'Connector status'}</span>
                      <span className="font-mono text-ink">Outbound-only (no inbound ports opened)</span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                      <span className="text-ink-2">{lang === 'th' ? 'รีซอร์สที่เข้าถึงได้' : 'Reachable resource'}</span>
                      <span className="font-mono text-ink">AEGIS Drive · NAS :443 only</span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-line text-[12.5px]">
                      <span className="text-ink-2">{lang === 'th' ? 'บล็อกการเชื่อมต่อ' : 'Blocked'}</span>
                      <span className="font-mono text-danger">ICMP / port scan / other LAN hosts</span>
                    </div>
                  </div>
                  <p className="text-[11.5px] text-ink-3 leading-relaxed mt-1">
                    {lang === 'th'
                      ? 'ไคลเอนต์ระยะไกลไม่สามารถมองเห็นอุปกรณ์อื่นๆ ในเครือข่ายได้ ไม่มี IP สาธารณะ และไม่มีการส่งต่อพอร์ตบน Edge Router'
                      : 'Remote clients cannot see any other device on the network. No public IP and no port-forwarding on the Edge Router.'}
                  </p>
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
                          <td className="px-4 py-2.5 font-medium text-ink">Admin</td>
                          <td className="px-4 py-2.5 font-mono text-ink">VPN (0-A)</td>
                          <td className="px-4 py-2.5 font-mono text-ink">All services + Mgmt</td>
                        </tr>
                        <tr className="border-b border-line last:border-b-0">
                          <td className="px-4 py-2.5 font-medium text-ink">DataLake-User</td>
                          <td className="px-4 py-2.5 font-mono text-ink">Twingate (0-B)</td>
                          <td className="px-4 py-2.5 font-mono text-ink">AEGIS Drive :443</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>

            {/* SECTION 2 — Vault Recovery Key (Mnemonic) */}
            <Card className="p-5">
              <CardTitle sub={lang === 'th' ? 'การจัดการคีย์กู้คืนข้อมูลแบบ Zero-Knowledge' : 'Manage Private Vault Zero-Knowledge recovery phrase'}>
                {lang === 'th' ? 'คีย์กู้คืนห้องนิรภัย (Mnemonic)' : 'Vault Recovery Key (Mnemonic)'}
              </CardTitle>

              {recoveryStatus === 'none' && (
                <div className="flex flex-col gap-3">
                  <p className="text-[13px] text-ink-2 leading-relaxed max-w-[56ch]">
                    {lang === 'th'
                      ? 'ห้องนิรภัยส่วนตัว (Private Vault) ของคุณถูกเข้ารหัสแบบ End-to-End หากคุณลืมรหัสผ่านของห้องนิรภัย จะมีเพียงคีย์กู้คืนข้อมูลนี้เท่านั้นที่สามารถใช้เพื่อกู้คืนสิทธิ์การเข้าถึงได้ ทาง AEGIS ไม่สามารถกู้คืนคีย์นี้ให้แก่คุณได้'
                      : 'Your Private Vault is end-to-end encrypted. If you forget your Vault password, only this recovery phrase can restore access. AEGIS can never recover it for you.'}
                  </p>
                  <Btn
                    variant="primary"
                    className="w-fit"
                    onClick={() => {
                      setWords(generate12Words());
                      setRecoveryStatus('generating');
                      setRevealed(false);
                      setConfirmed(false);
                    }}
                  >
                    {lang === 'th' ? 'สร้างคีย์กู้คืนข้อมูล 12 คำ' : 'Generate 12-word recovery phrase'}
                  </Btn>
                </div>
              )}

              {recoveryStatus === 'generating' && (
                <div className="flex flex-col gap-4 fade-in">
                  <p className="text-[13px] text-ink-2 leading-relaxed">
                    {lang === 'th'
                      ? 'โปรดเก็บบันทึกคำทั้ง 12 คำนี้ในสถานที่ปลอดภัยและห้ามเปิดเผยแก่ผู้ใด'
                      : 'Please store these 12 words in a safe place and do not share them with anyone.'}
                  </p>
                  
                  <div className="grid grid-cols-4 gap-2.5 my-2 max-sm:grid-cols-2">
                    {words.map((w, idx) => (
                      <div key={idx} className="flex items-center gap-2 px-3 py-2 bg-sunken rounded-lg font-mono text-[12.5px] border border-line">
                        <span className="text-ink-3 text-[11px] select-none">{idx + 1}.</span>
                        <span className={`text-ink font-semibold select-none transition-[filter] duration-200 ${revealed ? 'blur-none' : 'blur-[5px]'}`}>
                          {w}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between py-1 border-b border-line">
                    <span className="text-[13px] text-ink-2">
                      {lang === 'th' ? 'แสดงคีย์กู้คืนข้อมูล' : 'Reveal recovery phrase'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRevealed(!revealed)}
                      className="text-accent-ink hover:underline text-[13.5px] font-semibold cursor-pointer"
                    >
                      {revealed ? (lang === 'th' ? 'ซ่อน' : 'Hide') : (lang === 'th' ? 'แสดง' : 'Reveal')}
                    </button>
                  </div>

                  <div className="p-3.5 rounded-xl border border-amber-200 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-[12.5px] leading-relaxed flex flex-col gap-1">
                    <span className="font-bold">⚠️ {lang === 'th' ? 'คำเตือนสำคัญ' : 'Zero-Knowledge Warning'}</span>
                    <span>
                      {lang === 'th'
                        ? 'คีย์กู้คืนข้อมูล 12 คำนี้จะแสดงเพียงครั้งเดียวเท่านั้นและจะไม่มีการส่งไปยังเซิร์ฟเวอร์ โปรดจดบันทึกและเก็บไว้ในสถานที่ที่ปลอดภัยแบบออฟไลน์ ผู้ใดก็ตามที่มีคีย์นี้จะสามารถถอดรหัสและเข้าถึงข้อมูลในห้องนิรภัยของคุณได้'
                        : 'These 12 words are shown only once and are never sent to the server. Write them down and store them offline. Anyone with these words can decrypt your Vault.'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-3 mt-1">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(words.join(" "));
                      }}
                      className="text-left text-[13px] text-accent-ink hover:underline font-bold cursor-pointer w-fit"
                    >
                      📋 {lang === 'th' ? 'คัดลอกคำทั้งหมดไปยังคลิปบอร์ด' : 'Copy all words to clipboard'}
                    </button>
                    
                    <label className="flex items-start gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                        className="mt-1 size-4 rounded accent-accent border-line focus:ring-accent"
                      />
                      <span className="text-[13px] text-ink-2 leading-relaxed">
                        {lang === 'th'
                          ? 'ฉันได้จดบันทึกและเก็บคีย์กู้คืนข้อมูลไว้อย่างปลอดภัยเรียบร้อยแล้ว'
                          : 'I have safely stored my recovery phrase'}
                      </span>
                    </label>
                  </div>

                  <div className="flex gap-2 mt-4">
                    <Btn
                      variant="primary"
                      disabled={!confirmed}
                      onClick={() => setRecoveryStatus('active')}
                    >
                      {lang === 'th' ? 'เสร็จสิ้น' : 'Done'}
                    </Btn>
                    <Btn
                      variant="outline"
                      onClick={() => setRecoveryStatus('none')}
                    >
                      {lang === 'th' ? 'ยกเลิก' : 'Cancel'}
                    </Btn>
                  </div>
                </div>
              )}

              {recoveryStatus === 'active' && (
                <div className="flex flex-col gap-4 fade-in">
                  <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 rounded-xl text-[13px] font-semibold">
                    <span className="size-2 rounded-full bg-emerald-500" />
                    {lang === 'th' ? 'คีย์กู้คืนข้อมูลพร้อมใช้งาน · บันทึกแบบออฟไลน์โดยผู้ใช้เรียบร้อยแล้ว' : 'Recovery phrase active · stored offline by user'}
                  </div>
                  
                  <p className="text-[13px] text-ink-3 leading-relaxed">
                    {lang === 'th'
                      ? 'เนื่องจากความปลอดภัยระดับสูงสุดของระบบ คีย์กู้คืนข้อมูลนี้จะไม่สามารถแสดงซ้ำได้อีก หากคุณต้องการสร้างคีย์ใหม่ คีย์ชุดเก่าจะถูกยกเลิกทันที'
                      : 'For maximum security, this recovery phrase cannot be displayed again. If you generate a new phrase, the old phrase will be invalidated.'}
                  </p>
                  
                  <Btn
                    variant="outline"
                    className="w-fit"
                    onClick={() => {
                      setWords(generate12Words());
                      setRecoveryStatus('generating');
                      setRevealed(false);
                      setConfirmed(false);
                    }}
                  >
                    {lang === 'th' ? 'สร้างคีย์กู้คืนใหม่' : 'Regenerate'}
                  </Btn>
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'storagedata' && (
          <Card className="p-5 fade-in">
            <CardTitle>{t('setStorageData')}</CardTitle>
            <Row label={t('snapSchedule')}>
              <div className="w-44">
                <PillSelect defaultValue="6h" aria-label={t('snapSchedule')}>
                  <option value="1h">{t('everyHour')}</option>
                  <option value="6h">{t('every6h')}</option>
                  <option value="24h">{t('daily')}</option>
                </PillSelect>
              </div>
            </Row>
            <Row label={t('retention')} note={t('retentionNote')} />
          </Card>
        )}

        {/* Administration — rendered only for admin; ไม่มี DOM trace สำหรับ role อื่น */}
        {activeTab === 'admin' && canAdministrate(role) && (
          <div className="flex flex-col gap-5 fade-in">
            <Card className="p-5">
              <CardTitle>{t('encKeys')}</CardTitle>
              {keysApi.loading ? (
                <SkeletonLoader />
              ) : keysApi.error ? (
                <ErrorState t={t} kind={keysApi.error} onRetry={keysApi.retry} />
              ) : (
                <>
                  <p className="text-[13px] text-ink-2">
                    {t('encKeysNote')} <span className="font-mono text-ink">{fmtDateTime(keysApi.data?.rotatedAt, lang)}</span>
                  </p>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-3 text-[12.5px] text-ink-2">
                    <span>{t('keyAlgorithm')}: <span className="font-mono text-ink">{keysApi.data?.algorithm}</span></span>
                    <span>{t('keyId')}: <span className="font-mono text-ink">{keysApi.data?.keyId}</span></span>
                  </div>
                  <Btn variant="outline" size="sm" className="mt-4" onClick={rotateKeys} disabled={rotating}>
                    <RefreshCw size={14} strokeWidth={1.5} className={rotating ? 'animate-spin' : ''} />
                    {rotating ? t('rotating') : t('rotateNow')}
                  </Btn>
                </>
              )}
            </Card>
            <Card className="p-5">
              <CardTitle>{t('networkZones')}</CardTitle>
              {zonesApi.loading ? (
                <SkeletonLoader />
              ) : zonesApi.error ? (
                <ErrorState t={t} kind={zonesApi.error} onRetry={zonesApi.retry} />
              ) : zones.length === 0 ? (
                <EmptyState icon={ShieldCheck} title={t('emptyNoZones')} />
              ) : (
              <div className="flex flex-col gap-2">
                {zones.map((z) => (
                  <div key={z.id ?? z.cidr} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
                    <Chip tone={z.tone}>{t(z.name)}</Chip>
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
              <div className="flex flex-col gap-1.5 font-mono text-[12.5px] text-ink-2">
                <span>edge-site-B · /backup · rsync+ssh</span>
                <span>offsite-tape · LTO-9 · weekly rotation</span>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
