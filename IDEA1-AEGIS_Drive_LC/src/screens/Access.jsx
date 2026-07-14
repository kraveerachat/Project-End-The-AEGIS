import { useState } from 'react'
import { UserPlus, Check, Info, MoreHorizontal } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Th, IconBtn } from '../components/ui.jsx'
import { useNow } from '../lib/hooks.js'
import { fmtRelative } from '../lib/format.js'
import { USERS, PERMISSIONS } from '../lib/data.js'

const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()

/* One matrix cell — granted fills with a drawing check; revoked wipes to
   hatch. Same grammar as everywhere: hatch = not present. */
function PermCell({ granted, onToggle, label, delay = 0, editable }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={granted}
      aria-label={label}
      disabled={!editable}
      onClick={onToggle}
      className={`relative size-7 rounded-[8px] border overflow-hidden transition-colors duration-[var(--dur-base)] ${editable ? 'cursor-pointer' : 'cursor-default'}`}
      style={{
        background: granted ? 'var(--accent)' : 'var(--card-sunken)',
        borderColor: granted ? 'var(--accent)' : 'var(--line)',
        transitionDelay: `${delay}ms`,
      }}
    >
      {/* hatch veil for the denied state */}
      <span
        aria-hidden
        className="absolute inset-0 hatch hatch-ink3 transition-[clip-path] duration-[var(--dur-base)]"
        style={{
          clipPath: granted ? 'inset(0 0 0 100%)' : 'inset(0 0 0 0)',
          transitionDelay: `${delay}ms`,
          transitionTimingFunction: 'var(--ease)',
        }}
      />
      {granted && (
        <span className="absolute inset-0 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
          </svg>
        </span>
      )}
    </button>
  )
}

export function Access({ t }) {
  const now = useNow(30_000)
  const [userPerms, setUserPerms] = useState(() => Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.user])))

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
      {/* user table */}
      <div className="col-span-12">
        <Card className="overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center">
            <h2 className="text-[16px] font-semibold text-ink">{t('accessTitle')}</h2>
            <div className="flex-1" />
            <Btn variant="primary" size="sm">
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
                  <Th>{t('colSessions')}</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {USERS.map((u, i) => (
                  <tr key={u.id} className="border-b border-line last:border-b-0 hover:bg-sunken transition-colors duration-[var(--dur-fast)] rise-in" style={{ height: 'var(--row-h)', animationDelay: `${i * 25}ms` }}>
                    <td className="px-4 pl-5">
                      <span className="flex items-center gap-2.5">
                        <span className="size-7 rounded-full bg-ink text-card text-[10.5px] font-bold flex items-center justify-center shrink-0">
                          {initials(u.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13.5px] font-medium text-ink truncate">{u.name}</span>
                          <span className="block font-mono text-[11px] text-ink-3 truncate">{u.username}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4">
                      <Chip tone={u.role === 'admin' ? 'violet' : 'accent'}>{u.role === 'admin' ? t('roleAdmin') : t('roleUser')}</Chip>
                    </td>
                    <td className="px-4">
                      <Chip tone={u.status === 'active' ? 'ok' : 'neutral'}>{u.status === 'active' ? t('active') : t('suspended')}</Chip>
                    </td>
                    <td className="px-4 text-[13px] text-ink-2 whitespace-nowrap">{fmtRelative(t, u.lastLogin, now)}</td>
                    <td className="px-4 text-[13px] text-ink-2" style={{ fontVariantNumeric: 'tabular-nums' }}>{u.sessions}</td>
                    <td className="px-4 text-right">
                      <IconBtn label="More"><MoreHorizontal size={15} strokeWidth={1.5} /></IconBtn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* permission matrix — the shape of a role, visible as texture */}
      <div className="col-span-8 max-lg:col-span-12">
        <Card className="p-5">
          <CardTitle>{t('permMatrix')}</CardTitle>
          <div className="grid" style={{ gridTemplateColumns: '1fr auto auto', columnGap: 28, rowGap: 10 }}>
            <span />
            <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em] text-center w-16">{t('roleAdmin')}</span>
            <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em] text-center w-16">{t('roleUser')}</span>
            {PERMISSIONS.map((p, i) => (
              <div key={p.key} className="contents">
                <span className="text-[13.5px] font-medium text-ink-2 py-0.5">{t(p.key)}</span>
                <span className="flex justify-center">
                  <PermCell granted={p.admin} editable={false} label={`${t(p.key)} · ${t('roleAdmin')}`} />
                </span>
                <span className="flex justify-center">
                  <PermCell
                    granted={userPerms[p.key]}
                    editable
                    delay={i * 40}
                    label={`${t(p.key)} · ${t('roleUser')}`}
                    onToggle={() => setUserPerms((prev) => ({ ...prev, [p.key]: !prev[p.key] }))}
                  />
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
    </div>
  )
}
