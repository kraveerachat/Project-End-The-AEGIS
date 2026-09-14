import session from 'express-session'

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_PRUNE_INTERVAL_MS = 60_000

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function done(callback, error, value) {
  if (typeof callback === 'function') process.nextTick(callback, error, value)
}

/**
 * PR10 D8 / PR11 Phase 2 (design §4.5): the Web session store.
 *
 * In-memory only, so a restart logs the Admin out. Bounded, so it cannot grow
 * without limit: when full, expired entries are pruned first and then the
 * least-recently-written entry is evicted. An entry expires at its cookie
 * expiry or after the idle TTL since it was last written, whichever is sooner,
 * and is never returned after that. Entries are stored serialized, so a caller
 * never shares mutable state with the store.
 */
export class BoundedSessionStore extends session.Store {
  #entries = new Map()
  #idleMs
  #maxEntries
  #clock
  #timer

  constructor({
    idleMs,
    maxEntries = DEFAULT_MAX_ENTRIES,
    pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
    clock = () => Date.now(),
  } = {}) {
    super()
    if (!positiveInteger(idleMs) || !positiveInteger(maxEntries) || !positiveInteger(pruneIntervalMs)) {
      throw new Error('The session store requires positive integer idleMs, maxEntries, and pruneIntervalMs')
    }
    this.#idleMs = idleMs
    this.#maxEntries = maxEntries
    this.#clock = clock
    this.#timer = setInterval(() => this.prune(), pruneIntervalMs)
    this.#timer.unref?.()
  }

  /** Stored entries, including expired ones not yet pruned. */
  get size() {
    return this.#entries.size
  }

  prune() {
    const now = this.#clock()
    for (const [sid, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(sid)
    }
  }

  close() {
    clearInterval(this.#timer)
  }

  #expiresAt(sess) {
    const raw = sess?.cookie?.expires
    const cookieExpiry = raw ? new Date(raw).getTime() : Number.NaN
    const idleExpiry = this.#clock() + this.#idleMs
    return Number.isFinite(cookieExpiry) ? Math.min(cookieExpiry, idleExpiry) : idleExpiry
  }

  #read(sid) {
    const entry = this.#entries.get(sid)
    if (!entry) return undefined
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(sid)
      return undefined
    }
    return entry
  }

  #write(sid, sess) {
    const entry = { serialized: JSON.stringify(sess), expiresAt: this.#expiresAt(sess) }
    if (!this.#entries.has(sid) && this.#entries.size >= this.#maxEntries) {
      this.prune()
      if (this.#entries.size >= this.#maxEntries) {
        this.#entries.delete(this.#entries.keys().next().value)
      }
    }
    // Re-insert so iteration order stays least- to most-recently written.
    this.#entries.delete(sid)
    this.#entries.set(sid, entry)
  }

  get(sid, callback) {
    try {
      const entry = this.#read(sid)
      done(callback, null, entry ? JSON.parse(entry.serialized) : undefined)
    } catch (error) {
      done(callback, error)
    }
  }

  set(sid, sess, callback) {
    try {
      this.#write(sid, sess)
      done(callback, null)
    } catch (error) {
      done(callback, error)
    }
  }

  touch(sid, sess, callback) {
    try {
      const entry = this.#read(sid)
      if (entry) this.#write(sid, { ...JSON.parse(entry.serialized), cookie: sess.cookie })
      done(callback, null)
    } catch (error) {
      done(callback, error)
    }
  }

  destroy(sid, callback) {
    this.#entries.delete(sid)
    done(callback, null)
  }

  all(callback) {
    try {
      this.prune()
      const sessions = {}
      for (const [sid, entry] of this.#entries) sessions[sid] = JSON.parse(entry.serialized)
      done(callback, null, sessions)
    } catch (error) {
      done(callback, error)
    }
  }

  length(callback) {
    this.prune()
    done(callback, null, this.#entries.size)
  }

  clear(callback) {
    this.#entries.clear()
    done(callback, null)
  }
}

export function createBoundedSessionStore(options) {
  return new BoundedSessionStore(options)
}
