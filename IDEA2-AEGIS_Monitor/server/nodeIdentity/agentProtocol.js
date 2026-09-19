const MAX_UINT64 = (1n << 64n) - 1n
const MAX_UINT32 = (1n << 32n) - 1n
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const HASH_RE = /^[0-9a-f]{64}$/

export const AUTH_DOMAIN = 'AEGIS-AGENT-AUTH-V1'

export const REQUEST_PROOFS = Object.freeze({
  heartbeat: Object.freeze({ domain: 'AEGIS-AGENT-HEARTBEAT-V1', method: 'POST', path: '/internal/heartbeat' }),
  detection: Object.freeze({ domain: 'AEGIS-ENGINE-DETECTION-V1', method: 'POST', path: '/internal/detections' }),
  alert: Object.freeze({ domain: 'AEGIS-ENGINE-ALERT-V1', method: 'POST', path: '/internal/alerts' }),
  clip: Object.freeze({ domain: 'AEGIS-ENGINE-CLIP-V1', method: 'POST', path: '/internal/clips' }),
})

const AUTH_FIELDS = Object.freeze([
  'challengeId', 'nonce', 'issuedAtMs', 'expiresAtMs',
  'audience', 'purpose', 'nodeId', 'keyVersion',
])
const REQUEST_FIELDS = Object.freeze([
  'domain', 'sessionId', 'requestNonce', 'timestampMs',
  'sequence', 'method', 'path', 'bodySha256',
])

function assertExactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('fields must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('field set is not canonical')
  }
}

function canonicalDecimal(value, options) {
  return parseUint(value, options).toString(10)
}

