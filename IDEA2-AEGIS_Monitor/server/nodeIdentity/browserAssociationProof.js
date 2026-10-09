import { timingSafeEqual } from 'node:crypto'

import { parseCanonicalBase64Url, parseCanonicalToken } from './agentProtocol.js'
import { verifyEd25519Signature } from './ed25519.js'

export const BROWSER_ASSOCIATION_DOMAIN = 'AEGIS-BROWSER-NODE-ASSOCIATION-V1'

const CLAIM_FIELDS = Object.freeze([
  'version', 'purpose', 'audience', 'challenge_id', 'challenge_nonce',
  'session_binding', 'node_id', 'key_version', 'issued_at_ms', 'expires_at_ms',
])

function assertExactFields(value, fields = CLAIM_FIELDS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('claims must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('claim field set is not canonical')
  }
}

function safeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(`${label} must be a canonical safe integer`)
  }
  return String(value)
}

function textBase64(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`)
  return Buffer.from(value, 'utf8').toString('base64url')
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function canonicalBrowserAssociationPayload(claims) {
  assertExactFields(claims)
  if (claims.version !== 1) throw new TypeError('version is not canonical')
  if (claims.purpose !== BROWSER_ASSOCIATION_DOMAIN) throw new TypeError('purpose is not canonical')
  const issuedAtMs = safeInteger(claims.issued_at_ms, 'issued at')
  const expiresAtMs = safeInteger(claims.expires_at_ms, 'expires at')
  if (claims.expires_at_ms <= claims.issued_at_ms) throw new RangeError('expires at must follow issued at')
  const keyVersion = safeInteger(claims.key_version, 'key version', { positive: true })
  return Buffer.from([
    BROWSER_ASSOCIATION_DOMAIN,
    'version=1',
    `purpose_b64=${textBase64(claims.purpose, 'purpose')}`,
    `audience_b64=${textBase64(claims.audience, 'audience')}`,
    `challenge_id=${parseCanonicalToken(claims.challenge_id, 32, 'challenge id')}`,
    `challenge_nonce=${parseCanonicalToken(claims.challenge_nonce, 32, 'challenge nonce')}`,
    `session_binding=${parseCanonicalToken(claims.session_binding, 32, 'session binding')}`,
    `node_id_b64=${textBase64(claims.node_id, 'node id')}`,
    `key_version=${keyVersion}`,
    `issued_at_ms=${issuedAtMs}`,
    `expires_at_ms=${expiresAtMs}`,
  ].join('\n'), 'utf8')
}

export function verifyBrowserAssociationProof({ claims, signature, publicKeyPem, expected, nowMs = Date.now() }) {
  try {
    if (!expected || !Number.isSafeInteger(nowMs)) return false
    const canonical = canonicalBrowserAssociationPayload(claims)
    parseCanonicalBase64Url(signature, 64, 'signature')
    if (nowMs < claims.issued_at_ms || nowMs >= claims.expires_at_ms) return false
    if (
      !equalText(claims.audience, expected.audience)
      || !equalText(claims.session_binding, expected.sessionBinding)
      || !equalText(claims.challenge_id, expected.challengeId)
      || !equalText(claims.challenge_nonce, expected.challengeNonce)
      || claims.issued_at_ms !== expected.issuedAtMs
      || claims.expires_at_ms !== expected.expiresAtMs
    ) return false
    return verifyEd25519Signature({ publicKeyPem, message: canonical, signature })
  } catch {
    return false
  }
}
