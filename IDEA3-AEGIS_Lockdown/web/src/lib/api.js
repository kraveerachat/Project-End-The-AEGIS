let csrfToken = null

export function setCsrfToken(token) {
  csrfToken = token || null
}

export async function apiFetch(path, options = {}) {
  const method = options.method || 'GET'
  const headers = new Headers(options.headers)
  headers.set('accept', 'application/json')
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && csrfToken) headers.set('x-csrf-token', csrfToken)

  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  const response = await fetch(`${base}api${path}`, { ...options, method, headers, credentials: 'same-origin' })
  const body = response.status === 204 ? null : await response.json().catch(() => null)

  if (!response.ok) {
    const error = new Error(body?.error?.message || 'ไม่สามารถเชื่อมต่อ Security Center')
    error.code = body?.error?.code || 'REQUEST_FAILED'
    error.status = response.status
    throw error
  }

  return body
}
