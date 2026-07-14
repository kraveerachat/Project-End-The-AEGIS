import { useEffect, useState } from 'react'
import {
  Gauge, Folder, Vault as VaultIcon, Upload, Link2, History, HardDrive,
  ScrollText, UserCog, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { AegisLockup, AegisMark } from './AegisMark.jsx'
import { Progress } from './ui.jsx'
import { useCountUp } from '../lib/hooks.js'

const ICONS = { gauge: Gauge, folder: Folder, vault: VaultIcon, upload: Upload, link: Link2, history: History, harddrive: HardDrive, scroll: ScrollText, usercog: UserCog, settings: SettingsIcon }

/* Height+fade collapse used when the preview role gains/loses the admin
   group. While closed the children are UNMOUNTED — no DOM trace. The exit
   animation exists only for the developer preview instrument. */
function Collapse({ show, children }) {
  const [mounted, setMounted] = useState(show)
  const [open, setOpen] = useState(show)
  useEffect(() => {
    if (show) {
      setMounted(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)))
      return () => cancelAnimationFrame(id)
    }
    setOpen(false)
    const id = setTimeout(() => setMounted(false), 320)
    return () => clearTimeout(id)
  }, [show])
  if (!mounted) return null
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-[300ms]"
      style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transitionTimingFunction: 'var(--ease)' }}
    >
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  )
}

function NavItem({ icon, label, active, collapsed, onClick, delay = 0 }) {
  const Icon = ICONS[icon] ?? Gauge
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={`flex items-center gap-3 h-10 rounded-full text-[14px] font-medium transition-colors duration-[var(--dur-fast)] cursor-pointer w-full rise-in ${
        active ? 'bg-ink text-card' : 'text-ink-2 hover:bg-sunken'
      } ${collapsed ? 'justify-center px-0' : 'px-3.5'}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <Icon size={17} strokeWidth={1.5} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  )
}

export function Sidebar({ t, nav, screen, setScreen, collapsed, setCollapsed, metrics, mobileOpen, closeMobile }) {
  const storage = useCountUp(metrics.storageGB, 700)
  const groups = ['navGroupWorkspace', 'navGroupProtection', 'navGroupAdmin']

  const body = (
    <div className="flex flex-col h-full bg-card border-r border-line">
      <div className={`flex items-center h-16 shrink-0 ${collapsed ? 'justify-center px-0' : 'justify-between px-5'}`}>
        {collapsed ? <AegisMark size={28} /> : <AegisLockup markSize={28} sub="DRIVE_LC" />}
        {!collapsed && (
          <button
            type="button"
            aria-label={t('collapseSidebar')}
            onClick={() => setCollapsed(true)}
            className="size-8 flex items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer max-md:hidden"
          >
            <PanelLeftClose size={15} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          aria-label={t('expandSidebar')}
          onClick={() => setCollapsed(false)}
          className="mx-auto mb-1 size-8 flex items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer"
        >
          <PanelLeftOpen size={15} strokeWidth={1.5} />
        </button>
      )}

      <nav className={`flex-1 overflow-y-auto py-2 flex flex-col gap-0.5 ${collapsed ? 'px-3' : 'px-4'}`} aria-label={t('productName')}>
        {groups.map((groupKey) => {
          // filter BEFORE map — สิ่งที่ role นี้ไม่มีสิทธิ์ "ไม่ถูก render เลย"
          const items = nav.filter((n) => n.group === groupKey)
          const isAdminGroup = groupKey === 'navGroupAdmin'
          const inner = items.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {!collapsed && (
                <p className="text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.1em] px-3.5 pt-4 pb-1.5">{t(groupKey)}</p>
              )}
              {collapsed && <div className="h-3" aria-hidden />}
              {items.map((item, i) => (
                <NavItem
                  key={item.id}
                  icon={item.icon}
                  label={t(item.labelKey)}
                  active={screen === item.id}
                  collapsed={collapsed}
                  delay={i * 40}
                  onClick={() => { setScreen(item.id); closeMobile() }}
                />
              ))}
            </div>
          )
          // Admin group slides in/out as the previewed role changes —
          // items never simply pop.
          return isAdminGroup ? <Collapse key={groupKey} show={items.length > 0}>{inner}</Collapse> : <div key={groupKey}>{inner}</div>
        })}

        <div className="flex flex-col gap-0.5 mt-1">
          {collapsed && <div className="h-3" aria-hidden />}
          <NavItem
            icon="settings"
            label={t('navSettings')}
            active={screen === 'settings'}
            collapsed={collapsed}
            onClick={() => { setScreen('settings'); closeMobile() }}
          />
        </div>
      </nav>

      {/* storage meter */}
      {!collapsed && (
        <div className="m-4 mt-2 p-3.5 rounded-[var(--r-tile)] bg-sunken">
          <div className="flex items-baseline justify-between">
            <p className="text-[12px] font-semibold text-ink-2">{t('storageMeter')}</p>
            <p className="text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span className="font-semibold text-ink">{Math.round(storage)} GB</span> / 1 TB
            </p>
          </div>
          <Progress value={(storage / 1024) * 100} height={4} className="mt-2.5" />
          <button type="button" className="mt-3 text-[10.5px] font-bold tracking-[0.08em] text-accent-ink hover:underline cursor-pointer">
            {t('upgradeStorage')}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <>
      {/* desktop */}
      <aside
        className="max-md:hidden shrink-0 h-full transition-[width] duration-[var(--dur-slow)]"
        style={{ width: collapsed ? 72 : 260, transitionTimingFunction: 'var(--ease)' }}
      >
        {body}
      </aside>
      {/* mobile off-canvas */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0" style={{ zIndex: 'var(--z-drawer)' }}>
          <div className="absolute inset-0 fade-in" style={{ background: 'color-mix(in srgb, var(--ink) 30%, transparent)' }} onClick={closeMobile} aria-hidden />
          <div className="absolute left-0 top-0 bottom-0 w-[260px]" style={{ animation: 'sidebar-in var(--dur-base) var(--ease) both' }}>
            <style>{`@keyframes sidebar-in { from { transform: translateX(-24px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`}</style>
            {body}
          </div>
        </div>
      )}
    </>
  )
}
