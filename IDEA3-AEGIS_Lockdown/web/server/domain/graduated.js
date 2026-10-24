/**
 * The optional `graduated` section of the Core status projection (design: doc/Content/16_GRADUATED_RESPONSE.md).
 *
 * Display data only. The Core's own severity decisions arrive inside the one-way, Core-initiated status push; this module
 * validates them strictly and gives the UI a bounded view. Nothing here reads a file, opens a socket, mounts a route or accepts a
 * command: the web gains no path to CUT or RESTORE and the vocabulary below has no RESTORE value at all.
 *
 * Strictness: every enum is closed, addresses are IPv4 only, strings are never free text (each field is an enum, an address, an ISO
 * time or a MITRE id), arrays and numbers are bounded, times from the future are refused, and unknown fields are dropped from the
 * copy that is kept. An invalid section is never repaired.
 */
export const GRADUATED_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
export const GRADUATED_ACTIONS = Object.freeze(['NONE', 'SOFTWARE_BLOCK', 'RECOMMEND_CUT', 'AUTO_CUT'])
export const GRADUATED_OUTCOMES = Object.freeze(['NONE', 'BLOCKED', 'BLOCK_FAILED', 'DRY_RUN', 'RECOMMENDED', 'CUT_SENT', 'CUT_QUEUED', 'CUT_REFUSED', 'CUT_DISARMED'])
export const GRADUATED_KINDS = Object.freeze(['port_scan', 'ssh_brute_force', 'syn_flood', 'ssh_login_after_failures', 'generic'])
export const GRADUATED_MAX_DECISIONS = 5
export const GRADUATED_MAX_MITRE = 6
export const GRADUATED_MAX_SCORE = 1000
/** Mirrors the Core scoring window (evidence older than 600 s no longer counts): older decisions are shown as historical. */
export const GRADUATED_CURRENT_WINDOW_MS = 600_000
export const GRADUATED_MAX_FUTURE_SKEW_MS = 5_000

const SECTION_KEYS = ['schemaVersion', 'updatedAt', 'highestLevel', 'cutRecommendedFor', 'autoCutLatched', 'decisions']
const DECISION_KEYS = ['at', 'attackerIp', 'kind', 'level', 'action', 'outcome', 'score', 'mitre']
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const MITRE_ID = /^T\d{4}(?:\.\d{3})?$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function validTime(value, nowMs) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed <= nowMs + GRADUATED_MAX_FUTURE_SKEW_MS
}

function sanitizeDecision(item, nowMs) {
  if (!isPlainObject(item) || !DECISION_KEYS.every((key) => Object.hasOwn(item, key))) return null
  if (!validTime(item.at, nowMs)) return null
  if (typeof item.attackerIp !== 'string' || !IPV4.test(item.attackerIp)) return null
  if (!GRADUATED_KINDS.includes(item.kind) || !GRADUATED_LEVELS.includes(item.level)) return null
  if (!GRADUATED_ACTIONS.includes(item.action) || !GRADUATED_OUTCOMES.includes(item.outcome)) return null
  if (!Number.isSafeInteger(item.score) || item.score < 0 || item.score > GRADUATED_MAX_SCORE) return null
  if (!Array.isArray(item.mitre) || item.mitre.length > GRADUATED_MAX_MITRE) return null
  if (!item.mitre.every((id) => typeof id === 'string' && MITRE_ID.test(id)) || new Set(item.mitre).size !== item.mitre.length) return null
  return {
    at: item.at, attackerIp: item.attackerIp, kind: item.kind, level: item.level, action: item.action,
    outcome: item.outcome, score: item.score, mitre: [...item.mitre],
  }
}

/**
 * Strictly validate one section and return a copy that holds only the known fields, or null when anything is wrong.
 * @param value the untrusted `graduated` value
 * @param options.nowMs the caller's clock (never read here)
 */
export function sanitizeGraduated(value, { nowMs }) {
  if (!Number.isFinite(nowMs) || !isPlainObject(value)) return null
  if (!SECTION_KEYS.every((key) => Object.hasOwn(value, key))) return null
  if (value.schemaVersion !== 1 || !validTime(value.updatedAt, nowMs)) return null
  if (!GRADUATED_LEVELS.includes(value.highestLevel) || typeof value.autoCutLatched !== 'boolean') return null
  if (value.cutRecommendedFor !== null && (typeof value.cutRecommendedFor !== 'string' || !IPV4.test(value.cutRecommendedFor))) return null
  if (!Array.isArray(value.decisions) || value.decisions.length > GRADUATED_MAX_DECISIONS) return null
  const decisions = value.decisions.map((item) => sanitizeDecision(item, nowMs))
  if (decisions.some((decision) => decision === null)) return null
  return {
    schemaVersion: 1,
    updatedAt: value.updatedAt,
    highestLevel: value.highestLevel,
    cutRecommendedFor: value.cutRecommendedFor,
    autoCutLatched: value.autoCutLatched,
    decisions,
  }
}

/**
 * The UI view of a section: null when it is absent, invalid or comes from evidence that is not fresh. Newest decision first.
 * `current` is true only while the last Core update is inside the Core scoring window; an older level is history, not a live reading.
 */
export function normalizeGraduated(raw, { now, forceUnknown = false }) {
  if (forceUnknown || raw === undefined || raw === null) return null
  const section = sanitizeGraduated(raw, { nowMs: now.getTime() })
  if (!section) return null
  const ageMs = Math.max(0, now.getTime() - Date.parse(section.updatedAt))
  return {
    ...section,
    decisions: [...section.decisions].reverse(),
    ageMs,
    current: ageMs <= GRADUATED_CURRENT_WINDOW_MS,
    provenance: 'CORE_PROJECTION',
  }
}
