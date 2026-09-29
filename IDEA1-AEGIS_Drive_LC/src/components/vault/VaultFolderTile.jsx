// src/components/vault/VaultFolderTile.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · folder tile (UI-1/UI-4)
// Folder tile: Folder icon + name + child count (active view) — folders carry no size by structure.
// Body click = open; Ctrl/Cmd-click = additive select; checkbox toggles; three-dot = menu.
import { useState, useRef } from 'react'
import { Folder } from 'lucide-react'
import { AnchoredMenu } from '../ui.jsx'
import { FileCardCheckbox, FileCardMenuButton, FileCardShell } from '../FileCardPresentation.jsx'
import { VaultTileMenu, vaultTreeMenuItems } from './VaultTileMenu.jsx'

export function VaultFolderTile({ t, node, tileRef = null, layout = 'grid', view = 'active', selected = false, onSelect, onOpen, onAction, keyDegraded = false, childCount, ...rest }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const menuBtnRef = useRef(null)
  const dragOccurredRef = useRef(false)
  const items = menuOpen ? vaultTreeMenuItems({ t, kind: 'folder', view, keyDegraded }) : []

  return (
    <FileCardShell
      ref={tileRef}
      kind="folder"
      layout={layout}
      selected={selected}
      menuOpen={menuOpen}
      hovered={hovered}
      data-testid="vault-folder-tile"
      data-node-id={node.nodeId}
      data-icon="folder"
      data-layout={layout}
      className="group cursor-pointer"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...rest}
      onDragStart={(event) => {
        dragOccurredRef.current = true
        rest.onDragStart?.(event)
      }}
      onDragEnd={(event) => {
        setTimeout(() => { dragOccurredRef.current = false }, 100)
        rest.onDragEnd?.(event)
      }}
    >
      <FileCardCheckbox
        data-testid="vault-tree-tile-checkbox"
        selected={selected}
        label={t('vaultTreeSelectLabel', { name: node.name })}
        onClick={(event) => { event.stopPropagation(); onSelect(node.nodeId, { additive: true }) }}
        className="absolute right-10 top-1/2 -translate-y-1/2 z-20"
      />
      <button
        type="button"
        data-testid="vault-folder-tile-body"
        className="min-w-0 w-full text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent flex items-center gap-2.5 pr-14"
        onClick={(e) => {
          if (dragOccurredRef.current) { dragOccurredRef.current = false; return }
          if (e.ctrlKey || e.metaKey) { onSelect(node.nodeId, { additive: true }); return }
          onOpen(node.nodeId)
        }}
      >
        <span className="text-[var(--accent)] shrink-0">
          <Folder size={20} strokeWidth={1.4} fill="var(--accent-soft)" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{node.name}</span>
      </button>
      <FileCardMenuButton
        ref={menuBtnRef}
        data-vault-tile-menu={node.nodeId}
        label={t('vaultTreeMenuLabel', { name: node.name })}
        menuOpen={menuOpen}
        data-visible={selected || menuOpen ? 'true' : undefined}
        className="absolute right-2 top-1/2 -translate-y-1/2 z-20"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
      />
      <AnchoredMenu open={menuOpen} anchorRef={menuBtnRef} onClose={() => setMenuOpen(false)} label={t('vaultTreeMenuLabel', { name: node.name })}>
        <VaultTileMenu items={items} onAction={(id) => { setMenuOpen(false); onAction(node, id) }} />
      </AnchoredMenu>
    </FileCardShell>
  )
}
