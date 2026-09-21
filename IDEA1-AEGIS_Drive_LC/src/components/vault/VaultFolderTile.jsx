// src/components/vault/VaultFolderTile.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · folder tile (UI-1/UI-4)
// Folder tile: Folder icon + name + child count (active view) — folders carry no size by structure.
// Body click = open; Ctrl/Cmd-click = additive select; checkbox toggles; three-dot = menu.
import { useState, useRef } from 'react'
import { Folder, MoreVertical } from 'lucide-react'
import { AnchoredMenu } from '../ui.jsx'
import { VaultTileMenu, vaultTreeMenuItems } from './VaultTileMenu.jsx'

export function VaultFolderTile({ t, node, view = 'active', childCount = null, selected = false, onSelect, onOpen, onAction, keyDegraded = false, ...rest }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef(null)
  const items = menuOpen ? vaultTreeMenuItems({ t, kind: 'folder', view, keyDegraded }) : []

  return (
    <div
      data-testid="vault-folder-tile"
      data-node-id={node.nodeId}
      data-icon="folder"
      className="relative group rounded-[var(--r-tile)] border border-line bg-card p-3 flex flex-col items-start gap-2 transition-transform duration-[var(--dur-fast)] hover:-translate-y-0.5"
      {...rest}
    >
      <input
        type="checkbox"
        data-testid="vault-tree-tile-checkbox"
        checked={selected}
        onChange={() => onSelect(node.nodeId, { additive: true })}
        aria-label={t('vaultTreeSelectLabel', { name: node.name })}
        className="size-4 accent-[var(--accent)] cursor-pointer shrink-0"
      />
      <button
        type="button"
        data-testid="vault-folder-tile-body"
        className="flex flex-col items-start gap-1.5 w-full text-left cursor-pointer"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) { onSelect(node.nodeId, { additive: true }); return }
          onOpen(node.nodeId)
        }}
      >
        <span className="text-[var(--accent)]">
          <Folder size={40} strokeWidth={1.2} />
        </span>
        <span className="w-full truncate text-[13.5px] font-medium text-ink">{node.name}</span>
        {childCount !== null && childCount !== undefined && (
          <span data-testid="vault-folder-child-count" className="text-[12px] text-ink-3">
            {childCount === 0 ? t('vaultTreeFolderEmpty') : childCount === 1 ? t('vaultTreeChildCountOne') : t('vaultTreeChildCount', { n: childCount })}
          </span>
        )}
      </button>
      <button
        type="button"
        ref={menuBtnRef}
        data-vault-tile-menu={node.nodeId}
        aria-label={t('vaultTreeMenuLabel', { name: node.name })}
        aria-haspopup="menu"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ui-icon-button size-8 rounded-full text-ink-2 hover:bg-sunken cursor-pointer"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
      >
        <MoreVertical size={16} strokeWidth={1.5} />
      </button>
      <AnchoredMenu open={menuOpen} anchorRef={menuBtnRef} onClose={() => setMenuOpen(false)} label={t('vaultTreeMenuLabel', { name: node.name })}>
        <VaultTileMenu items={items} onAction={(id) => { setMenuOpen(false); onAction(node, id) }} />
      </AnchoredMenu>
    </div>
  )
}
