// src/components/preview/providers/AudioPreview.jsx — AEGIS Drive (IDEA1) · Unified Preview P1 · audio renderer (spec §17)
//
// The browser's own <audio controls> is the player: it already has accessible play/pause/seek/volume
// with keyboard support, so nothing here wraps it in a focus trap or re-implements controls.
// ⚠️ `src` is an owner-only Range URL (Files /preview) or a Vault Blob/SW-session URL — never plaintext
//    stored anywhere. Never autoplays. preload="metadata" fetches only what duration needs.
import { useState } from 'react'

/** 125.4 → '2:05', 3725 → '1:02:05' */
export function formatAudioDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

/**
 * @param {{ t: Function, src: string, fileName: string, onPhase?: (phase: 'ready'|'failed') => void }} props
 */
export function AudioPreview({ t, src, fileName, onPhase }) {
  const [duration, setDuration] = useState(null)
  const [buffering, setBuffering] = useState(false)
  return (
    <div className="w-full px-6 py-10 flex flex-col items-center gap-3" data-preview-provider="audio-native">
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={t('previewAudioLabel', { name: fileName })}
        onLoadedMetadata={(e) => { setDuration(formatAudioDuration(e.currentTarget.duration)); onPhase?.('ready') }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onError={() => { setBuffering(false); onPhase?.('failed') }}
        className="w-full max-w-[560px]"
      />
      {duration && (
        <p className="text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{t('previewAudioDuration', { time: duration })}</p>
      )}
      {buffering && <p role="status" className="text-[12px] text-ink-3">{t('previewAudioBuffering')}</p>}
    </div>
  )
}
