import { useEffect, useRef, useState } from 'react'

const THRESHOLD_PX = 4
const IGNORE = '[data-file-kind], [data-node-id], button, input, select, textarea, a, label, [role="menu"], [role="dialog"], [data-marquee-ignore]'

const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const sameSet = (a, b) => a.size === b.size && [...a].every((id) => b.has(id))

/**
 * The one desktop marquee implementation for every workspace (Files grid, Vault TREE grid).
 *
 * The selection source — `{ enabled, tileEls, selectedIds, onSelectionChange }` — is read
 * at event time, never captured at render. Two ways to supply it:
 *   - inline arguments (a component that owns both the surface and the selection), or
 *   - `sourceRef` whose `.current` is that object (WorkspaceMarqueeSurface: App owns the
 *     surface, the mounted screen registers its selection source into it).
 * Box geometry is relative to `canvasRef`; the element that paints the rectangle must be
 * a direct child of that canvas so the canvas is also the rectangle's containing block.
 */
export function useMarqueeSelection({ enabled, canvasRef, tileEls, selectedIds, onSelectionChange, sourceRef = null }) {
  const [tracking, setTracking] = useState(false)
  const [box, setBox] = useState(null)
  const drag = useRef(null)
  const inline = useRef(null)
  inline.current = { enabled, tileEls, selectedIds, onSelectionChange }
  const readSource = useRef(null)
  readSource.current = () => (sourceRef ? sourceRef.current : inline.current) ?? null

  const onPointerDown = (event) => {
    const current = readSource.current()
    if (!current?.enabled || typeof current.onSelectionChange !== 'function') return
    if (event.button !== 0 || event.pointerType === 'touch') return
    if (event.target?.closest?.(IGNORE)) return
    drag.current = {
      originX: event.clientX,
      originY: event.clientY,
      additive: event.ctrlKey || event.metaKey,
      snapshot: new Set(current.selectedIds ?? []),
      active: false,
    }
    setTracking(true)
  }

  useEffect(() => {
    if (!tracking) return undefined
    const source = () => readSource.current()
    const select = (ids) => source()?.onSelectionChange?.(ids)
    const finish = (cancelled) => {
      const current = drag.current
      drag.current = null
      if (cancelled && current?.active) select(new Set(current.snapshot))
      if (!cancelled && current && !current.active && !current.additive && current.snapshot.size > 0) {
        select(new Set())
      }
      setBox(null)
      setTracking(false)
    }
    const onMove = (event) => {
      const current = drag.current
      if (!current) return
      const dx = event.clientX - current.originX
      const dy = event.clientY - current.originY
      if (!current.active && Math.abs(dx) < THRESHOLD_PX && Math.abs(dy) < THRESHOLD_PX) return
      current.active = true
      const area = {
        left: Math.min(current.originX, event.clientX),
        top: Math.min(current.originY, event.clientY),
        right: Math.max(current.originX, event.clientX),
        bottom: Math.max(current.originY, event.clientY),
      }
      const canvas = canvasRef.current?.getBoundingClientRect?.() ?? { left: 0, top: 0 }
      const hits = new Set(current.additive ? current.snapshot : [])
      for (const [id, element] of source()?.tileEls?.current ?? []) {
        if (element && intersects(element.getBoundingClientRect(), area)) hits.add(id)
      }
      if (!sameSet(hits, source()?.selectedIds ?? new Set())) select(hits)
      setBox({ left: area.left - canvas.left, top: area.top - canvas.top, width: area.right - area.left, height: area.bottom - area.top })
    }
    const onUp = () => finish(false)
    const onCancel = () => finish(true)
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(true) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [tracking, canvasRef])

  return { onPointerDown, tracking, box }
}
