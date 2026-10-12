// src/components/ExternalFileDropSurface.jsx — AEGIS Drive (IDEA1) · PR220-R2 corrective · one external-file drop affordance
//
// Files' workspace drop state is the visual source of truth (dashed accent boundary, tinted
// workspace, centered explanatory pill). Files and Vault both render it through this surface,
// so the two can never drift apart again.
//   • presentation + drag-active state only. What a drop MEANS stays with the caller: Files
//     passes `onDrop` (its upload queue); Vault leaves it out and keeps its screen-level
//     encrypted-upload handler, which the drop event still bubbles to unchanged
//   • only a genuine OS file drag lights it up — an internal AEGIS item drag is a move, and
//     Chrome adds 'Files' to image-element drags, so the AEGIS item type always wins
//   • nested children never flicker it (leave INTO a descendant is ignored, dragover re-asserts);
//     leaving the surface, drop, Escape, a drag ending anywhere, or `enabled` turning false clear it
//   • no role branch: Admin, DataLake-User and any future account render the same thing
import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { isExternalFileDrag, isInternalItemDrag } from '../lib/fileDragDrop.js'

const isUploadDrag = (transfer) => isExternalFileDrag(transfer) && !isInternalItemDrag(transfer)

export function ExternalFileDropSurface({ enabled = true, hint, onDrop, children }) {
  const [active, setActive] = useState(false)
  const show = active && enabled

  useEffect(() => {
    if (!show) return undefined
    const clear = () => setActive(false)
    const onKey = (e) => { if (e.key === 'Escape') clear() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [show])

  useEffect(() => { if (!enabled) setActive(false) }, [enabled])

  const engage = (event) => {
    if (!enabled || !isUploadDrag(event.dataTransfer)) return
    event.preventDefault()
    setActive(true)
  }

  return (
    <div
      data-external-drop-surface=""
      data-drop-active={show ? 'true' : undefined}
      onDragEnter={engage}
      onDragOver={engage}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setActive(false) }}
      onDrop={(event) => { setActive(false); onDrop?.(event) }}
      className={`relative rounded-[var(--r-card)] transition-[outline-color,background-color] ${show ? 'outline-2 outline-dashed outline-accent bg-[var(--accent-soft)]' : ''}`}
    >
      <p className="sr-only">{hint}</p>
      {show && (
        <div data-neo-drop-overlay="" className="absolute inset-0 z-20 rounded-[var(--r-card)] border-2 border-dashed border-accent bg-[var(--accent-soft)] flex items-center justify-center pointer-events-none">
          <span className="inline-flex items-center gap-2 rounded-full bg-card px-4 py-2 text-[13px] font-semibold text-accent shadow-[var(--elev-1)]"><Upload size={16} aria-hidden />{hint}</span>
        </div>
      )}
      {children}
    </div>
  )
}
