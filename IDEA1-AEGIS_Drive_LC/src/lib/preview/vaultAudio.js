// src/lib/preview/vaultAudio.js — AEGIS Drive (IDEA1) · Unified Preview P1 · Vault audio path (spec §17)
//
// ⚠️ Zero-knowledge: audio plaintext exists only in this tab — a whole-decrypt Blob URL (registered with the
//    unlocked state so a lock revokes it) or the existing range-decryption Service Worker session (no-store,
//    session token closed on lock). Nothing is stored, nothing is sent to the server as plaintext.
// ⚠️ Above `audioWholeDecryptMaxBytes` there is NO whole-file fallback: no Service Worker (or a V1 blob,
//    which has no chunked range path) means "too large to preview — download instead".
// ⚠️ `contentType` must come from the detected format (vaultRenderMime), never the upload-time hint.

/**
 * @param {{ variant: 1|2, plainSize: number, limits: { audioWholeDecryptMaxBytes: number }, streamSupported: boolean }} o
 * @returns {'whole'|'stream'|'too-large'}
 */
export function planVaultAudioPreview({ variant, plainSize, limits, streamSupported }) {
  const size = Math.max(0, Number(plainSize) || 0)
  if (size <= limits.audioWholeDecryptMaxBytes) return 'whole'
  if (variant === 2 && streamSupported) return 'stream'
  return 'too-large'
}

/**
 * Run the planned path. `openStream({ contentType })` opens the SW session; `readWhole()` decrypts the file.
 * @returns {Promise<{ path: 'whole', ok: true, bytes: Uint8Array }
 *   | { path: 'stream', ok: true, token: string, url: string }
 *   | { path: 'stream', ok: false, reason: string }
 *   | { path: 'too-large', ok: false }>}
 */
export async function openVaultAudioPreview({ variant, plainSize, limits, streamSupported, contentType, openStream, readWhole }) {
  const path = planVaultAudioPreview({ variant, plainSize, limits, streamSupported })
  if (path === 'too-large') return { path, ok: false }
  if (path === 'stream') {
    const s = await openStream({ contentType })
    return s?.ok ? { path, ok: true, token: s.token, url: s.url } : { path, ok: false, reason: s?.reason ?? 'PREVIEW_SESSION' }
  }
  // without readWhole the caller runs its own whole-decrypt + signature render gate (VaultTreeScreen)
  return { path, ok: true, bytes: readWhole ? await readWhole() : null }
}
