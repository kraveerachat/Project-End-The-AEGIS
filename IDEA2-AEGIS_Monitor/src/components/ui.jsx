import { SearchX } from 'lucide-react'

export function Ping({ tone = 'ok' }) {
  const cls = tone === 'ok' ? 'png' : tone === 'amb' ? 'png amb' : 'png down'
  return (
    <span className={cls} aria-hidden="true">
      <i className="ring" /><i className="core" />
    </span>
  )
}

export function BBox({ kind, label, top, left, width, height }) {
  return (
    <div className={`bbox ${kind}`} style={{ top, left, width, height }}>
      <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
      {label && <span className="bblab"><span>{label}</span></span>}
    </div>
  )
}

export function TBox({ kind, top, left, width, height }) {
  return <div className={`tbox ${kind}`} style={{ top, left, width, height }} />
}

export function FeedChrome() {
  return <div className="grid2" aria-hidden="true" />
}

export function EmptyState({ icon: Icon = SearchX, title, hint, action }) {
  return (
    <div className="empty" role="status">
      <Icon aria-hidden="true" />
      <div className="empty-t">{title}</div>
      {hint && <p className="empty-s">{hint}</p>}
      {action}
    </div>
  )
}

export function StaleBadge({ red = false, label = 'Stale' }) {
  return <span className={red ? 'stale red' : 'stale'}>{label}</span>
}

/* ── Sparkle button — primary action pop ────────────────────────── */
const SPARKLE_SIZES = {
  lg: 'h-12 px-6 text-[14px]',
  xl: 'h-14 px-8 text-[15px]',
}
const POINTS = Array.from({ length: 10 })

export function SparkleButton({ sparkles = 'hover', size = 'lg', className = '', children, ...rest }) {
  return (
    <button
      type="button"
      className={`sparkle-btn sparkle-btn--${sparkles} inline-flex items-center justify-center font-semibold cursor-pointer ${SPARKLE_SIZES[size]} ${className}`}
      {...rest}
    >
      <span className="sparkle-points" aria-hidden>
        {POINTS.map((_, i) => (
          <i key={i} className="sparkle-point" />
        ))}
      </span>
      <span className="sparkle-btn__label">{children}</span>
    </button>
  )
}

export function ThemeToggle({ theme, setTheme, t }) {
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme && setTheme(dark ? 'light' : 'dark')}
      className="size-9 flex items-center justify-center rounded-full text-ink-3 bg-sunken hover:text-ink hover:bg-card border border-line transition-colors duration-[var(--dur-fast)] cursor-pointer shrink-0"
    >
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      )}
    </button>
  )
}

export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="relative w-10 h-6 rounded-full transition-colors duration-[var(--dur-fast)] cursor-pointer shrink-0"
      style={{ background: on ? 'linear-gradient(135deg, #2563eb, #7c3aed)' : 'var(--line)' }}
    >
      <span
        className="absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform duration-[var(--dur-fast)]"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(0)', boxShadow: 'var(--elev-1)' }}
      />
    </button>
  )
}

export function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex items-center gap-0.5 bg-sunken border border-line rounded-full p-0.5">
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`h-7 px-3 rounded-full text-[12.5px] font-medium transition-colors duration-[var(--dur-fast)] cursor-pointer whitespace-nowrap ${
              active ? 'bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-500 dark:to-purple-500 text-white' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function Field({ id, label, right, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
          {label}
        </label>
        {right}
      </div>
      {children}
    </div>
  )
}

export function PillInput({ className = '', ...rest }) {
  return (
    <input
      className={`w-full h-12 px-4 rounded-full bg-sunken border border-line text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_rgba(124,58,237,0.3)] ${className}`}
      {...rest}
    />
  )
}
