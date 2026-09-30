// src/lib/preview/vaultCapability.js — AEGIS Drive (IDEA1) · Unified Preview P0 · Vault capability from content
//
// ⚠️ The Vault's preview decision used to be `previewKindFor(node.mediaType)` — the browser's
//    File.type at upload time. That MIME is now only a hint that is never consulted: the decision
//    comes from the decrypted content signature when this unlocked session has seen the first
//    bytes, and otherwise from the normalised extension with `verify: 'signature'` (renderers must
//    confirm the bytes before showing anything).
// ⚠️ The cache is page memory for ONE unlocked session and holds derived facts only
//    ({ sniff, textLike }) — never plaintext, never storage (no localStorage/IndexedDB/Cache API).
//    The screen clears it through its unlocked-state disposer on lock/logout.
import { detectFormat, probeHead } from './formats.js'
import { resolveCapability, previewKindOf } from './registry.js'

const EMPTY_ENV = Object.freeze({ canPlay: Object.freeze({}), webCodecs: Object.freeze({ videoDecode: false, videoEncode: false, imageDecode: false }), swRange: false, webpEncode: false, engine: 'other' })

/** Identity of the content a node points at: a replaced file (new blobRef) is a new entry. */
export function vaultContentKey(node) {
  const ref = node?.blobRef
  if (!node?.nodeId || !ref) return null
  return `${node.nodeId}|${ref.formatVersion ?? 1}|${String(ref.id)}`
}

/**
 * @param {{ onChange?: () => void }} [o]
 * @returns {{ get(node): object|null, record(node, head: Uint8Array): object|null, clear(o?: { seal?: boolean }): void, size(): number }}
 */
export function createVaultCapabilityCache({ onChange = null } = {}) {
  const probes = new Map()
  let sealed = false
  return Object.freeze({
    get(node) {
      const key = vaultContentKey(node)
      return key ? probes.get(key) ?? null : null
    },
    /** Record derived facts from decrypted leading bytes; the bytes themselves are not kept. */
    record(node, head) {
      const key = vaultContentKey(node)
      if (sealed || !key || !head || !head.length) return null
      const probe = probeHead(head)
      const prev = probes.get(key)
      probes.set(key, probe)
      if (!prev || prev.sniff !== probe.sniff || prev.textLike !== probe.textLike) onChange?.()
      return probe
    },
    /** `seal: true` (lock/logout): also ignore records from jobs that finish after the purge */
    clear({ seal = false } = {}) {
      if (seal) sealed = true
      const had = probes.size > 0
      probes.clear()
      if (had) onChange?.()
    },
    size: () => probes.size,
  })
}

/**
 * FileCapability of a Vault node (spec §2) — pure; the mediaType hint is never used.
 * @param {object} node manifest file node
 * @param {{ cache?: ReturnType<typeof createVaultCapabilityCache>|null, env?: object, locked?: boolean, head?: Uint8Array|null }} [o]
 */
export function vaultNodeCapability(node, { cache = null, env = EMPTY_ENV, locked = false, head = null } = {}) {
  if (!node || node.kind !== 'file') return resolveCapability(null, 'vault', env, { locked })
  const probe = head ? probeHead(head) : cache?.get(node) ?? null
  const descriptor = { ...detectFormat({ probe, name: node.name, hintMime: node.mediaType }), size: node.plainSize ?? 0 }
  return resolveCapability(descriptor, 'vault', env, { locked })
}

/** Legacy two-kind view for the existing tile/modal paths: 'image' | 'video' | null */
export function vaultPreviewKind(node, opts) {
  return previewKindOf(vaultNodeCapability(node, opts))
}

/** Normalised MIME for the confirmed format (used as the Blob / SW content type instead of the hint). */
const MIME_BY_FORMAT = Object.freeze({
  jpeg: 'image/jpeg', png: 'image/png', apng: 'image/png', gif: 'image/gif', webp: 'image/webp', 'webp-animated': 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', 'ogg-video': 'video/ogg',
})

/**
 * Render gate: confirm decrypted leading bytes before any renderer receives them.
 * @returns {{ ok: true, kind: 'image'|'video', mime: string } | { ok: false, capability: object }}
 */
export function confirmVaultRender(node, head, { cache = null, env = EMPTY_ENV } = {}) {
  if (cache && head) cache.record(node, head)
  const descriptor = { ...detectFormat({ head, name: node?.name, hintMime: node?.mediaType }), size: node?.plainSize ?? 0 }
  const cap = resolveCapability(descriptor, 'vault', env)
  const kind = previewKindOf(cap)
  if (!kind) return { ok: false, capability: cap }
  return { ok: true, kind, mime: MIME_BY_FORMAT[descriptor.format] }
}

/** Content type for a render path that cannot sniff first (streamed large video): from the extension, never the hint. */
export function vaultRenderMime(node, opts) {
  const cap = vaultNodeCapability(node, opts)
  if (previewKindOf(cap) === null) return null
  const probe = opts?.cache?.get(node) ?? null
  const { format } = detectFormat({ probe, name: node?.name })
  return MIME_BY_FORMAT[format] ?? null
}
