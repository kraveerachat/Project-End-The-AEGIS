// src/lib/preview/textHead.js — AEGIS Drive (IDEA1) · Unified Preview P1 · bounded text head reader (spec §18.2)
//
// Text previews never read a whole file: Files asks the owner-only /preview route for one Range of at most
// `maxBytes`; the Vault asks for the plaintext range [0, maxBytes) of a blob it decrypts in this tab only.
// ⚠️ The result is a JS string held by the open preview only — no storage, no cache, no network copy.
// ⚠️ Decoding never throws: invalid UTF-8 becomes U+FFFD. Rendering is the renderer's job (text nodes only).

/** Text previews show at most this much from the start of a file (= Vault limit textPreviewMaxBytes) */
export const TEXT_PREVIEW_MAX_BYTES = 1_048_576

/**
 * @param {Uint8Array} bytes
 * @param {{ truncated?: boolean }} [o] truncated: the byte cap may have cut a multi-byte character — drop it
 * @returns {{ text: string, encoding: 'utf-8'|'utf-16le'|'utf-16be' }}
 */
export function decodeTextBytes(bytes, { truncated = false } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  let encoding = 'utf-8'
  let body = u8
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) { encoding = 'utf-16le'; body = u8.subarray(2) }
  else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) { encoding = 'utf-16be'; body = u8.subarray(2) }
  else if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) body = u8.subarray(3)
  // stream:true keeps an incomplete final sequence pending instead of emitting U+FFFD for it
  const text = new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(body, { stream: truncated })
  return { text, encoding }
}

function totalFromContentRange(value) {
  const m = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(String(value ?? '').trim())
  return m ? Number(m[1]) : null
}

/**
 * @param {{ kind: 'files', url: string }
 *   | { kind: 'vault', readPlainRange: (start: number, end: number) => Promise<Uint8Array>, totalBytes?: number }} source
 * @param {{ maxBytes: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ text: string, truncated: boolean, encoding: 'utf-8'|'utf-16le'|'utf-16be' }>}
 */
export async function readTextHead(source, { maxBytes, signal, fetchImpl = globalThis.fetch } = {}) {
  if (!(maxBytes > 0)) throw new TypeError('maxBytes must be positive')
  let bytes
  let total = null
  if (source?.kind === 'files') {
    const res = await fetchImpl(source.url, { headers: { Range: `bytes=0-${maxBytes - 1}` }, credentials: 'same-origin', signal })
    if (!res?.ok) throw new Error(`preview fetch failed: ${res?.status ?? 'network'}`)
    if (res.status === 206) total = totalFromContentRange(res.headers?.get?.('content-range'))
    bytes = new Uint8Array(await res.arrayBuffer())
  } else if (source?.kind === 'vault') {
    bytes = await source.readPlainRange(0, maxBytes)
    total = Number.isFinite(source.totalBytes) ? source.totalBytes : null
  } else {
    throw new TypeError('unknown text source')
  }
  const truncated = bytes.length > maxBytes || (total !== null && total > maxBytes)
  if (bytes.length > maxBytes) bytes = bytes.subarray(0, maxBytes)
  const { text, encoding } = decodeTextBytes(bytes, { truncated })
  return { text, truncated, encoding }
}
