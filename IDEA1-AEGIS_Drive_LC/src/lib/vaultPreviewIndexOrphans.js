// src/lib/vaultPreviewIndexOrphans.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · orphan classification
//   + read-only reachability report (plan Tasks D.1, D.4)
//
// D.1  Classification reads ONLY the decrypted, AEAD-authenticated V2 metadata ({ name, type }). No server-supplied
//      field (lifecycle, size, id, timestamps) can make a blob look like an index object: the server cannot forge
//      encrypted metadata, so a user file is never hidden and a reserved object is never offered as a user file.
//        { name: '', type: INDEX_ROOT_MARKER }         → INDEX_ROOT
//        { name: '', type: INDEX_SHARD_MARKER }        → INDEX_SHARD
//        { name: '', type: 'image/jpeg'|'image/webp' } → DERIVATIVE
//        { name: '', type: <anything else> }           → UNNAMED_USER   (recoverable only with an explicit user name)
//        { name: <non-empty>, … }                      → USER           (whatever its type says)
//        null / not an object                          → UNDECRYPTABLE  (recoverable only with an explicit user name)
//
// D.4  RETENTION POLICY (D-1): KEEP EVERYTHING. Every generation and every INDEX_* blob is retained. Growth is bounded
//      only by the server-enforced per-owner retained-storage budget (Task C.7); when it is reached, new preview
//      persistence stops and tiles use the original files. Client-declared superseded refs are advisory bookkeeping
//      and never deletion authority (SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO). Any future physical removal needs its
//      own architecture + plan + Human gate HG-GC that independently proves reachability and retention safety (it may
//      not rely on client-declared superseded refs) with recovery and rollback evidence. HG-GC is outside D-1.
//      The report below is diagnostics only: counts, no ids or names, no mutating request, and it runs only when a
//      caller explicitly invokes it — never on unlock.
// ⚠️ No transport of its own, no storage, no DOM.

import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, DERIVATIVE_MIMES } from './vaultPreviewIndexConstants.js'

export const BLOB_CLASS = Object.freeze({
  USER: 'USER', INDEX_ROOT: 'INDEX_ROOT', INDEX_SHARD: 'INDEX_SHARD', DERIVATIVE: 'DERIVATIVE', UNNAMED_USER: 'UNNAMED_USER', UNDECRYPTABLE: 'UNDECRYPTABLE',
})

/** classes that are preview-index objects (never offered for recovery as user files) */
export const RESERVED_BLOB_CLASSES = Object.freeze([BLOB_CLASS.INDEX_ROOT, BLOB_CLASS.INDEX_SHARD, BLOB_CLASS.DERIVATIVE])

/** @param {{ name?: unknown, type?: unknown } | null | undefined} meta decrypted V2 metadata, or null when undecryptable */
export function classifyDecryptedMeta(meta) {
  if (!meta || typeof meta !== 'object') return BLOB_CLASS.UNDECRYPTABLE
  if (typeof meta.name !== 'string') return BLOB_CLASS.UNNAMED_USER
  if (meta.name !== '') return BLOB_CLASS.USER
  if (meta.type === INDEX_ROOT_MARKER) return BLOB_CLASS.INDEX_ROOT
  if (meta.type === INDEX_SHARD_MARKER) return BLOB_CLASS.INDEX_SHARD
  if (DERIVATIVE_MIMES.includes(meta.type)) return BLOB_CLASS.DERIVATIVE
  return BLOB_CLASS.UNNAMED_USER
}

const MAX_PAGES = 10_000

/**
 * Read-only reachability counts for the current preview index.
 * reachable set = current root + its shards + every derivative those shards reference (shards read via the reader).
 * @param {{ reader: { snapshot(): { head, root }, shardOf(prefix: string): Promise<object|null> },
 *           api: { listPreviewIndexBlobs(q: { after, limit }, o?: { signal }): Promise<{ blobs, next }> },
 *           pageSize?: number, signal?: AbortSignal | null }} o
 * @returns {Promise<{ reachable: number, stagedUnreachable: number, managedUnreachable: number, generationsRetained: number }>}
 */
export async function reachabilityReport({ reader, api, pageSize = 500, signal = null }) {
  const { head, root } = reader.snapshot() ?? {}
  const live = new Set()
  if (head && root) {
    live.add(String(head.rootBlobRef.id))
    for (const d of root.shards ?? []) {
      live.add(String(d.blobRef.id))
      const shard = await reader.shardOf(d.prefix)
      for (const list of shard?.entries?.values?.() ?? []) for (const e of list) live.add(String(e.blobRef.id))
    }
  }
  // generations are sequential from 1 and never removed in D-1, so the head generation is the retained count
  const out = { reachable: 0, stagedUnreachable: 0, managedUnreachable: 0, generationsRetained: head?.indexGeneration ?? 0 }
  let after = null
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const r = await api.listPreviewIndexBlobs({ after, limit: pageSize }, { signal })
    for (const b of r?.blobs ?? []) {
      if (live.has(String(b.id))) out.reachable++
      else if (b.lifecycle === 'INDEX_STAGED') out.stagedUnreachable++
      else if (b.lifecycle === 'INDEX_MANAGED') out.managedUnreachable++
    }
    if (!r?.next) break
    after = r.next
  }
  return out
}
