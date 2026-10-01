// src/lib/preview/registry.js — AEGIS Drive (IDEA1) · Unified Preview P0 · provider registry + capability resolver
//
// ⚠️ One resolver for Normal Files and the Private Vault (spec §2, §4). It is a pure function of
//    (descriptor, context, env): no I/O, no role, no user id, no account age — every account gets
//    the same answer for the same file (spec §30).
// ⚠️ `download` is ALWAYS true. Preview support never gates download (spec §2 rule 1, §3.2).
// ⚠️ P0 registers only the providers that exist today and keeps each context's current
//    previewable set: Files mirrors the server /preview extension allowlist
//    (server/config/previewMedia.js); the Vault keeps its image/video set but decides from the
//    content signature instead of the client MIME. P1+ append providers here.
import { familyOf } from './formats.js'

/** Files: the server /preview route gates by extension, so the client must not offer more. */
const FILES_IMAGE_EXTS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'])
const FILES_VIDEO_EXTS = Object.freeze(['mp4', 'webm'])
/** P1: the server /preview route serves these as audio after a head-signature check */
const FILES_AUDIO_EXTS = Object.freeze(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'])

/** Playback MIME per audio FormatId — also what canPlayType is asked (spec §17) */
export const AUDIO_MIME_BY_FORMAT = Object.freeze({
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', 'ogg-audio': 'audio/ogg', opus: 'audio/ogg; codecs="opus"', wav: 'audio/wav', flac: 'audio/flac',
})
const canPlayAudio = (format, env) => env?.canPlay?.[AUDIO_MIME_BY_FORMAT[format]] === true

/** P1: text family — the server /preview route serves these as text/plain; charset=utf-8 after a text check */
const FILES_TEXT_EXTS = Object.freeze(('txt log md markdown json csv tsv xml svg html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go '
  + 'rs rb php sh ps1 bat yml yaml toml ini cfg conf sql kt swift').split(' '))
const TEXT_FORMATS = Object.freeze(['text', 'source', 'svg', 'html', 'xml', 'markdown', 'json', 'csv', 'tsv'])

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'image-native', family: 'image', source: 'range-url-or-bytes',
    formats: Object.freeze({ files: Object.freeze(['jpeg', 'png', 'webp', 'avif', 'bmp']), vault: Object.freeze(['jpeg', 'png', 'webp']) }),
    filesExtensions: FILES_IMAGE_EXTS,
  }),
  Object.freeze({
    id: 'animated-native', family: 'animated-image', source: 'range-url-or-bytes',
    formats: Object.freeze({ files: Object.freeze(['gif']), vault: Object.freeze(['gif', 'apng', 'webp-animated']) }),
    filesExtensions: FILES_IMAGE_EXTS,
  }),
  Object.freeze({
    id: 'video-native', family: 'video', source: 'range-url-or-bytes',
    formats: Object.freeze({ files: Object.freeze(['mp4', 'webm']), vault: Object.freeze(['mp4', 'webm', 'ogg-video']) }),
    filesExtensions: FILES_VIDEO_EXTS,
  }),
  // P1: native <audio>; MP3 is required, every format still needs the browser to say it can play it
  Object.freeze({
    id: 'audio-native', family: 'audio', source: 'range-url-or-bytes',
    formats: Object.freeze({ files: Object.freeze(Object.keys(AUDIO_MIME_BY_FORMAT)), vault: Object.freeze(Object.keys(AUDIO_MIME_BY_FORMAT)) }),
    filesExtensions: FILES_AUDIO_EXTS,
    playable: canPlayAudio,
  }),
  // P1: bounded head (1 MiB) shown as inert text — SVG/HTML/XML are source, never active content
  Object.freeze({
    id: 'text-plain', family: 'text', source: 'text-head',
    formats: Object.freeze({ files: TEXT_FORMATS, vault: TEXT_FORMATS }),
    filesExtensions: FILES_TEXT_EXTS,
  }),
])

const TILE_BY_FAMILY = Object.freeze({ image: 'thumbnail', 'animated-image': 'thumbnail', video: 'poster' })

const capability = (fields) => Object.freeze({ download: true, family: 'none', provider: null, state: 'unsupported', tile: 'icon', reason: null, verify: 'none', ...fields })

function providerFor(format, ext, context) {
  for (const p of PROVIDERS) {
    const list = p.formats[context]
    if (!list || !list.includes(format)) continue
    if (context === 'files' && !p.filesExtensions.includes(ext)) continue
    return p
  }
  return null
}

/**
 * @param {{ format?: string|null, basis?: string, ext?: string, size?: number } | null} descriptor
 * @param {'files'|'vault'} context
 * @param {object} _env detectPreviewEnv() snapshot (consulted by providers that require a codec; none in P0)
 * @param {{ locked?: boolean, integrityFailed?: boolean }} [opts]
 * @returns {Readonly<{ download: true, family: string, provider: string|null,
 *   state: 'available'|'too-large'|'unsupported-codec'|'unsupported'|'locked'|'integrity-failed',
 *   tile: 'thumbnail'|'poster'|'motion'|'icon', reason: string|null, verify: 'signature'|'none' }>}
 */
export function resolveCapability(descriptor, context, _env, { locked = false, integrityFailed = false } = {}) {
  if (locked) return capability({ state: 'locked', reason: 'LOCKED' })
  const format = descriptor?.format ?? 'unknown'
  const family = familyOf(format)
  if (integrityFailed) return capability({ family, state: 'integrity-failed', reason: 'INTEGRITY' })
  const provider = providerFor(format, String(descriptor?.ext ?? ''), context)
  if (!provider) return capability({ family, state: 'unsupported', reason: 'NO_PROVIDER' })
  if (provider.playable && !provider.playable(format, _env)) return capability({ family, provider: provider.id, state: 'unsupported-codec', reason: 'CODEC' })
  // Vault decisions made from the name alone must be confirmed from the decrypted bytes before render
  const verify = context === 'vault' && descriptor?.basis !== 'signature' ? 'signature' : 'none'
  return capability({ family, provider: provider.id, state: 'available', tile: TILE_BY_FAMILY[family] ?? 'icon', verify })
}

/**
 * What the preview MODAL renders for an available capability: 'image' | 'video' | 'audio' | 'text' | null.
 * ⚠️ Tiles keep using previewKindOf (image/video only) so audio/text files never trigger tile media work.
 * @param {ReturnType<typeof resolveCapability>} cap
 */
export function previewModeOf(cap) {
  if (!cap || cap.state !== 'available') return null
  if (cap.family === 'image' || cap.family === 'animated-image') return 'image'
  if (cap.family === 'video' || cap.family === 'audio' || cap.family === 'text') return cap.family
  return null
}

/**
 * Legacy two-kind view used by the existing tile/modal code paths ('image' | 'video' | null).
 * @param {ReturnType<typeof resolveCapability>} cap
 */
export function previewKindOf(cap) {
  if (!cap || cap.state !== 'available') return null
  if (cap.family === 'image' || cap.family === 'animated-image') return 'image'
  if (cap.family === 'video') return 'video'
  return null
}
