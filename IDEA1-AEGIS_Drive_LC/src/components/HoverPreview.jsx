import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/*
 * Compact hover/focus preview — an enterprise tooltip, not a modal.
 *
 * Contract (kept deliberately narrow so it can sit on any data row):
 * - Content is a plain { title, status?, rows[] } object built from values the
 *   screen ALREADY rendered (see lib/previewContent.js). This component never
 *   fetches, so a preview can never reveal more than the row it describes.
 * - Mouse: opens after a stable hover (OPEN_DELAY), closes shortly after the
 *   pointer leaves both the trigger and the panel (CLOSE_DELAY), so moving
 *   from row to panel does not flicker.
 * - Keyboard: opens on :focus-visible, closes on blur or Escape. The panel is
 *   never focusable, so it cannot trap focus.
 * - Touch/pen: ignored entirely. Taps keep their normal meaning; the same
 *   facts stay on screen in the row itself.
 * - One preview at a time across the app.
 * - Portaled + position: fixed, so no card overflow can clip it; it flips
 *   below when there is no room above and clamps to the viewport.
 */
const OPEN_DELAY = 300
const CLOSE_DELAY = 130
const GAP = 8
const EDGE = 8

let closeActive = null

export function HoverPreview({
  as: Tag = 'div',
  preview,
  children,
  className = '',
  onActiveChange,
  ref: externalRef,
  ...rest
}) {
  const id = useId()
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const openTimer = useRef(0)
  const closeTimer = useRef(0)
  const anchorX = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  // The trigger may also be a caller's animation target (e.g. a GSAP ring), so
  // both refs receive the same node.
  const setTriggerRef = useCallback((node) => {
    triggerRef.current = node
    if (typeof externalRef === 'function') externalRef(node)
    else if (externalRef) externalRef.current = node
  }, [externalRef])

  const clearTimers = () => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
  }

  const close = useCallback(() => {
    clearTimers()
    setOpen(false)
    setPos(null)
    if (closeActive === close) closeActive = null
  }, [])

  const show = useCallback(() => {
    if (closeActive && closeActive !== close) closeActive()
    closeActive = close
    setOpen(true)
  }, [close])

  const scheduleClose = () => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(close, CLOSE_DELAY)
  }

  useEffect(() => () => {
    clearTimers()
    if (closeActive === close) closeActive = null
  }, [close])

  // Anything that moves the trigger under a fixed panel ends the preview
  // rather than leaving it pointing at the wrong row.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => { if (event.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const panel = panelRef.current.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const ax = anchorX.current ?? rect.left + rect.width / 2
    const left = Math.min(Math.max(EDGE, ax - panel.width / 2), Math.max(EDGE, vw - panel.width - EDGE))
    const roomAbove = rect.top - GAP - panel.height >= EDGE
    const roomBelow = rect.bottom + GAP + panel.height <= vh - EDGE
    const placement = roomAbove || !roomBelow ? 'top' : 'bottom'
    const top = placement === 'top'
      ? Math.max(EDGE, rect.top - GAP - panel.height)
      : rect.bottom + GAP
    const arrow = Math.min(Math.max(14, ax - left), panel.width - 14)
    setPos({ left: Math.round(left), top: Math.round(top), placement, arrow: Math.round(arrow) })
  }, [open])

  if (!preview) {
    return <Tag ref={externalRef} className={className} {...rest}>{children}</Tag>
  }

  const handlers = {
    onPointerEnter: (event) => {
      if (event.pointerType !== 'mouse') return
      onActiveChange?.(true)
      window.clearTimeout(closeTimer.current)
      if (open) return
      const rect = event.currentTarget.getBoundingClientRect()
      anchorX.current = Math.min(Math.max(event.clientX, rect.left + 24), rect.right - 24)
      window.clearTimeout(openTimer.current)
      openTimer.current = window.setTimeout(show, OPEN_DELAY)
    },
    onPointerLeave: (event) => {
      if (event.pointerType !== 'mouse') return
      onActiveChange?.(false)
      scheduleClose()
    },
    // A press is an action, not a request for more detail.
    onPointerDown: () => close(),
    onFocus: (event) => {
      onActiveChange?.(true)
      let visible = false
      try { visible = event.target.matches(':focus-visible') } catch { visible = false }
      if (!visible) return
      anchorX.current = null
      window.clearTimeout(closeTimer.current)
      show()
    },
    onBlur: (event) => {
      if (event.currentTarget.contains(event.relatedTarget)) return
      onActiveChange?.(false)
      close()
    },
    onKeyDown: (event) => {
      // Escape closes only the preview; a dialog behind it stays open.
      if (event.key === 'Escape' && open) {
        event.stopPropagation()
        close()
      }
    },
  }

  return (
    <>
      <Tag
        ref={setTriggerRef}
        className={className}
        data-preview-open={open ? 'true' : undefined}
        aria-describedby={open ? id : undefined}
        {...rest}
        {...handlers}
      >
        {children}
      </Tag>
      {open && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="tooltip"
          className="hover-preview"
          data-kind={preview.kind}
          data-placement={pos?.placement ?? 'top'}
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            visibility: pos ? 'visible' : 'hidden',
            '--preview-arrow-x': `${pos?.arrow ?? 0}px`,
          }}
          onPointerEnter={(event) => { if (event.pointerType === 'mouse') window.clearTimeout(closeTimer.current) }}
          onPointerLeave={(event) => { if (event.pointerType === 'mouse') scheduleClose() }}
        >
          <div className="hover-preview__head">
            {preview.eyebrow && <span className="hover-preview__eyebrow">{preview.eyebrow}</span>}
            <p className="hover-preview__title">{preview.title}</p>
          </div>
          {preview.status && (
            <span className="hover-preview__status" data-tone={preview.status.tone}>
              <span className="hover-preview__status-dot" aria-hidden />
              {preview.status.label}
            </span>
          )}
          {preview.rows?.length > 0 && (
            <dl className="hover-preview__rows">
              {preview.rows.map((row) => (
                <div key={row.label} className="hover-preview__row">
                  <dt>{row.label}</dt>
                  <dd lang={row.mono ? 'en' : undefined} data-mono={row.mono ? 'true' : undefined}>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <span className="hover-preview__arrow" aria-hidden />
        </div>,
        document.body,
      )}
    </>
  )
}
