import { createHash, randomBytes as systemRandomBytes } from 'node:crypto'

import { generateCanonicalToken, IdentityCapacityError } from './challengeStore.js'
import { parseCanonicalToken } from './agentProtocol.js'
import { BROWSER_ASSOCIATION_DOMAIN } from './browserAssociationProof.js'

export class BrowserAssociationChallengeStore {
  #entries = new Map()
  #spent = new Map()
  #now
  #randomBytes
  #ttlMs
  #maxPerSession
  #maxTotal

  constructor({ now = Date.now, randomBytes = systemRandomBytes, ttlMs = 30_000, maxPerSession = 8, maxTotal = 2_048 } = {}) {
    this.#now = now
    this.#randomBytes = randomBytes
    this.#ttlMs = ttlMs
    this.#maxPerSession = maxPerSession
    this.#maxTotal = maxTotal
  }

  get size() {
    this.#purgeExpired()
    return this.#entries.size
  }

  issue({ sessionBinding, audience }) {
    parseCanonicalToken(sessionBinding, 32, 'session binding')
    if (typeof audience !== 'string' || audience.length === 0) throw new TypeError('audience is required')
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('clock must return a safe integer')
    this.#purgeExpired(now)
    const sessionDigest = this.#digest(sessionBinding)
    const sameSession = [...this.#entries.entries()].filter(([, entry]) => entry.sessionDigest === sessionDigest)
    while (sameSession.length >= this.#maxPerSession) {
      const [oldestId, oldest] = sameSession.shift()
      this.#entries.delete(oldestId)
      this.#spent.set(oldestId, oldest.challenge.expires_at_ms)
    }
    if (this.#entries.size + this.#spent.size >= this.#maxTotal) throw new IdentityCapacityError()
    let challengeId
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = generateCanonicalToken(32, this.#randomBytes)
      if (!this.#entries.has(candidate) && !this.#spent.has(candidate)) {
        challengeId = candidate
        break
      }
    }
    if (!challengeId) throw new IdentityCapacityError('unique challenge generation failed')
    const challenge = Object.freeze({
      version: 1,
      purpose: BROWSER_ASSOCIATION_DOMAIN,
      audience,
      challenge_id: challengeId,
      challenge_nonce: generateCanonicalToken(32, this.#randomBytes),
      session_binding: sessionBinding,
      issued_at_ms: now,
      expires_at_ms: now + this.#ttlMs,
    })
    this.#entries.set(challengeId, { challenge, sessionDigest })
    return challenge
  }

  consume({ challengeId, sessionBinding }) {
    const now = this.#now()
    this.#purgeExpired(now)
    let sessionDigest
    try {
      parseCanonicalToken(challengeId, 32, 'challenge id')
      parseCanonicalToken(sessionBinding, 32, 'session binding')
      sessionDigest = this.#digest(sessionBinding)
    } catch {
      return null
    }
    const entry = this.#entries.get(challengeId)
    if (!entry || entry.sessionDigest !== sessionDigest || now >= entry.challenge.expires_at_ms) return null
    this.#entries.delete(challengeId)
    this.#spent.set(challengeId, entry.challenge.expires_at_ms)
    return entry.challenge
  }

  #digest(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }

  #purgeExpired(now = this.#now()) {
    for (const [id, entry] of this.#entries) {
      if (now >= entry.challenge.expires_at_ms) this.#entries.delete(id)
    }
    for (const [id, expiresAt] of this.#spent) {
      if (now >= expiresAt) this.#spent.delete(id)
    }
  }
}
