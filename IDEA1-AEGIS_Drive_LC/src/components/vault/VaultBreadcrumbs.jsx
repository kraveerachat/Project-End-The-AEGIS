// src/components/vault/VaultBreadcrumbs.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · breadcrumb path (UI-3)
//
// วาดเส้นทาง root → … → โฟลเดอร์ปัจจุบันจาก breadcrumbsFor (viewSelectors ส่งมาเป็นอาร์เรย์ node แล้ว)
// กติกา:
//   • ขนมปังทุกชิ้นเป็น <button> จึงโฟกัสได้; Enter/Space ตั้งใจจัดการเอง (preventDefault กันการคลิกซ้ำ
//     จาก activation ดั้งเดิมของเบราว์เซอร์) — ใน jsdom ทางเดียวที่พิสูจน์ได้คือ keydown ตรง ๆ
//   • crumb ปัจจุบัน = ชิ้นสุดท้าย มี aria-current="page" (ผู้ใช้โปรแกรมอ่านจอรู้ว่าอยู่ตรงไหน)
// ⚠️ ชื่อโฟลเดอร์ทั้งหมดมาจาก manifest ที่ถอดรหัสในหน่วยความจำ — ล็อก = จอนี้ไม่มีอยู่เลย
import { useState } from 'react'
import { isInternalItemDrag, isExternalFileDrag } from '../../lib/fileDragDrop.js'

export function VaultBreadcrumbs({ t, items, onNavigate, canDrop = false, onDropTarget }) {
  const [dropTarget, setDropTarget] = useState(null)
  return (
    <nav aria-label={t('vaultTreeBreadcrumbNavLabel')} data-testid="vault-tree-breadcrumbs" className="flex items-center gap-1 flex-wrap min-w-0">
      {items.map((c, i) => {
        const isCurrent = i === items.length - 1
        return (
          <span key={c.nodeId} className="flex items-center gap-1 min-w-0">
            {i > 0 && (
              <span aria-hidden="true" className="text-[13px] text-ink-3 shrink-0 select-none">
                ›
              </span>
            )}
            <button
              type="button"
              data-testid={isCurrent ? 'vault-tree-crumb-current' : 'vault-tree-crumb'}
              aria-current={isCurrent ? 'page' : undefined}
              onClick={() => onNavigate(c.nodeId)}
              data-drop-target={dropTarget === c.nodeId ? 'yes' : undefined}
              onDragOver={(event) => {
                const dt = event.dataTransfer
                const isInternal = isInternalItemDrag(dt)
                const isExt = !isInternal && isExternalFileDrag(dt)
                if (isCurrent || (!canDrop && !isInternal) || isExt) return
                event.preventDefault()
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                setDropTarget(c.nodeId)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => {
                const dt = event.dataTransfer
                const isInternal = isInternalItemDrag(dt)
                const isExt = !isInternal && isExternalFileDrag(dt)
                if (isCurrent || (!canDrop && !isInternal) || isExt) return
                event.preventDefault()
                event.stopPropagation()
                setDropTarget(null)
                onDropTarget?.(c.nodeId, dt)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onNavigate(c.nodeId)
                }
              }}
              className={`max-w-[220px] truncate text-[13px] px-2 py-1 rounded-[6px] transition-colors duration-[var(--dur-fast)] cursor-pointer ${
                dropTarget === c.nodeId
                  ? 'font-semibold text-ink bg-[var(--accent-soft)] ring-1 ring-accent'
                  : isCurrent
                  ? 'font-semibold text-ink bg-sunken'
                  : 'text-ink-2 hover:bg-sunken hover:text-ink'
              }`}
            >
              {c.name}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
