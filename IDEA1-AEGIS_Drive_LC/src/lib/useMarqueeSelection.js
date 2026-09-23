import { useEffect, useRef, useState } from 'react'

const THRESHOLD_PX = 4
const IGNORE = '[data-file-kind], [data-node-id], button, input, select, textarea, a, label, [role="menu"], [role="dialog"], [data-marquee-ignore]'

const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const sameSet = (a, b) => a.size === b.size && [...a].every((id) => b.has(id))

export function useMarqueeSelection({ enabled, canvasRef, tileEls, selectedIds, onSelectionChange }) {
  const [tracking, setTracking] = useState(false)
  const [box, setBox] = useState(null)
  const drag = useRef(null)
  const latest = useRef({ selectedIds, onSelectionChange })
  latest.current = { selectedIds, onSelectionChange }

  const onPointerDown = (event) => {
    if (!enabled || event.button !== 0 || event.pointerType === 'touch') return
    if (event.target?.closest?.(IGNORE)) return
    drag.current = {
      originX: event.clientX,
      originY: event.clientY,
      additive: event.ctrlKey || event.metaKey,
      snapshot: new Set(latest.current.selectedIds ?? []),
      active: false,
    }
    setTracking(true)
  }

  useEffect(() => {
    if (!tracking) return undefined
    const finish = (cancelled) => {
      const current = drag.current
      drag.current = null
      if (cancelled && current?.active) latest.current.onSelectionChange?.(new Set(current.snapshot))
      if (!cancelled && current && !current.active && !current.additive && current.snapshot.size > 0) {
        latest.current.onSelectionChange?.(new Set())
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
      const registered = tileEls.current.size
        ? tileEls.current
        : new Map([...(canvasRef.current?.querySelectorAll?.('[data-node-id]') ?? [])].map((element) => [element.dataset.nodeId, element]))
      for (const [id, element] of registered) {
        if (element && intersects(element.getBoundingClientRect(), area)) hits.add(id)
      }
      const changed = !sameSet(hits, latest.current.selectedIds ?? new Set())
      if (changed) latest.current.onSelectionChange?.(hits)
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
  }, [tracking, canvasRef, tileEls])

  return { onPointerDown, tracking, box }
}
