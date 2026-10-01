// src/lib/preview/vaultTextHead.js — AEGIS Drive (IDEA1) · Unified Preview P1 · Vault plaintext head (spec §18.2)
//
// Reads only the first `maxBytes` of a V2 Vault blob's plaintext through the normal chunked decrypt path:
// the sink keeps what arrives and aborts the download as soon as enough is held, so no chunk after the one
// that crosses `maxBytes` is ever fetched or decrypted. (One chunk is still decrypted whole: a V2 chunk is
// the unit of authentication.)
// ⚠️ Plaintext stays in this function's return value only — nothing is stored or cached.

/**
 * @param {{ download: (o: { sink: object, signal: AbortSignal }) => Promise<{ ok: boolean, reason?: string }>,
 *   maxBytes: number, plainSize: number, signal?: AbortSignal }} o
 * @returns {Promise<Uint8Array>} at most maxBytes bytes from the start of the plaintext
 */
export async function readVaultPlainHead({ download, maxBytes, plainSize, signal = null }) {
  const want = Math.min(maxBytes, Math.max(0, Number(plainSize) || 0))
  const ctrl = new AbortController()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
  const parts = []
  let held = 0
  const sink = {
    async write(bytes) {
      if (held >= want) return
      const take = bytes.subarray(0, want - held)
      parts.push(take.slice()) // copy only what is kept; the rest of the chunk is released with it
      held += take.length
      if (held >= want) ctrl.abort() // the download loop stops before fetching the next chunk
    },
    async close() { return parts },
    async abort() { /* keep the head we already hold */ },
  }
  const res = await download({ sink, signal: ctrl.signal })
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  if (held < want && !res?.ok) throw new Error(res?.reason ?? 'VAULT_HEAD')
  const out = new Uint8Array(held)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
