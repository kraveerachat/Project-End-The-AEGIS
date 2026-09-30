// AEGIS CORE ENTRY UX CONTRACT — HUMAN OWNER CONTROLLED.
// One fixed browser-history guard keeps ordinary Back inside authenticated Drive.
// It is navigation UX, never an authorization check. Changing it requires an
// explicit task, RED browser evidence, preserved server auth, Human/integration review.
const INDEX = 'aegisDriveAuthIndex'

export function armAuthenticatedBackBoundary(history, url) {
  if (Number.isInteger(history.state?.[INDEX]) && history.state[INDEX] > 0) return
  history.replaceState({ ...(history.state || {}), [INDEX]: 0 }, '', url)
  history.pushState({ ...(history.state || {}), [INDEX]: 1 }, '', url)
}

export function authenticatedNavigationState(state, replace = false) {
  const index = state?.[INDEX]
  if (!Number.isInteger(index)) return null
  return { ...(state || {}), [INDEX]: replace ? index : index + 1 }
}

export function handleAuthenticatedBack(history, active = true) {
  if (!active || history.state?.[INDEX] !== 0) return false
  history.forward() // no pushState, so repeated Back cannot grow history
  return true
}

export function releaseAuthenticatedBackBoundary(history) {
  const index = history.state?.[INDEX]
  if (Number.isInteger(index) && index > 0) history.go(-index)
}
