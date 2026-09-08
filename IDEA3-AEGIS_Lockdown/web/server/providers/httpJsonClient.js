const MAX_RESPONSE_BYTES = 256 * 1024
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_CREDENTIAL = /^[\x21-\x7e]{8,512}$/

function rejected(code) {
  return { ok: false, code, data: null }
}

function safeUrl(url) {
  if (typeof url !== 'string' || url.trim().length === 0) return null
  try {
    const parsed = new URL(url)
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}

function buildHeaders(token) {
  const headers = { accept: 'application/json' }
  if (typeof token === 'string' && SAFE_CREDENTIAL.test(token)) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * Read one bounded JSON document from an upstream integration feed.
 * The credential is only ever placed in the outgoing Authorization header; no
 * result, error, or code returned from here ever carries it or the raw body.
 */
export async function fetchJsonDocument(url, { fetchImpl = fetch, timeoutMs, token = null, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const target = safeUrl(url)
  if (!target) return rejected('NOT_CONFIGURED')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return rejected('ADAPTER_RESPONSE_REJECTED')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: buildHeaders(token),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response?.ok || response.redirected === true) return rejected('ADAPTER_RESPONSE_REJECTED')

    const text = await response.text()
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) return rejected('ADAPTER_RESPONSE_REJECTED')

    try {
      return { ok: true, code: null, data: JSON.parse(text) }
    } catch {
      return rejected('MALFORMED_RESPONSE')
    }
  } catch (error) {
    return rejected(error?.name === 'AbortError' ? 'ADAPTER_TIMEOUT' : 'ADAPTER_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
}

export { MAX_RESPONSE_BYTES }
