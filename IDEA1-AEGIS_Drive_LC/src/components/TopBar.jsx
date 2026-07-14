import { useEffect, useRef, useState } from 'react'
import { Search, Bell, ChevronDown, Menu, FileText, LogOut, FlaskConical } from 'lucide-react'
import { Chip, Dot } from './ui.jsx'
import { ROLE_ADMIN, ROLE_USER } from '../lib/authz.js'
import { FILES, ACTIVITY } from '../lib/data.js'

function Dropdown({ open, onClose, children, align = 'right', width = 280 }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      className={`absolute top-[calc(100%+8px)] bg-card border border-line rounded-[var(--r-tile)] py-2 fade-in ${align === 'right' ? 'right-0' : 'left-0'}`}
      style={{ width, boxShadow: 'var(--elev-2)', zIndex: 'var(--z-dropdown)' }}
    >
      {children}
    </div>
  )
}

export function TopBar({ t, screenLabel, scrolled, previewRole, setPreviewRole, user, theme, setTheme, onSignOut, openMobileNav, goToFiles }) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [bellOpen, setBellOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const searchRef = useRef(null)

  // ⌘K / Ctrl+K — focus global search
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const matches = FILES.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5)
  const alerts = ACTIVITY.filter((a) => a.result !== 'ok')

  return (
    <header
      className="h-16 shrink-0 bg-card flex items-center gap-3 px-5 max-md:px-3 border-b transition-shadow duration-[var(--dur-base)]"
      style={{ borderColor: 'var(--line)', boxShadow: scrolled ? 'var(--elev-1)' : 'none', zIndex: 'var(--z-sticky)', position: 'relative' }}
    >
      <button
        type="button"
        aria-label={t('expandSidebar')}
        onClick={openMobileNav}
        className="md:hidden size-9 flex items-center justify-center rounded-full text-ink-2 hover:bg-sunken cursor-pointer"
      >
        <Menu size={17} strokeWidth={1.5} />
      </button>

      {/* breadcrumbs */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13.5px] whitespace-nowrap max-sm:hidden">
        <span className="text-ink-3">AEGIS</span>
        <span className="text-ink-3">/</span>
        <span className="font-semibold text-ink">{screenLabel}</span>
      </nav>

      {/* global search */}
      <div className="flex-1 flex justify-center px-2 min-w-0">
        <div className="relative w-full max-w-[440px]">
          <Search size={15} strokeWidth={1.5} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true) }}
            onFocus={() => setSearchOpen(true)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="w-full h-10 pl-10 pr-14 rounded-full bg-sunken border border-transparent text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10.5px] font-semibold text-ink-3 bg-card border border-line rounded-[6px] px-1.5 py-0.5 pointer-events-none max-sm:hidden">
            ⌘K
          </kbd>
          <Dropdown open={searchOpen} onClose={() => setSearchOpen(false)} align="left" width="100%">
            <p className="px-4 pb-1.5 text-[11px] font-semibold text-ink-3 uppercase tracking-[0.08em]">{t('searchRecent')}</p>
            {matches.length === 0 && <p className="px-4 py-2 text-[13px] text-ink-3">{t('empty')}</p>}
            {matches.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => { setSearchOpen(false); setQuery(''); goToFiles() }}
                className="w-full flex items-center gap-2.5 px-4 h-9 text-[13px] font-medium text-ink-2 hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer"
              >
                <FileText size={14} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </Dropdown>
        </div>
      </div>

      {/* edge node status */}
      <Chip tone="ok" className="max-lg:hidden">
        <Dot tone="ok" pulse size={6} />
        {t('edgeNodeOnline')}
      </Chip>

      {/* notifications */}
      <div className="relative">
        <button
          type="button"
          aria-label={t('notifications')}
          onClick={() => setBellOpen((v) => !v)}
          className="relative size-9 flex items-center justify-center rounded-full text-ink-2 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer"
        >
          <Bell size={16} strokeWidth={1.5} />
          {alerts.length > 0 && (
            <span
              className="absolute top-1 right-1 min-w-[15px] h-[15px] px-0.5 rounded-full text-[9px] font-bold text-white flex items-center justify-center"
              style={{ background: 'var(--danger)' }}
            >
              {alerts.length}
            </span>
          )}
        </button>
        <Dropdown open={bellOpen} onClose={() => setBellOpen(false)} width={320}>
          <p className="px-4 pb-1.5 text-[11px] font-semibold text-ink-3 uppercase tracking-[0.08em]">{t('notifications')}</p>
          {alerts.map((a) => (
            <div key={a.id} className="px-4 py-2 border-b border-line last:border-b-0" style={{ background: 'var(--danger-soft)', borderLeft: '2px solid var(--danger)' }}>
              <p className="text-[12.5px] text-ink leading-snug">
                <span className="font-semibold">{a.actor}</span> · {a.action}
              </p>
              <p className="font-mono text-[11px] text-ink-3 mt-0.5 truncate">{a.target}</p>
            </div>
          ))}
        </Dropdown>
      </div>

      {/* theme toggle */}
      <button
        type="button"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
        className="size-9 flex items-center justify-center rounded-full text-ink-2 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer"
      >
        {theme === 'dark' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        )}
      </button>

      {/* Preview-as-role — a developer instrument, visibly not part of auth */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPreviewOpen((v) => !v)}
          title={t('previewAsTooltip')}
          className="flex items-center gap-1.5 h-8 px-3 rounded-full text-[11px] font-bold tracking-[0.04em] cursor-pointer transition-colors duration-[var(--dur-fast)] max-sm:hidden"
          style={{ border: '1.5px solid var(--warn)', color: 'var(--warn)', background: previewOpen ? 'var(--warn-soft)' : 'transparent' }}
        >
          <FlaskConical size={12} strokeWidth={2} />
          {t('previewAs')}: {previewRole === ROLE_ADMIN ? t('roleAdmin') : t('roleUser')}
          <ChevronDown size={12} strokeWidth={2} className="transition-transform duration-[var(--dur-fast)]" style={{ transform: previewOpen ? 'rotate(180deg)' : 'none' }} />
        </button>
        <Dropdown open={previewOpen} onClose={() => setPreviewOpen(false)} width={260}>
          <p className="px-4 pb-2 text-[11px] leading-relaxed text-ink-3">{t('previewAsTooltip')}</p>
          {[ROLE_USER, ROLE_ADMIN].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => { setPreviewRole(r); setPreviewOpen(false) }}
              className="w-full flex items-center justify-between px-4 h-9 text-[13px] font-medium text-ink hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer"
            >
              {r === ROLE_ADMIN ? t('roleAdmin') : t('roleUser')}
              {previewRole === r && <span className="size-2 rounded-full" style={{ background: 'var(--warn)' }} />}
            </button>
          ))}
        </Dropdown>
      </div>

      {/* avatar */}
      <div className="relative">
        <button
          type="button"
          aria-label={user.displayName}
          onClick={() => setAvatarOpen((v) => !v)}
          className="size-9 rounded-full bg-ink text-card text-[11px] font-bold flex items-center justify-center cursor-pointer"
        >
          {user.displayName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
        </button>
        <Dropdown open={avatarOpen} onClose={() => setAvatarOpen(false)} width={220}>
          <div className="px-4 pb-2 border-b border-line mb-1.5">
            <p className="text-[13.5px] font-semibold text-ink">{user.displayName}</p>
            <p className="font-mono text-[11px] text-ink-3">{user.username}</p>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="w-full flex items-center gap-2.5 px-4 h-9 text-[13px] font-medium hover:bg-sunken transition-colors duration-[var(--dur-fast)] cursor-pointer"
            style={{ color: 'var(--danger)' }}
          >
            <LogOut size={14} strokeWidth={1.5} />
            {t('signOut')}
          </button>
        </Dropdown>
      </div>
    </header>
  )
}
