import { isPlatformWired } from './fetchState.js'

const EMPTY_METRICS = Object.freeze({
  storageBytes: 0,
  storageTotalBytes: 0,
  dataLakeBytes: 0,
  files: 0,
  activeShares: 0,
})

const arrayOrEmpty = (value) => (Array.isArray(value) ? value : [])

const numberOrFallback = (value, fallback) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
)

export function createEmptyDashboardData() {
  return {
    metrics: { ...EMPTY_METRICS },
    securityAlerts: 0,
    shares: [],
    loginHistory: [],
    activity7d: [],
    recentFiles: [],
  }
}

/**
 * Keeps the Dashboard layout contract stable while data is not wired yet.
 * Missing fields become zero/empty placeholders; explicit null capacity values
 * remain null because the server uses null to mean statfs could not read them.
 */
export function normalizeDashboardData(data) {
  const empty = createEmptyDashboardData()
  const metrics = data?.metrics ?? {}

  return {
    ...empty,
    ...data,
    metrics: {
      storageBytes: metrics.storageBytes === null
        ? null
        : numberOrFallback(metrics.storageBytes, empty.metrics.storageBytes),
      storageTotalBytes: metrics.storageTotalBytes === null
        ? null
        : numberOrFallback(metrics.storageTotalBytes, empty.metrics.storageTotalBytes),
      dataLakeBytes: numberOrFallback(metrics.dataLakeBytes, empty.metrics.dataLakeBytes),
      files: numberOrFallback(metrics.files, empty.metrics.files),
      activeShares: numberOrFallback(metrics.activeShares, empty.metrics.activeShares),
    },
    securityAlerts: numberOrFallback(data?.securityAlerts, empty.securityAlerts),
    shares: arrayOrEmpty(data?.shares),
    loginHistory: arrayOrEmpty(data?.loginHistory),
    activity7d: arrayOrEmpty(data?.activity7d),
    recentFiles: arrayOrEmpty(data?.recentFiles),
  }
}

// A disconnected/not-yet-wired platform is an empty state. If health confirms a
// wired platform is up but this one endpoint fails, that is a real fetch error.
//
// `db === 'memory'` is not a wired platform: there is no durable store behind
// the API yet, so the cards are already showing zeros and "ยังไม่เชื่อมต่อ" on
// purpose. Stacking an alert panel on top of that correct empty state reads as
// a broken app rather than an unconnected one — so the panel stays closed until
// a real store answers /healthz.
export function shouldShowDashboardFetchError(error, healthData) {
  return Boolean(error) && isPlatformWired(healthData)
}
