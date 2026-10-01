// src/lib/preview/env.js — AEGIS Drive (IDEA1) · Unified Preview P0 · browser capability snapshot
//
// ⚠️ Feature detection only: what this browser can decode/encode. No storage, no network, no
//    account input. Missing APIs (Node, jsdom, old browsers) yield `false`, never an exception.

/** MIME types probed with HTMLMediaElement.canPlayType (P1 audio providers consult these). */
export const PROBED_MEDIA_TYPES = Object.freeze([
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/ogg; codecs="opus"', 'audio/wav', 'audio/flac', 'audio/webm',
  'video/mp4', 'video/webm', 'video/ogg',
])

function engineOf(userAgent) {
  const ua = String(userAgent ?? '')
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium'
  if (/Firefox\//.test(ua)) return 'gecko'
  if (/AppleWebKit\//.test(ua) && /Safari\//.test(ua)) return 'webkit'
  return 'other'
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * canPlayType for every probed media type only (no canvas, no other probe) — what the audio/video
 * providers consult. Never throws; a missing API gives `false`.
 * @param {Window|object} [win]
 * @returns {Readonly<Record<string, boolean>>}
 */
export function detectCanPlay(win = globalThis) {
  const w = win && typeof win === 'object' ? win : {}
  const canPlay = {}
  let probe = null
  try { probe = w.document?.createElement?.('audio') ?? null } catch { probe = null }
  for (const type of PROBED_MEDIA_TYPES) {
    let ok = false
    try { ok = typeof probe?.canPlayType === 'function' && probe.canPlayType(type) !== '' } catch { ok = false }
    canPlay[type] = ok
  }
  return Object.freeze(canPlay)
}

/**
 * @param {Window|object} [win] defaults to globalThis
 * @returns {Readonly<{ canPlay: Record<string, boolean>, webCodecs: { videoDecode: boolean, videoEncode: boolean, imageDecode: boolean },
 *                     swRange: boolean, webpEncode: boolean, engine: 'chromium'|'gecko'|'webkit'|'other' }>}
 */
export function detectPreviewEnv(win = globalThis) {
  const w = win && typeof win === 'object' ? win : {}
  const canPlay = { ...detectCanPlay(w) }
  let webpEncode = false
  try {
    const canvas = w.document?.createElement?.('canvas')
    webpEncode = typeof canvas?.toDataURL === 'function' && String(canvas.toDataURL('image/webp')).startsWith('data:image/webp')
  } catch { webpEncode = false }
  return deepFreeze({
    canPlay,
    webCodecs: {
      videoDecode: typeof w.VideoDecoder === 'function',
      videoEncode: typeof w.VideoEncoder === 'function',
      imageDecode: typeof w.ImageDecoder === 'function',
    },
    swRange: Boolean(w.navigator?.serviceWorker) && typeof w.ReadableStream === 'function',
    webpEncode,
    engine: engineOf(w.navigator?.userAgent),
  })
}
