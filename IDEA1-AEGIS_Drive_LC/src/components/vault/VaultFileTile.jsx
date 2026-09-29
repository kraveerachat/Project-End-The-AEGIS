// src/components/vault/VaultFileTile.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · file tile (UI-1/UI-4)
// File tile: icon or poster slot (Phase 7 fills it), name, size/type from the manifest node — never envelope metadata.
import { useEffect, useState, useRef } from 'react'
import { File, FileArchive, FileImage, FileText, FileVideo } from 'lucide-react'
import { AnchoredMenu } from '../ui.jsx'
import { FileCardCheckbox, FileCardMenuButton, FileCardShell } from '../FileCardPresentation.jsx'
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
  const [cardHovered, setCardHovered] = useState(false)
  const [hovering, setHovering] = useState(false)
  const menuBtnRef = useRef(null)
  const holdTimerRef = useRef(0)
  const touchGestureRef = useRef(false)
  const dragOccurredRef = useRef(false)
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
    <FileCardShell
      ref={tileRef}
      kind="file"
      layout={layout}
      selected={selected}
      menuOpen={menuOpen}
      hovered={cardHovered}
      data-testid="vault-file-tile"
      data-node-id={node.nodeId}
      data-icon="file"
      data-layout={layout}
      title={media?.reason ?? undefined}
      className={`group cursor-pointer ${layout === 'list' ? '' : 'flex flex-col items-start gap-2'}`}
      onMouseEnter={() => setCardHovered(true)}
      onMouseLeave={() => { setCardHovered(false); stopMotion() }}
      {...rest}
      onDragStart={(event) => {
        if (touchGestureRef.current) { event.preventDefault(); return }
        dragOccurredRef.current = true
        onDragStart?.(event)
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
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute top-2 left-2 z-20"
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
          if (dragOccurredRef.current) { dragOccurredRef.current = false; return }
          if (consumeClickRef.current) { consumeClickRef.current = false; return }
          if (e.ctrlKey || e.metaKey) { onSelect(node.nodeId, { additive: true }); return }
          onPreview(node)
        }}
      >
        <span data-testid="vault-file-preview-slot" className={previewClass}>
          {media?.motionUrl && hovering && media?.motionKind === 'video' ? (
            <video src={media.motionUrl} autoPlay muted loop playsInline preload="metadata" tabIndex={-1} aria-hidden="true" data-testid="vault-tree-tile-motion" className="size-full object-cover pointer-events-none" />
          ) : media?.motionUrl && hovering ? (
            <img src={media.motionUrl} alt="" draggable={false} data-testid="vault-tree-tile-motion" className="size-full object-cover pointer-events-none" />
          ) : media?.posterUrl ? (
            <img src={media.posterUrl} alt="" draggable={false} data-testid="vault-tree-tile-poster" className="size-full object-cover pointer-events-none" />
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
          {media?.reasonLabel && (
            <span data-testid="vault-media-reason" role="status" className="block text-[11px] leading-snug text-ink-3 mt-1">
              {media.reasonLabel}
            </span>
          )}
        </span>
      </button>
      <FileCardMenuButton
        ref={menuBtnRef}
        data-vault-tile-menu={node.nodeId}
        label={t('vaultTreeMenuLabel', { name: node.name })}
        menuOpen={menuOpen}
        data-visible={selected || menuOpen ? 'true' : undefined}
        className="absolute top-2 right-2 z-20"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
      />
      <AnchoredMenu open={menuOpen} anchorRef={menuBtnRef} onClose={() => setMenuOpen(false)} label={t('vaultTreeMenuLabel', { name: node.name })}>
        <VaultTileMenu items={items} onAction={(id) => { setMenuOpen(false); onAction(node, id) }} />
      </AnchoredMenu>
    </FileCardShell>
  )
}
