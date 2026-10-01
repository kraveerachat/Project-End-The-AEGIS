// src/lib/vaultPreviewProfiles.js — AEGIS Drive (IDEA1) · Unified Preview P2a · derivative profile table
//
// The frozen bounds a manifest-v2 preview entry must satisfy (spec §8.2, §10). Used ONLY to validate
// entries that a later build (P2b+) writes; P2a itself never generates or writes a derivative.
//
// ⚠️ Profile ids are immutable: changing any bound or codec here is a new profile (`vp2`), never an
//    edit of `vp1` — a reader with tighter bounds than the writer would fail secure on a valid Vault.
// ⚠️ Entries with an unknown (future) profile are structurally validated but not bound-checked, and
//    effectivePreviews() ignores them (treated as missing, regenerated lazily — spec §10).
// ⚠️ Pure data — no I/O, no storage, no DOM.

const KiB = 1024
const MiB = 1024 * KiB

export const PREVIEW_KINDS = Object.freeze(['thumb', 'poster', 'motion', 'proxy'])
/** at most one entry per kind (spec §8.2) */
export const MAX_PREVIEWS_PER_NODE = PREVIEW_KINDS.length
/** kinds that are time-based and therefore carry `durationMs` */
export const TIMED_PREVIEW_KINDS = Object.freeze(['motion', 'proxy'])
export const PREVIEW_PROFILE_RE = /^vp[1-9][0-9]*$/

/**
 * Reader acceptance ceiling for the vp1 proxy (spec §16.4, D-9 `proxyMaxSeconds` has no fixed value yet).
 * The P4 writer's `proxyMaxSeconds` must stay ≤ this, or ship its proxies as a new profile.
 * Size ceiling = max video 1.5 Mbps + audio 96 kbps over the full duration, rounded up to 1 GiB.
 */
export const VP1_PROXY_MAX_DURATION_MS = 3_600_000
export const VP1_PROXY_MAX_PLAIN_SIZE = 1024 * MiB

const kind = (o) => Object.freeze({ ...o, mimes: Object.freeze([...o.mimes]) })

/** long/short edge (orientation-independent), plaintext size, duration (timed kinds only), allowed MIME */
export const VAULT_PREVIEW_PROFILES = Object.freeze({
  vp1: Object.freeze({
    thumb: kind({ maxLongEdge: 512, maxShortEdge: 512, maxPlainSize: 256 * KiB, maxDurationMs: null, mimes: ['image/webp', 'image/jpeg'] }),
    poster: kind({ maxLongEdge: 512, maxShortEdge: 512, maxPlainSize: 256 * KiB, maxDurationMs: null, mimes: ['image/webp', 'image/jpeg'] }),
    motion: kind({ maxLongEdge: 480, maxShortEdge: 270, maxPlainSize: 4 * MiB, maxDurationMs: 6_000, mimes: ['video/mp4', 'video/webm'] }),
    proxy: kind({ maxLongEdge: 854, maxShortEdge: 480, maxPlainSize: VP1_PROXY_MAX_PLAIN_SIZE, maxDurationMs: VP1_PROXY_MAX_DURATION_MS, mimes: ['video/mp4'] }),
  }),
})

/** bounds for (profile, kind), or null when this build does not know the profile */
export function previewProfileBounds(profile, previewKind) {
  if (!Object.hasOwn(VAULT_PREVIEW_PROFILES, profile)) return null
  return VAULT_PREVIEW_PROFILES[profile][previewKind] ?? null
}
