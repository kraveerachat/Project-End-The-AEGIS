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
  // Vault decisions made from the name alone must be confirmed from the decrypted bytes before render
  const verify = context === 'vault' && descriptor?.basis !== 'signature' ? 'signature' : 'none'
  return capability({ family, provider: provider.id, state: 'available', tile: TILE_BY_FAMILY[family] ?? 'icon', verify })
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
