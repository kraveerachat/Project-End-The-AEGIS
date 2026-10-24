// Presentation helpers for the Core's graduated-response view (server/domain/graduated.js owns the contract).
// Levels, kinds, actions, outcomes and MITRE ids are codes: they are shown as the Core sent them and are never translated.
const LEVEL_CLASS = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' })

export function levelClass(level) {
  return Object.hasOwn(LEVEL_CLASS, level) ? LEVEL_CLASS[level] : 'unknown'
}

/** The runtime's graduated view, or null: absent, invalid or not-fresh evidence is shown as "no data", never as LOW. */
export function graduatedOf(snapshot) {
  const value = snapshot?.runtime?.graduated
  return value && typeof value === 'object' && Array.isArray(value.decisions) ? value : null
}
