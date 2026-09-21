// src/components/vault/VaultFileTile.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · file tile (UI-1/UI-4)
// File tile: icon or poster slot (Phase 7 fills it), name, size/type from the manifest node — never envelope metadata.
import { useEffect, useState, useRef } from 'react'
import { File, FileArchive, FileImage, FileText, FileVideo, MoreVertical } from 'lucide-react'
import { AnchoredMenu } from '../ui.jsx'
import { VaultTileMenu, vaultTreeMenuItems } from './VaultTileMenu.jsx'
import { fmtBytes } from '../../lib/format.js'

function iconFor(mediaType = '') {
  if (mediaType.startsWith('image/')) return FileImage
  if (mediaType.startsWith('video/')) return FileVideo
  if (mediaType.startsWith('text/') || mediaType === 'application/pdf') return FileText
  if (/zip|tar|gzip|rar|7z/.test(mediaType)) return FileArchive
  return File
}

export const VAULT_MEDIA_HOLD_MS = 250

export function VaultFileTile({ t, node, tileRef = null, layout = 'grid', view = 'active', previewKind = null, selected = false, onSelect, onPreview, onAction, keyDegraded = false, media = null, onDragStart, ...rest }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovering, setHovering] = useState(false)
  const menuBtnRef = useRef(null)
  const holdTimerRef = useRef(0)
  const touchGestureRef = useRef(false)
  const consumeClickRef = useRef(false)
  const motionActiveRef = useRef(false)
  const mediaRef = useRef(media)
  mediaRef.current = media
  const items = menuOpen ? vaultTreeMenuItems({ t, kind: 'file', view, previewKind, keyDegraded }) : []
  const FileIcon = iconFor(node.mediaType)
  const previewClass = layout === 'list'
    ? 'size-12 rounded-[8px] bg-sunken flex items-center justify-center overflow-hidden shrink-0'
    : 'w-full aspect-[4/3] rounded-[10px] bg-sunken flex items-center justify-center overflow-hidden'

  const startMotion = () => {
    if (!media?.hoverEnabled || motionActiveRef.current) return
    motionActiveRef.current = true
    setHovering(true)
    media.onHoverStart?.()
  }
  const stopMotion = () => {
    clearTimeout(holdTimerRef.current)
    holdTimerRef.current = 0
    if (motionActiveRef.current) {
      motionActiveRef.current = false
      setHovering(false)
      media?.onHoverEnd?.()
    }
  }
  useEffect(() => () => {
    clearTimeout(holdTimerRef.current)
    if (motionActiveRef.current) mediaRef.current?.onHoverEnd?.()
  }, [])

  return (
    <div
      ref={tileRef}
      data-testid="vault-file-tile"
      data-node-id={node.nodeId}
      data-icon="file"
      data-layout={layout}
      title={media?.reason ?? undefined}
      onDragStart={(event) => {
        if (touchGestureRef.current) { event.preventDefault(); return }
        onDragStart?.(event)
      }}
      className={`relative group rounded-[var(--r-tile)] border bg-card transition-[border-color,background-color] duration-[var(--dur-fast)] ${selected ? 'border-accent bg-[var(--accent-soft)]' : 'border-line'} ${layout === 'list' ? 'min-h-16 px-3 py-2 flex items-center gap-3' : 'p-3 flex flex-col items-start gap-2'}`}
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
        data-testid="vault-file-tile-body"
        className={`min-w-0 w-full text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${layout === 'list' ? 'flex items-center gap-3 pr-8' : 'flex flex-col items-start gap-2'}`}
        onMouseEnter={media?.hoverEnabled ? startMotion : undefined}
        onMouseLeave={media?.hoverEnabled ? stopMotion : undefined}
        onPointerDown={media?.hoverEnabled ? (event) => {
          if (event.pointerType !== 'touch') return
          touchGestureRef.current = true
          clearTimeout(holdTimerRef.current)
          holdTimerRef.current = setTimeout(() => {
            consumeClickRef.current = true
            startMotion()
          }, VAULT_MEDIA_HOLD_MS)
        } : undefined}
        onPointerUp={media?.hoverEnabled ? (event) => {
          if (event.pointerType !== 'touch') return
          touchGestureRef.current = false
          stopMotion()
        } : undefined}
        onPointerCancel={media?.hoverEnabled ? () => {
          touchGestureRef.current = false
          stopMotion()
        } : undefined}
        data-motion-active={hovering && media?.motionUrl ? 'true' : undefined}
        onClick={(e) => {
          if (consumeClickRef.current) { consumeClickRef.current = false; return }
          if (e.ctrlKey || e.metaKey) { onSelect(node.nodeId, { additive: true }); return }
          onPreview(node)
        }}
      >
        <span data-testid="vault-file-preview-slot" className={previewClass}>
          {media?.motionUrl && hovering ? (
            <img src={media.motionUrl} alt="" data-testid="vault-tree-tile-poster" className="size-full object-contain" />
          ) : media?.posterUrl ? (
            <img src={media.posterUrl} alt="" data-testid="vault-tree-tile-poster" className="size-full object-contain" />
          ) : (
            <span className="text-[var(--accent)]">
              <FileIcon size={layout === 'list' ? 24 : 42} strokeWidth={1.2} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 w-full">
          <span className="block w-full truncate text-[13.5px] font-medium text-ink">{node.name}</span>
          <span data-testid="vault-file-info" className="block text-[12px] text-ink-3 truncate w-full mt-0.5">
            {node.mediaType ? `${node.mediaType} · ${fmtBytes(node.plainSize)}` : fmtBytes(node.plainSize)}
          </span>
        </span>
      </button>
      <button
        type="button"
        ref={menuBtnRef}
        data-vault-tile-menu={node.nodeId}
        aria-label={t('vaultTreeMenuLabel', { name: node.name })}
        aria-haspopup="menu"
        data-visible={selected || menuOpen ? 'true' : undefined}
        className="tile-hover-control absolute top-2 right-2 ui-icon-button size-8 rounded-full text-ink-2 hover:bg-sunken cursor-pointer"
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
