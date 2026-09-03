import { useEffect, useState } from 'react'
import {
  Gauge, Folder, Vault as VaultIcon, Upload, Link2, History, HardDrive,
  ScrollText, UserCog, ShieldCheck, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen, Trash2,
} from 'lucide-react'
import { AegisLockup, AegisMark } from './AegisMark.jsx'
import { Progress } from './ui.jsx'
import { useCountUp } from '../lib/hooks.js'
import { fmtBytes } from '../lib/format.js'

const ICONS = { gauge: Gauge, folder: Folder, vault: VaultIcon, upload: Upload, link: Link2, history: History, trash: Trash2, harddrive: HardDrive, scroll: ScrollText, usercog: UserCog, shield: ShieldCheck, settings: SettingsIcon }

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
      className={`sidebar-nav-item flex items-center gap-3 h-10 rounded-[10px] text-[14px] font-medium transition-all duration-[var(--dur-fast)] cursor-pointer w-full rise-in ${
        active
          ? 'is-active bg-accent-soft text-accent-ink'
          : 'text-ink-3 hover:bg-sunken hover:text-ink'
      } ${collapsed ? 'justify-center px-0' : 'px-3.5'}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <Icon size={17} strokeWidth={1.5} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  )
}

export function Sidebar({ t, nav, screen, setScreen, collapsed, setCollapsed, metrics, metricsUnavailable = false, resolvedTheme, mobileOpen, closeMobile }) {
  // metrics มาจาก /api/dashboard — ระหว่างโหลดเป็น null → มิเตอร์แสดง skeleton
  // ใช้ bytes + fmtBytes ชุดเดียวกับ Dashboard/Storage ห้ามผสม decimal GB กับ binary GB
  const storageBytes = useCountUp(metrics?.storageBytes ?? 0, 700)
  const totalBytes = metrics?.storageTotalBytes ?? 0
  const storagePct = totalBytes > 0 ? (storageBytes / totalBytes) * 100 : 0
  const groups = ['navGroupWorkspace', 'navGroupProtection', 'navGroupAdmin']

  const body = (
    <div className="flex flex-col h-full bg-card border-r border-line">
      <div className={`flex items-center h-16 shrink-0 ${collapsed ? 'justify-center px-0' : 'justify-between px-5'}`}>
        {collapsed
          ? <AegisMark size={32} theme={resolvedTheme} />
          : <AegisLockup markSize={36} theme={resolvedTheme} title="AEGIS Drive_LC" sub={t('productLockupSub')} />}
        {!collapsed && (
          <button
            type="button"
            aria-label={t('collapseSidebar')}
            onClick={() => setCollapsed(true)}
            className="size-8 flex items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer max-lg:hidden"
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

      {/* storage meter — จากเซิร์ฟเวอร์เท่านั้น; ระหว่างโหลด = skeleton ไม่ใช่เลขปลอม */}
      {!collapsed && (
        <div className="m-4 mt-2 p-3.5 rounded-[var(--r-tile)] bg-sunken">
          {metricsUnavailable ? (
            <div role="status" className="hatch hatch-ink3 rounded-[9px] border border-dashed border-line px-3 py-2.5 flex items-center justify-between gap-3">
              <p className="text-[12px] font-semibold text-ink-2">{t('storageMeter')}</p>
              <p className="text-[11.5px] font-semibold text-ink-3">{t('notAvailable')}</p>
            </div>
          ) : metrics ? (
            <>
              <div className="flex items-baseline justify-between">
                <p className="text-[12px] font-semibold text-ink-2">{t('storageMeter')}</p>
                <p className="text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <span className="font-semibold text-ink">{fmtBytes(storageBytes)}</span> / {fmtBytes(totalBytes)}
                </p>
              </div>
              <Progress value={storagePct} height={4} className="mt-2.5" />
            </>
          ) : (
            <div className="flex flex-col gap-2.5" aria-busy="true">
              <div className="w-2/3 h-3.5 skeleton" />
              <div className="w-full h-1 rounded-full skeleton" />
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      {/* desktop */}
      <aside
        className="hidden lg:block shrink-0 h-full transition-[width] duration-[var(--dur-slow)]"
        style={{ width: collapsed ? 72 : 260, transitionTimingFunction: 'var(--ease)' }}
      >
        {body}
      </aside>
      {/* mobile off-canvas */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0" style={{ zIndex: 'var(--z-drawer)' }}>
          <div className="absolute inset-0 fade-in" style={{ background: 'color-mix(in srgb, var(--ink) 30%, transparent)' }} onClick={closeMobile} aria-hidden />
          <div className="absolute left-0 top-0 bottom-0 w-[260px]" style={{ animation: 'sidebar-in var(--dur-base) var(--ease) both' }}>
            {body}
          </div>
        </div>
      )}
    </>
  )
}
