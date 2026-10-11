import { Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/*
 * NeoSelect — the Neo presentation of PillSelect (Dark and Light).
 *
 * A native <select> opens an operating-system list that CSS cannot round,
 * tint or animate, so in Neo the OPEN list is drawn here as an
 * accessible combobox + listbox. The behaviour contract is unchanged:
 *
 *   - The real <select> (with every original prop and <option> child) is
 *     still rendered. It stays the single source of the value, of form
 *     semantics, of `disabled`, and of test hooks such as data-testid.
 *   - Choosing an option writes it through the native value setter and fires
 *     a real `change` event on that select, so every caller's
 *     onChange(e.target.value) runs exactly as before — controlled or not.
 *   - Option values, labels, order and disabled states are read from the
 *     same <option> children; nothing is re-declared.
 *
 * Keyboard: Enter / Space / Alt+ArrowDown open; ArrowUp / ArrowDown / Home /
 * End move; Enter / Space choose; Escape / Tab close; printable keys jump to
 * the next option starting with that text (typeahead). Focus never leaves the
 * trigger (aria-activedescendant), so focus return is automatic.
 */

const MARGIN = 8
const GAP = 6

function flattenOptions(children, out = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === 'option') {
      out.push({
        value: child.props.value !== undefined ? String(child.props.value) : String(child.props.children ?? ''),
        label: child.props.children,
        disabled: Boolean(child.props.disabled),
      })
    } else if (child.props?.children) {
      flattenOptions(child.props.children, out)
    }
  })
  return out
}

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return isValidElement(node) ? textOf(node.props.children) : ''
}

const nativeValueSetter = () => Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set

function place(rect, panel) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Match the trigger; only a narrow trigger may widen (to 320px) for its labels.
  // Longer labels ellipsize and carry a title instead of overhanging a modal.
  const width = Math.min(Math.max(rect.width, Math.min(panel.scrollWidth + 2, 320)), vw - MARGIN * 2)
  let left = Math.min(Math.max(MARGIN, rect.left), vw - width - MARGIN)
  const below = vh - rect.bottom - GAP - MARGIN
  const above = rect.top - GAP - MARGIN
  const wanted = Math.min(panel.scrollHeight, 320)
  const flip = wanted > below && above > below
  const maxHeight = Math.max(120, Math.min(320, flip ? above : below))
  const top = flip ? Math.max(MARGIN, rect.top - GAP - Math.min(wanted, maxHeight)) : rect.bottom + GAP
  return { left, top, width, maxHeight, flip }
}

export function NeoSelect({ className = '', children, selectProps }) {
  const {
    id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy,
    disabled = false, value, defaultValue, title,
  } = selectProps
  const options = flattenOptions(children)
  const selectRef = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState(value !== undefined ? String(value) : defaultValue !== undefined ? String(defaultValue) : options[0]?.value)
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState(null)
  const typeahead = useRef({ text: '', at: 0 })

  // The native select is the source of truth (controlled or uncontrolled).
  const syncFromNative = useCallback(() => {
    if (selectRef.current) setCurrent(selectRef.current.value)
  }, [])
  useLayoutEffect(() => { syncFromNative() }, [value, syncFromNative, children])

  const currentIndex = options.findIndex((o) => o.value === current)
  const currentOption = options[currentIndex] ?? options[0]

  const choose = (index) => {
    const option = options[index]
    const select = selectRef.current
    if (!option || option.disabled || !select) return
    if (select.value !== option.value) {
      nativeValueSetter()?.call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    syncFromNative()
    // A controlled parent may reject the value; React then restores the DOM
    // value after this handler, so read it again on the next frame.
    requestAnimationFrame(syncFromNative)
    setOpen(false)
  }

  const step = (from, dir) => {
    for (let i = 1; i <= options.length; i += 1) {
      const next = (from + dir * i + options.length * 2) % options.length
      if (!options[next].disabled) return next
    }
    return from
  }

  const openList = (startAt = currentIndex) => {
    if (disabled || options.length === 0) return
    setActive(startAt >= 0 ? startAt : step(-1, 1))
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined }
    const sync = () => {
      if (!triggerRef.current || !panelRef.current) return
      setPos(place(triggerRef.current.getBoundingClientRect(), panelRef.current))
    }
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open])

  // Keep the active option in view as the keyboard moves through a long list.
  useEffect(() => {
    if (!open || active < 0) return
    panelRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, pos])

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event) => {
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer, true)
    return () => window.removeEventListener('pointerdown', onPointer, true)
  }, [open])

  const onKeyDown = (event) => {
    if (disabled) return
    const { key } = event
    if (!open) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        openList()
      }
      return
    }
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
    if (key === 'Tab') { setOpen(false); return }
    if (key === 'ArrowDown') { event.preventDefault(); setActive((a) => step(a, 1)); return }
    if (key === 'ArrowUp') { event.preventDefault(); setActive((a) => step(a, -1)); return }
    if (key === 'Home') { event.preventDefault(); setActive(step(-1, 1)); return }
    if (key === 'End') { event.preventDefault(); setActive(step(options.length, -1)); return }
    if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(active); return }
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now()
      const ta = typeahead.current
      ta.text = now - ta.at > 700 ? key.toLowerCase() : ta.text + key.toLowerCase()
      ta.at = now
      const match = options.findIndex((o) => !o.disabled && textOf(o.label).toLowerCase().startsWith(ta.text))
      if (match >= 0) setActive(match)
    }
  }

  // The native select keeps every original prop except the ones that now
  // belong to the visible trigger (id, labelling) and the visual class.
  const { id: _id, 'aria-label': _al, 'aria-labelledby': _alb, 'aria-describedby': _adb, style: _style, ...nativeProps } = selectProps
  const portalRoot = typeof document !== 'undefined' ? document.body : null

  return (
    <span className="neo-select" data-open={open ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined}>
      <select
        ref={selectRef}
        {...nativeProps}
        tabIndex={-1}
        aria-hidden="true"
        className="neo-select-native"
        onChange={(event) => { nativeProps.onChange?.(event); syncFromNative() }}
      >
        {children}
      </select>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`neo-select-trigger ${className}`}
      >
        <span className="neo-select-value">{currentOption?.label ?? ''}</span>
        <svg className="neo-select-chevron" width="12" height="8" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && portalRoot && createPortal(
        <div
          ref={panelRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : (ariaLabelledBy ?? id)}
          className="neo-select-panel"
          data-placement={pos?.flip ? 'top' : 'bottom'}
          style={{
            left: pos ? pos.left : 0,
            top: pos ? pos.top : 0,
            width: pos ? pos.width : undefined,
            maxHeight: pos ? pos.maxHeight : undefined,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {options.map((option, index) => (
            <div
              key={`${option.value}-${index}`}
              id={`${listId}-opt-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === current}
              aria-disabled={option.disabled || undefined}
              data-active={index === active ? 'true' : undefined}
              className="neo-select-option"
              onPointerEnter={() => !option.disabled && setActive(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="neo-select-option-label" title={textOf(option.label) || undefined}>{option.label}</span>
              {option.value === current && (
                <svg className="neo-select-check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          ))}
        </div>,
        portalRoot,
      )}
    </span>
  )
}

/** True while the document uses the Neo interface (either theme); follows live style changes. */
export function useNeoUi() {
  const read = () => typeof document !== 'undefined'
    && document.documentElement.dataset.uiStyle === 'neo'
  const [on, setOn] = useState(read)
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return undefined
    const observer = new MutationObserver(() => setOn(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-style', 'data-theme'] })
    setOn(read())
    return () => observer.disconnect()
  }, [])
  return on
}
