/**
 * A backend that is not wired yet is an empty state, never a failure.
 *
 * `placeholderMode` (App.jsx) is on when /healthz never answered or reports the
 * in-memory fallback: the platform has no durable store behind it yet, so every
 * screen is already showing zeros and "ยังไม่เชื่อมต่อ" on purpose. A request
 * that fails in that state adds nothing the empty state has not said, and an
 * alert panel on top of a correct empty screen reads as a broken app instead of
 * an unconnected one — so the error panel stays closed and the empty state keeps
 * the space.
 *
 * Once the platform is wired, this is a pass-through: a request that genuinely
 * fails at runtime still surfaces its ErrorState with a working Retry.
 *
 * @param {string|null|undefined} error  errorKind from useApi
 * @param {boolean} placeholderMode      true = backend not wired yet
 * @returns {string|null} the error kind to render, or null to render nothing
 */
export function visibleFetchError(error, placeholderMode) {
  return placeholderMode ? null : (error ?? null)
}

/**
 * One source of truth for whether API payloads represent a connected platform.
 * A missing/failed health response and the seeded in-memory development store
 * are both unwired states; only a successful durable backend is wired.
 */
export function isPlatformWired(healthData) {
  return healthData?.ok === true && healthData?.db !== 'memory'
}
