// src/lib/vaultPreviewIndexObject.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · encrypted objects
//
// Root catalogs, shards and thumb/poster derivatives are ordinary V2 blobs: random per-blob DEK wrapped by the KEK,
// encrypted { name, type, plainSize } metadata, AES-256-GCM chunk with contentId/index/count AAD — the existing
// envelope, unchanged. NO new crypto lives here; this module only orders existing primitives and adds checks:
//   • expected contentId (from the authenticated parent: head → root → shard → entry) is compared BEFORE any key
//     use or chunk fetch;
//   • the encrypted metadata must carry the reserved marker / exact derivative MIME and an empty name;
//   • sizes are bounded before fetching; index objects are a single chunk; partial or tampered plaintext is never returned.
// ⚠️ Plaintext lives only in page memory; nothing here touches browser storage.
// ⚠️ Sealing uploads through PREVIEW_INDEX_UPLOAD_ROUTE_BASE, whose server route arrives (write-gated) in PR-C.

import { uploadVaultFileChunked } from './vaultChunkedUpload.js'
import { unwrapVaultV2Dek, decryptVaultV2MetaWithDek, decryptVaultChunk, GCM_TAG_BYTES } from './vaultChunkCrypto.js'
import { padToBucket, stripPadding } from './vaultTreeCanonical.js'
import { apiFetch, apiFetchBytes, apiUpload } from './api.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, DERIVATIVE_MIMES, PREVIEW_INDEX_UPLOAD_ROUTE_BASE } from './vaultPreviewIndexConstants.js'

/** structural: equals the server's minimum V2 plaintext chunk (8 MiB), so every index object/derivative is one chunk */
export const INDEX_OBJECT_PLAINTEXT_CHUNK_BYTES = 8 * 1024 * 1024
const MARKERS = new Set([INDEX_ROOT_MARKER, INDEX_SHARD_MARKER])

async function sealBytes({ kek, bytes, type, transport, upload, signal }) {
  const file = new File([bytes], '', { type })
  const res = await upload({
    kek, file, plaintextChunkBytes: INDEX_OBJECT_PLAINTEXT_CHUNK_BYTES, concurrency: 1, signal,
    fetchJson: transport?.fetchJson ?? apiFetch, sendUpload: transport?.sendUpload ?? apiUpload,
    routeBase: PREVIEW_INDEX_UPLOAD_ROUTE_BASE,
  })
  if (!res?.ok) throw new Error(`SEAL_FAILED:${res?.reason ?? 'unknown'}`)
  return { blobRef: { formatVersion: 2, id: String(res.blob.id) }, contentId: res.blob.contentIdB64, cipherBytes: Number(res.blob.size) }
}

/**
 * pad an index plaintext to the smallest bucket and upload it as a one-chunk V2 blob with meta { name: '', type: marker }
 * @returns {Promise<{ blobRef: { formatVersion: 2, id: string }, contentId: string, paddedBytes: number, cipherBytes: number }>}
 */
export async function sealIndexObject({ kek, marker, plaintext, buckets, transport = null, upload = uploadVaultFileChunked, signal = null }) {
  if (!MARKERS.has(marker)) throw new Error('sealIndexObject: unknown marker')
  if (!(plaintext instanceof Uint8Array)) throw new TypeError('sealIndexObject: plaintext must be a Uint8Array')
  const { padded, paddedLength } = padToBucket(plaintext, buckets) // throws LIMIT_DECODED_BYTES when no bucket fits
  const out = await sealBytes({ kek, bytes: padded, type: marker, transport, upload, signal })
  return { ...out, paddedBytes: paddedLength }
}

/**
 * upload one thumb/poster derivative as a one-chunk V2 blob with meta { name: '', type: mime } (not padded)
 * @returns {Promise<{ blobRef: { formatVersion: 2, id: string }, contentId: string, plainSize: number }>}
 */
export async function sealDerivative({ kek, bytes, mime, transport = null, upload = uploadVaultFileChunked, signal = null }) {
  if (!DERIVATIVE_MIMES.includes(mime)) throw new Error('sealDerivative: mime must be image/webp or image/jpeg')
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TypeError('sealDerivative: bytes')
  const out = await sealBytes({ kek, bytes, type: mime, transport, upload, signal })
  return { blobRef: out.blobRef, contentId: out.contentId, plainSize: bytes.length }
}

