const UPLOAD_ALIASES = new Set(['upload', 'uploads'])

const normalizedBase = (basePath = '/') => {
  const withLeading = String(basePath || '/').startsWith('/') ? String(basePath || '/') : `/${basePath}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

export function normalizeNavigationIntent(destination, params = {}) {
  const requested = String(destination || 'dashboard').toLowerCase()
  if (UPLOAD_ALIASES.has(requested)) {
    return { screen: 'files', params: { ...params, uploadOpen: true } }
  }
  return { screen: requested, params: { ...params } }
}

export function visiblePrimaryNav(serverNav) {
  if (!Array.isArray(serverNav)) return []
  return serverNav.filter((item) => item?.id !== 'uploads')
}

export function readLocationIntent(pathname, search = '', basePath = '/') {
  const base = normalizedBase(basePath)
  let relative = String(pathname || '/')
  if (relative.startsWith(base)) relative = relative.slice(base.length)
  relative = relative.replace(/^\/+|\/+$/g, '')
  const segment = relative.split('/')[0] || 'dashboard'
  const query = new URLSearchParams(String(search || '').replace(/^\?/, ''))
  const params = {}
  if (query.get('upload') === 'open') params.uploadOpen = true
  if (query.get('file')) params.fileId = query.get('file')
  return normalizeNavigationIntent(segment, params)
}

export function buildLocationForIntent(intent, basePath = '/') {
  const { screen, params } = normalizeNavigationIntent(intent?.screen, intent?.params)
  const base = normalizedBase(basePath)
  const query = new URLSearchParams()
  if (params.uploadOpen) query.set('upload', 'open')
  if (params.fileId != null && String(params.fileId)) query.set('file', String(params.fileId))
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return `${base}${screen}${suffix}`
}