function encodeText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`)
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function parseCanonicalToken(value, expectedBytes, label = 'token') {
  if (typeof value !== 'string' || !TOKEN_RE.test(value) || value.includes('=')) {
    throw new TypeError(`${label} is not canonical Base64URL`)
  }
  let decoded
  try {
    decoded = Buffer.from(value, 'base64url')
  } catch {
    throw new TypeError(`${label} is not canonical Base64URL`)
  }
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new TypeError(`${label} has the wrong canonical length`)
  }
  return value
}

export function parseUint(value, { label = 'integer', positive = false, max = MAX_UINT64 } = {}) {
  let rendered
  if (typeof value === 'bigint') rendered = value.toString(10)
  else if (typeof value === 'number' && Number.isSafeInteger(value)) rendered = String(value)
  else if (typeof value === 'string') rendered = value
  else throw new TypeError(`${label} is not an unsigned decimal integer`)
  if (!/^(?:0|[1-9][0-9]*)$/.test(rendered)) throw new TypeError(`${label} is not canonical unsigned decimal`)
  const parsed = BigInt(rendered)
  if ((positive && parsed === 0n) || parsed > max) throw new RangeError(`${label} is outside the allowed range`)
  return parsed
}

export function canonicalAuthPayload(fields) {
  assertExactFields(fields, AUTH_FIELDS)
  const challengeId = parseCanonicalToken(fields.challengeId, 32, 'challenge id')
  const nonce = parseCanonicalToken(fields.nonce, 32, 'nonce')
  const issuedAtMs = canonicalDecimal(fields.issuedAtMs, { label: 'issued at' })
  const expiresAtMs = canonicalDecimal(fields.expiresAtMs, { label: 'expires at' })
  if (BigInt(expiresAtMs) <= BigInt(issuedAtMs)) throw new RangeError('expires at must follow issued at')
  if (fields.purpose !== 'agent-authenticate') throw new TypeError('purpose is not canonical')
  const keyVersion = canonicalDecimal(fields.keyVersion, {
    label: 'key version', positive: true, max: MAX_UINT32,
  })
  return Buffer.from([
    AUTH_DOMAIN,
    `challenge_id=${challengeId}`,
    `nonce=${nonce}`,
    `issued_at_ms=${issuedAtMs}`,
    `expires_at_ms=${expiresAtMs}`,
    `audience_b64=${encodeText(fields.audience, 'audience')}`,
    `purpose_b64=${encodeText(fields.purpose, 'purpose')}`,
    `node_id_b64=${encodeText(fields.nodeId, 'node id')}`,
    `key_version=${keyVersion}`,
  ].join('\n'), 'utf8')
}

export function canonicalRequestPayload(fields) {
  assertExactFields(fields, REQUEST_FIELDS)
  const proof = Object.values(REQUEST_PROOFS).find(({ domain }) => domain === fields.domain)
  if (!proof) throw new TypeError('domain is not recognized')
  if (fields.method !== proof.method) throw new TypeError('method does not match proof domain')
  if (fields.path !== proof.path) throw new TypeError('path does not match proof domain')
  if (!HASH_RE.test(fields.bodySha256)) throw new TypeError('body hash is not canonical')
  return Buffer.from([
    proof.domain,
    `session_id=${parseCanonicalToken(fields.sessionId, 32, 'session id')}`,
    `request_nonce=${parseCanonicalToken(fields.requestNonce, 16, 'request nonce')}`,
    `timestamp_ms=${canonicalDecimal(fields.timestampMs, { label: 'timestamp' })}`,
    `sequence=${canonicalDecimal(fields.sequence, { label: 'sequence', positive: true })}`,
    `method_b64=${encodeText(fields.method, 'method')}`,
    `path_b64=${encodeText(fields.path, 'path')}`,
    `body_sha256=${fields.bodySha256}`,
  ].join('\n'), 'utf8')
}

function scanString(text, state) {
  if (text[state.index] !== '"') throw new SyntaxError('JSON object key must be a string')
  const start = state.index
  state.index += 1
  while (state.index < text.length) {
    const char = text[state.index]
    if (char === '\\') {
      state.index += 2
      continue
    }
    state.index += 1
    if (char === '"') return JSON.parse(text.slice(start, state.index))
  }
  throw new SyntaxError('unterminated JSON string')
}

function skipWhitespace(text, state) {
  while (/\s/.test(text[state.index] ?? '')) state.index += 1
}

function scanValue(text, state) {
  skipWhitespace(text, state)
  const char = text[state.index]
  if (char === '{') return scanObject(text, state)
  if (char === '[') {
    state.index += 1
    skipWhitespace(text, state)
    if (text[state.index] === ']') { state.index += 1; return }
    while (state.index < text.length) {
      scanValue(text, state)
      skipWhitespace(text, state)
      if (text[state.index] === ']') { state.index += 1; return }
      if (text[state.index] !== ',') throw new SyntaxError('invalid JSON array')
      state.index += 1
    }
    throw new SyntaxError('unterminated JSON array')
  }
  if (char === '"') { scanString(text, state); return }
  while (state.index < text.length && !/[\s,}\]]/.test(text[state.index])) state.index += 1
}

function scanObject(text, state) {
  state.index += 1
  const keys = new Set()
  skipWhitespace(text, state)
  if (text[state.index] === '}') { state.index += 1; return }
  while (state.index < text.length) {
    skipWhitespace(text, state)
    const key = scanString(text, state)
    if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`)
    keys.add(key)
    skipWhitespace(text, state)
    if (text[state.index] !== ':') throw new SyntaxError('invalid JSON object')
    state.index += 1
    scanValue(text, state)
    skipWhitespace(text, state)
    if (text[state.index] === '}') { state.index += 1; return }
    if (text[state.index] !== ',') throw new SyntaxError('invalid JSON object')
    state.index += 1
  }
  throw new SyntaxError('unterminated JSON object')
}

export function parseStrictJsonBytes(rawBytes, { maxBytes = 16 * 1024 } = {}) {
  const bytes = Buffer.from(rawBytes)
  if (bytes.length > maxBytes) throw new RangeError('JSON body exceeds size limit')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new TypeError('JSON body is not valid UTF-8')
  }
  const state = { index: 0 }
  scanValue(text, state)
  skipWhitespace(text, state)
  if (state.index !== text.length) throw new SyntaxError('JSON body has trailing data')
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('JSON body must be an object')
  }
  return parsed
}
