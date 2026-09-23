import { X } from 'lucide-react'

export function SelectionAction({ children, danger = false, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`flex items-center gap-1.5 min-h-9 px-3 rounded-full text-[13px] font-medium text-ink-2 hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors duration-[var(--dur-fast)] cursor-pointer ${className}`}
      style={danger ? { color: 'var(--danger)' } : undefined}
      {...props}
    >
      {children}
    </button>
  )
}
export function SelectionActionBar({ label, clearLabel, onClear, children, className = '', ...props }) {
  return (
    <div
      role="region"
      aria-label={clearLabel}
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)] max-w-[calc(100vw-2rem)] flex items-center justify-center gap-1.5 flex-wrap rounded-full border border-line bg-card text-ink pl-4 pr-1.5 py-1.5 ${className}`}
      style={{ boxShadow: 'var(--elev-2)', animation: 'bar-up var(--dur-base) var(--ease) both' }}
      {...props}
    >
      <span className="text-[13px] font-semibold mr-1.5 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {label}
      </span>
      {children}
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="size-9 flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors duration-[var(--dur-fast)] cursor-pointer"
      >
        <X size={15} strokeWidth={1.5} />
      </button>
    </div>
  )
}
