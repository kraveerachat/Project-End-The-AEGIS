/* Precision Light primitives — only what a door, a lock, and a menu need. */

/* ── Buttons — every button is a pill ────────────────────────────── */
export function Btn({ variant = 'outline', size = 'md', className = '', children, ...rest }) {
  const sizes = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-[14px]', lg: 'h-12 px-6 text-[14px]' }
  const variants = {
    // the one colored shadow in the system — it makes the primary action pop
    primary:
      'bg-(--accent-solid) text-white font-semibold shadow-(--elev-accent) hover:bg-(--accent-solid-hover) hover:-translate-y-px active:scale-[0.98] active:translate-y-0 disabled:shadow-none',
    outline: 'bg-card text-ink font-medium border border-line hover:bg-sunken active:scale-[0.98]',
    ghost: 'text-ink-2 font-medium hover:bg-sunken hover:text-ink active:scale-[0.98]',
  }
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full transition-[background-color,color,transform,opacity,box-shadow] duration-(--dur-fast) cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100 ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ── Toggle switch ───────────────────────────────────────────────── */
export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="relative w-10 h-6 rounded-full transition-colors duration-(--dur-fast) cursor-pointer shrink-0"
      style={{ background: on ? 'var(--accent)' : 'var(--line)' }}
    >
      <span
        className="absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform duration-(--dur-fast)"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(0)', boxShadow: 'var(--elev-1)' }}
      />
    </button>
  )
}

/* ── Theme toggle — one look everywhere (pre-auth header + Hub) ──── */
export function ThemeToggle({ theme, setTheme, t }) {
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      aria-label={dark ? t('themeToLight') : t('themeToDark')}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="size-9 flex items-center justify-center rounded-full text-ink-3 bg-sunken hover:text-ink hover:bg-card transition-colors duration-(--dur-fast) cursor-pointer shrink-0"
    >
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      )}
    </button>
  )
}

/* ── Segmented control — the TH/EN toggle ────────────────────────── */
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
            className={`h-7 px-3 rounded-full text-[12.5px] font-medium transition-colors duration-(--dur-fast) cursor-pointer whitespace-nowrap ${
              active ? 'bg-ink text-card' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── Labeled pill input ──────────────────────────────────────────── */
export function Field({ id, label, children }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}

export function PillInput({ className = '', ...rest }) {
  return (
    <input
      className={`w-full h-12 px-4 rounded-full bg-sunken border border-line text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-(--dur-fast) focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] ${className}`}
      {...rest}
    />
  )
}

/* ── Chip — soft background + strong text, never saturated fill ──── */
const CHIP_TONES = {
  accent: 'bg-accent-soft text-accent-ink',
  neutral: 'bg-sunken text-ink-2 border border-line',
}
export function Chip({ tone = 'neutral', children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap ${CHIP_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
