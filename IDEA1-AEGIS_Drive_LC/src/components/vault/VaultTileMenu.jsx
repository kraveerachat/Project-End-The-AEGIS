// src/components/vault/VaultTileMenu.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · the tree tile menu (UI-5/UI-6)
//
// เมนูต่อชนิดโหนดตามสัญญาของแผน:
//   ไฟล์ (active)   : Preview (เมื่อ previewKindFor(mediaType) ไม่ใช่ null) → Details → Download → Rename → Move → Trash
//   โฟลเดอร์ (active): Open → Details → Rename → Move → Trash
//   อยู่ในถัง        : Restore → Details
// ข้อจำกัดเด็ดขาด:
//   • ไม่มี Secure Share / Public Share / File History / Verify / Protected Trash เด็ดขาด (UI-6)
//     — คำสั่งเหล่านี้ต้อง "กุญแจหรือเซิร์ฟเวอร์เห็นความหมาย" ซึ่ง Approach B ไม่ยอมให้เกิด
//   • กุญแจช่องเดียวพัง (KEY_DEGRADED) = รายการแก้ไขถูกปิดด้วยเหตุผลจริง ไม่ใช่แค่ปุ่มหมอง
//     (data-reason ให้เทสต์/ผู้อ่านจอตรวจเหตุผลได้แบบแม่นยำ)
// ⚠️ คอมโพเนนต์นี้เป็น "เนื้อเมนู" เท่านั้น — ตัวห่อ AnchoredMenu (portal) อยู่ที่ไทล์ผู้เรียก
import { Eye, Info, Download, Pencil, FolderInput, Trash2, RotateCcw, FolderOpen } from 'lucide-react'

const ICONS = Object.freeze({
  open: FolderOpen,
  preview: Eye,
  details: Info,
  download: Download,
  rename: Pencil,
  move: FolderInput,
  trash: Trash2,
  restore: RotateCcw,
})

/**
 * รายการเมนูตามสัญญา — ผู้เรียกคุม kind/view/previewKind/keyDegraded
 * @returns {Array<{ id: string, label: string, danger?: boolean, disabled?: boolean, reason?: string }>}
 */
export function vaultTreeMenuItems({ t, kind, view, previewKind = null, keyDegraded = false }) {
  const deg = (id) => (keyDegraded ? { disabled: true, reason: 'KEY_DEGRADED' } : {})
  if (view === 'trash') {
    return [
      { id: 'restore', label: t('vaultTreeMenuRestore'), ...deg() },
      { id: 'details', label: t('vaultTreeMenuDetails') },
    ]
  }
  if (kind === 'folder') {
    return [
      { id: 'open', label: t('vaultTreeMenuOpen') },
      { id: 'details', label: t('vaultTreeMenuDetails') },
      { id: 'rename', label: t('vaultTreeMenuRename'), ...deg() },
      { id: 'move', label: t('vaultTreeMenuMove'), ...deg() },
      { id: 'trash', label: t('vaultTreeMenuTrash'), danger: true, ...deg() },
    ]
  }
  return [
    ...(previewKind ? [{ id: 'preview', label: t('vaultTreeMenuPreview') }] : []),
    { id: 'details', label: t('vaultTreeMenuDetails') },
    { id: 'download', label: t('vaultTreeMenuDownload') },
    { id: 'rename', label: t('vaultTreeMenuRename'), ...deg() },
    { id: 'move', label: t('vaultTreeMenuMove'), ...deg() },
    { id: 'trash', label: t('vaultTreeMenuTrash'), danger: true, ...deg() },
  ]
}

export function VaultTileMenu({ items, onAction }) {
  return (
    <>
      {items.map(({ id, label, danger, disabled, reason }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          data-action={id}
          data-reason={reason ?? undefined}
          disabled={disabled ?? false}
          aria-disabled={disabled ? 'true' : undefined}
          title={reason ? reason : undefined}
          onClick={disabled ? undefined : () => onAction(id)}
          className={`w-full flex items-center gap-2.5 px-3.5 h-8 text-[13px] font-medium text-left whitespace-nowrap transition-colors duration-[var(--dur-fast)] ${
            disabled ? 'cursor-default' : 'hover:bg-sunken cursor-pointer'
          }`}
          style={{ color: danger ? 'var(--danger)' : disabled ? 'var(--ink-3)' : 'var(--ink-2)' }}
        >
          {(() => { const Icon = ICONS[id]; return Icon ? <Icon size={14} strokeWidth={1.5} /> : null })()}
          {label}
        </button>
      ))}
    </>
  )
}
