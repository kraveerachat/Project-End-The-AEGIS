import { useState } from 'react'
import { Monitor, KeyRound, Database, ShieldCheck, Palette, LogOut } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Segmented, Field, PillInput, PillSelect } from '../components/ui.jsx'
import { canAdministrate } from '../lib/authz.js'
import { useNow } from '../lib/hooks.js'
import { fmtRelative, fmtDateTime } from '../lib/format.js'
import { SESSIONS } from '../lib/data.js'
import { LANGS } from '../lib/strings.js'

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
  const [sessions, setSessions] = useState(SESSIONS)

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
                  <p className="font-mono text-[12px] text-ink-3">{user.username} · {role === 'admin' ? t('roleAdmin') : t('roleUser')}</p>
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
                    {!s.current && (
                      <Btn variant="outline" size="sm" onClick={() => setSessions((prev) => prev.filter((x) => x.id !== s.id))}>
                        <LogOut size={13} strokeWidth={1.5} />
                        {t('signOut')}
                      </Btn>
                    )}
                  </div>
                ))}
              </div>
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
              <p className="text-[13px] text-ink-2">
                {t('encKeysNote')} <span className="font-mono text-ink">{fmtDateTime(Date.now() - 31 * 86_400_000, lang)}</span>
              </p>
            </Card>
            <Card className="p-5">
              <CardTitle>{t('networkZones')}</CardTitle>
              <div className="flex flex-col gap-2">
                {[
                  { name: t('zoneCompany'), cidr: '192.168.20.0/23', tone: 'accent' },
                  { name: t('zoneGuest'), cidr: '192.168.30.0/24', tone: 'neutral' },
                  { name: 'Management', cidr: '10.10.0.0/28', tone: 'violet' },
                ].map((z) => (
                  <div key={z.cidr} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
                    <Chip tone={z.tone}>{z.name}</Chip>
                    <span className="font-mono text-[12px] text-ink-2">{z.cidr}</span>
                  </div>
                ))}
              </div>
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
