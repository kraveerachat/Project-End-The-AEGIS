import { useState } from 'react'
import { Monitor, KeyRound, Database, ShieldCheck, Palette, LogOut, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Segmented, Field, PillInput, PillSelect, ErrorState, EmptyState, SkeletonLoader } from '../components/ui.jsx'
import { canAdministrate } from '../lib/authz.js'
import { useApi, useNow } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'
import { fmtRelative, fmtDateTime } from '../lib/format.js'
import { LANGS } from '../lib/strings.js'

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
