import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Gauge, Folder, Vault as VaultIcon, Upload, Link2, History, HardDrive,
  ScrollText, UserCog, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen, Menu, Trash2, X,
} from 'lucide-react'
import { AegisLockup, AegisMark } from './AegisMark.jsx'
import { Progress } from './ui.jsx'
import { useCountUp, useReducedMotion } from '../lib/hooks.js'
import { fmtBytes } from '../lib/format.js'

export const ICONS = { gauge: Gauge, folder: Folder, vault: VaultIcon, upload: Upload, link: Link2, history: History, trash: Trash2, harddrive: HardDrive, scroll: ScrollText, usercog: UserCog, settings: SettingsIcon }

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
      aria-label={collapsed ? label : undefined}
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

export function Sidebar({ t, nav, screen, setScreen, collapsed, setCollapsed, metrics, metricsUnavailable = false, resolvedTheme, mobileOpen, closeMobile, neoDashboard = false, position = 'left' }) {
  const mobilePanelRef = useRef(null)
  const desktopNavRef = useRef(null)
  const indicatorRef = useRef(null)
  const indicatorPlacedRef = useRef(false)
  const indicatorYRef = useRef(null)
  const reducedMotion = useReducedMotion()
  const [temporaryExpanded, setTemporaryExpanded] = useState(false)
  const closeMobileRef = useRef(closeMobile)
  closeMobileRef.current = closeMobile

  useEffect(() => {
    if (!mobileOpen) return undefined
    const previousFocus = document.activeElement
    const panel = mobilePanelRef.current
    const main = document.querySelector('.authenticated-shell main')
    const previousOverflow = main?.style.overflow
    if (main) main.style.overflow = 'hidden'
    panel?.querySelector('.neo-mobile-close')?.focus()

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMobileRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')]
        .filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!panel.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (main) main.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [mobileOpen])

  // metrics มาจาก /api/dashboard — ระหว่างโหลดเป็น null → มิเตอร์แสดง skeleton
  // ใช้ bytes + fmtBytes ชุดเดียวกับ Dashboard/Storage ห้ามผสม decimal GB กับ binary GB
  const storageBytes = useCountUp(metrics?.storageBytes ?? 0, 700)
  const totalBytes = metrics?.storageTotalBytes ?? 0
  const storagePct = totalBytes > 0 ? (storageBytes / totalBytes) * 100 : 0
  const groups = ['navGroupWorkspace', 'navGroupProtection', 'navGroupAdmin']
  const hoverRail = neoDashboard && position === 'left' && collapsed
  const railState = !collapsed ? 'pinned' : temporaryExpanded && hoverRail ? 'hover' : 'compact'

  useEffect(() => {
    if (!hoverRail) setTemporaryExpanded(false)
  }, [hoverRail])

  useLayoutEffect(() => {
    if (!neoDashboard || position !== 'left') return undefined
    const navElement = desktopNavRef.current
    const indicator = indicatorRef.current
    const active = navElement?.querySelector('.sidebar-nav-item.is-active')
    if (!navElement || !indicator || !active) return undefined
    const positionIndicator = () => {
      const navRect = navElement.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      if (activeRect.height <= 0 || navRect.height <= 0) return
      const y = activeRect.top - navRect.top + navElement.scrollTop
      if (!indicatorPlacedRef.current || reducedMotion) {
        indicator.style.transition = 'none'
        indicator.style.transform = `translateY(${y}px)`
        indicator.style.height = `${activeRect.height}px`
        indicator.style.opacity = '1'
      } else if (Math.abs(y - (indicatorYRef.current ?? y)) > 1) {
        indicator.style.transition = ''
        indicator.style.transform = `translateY(${y}px)`
        indicator.style.height = `${activeRect.height}px`
      }
      indicatorYRef.current = y
      indicatorPlacedRef.current = true
      navElement.dataset.navIndicator = 'ready'
    }
    const frame = requestAnimationFrame(positionIndicator)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(positionIndicator) : null
    observer?.observe(active)
    observer?.observe(navElement)
    window.addEventListener('resize', positionIndicator)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', positionIndicator)
    }
  }, [screen, collapsed, temporaryExpanded, neoDashboard, position, nav, reducedMotion])

  // The desktop rail owns its visual expansion. Its flex footprint stays at
  // 72px while the panel overlays the Dashboard; the mobile drawer is always
  // fully labelled, independent of the desktop pin preference.
  const renderBody = (isCollapsed, isMobile = false) => (
    <div className={`app-sidebar flex flex-col h-full bg-card border-r border-line ${neoDashboard ? 'neo-dashboard-sidebar' : ''}`} data-material={neoDashboard ? 'solid' : 'shell-glass'}>
      <div className={`neo-sidebar-header flex items-center h-16 shrink-0 ${isCollapsed ? 'justify-center px-0 neo-sidebar-header--compact' : 'justify-between px-5'}`}>
        {isCollapsed
          ? <AegisMark size={32} theme={resolvedTheme} />
          : <AegisLockup markSize={36} theme={resolvedTheme} title="AEGIS Drive_LC" sub={t('productLockupSub')} />}
        {neoDashboard && !isMobile && (
          <button
            type="button"
            aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
            className="neo-sidebar-header-toggle size-8 shrink-0 flex items-center justify-center rounded-[9px] text-ink-2 hover:text-ink cursor-pointer"
          >
            <Menu size={18} strokeWidth={1.7} aria-hidden />
          </button>
        )}
        {!neoDashboard && !isCollapsed && (
          <button
            type="button"
            aria-label={t('collapseSidebar')}
            onClick={() => setCollapsed(true)}
            className="size-8 flex items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer max-lg:hidden"
          >
            <PanelLeftClose size={15} strokeWidth={1.5} />
          </button>
        )}
        {mobileOpen && (
          <button type="button" aria-label={t('close')} onClick={closeMobile} className="neo-mobile-close lg:hidden size-10 flex items-center justify-center rounded-[10px] text-ink-2 hover:bg-sunken">
            <X size={18} aria-hidden />
          </button>
        )}
      </div>
      {!neoDashboard && isCollapsed && (
        <button
          type="button"
          aria-label={t('expandSidebar')}
          onClick={() => setCollapsed(false)}
          className="mx-auto mb-1 size-8 flex items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer"
        >
          <PanelLeftOpen size={15} strokeWidth={1.5} />
        </button>
      )}

      <nav ref={isMobile ? undefined : desktopNavRef} className={`flex-1 overflow-y-auto py-2 flex flex-col gap-0.5 ${isCollapsed ? 'px-3' : 'px-4'}`} aria-label={t('productName')}>
        {neoDashboard && !isMobile && <span ref={indicatorRef} className="neo-nav-indicator" aria-hidden />}
        {groups.map((groupKey) => {
          // filter BEFORE map — สิ่งที่ role นี้ไม่มีสิทธิ์ "ไม่ถูก render เลย"
          const items = nav.filter((n) => n.group === groupKey)
          const isAdminGroup = groupKey === 'navGroupAdmin'
          const inner = items.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {!isCollapsed && (
                <p className="text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.1em] px-3.5 pt-4 pb-1.5">{t(groupKey)}</p>
              )}
              {isCollapsed && <div className="h-3" aria-hidden />}
              {items.map((item, i) => (
                <NavItem
                  key={item.id}
                  icon={item.icon}
                  label={t(item.labelKey)}
                  active={screen === item.id}
                  collapsed={isCollapsed}
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
          {isCollapsed && <div className="h-3" aria-hidden />}
          <NavItem
            icon="settings"
            label={t('navSettings')}
            active={screen === 'settings'}
            collapsed={isCollapsed}
            onClick={() => { setScreen('settings'); closeMobile() }}
          />
        </div>
      </nav>

      {/* storage meter — จากเซิร์ฟเวอร์เท่านั้น; ระหว่างโหลด = skeleton ไม่ใช่เลขปลอม */}
      {!isCollapsed && (
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
        className={`app-sidebar-frame shrink-0 h-full transition-[width] duration-[var(--dur-slow)] ${position === 'left' ? 'hidden lg:block' : 'hidden'}`}
        data-rail-state={neoDashboard ? railState : undefined}
        onPointerEnter={(event) => {
          if (hoverRail && event.pointerType === 'mouse') setTemporaryExpanded(true)
        }}
        onPointerLeave={() => setTemporaryExpanded(false)}
        onFocusCapture={() => { if (hoverRail) setTemporaryExpanded(true) }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setTemporaryExpanded(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && temporaryExpanded) {
            setTemporaryExpanded(false)
            event.stopPropagation()
          }
        }}
        style={{ width: collapsed ? 72 : 260, transitionTimingFunction: 'var(--ease)' }}
      >
        {renderBody(collapsed && !temporaryExpanded)}
      </aside>
      {/* mobile off-canvas */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0" style={{ zIndex: 'var(--z-drawer)' }}>
          {/* ⚠️ สกริมของลิ้นชักต้องเป็น token ต่อธีม ไม่ใช่สูตรผสมจาก --ink
              --ink เป็นสีเกือบขาวในธีมมืด สูตรเดิมจึงปูสีขาว 30% ทับทั้งหน้า
              ทำให้ทั้ง shell ดูขุ่นเป็นหมอก แทนที่จะหรี่ลง (ดู .drawer-scrim) */}
          <div className="drawer-scrim fade-in" onClick={closeMobile} aria-hidden />
          <div ref={mobilePanelRef} role="dialog" aria-modal="true" aria-label={t('productName')} className="app-drawer-panel absolute left-0 top-0 bottom-0 w-[260px]" style={{ animation: 'sidebar-in var(--dur-base) var(--ease) both' }}>
            {renderBody(false, true)}
          </div>
        </div>
      )}
    </>
  )
}
