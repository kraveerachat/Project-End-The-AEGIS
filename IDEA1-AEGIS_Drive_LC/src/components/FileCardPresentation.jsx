import { forwardRef } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'

const shellClasses = ({ kind, layout }) => {
  if (kind === 'folder') {
    return layout === 'list'
      ? 'min-h-14 px-3 py-2 flex items-center gap-2.5'
      : 'h-12 pl-3 pr-16 flex items-center gap-2.5'
  }
  return layout === 'list'
    ? 'min-h-16 px-3 py-2 flex items-center gap-3'
    : 'p-3'
}

export const FileCardShell = forwardRef(function FileCardShell({
  as: Element = 'div', kind = 'file', layout = 'grid', selected = false,
  menuOpen = false, hovered = false, dropTarget = false, className = '',
  style = {}, children, ...props
}, ref) {
  return (
    <Element
      ref={ref}
      data-file-card-shell=""
      data-card-kind={kind}
      data-card-layout={layout}
      data-selected={selected ? 'true' : undefined}
      data-menu-open={menuOpen ? 'true' : undefined}
      className={`relative bg-card border rounded-[var(--r-tile)] select-none transition-[transform,box-shadow,border-color,background-color] duration-[var(--dur-fast)] ${shellClasses({ kind, layout })} ${className}`}
      style={{
        borderColor: dropTarget ? 'var(--accent)' : selected ? 'var(--accent)' : hovered ? 'var(--accent-soft)' : 'var(--line)',
        background: dropTarget
          ? 'color-mix(in srgb, var(--accent) 10%, var(--card))'
          : selected ? 'color-mix(in srgb, var(--accent) 4%, var(--card))' : 'var(--card)',
        transform: hovered && !dropTarget ? `translateY(${kind === 'folder' ? '-1px' : '-2px'})` : 'none',
        boxShadow: hovered ? 'var(--elev-1)' : 'none',
        transitionTimingFunction: 'var(--ease)',
        ...style,
      }}
      {...props}
    >
      {children}
    </Element>
  )
})
export function FileCardCheckbox({ selected, label, onClick, className = '', ...props }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={label}
      data-file-card-control="checkbox"
      className={`file-card-control size-5 rounded-[6px] border flex items-center justify-center transition-[opacity,background-color,border-color] duration-[var(--dur-fast)] cursor-pointer ${className}`}
      style={{
        background: selected ? 'var(--accent)' : 'var(--card)',
        borderColor: selected ? 'var(--accent)' : 'var(--line)',
      }}
      onClick={onClick}
      {...props}
    >
      {selected && <Check size={12} strokeWidth={2.5} color="var(--card)" />}
    </button>
  )
}

export const FileCardMenuButton = forwardRef(function FileCardMenuButton({
  label, menuOpen = false, onClick, className = '', ...props
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-file-card-control="menu"
      data-visible={menuOpen ? 'true' : undefined}
      className={`file-card-control size-7 flex items-center justify-center rounded-full bg-card border border-line text-ink-3 hover:text-ink transition-[opacity,color,background-color] duration-[var(--dur-fast)] cursor-pointer ${className}`}
      onClick={onClick}
      {...props}
    >
      <MoreHorizontal size={14} strokeWidth={1.5} />
    </button>
  )
})
