// Shared Normal Files / Protected Trash renderer. The caller supplies its
// authenticated read-only preview URL; no derivative or mutation path is used.
import { useCallback } from 'react'
import { AudioPreview } from './providers/AudioPreview.jsx'
import { TextFamilyPreview } from './providers/TextFamilyPreview.jsx'
import { readTextHead, TEXT_PREVIEW_MAX_BYTES } from '../../lib/preview/textHead.js'

export function FilePreviewMedia({ t, kind, capability, src, fileName, onPhase, phase = 'loading', maxHeight = '68vh' }) {
  const loadText = useCallback(
    (signal) => readTextHead({ kind: 'files', url: src }, { maxBytes: TEXT_PREVIEW_MAX_BYTES, signal }),
    [src],
  )
  if (kind === 'video') {
    return (
      <video controls preload="metadata" playsInline src={src}
        onLoadedMetadata={() => onPhase('ready')} onError={() => onPhase('failed')}
        className="max-w-full" style={{ maxHeight, opacity: phase === 'ready' ? 1 : 0 }} />
    )
  }
  if (kind === 'audio') return <AudioPreview t={t} src={src} fileName={fileName} onPhase={onPhase} />
  if (kind === 'text') {
    return (
      <TextFamilyPreview t={t} provider={capability?.provider ?? null}
        load={loadText} maxBytes={TEXT_PREVIEW_MAX_BYTES} onPhase={onPhase} />
    )
  }
  if (kind === 'image') {
    return (
      <img src={src} alt={fileName} decoding="async"
        onLoad={() => onPhase('ready')} onError={() => onPhase('failed')}
        className="max-w-full object-contain" style={{ maxHeight, opacity: phase === 'ready' ? 1 : 0 }} />
    )
  }
  return null
}
