import { randomBytes as systemRandomBytes } from 'node:crypto'

const TOKEN_START_RE = /^[A-Za-z0-9]/

export class IdentityCapacityError extends Error {
  constructor(message = 'identity state capacity reached') {
    super(message)
    this.name = 'IdentityCapacityError'
    this.code = 'IDENTITY_CAPACITY'
  }
}

export function generateCanonicalToken(byteLength, randomBytes = systemRandomBytes) {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const bytes = Buffer.from(randomBytes(byteLength))
    if (bytes.length !== byteLength) throw new TypeError('random source returned the wrong byte length')
    const token = bytes.toString('base64url')
    if (TOKEN_START_RE.test(token)) return token
  }
  throw new IdentityCapacityError('canonical token generation failed')
}

export class ChallengeStore {
  #entries = new Map()
  #now
  #randomBytes
  #ttlMs
  #maxPerNode
  #maxTotal

  constructor({
    now = Date.now,
    randomBytes = systemRandomBytes,
    ttlMs = 60_000,
    maxPerNode = 4,
    maxTotal = 1_024,
  } = {}) {
    this.#now = now
    this.#randomBytes = randomBytes
    this.#ttlMs = ttlMs
    this.#maxPerNode = maxPerNode
    this.#maxTotal = maxTotal
  }

  get size() {
    this.#purgeExpired()
    return this.#entries.size
  }

  issue({ nodeId, audience, keyVersion, physicalCameraId = null }) {
    const issuedAtMs = this.#now()
    this.#purgeExpired(issuedAtMs)
    let nodeCount = 0
    for (const entry of this.#entries.values()) {
      if (entry.nodeId === nodeId) nodeCount += 1
    }
    if (nodeCount >= this.#maxPerNode || this.#entries.size >= this.#maxTotal) {
      throw new IdentityCapacityError()
    }
    let challengeId = null
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = generateCanonicalToken(32, this.#randomBytes)
      if (!this.#entries.has(candidate)) {
        challengeId = candidate
        break
      }
    }
    if (!challengeId) throw new IdentityCapacityError('unique challenge generation failed')
    const payload = {
      challengeId,
      nonce: generateCanonicalToken(32, this.#randomBytes),
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.#ttlMs,
      audience,
      purpose: 'agent-authenticate',
      nodeId,
      keyVersion,
    }
    this.#entries.set(payload.challengeId, { ...payload, physicalCameraId })
    return payload
  }

  get(challengeId) {
    const now = this.#now()
    this.#purgeExpired(now)
    return this.#entries.get(challengeId) ?? null
  }

  consume(challengeId, expectedEntry) {
    const now = this.#now()
    this.#purgeExpired(now)
    const current = this.#entries.get(challengeId)
    if (!current || current !== expectedEntry || now >= current.expiresAtMs) return false
    this.#entries.delete(challengeId)
    return true
  }

  #purgeExpired(now = this.#now()) {
    for (const [challengeId, entry] of this.#entries) {
      if (now >= entry.expiresAtMs) this.#entries.delete(challengeId)
    }
  }
}