/**
 * Open a single-chunk V2 blob after checking the expected identity and bounds, verifying the authenticated metadata
 * with `acceptMeta`. Shared by index objects (here) and derivatives (vaultDerivativeRead.js).
 * @returns {Promise<{ ok: true, bytes: Uint8Array, meta: object } | { ok: false, reason: string }>}
 */
export async function openSingleChunkV2({ kek, envelope, expected, maxPlainBytes, acceptMeta, fetchBytes = apiFetchBytes, signal = null, onIntegrityFailure = null }) {
  const aborted = () => Boolean(signal?.aborted)
  if (aborted()) return { ok: false, reason: 'ABORTED' }
  if (!envelope) return { ok: false, reason: 'MISSING' }
  if (envelope.formatVersion !== 2 || String(envelope.id) !== String(expected?.blobRef?.id) || envelope.contentIdB64 !== expected?.contentId) {
    return { ok: false, reason: 'CONTENT_ID_MISMATCH' }
  }
  const plainSize = Number(envelope.size) - GCM_TAG_BYTES
  if (envelope.chunkCount !== 1 || !Number.isSafeInteger(plainSize) || plainSize < 1 || plainSize > maxPlainBytes) return { ok: false, reason: 'BOUNDS' }
  const integrity = () => { try { onIntegrityFailure?.() } catch { /* diagnostics only */ } return { ok: false, reason: 'INTEGRITY' } }
  let dek, meta
  try {
    dek = await unwrapVaultV2Dek(kek, envelope)
    meta = await decryptVaultV2MetaWithDek(dek, envelope)
  } catch { return aborted() ? { ok: false, reason: 'ABORTED' } : integrity() }
  if (aborted()) return { ok: false, reason: 'ABORTED' }
  const verdict = acceptMeta(meta)
  if (verdict !== true) return { ok: false, reason: verdict }
  if (meta.plainSize !== plainSize) return integrity()
  const res = await fetchBytes(`/api/vault/blobs/${encodeURIComponent(envelope.id)}/chunks/0`, { signal })
  if (aborted()) return { ok: false, reason: 'ABORTED' }
  if (!res?.ok || !res.bytes) return { ok: false, reason: 'MISSING' }
  const ivB64 = res.headers?.get?.('X-Vault-Chunk-IV')
  if (!ivB64) return integrity()
  let plain
  try {
    plain = await decryptVaultChunk(dek, { contentId: envelope.contentIdB64, chunkIndex: 0, chunkCount: 1, ivB64, ciphertext: res.bytes })
  } catch { return integrity() }
  if (aborted()) { plain.fill(0); return { ok: false, reason: 'ABORTED' } }
  if (plain.length !== plainSize) { plain.fill(0); return integrity() }
  return { ok: true, bytes: plain, meta }
}

/**
 * Open a root/shard object: expected contentId first, reserved marker + empty name, bounded padded size, unpadded result.
 * @returns {Promise<{ ok: true, plaintext: Uint8Array } | { ok: false, reason: 'MISSING'|'CONTENT_ID_MISMATCH'|'MARKER_MISMATCH'|'INTEGRITY'|'BOUNDS'|'ABORTED' }>}
 */
export async function openIndexObject({ kek, envelope, expected, marker, maxPaddedBytes, fetchBytes = apiFetchBytes, signal = null }) {
  if (!MARKERS.has(marker)) return { ok: false, reason: 'MARKER_MISMATCH' }
  const r = await openSingleChunkV2({
    kek, envelope, expected, maxPlainBytes: maxPaddedBytes, fetchBytes, signal,
    acceptMeta: (meta) => (meta && meta.name === '' && meta.type === marker ? true : 'MARKER_MISMATCH'),
  })
  if (!r.ok) return r
  try {
    return { ok: true, plaintext: stripPadding(r.bytes) }
  } catch {
    r.bytes.fill(0)
    return { ok: false, reason: 'INTEGRITY' }
  }
}
