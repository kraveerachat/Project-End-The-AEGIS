const MAX_UINT64 = (1n << 64n) - 1n
const BITMAP_MASK = MAX_UINT64

export class ReplayWindow {
  #highest = null
  #bitmap = 0n
  #nonces = new Map()
  #maxNonces

  constructor({ maxNonces = 4_096 } = {}) {
    this.#maxNonces = maxNonces
  }

  acceptSequence(value) {
    let sequence
    try {
      sequence = BigInt(value)
    } catch {
      return false
    }
    if (sequence <= 0n || sequence > MAX_UINT64) return false
    if (this.#highest === null) {
      this.#highest = sequence
      this.#bitmap = 1n
      return true
    }
    if (sequence > this.#highest) {
      const delta = sequence - this.#highest
      this.#bitmap = delta >= 64n
        ? 1n
        : ((this.#bitmap << delta) & BITMAP_MASK) | 1n
      this.#highest = sequence
      return true
    }
    const offset = this.#highest - sequence
    if (offset >= 64n) return false
    const mask = 1n << offset
    if ((this.#bitmap & mask) !== 0n) return false
    this.#bitmap |= mask
    return true
  }

  acceptNonce(digest, { retainUntilMs, nowMs }) {
    for (const [knownDigest, expiry] of this.#nonces) {
      if (nowMs > expiry) this.#nonces.delete(knownDigest)
    }
    if (this.#nonces.has(digest) || this.#nonces.size >= this.#maxNonces) return false
    this.#nonces.set(digest, retainUntilMs)
    return true
  }
}
