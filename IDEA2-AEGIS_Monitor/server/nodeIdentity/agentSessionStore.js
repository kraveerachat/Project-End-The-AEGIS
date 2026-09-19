import { createHash, randomBytes as systemRandomBytes } from 'node:crypto'

import { IdentityCapacityError, generateCanonicalToken } from './challengeStore.js'
import { ReplayWindow } from './replayWindow.js'

export function agentSessionDigest(sessionId) {
  return createHash('sha256').update(sessionId, 'ascii').digest('hex')
}

export class AgentSessionStore {
  #sessions = new Map()
  #nodeSessions = new Map()
  #now
  #randomBytes
  #ttlMs
  #maxSessions
  #replayWindowFactory

  constructor({
    now = Date.now,
    randomBytes = systemRandomBytes,
    ttlMs = 600_000,
    maxSessions = 1_024,
    replayWindowFactory = () => new ReplayWindow(),
  } = {}) {
    this.#now = now
    this.#randomBytes = randomBytes
    this.#ttlMs = ttlMs
    this.#maxSessions = maxSessions
    this.#replayWindowFactory = replayWindowFactory
  }

  get size() {
    this.#purgeExpired()
    return this.#sessions.size
  }

  create({ nodeId, keyVersion, physicalCameraId }) {
    const issuedAtMs = this.#now()
    this.#purgeExpired(issuedAtMs)
    const previousDigest = this.#nodeSessions.get(nodeId)
    const addsCapacity = previousDigest === undefined
    if (addsCapacity && this.#sessions.size >= this.#maxSessions) throw new IdentityCapacityError()

    let sessionId = null
    let digest = null
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = generateCanonicalToken(32, this.#randomBytes)
      const candidateDigest = agentSessionDigest(candidate)
      if (!this.#sessions.has(candidateDigest)) {
        sessionId = candidate
        digest = candidateDigest
        break
      }
    }
    if (!sessionId || !digest) throw new IdentityCapacityError('unique session generation failed')
    const state = {
      nodeId,
      keyVersion,
      physicalCameraId,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.#ttlMs,
      replay: this.#replayWindowFactory(),
    }
    if (previousDigest) this.#sessions.delete(previousDigest)
    this.#sessions.set(digest, state)
    this.#nodeSessions.set(nodeId, digest)
    return { sessionId, expiresAtMs: state.expiresAtMs }
  }

  lookup(sessionId) {
    const now = this.#now()
    this.#purgeExpired(now)
    const digest = agentSessionDigest(sessionId)
    const state = this.#sessions.get(digest)
    if (!state || now >= state.expiresAtMs) return null
    return state
  }

  invalidate(sessionId) {
    const digest = agentSessionDigest(sessionId)
    const state = this.#sessions.get(digest)
    if (!state) return false
    this.#sessions.delete(digest)
    if (this.#nodeSessions.get(state.nodeId) === digest) this.#nodeSessions.delete(state.nodeId)
    return true
  }

  #purgeExpired(now = this.#now()) {
    for (const [digest, state] of this.#sessions) {
      if (now >= state.expiresAtMs) {
        this.#sessions.delete(digest)
        if (this.#nodeSessions.get(state.nodeId) === digest) this.#nodeSessions.delete(state.nodeId)
      }
    }
  }
}
