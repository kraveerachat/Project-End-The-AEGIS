import { useEffect, useRef, useState } from 'react'
import { Link2, MoreHorizontal, Upload, Vault } from 'lucide-react'

function buildActions(t, go) {
  return [
    {
      id: 'upload',
      icon: Upload,
      shortLabel: t('quickUploadLabel'),
      label: t('uploadFile'),
      hint: t('uploadFileHint'),
      primary: true,
      run: () => go('files', { uploadOpen: true }),
    },
    {
      id: 'share',
      icon: Link2,
      shortLabel: t('quickShareLabel'),
      label: t('createShareLink'),
      hint: t('createShareLinkHint'),
      run: () => go('shares'),
    },
    {
      id: 'vault',
      icon: Vault,
      shortLabel: t('quickVaultLabel'),
      label: t('openPrivateVault'),
      hint: t('openPrivateVaultHint'),
      run: () => go('vault'),
    },
  ]
}

export function DashboardQuickActions({ t, go }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const menuRef = useRef(null)
  const triggerRef = useRef(null)
  const actions = buildActions(t, go)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector('button')?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const run = (action) => {
    setOpen(false)
    action.run()
  }

  return (
    <div ref={containerRef} className="dashboard-header-actions relative shrink-0">
      <div className="hidden items-center gap-2 md:flex" aria-label={t('quickActions')}>
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <button
              key={action.id}
              type="button"
              aria-label={action.label}
              title={`${action.label} — ${action.hint}`}
              onClick={() => run(action)}
              className={`header-action-button ${action.primary ? 'is-primary' : ''}`}
            >
              <span className="header-action-icon" aria-hidden>
                <Icon size={16} strokeWidth={1.9} />
              </span>
              <span>{action.shortLabel}</span>
            </button>
          )
        })}
      </div>

      <button
        ref={triggerRef}
        type="button"
        className="quick-actions-trigger md:hidden"
        aria-label={t('quickActions')}
        aria-expanded={open}
        aria-controls="dashboard-quick-actions-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={18} strokeWidth={1.8} aria-hidden />
        <span className="hidden sm:inline">{t('quickActions')}</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          id="dashboard-quick-actions-menu"
          role="menu"
          aria-label={t('quickActions')}
          className="quick-actions-menu md:hidden"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')]
            const current = items.indexOf(document.activeElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
            event.preventDefault()
            items[next]?.focus()
          }}
        >
          {actions.map((action) => {
            const Icon = action.icon
            return (
              <button key={action.id} type="button" role="menuitem" onClick={() => run(action)}>
                <span className={`quick-menu-icon ${action.primary ? 'is-primary' : ''}`} aria-hidden>
                  <Icon size={16} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 text-left">
                  <span className="block text-[13px] font-semibold text-ink">{action.label}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{action.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
