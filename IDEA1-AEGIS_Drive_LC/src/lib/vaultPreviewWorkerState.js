import {
  PREVIEW_FAILURE_REASON, previewSessionInvalidatedError,
} from './vaultPreviewErrors.js'

const cacheKey = (token, index) => `${token}:${index}`

/**
 * All state here is ordinary process memory owned by the Service Worker. A
 * worker restart creates a fresh instance: no key and no plaintext survives.
 */
export const MAX_PREVIEW_PLAINTEXT_CACHE_BYTES = 64 * 1024 * 1024

export function createPreviewWorkerState({
  maxPlaintextChunks = 2,
  maxPlaintextBytes = MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
  onCacheEvent,
} = {}) {
  const limit = Math.min(2, Math.max(1, Math.floor(Number(maxPlaintextChunks) || 2)))
  const byteLimit = Math.min(
    MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
    Math.max(1, Math.floor(Number(maxPlaintextBytes) || MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)),
  )
  const sessions = new Map()
  const cache = new Map()
  const recoveries = new Map()
  const tokenEpochs = new Map()
  // ⚠️ Ownership of an in-flight ciphertext load belongs to the *session*, never
  //    to whichever Range response happened to trigger it. Two overlapping
  //    Chromium ranges routinely wait on one shared chunk Promise; if that load
  //    carried request A's AbortSignal, Chromium cancelling A would reject the
  //    shared Promise and destroy request B's perfectly valid range too.
  //    Only deliberate teardown — close, lock, closeAll, replacement — aborts.
  const sessionAborters = new Map()
  const loadWaiters = []
  let globalEpoch = 0
  let activeLoads = 0

  const tokenEpoch = (token) => tokenEpochs.get(token) ?? 0
  const bumpToken = (token) => tokenEpochs.set(token, tokenEpoch(token) + 1)
  const lifecycleMatches = (token, session, startedTokenEpoch, startedGlobalEpoch) => (
    globalEpoch === startedGlobalEpoch
    && tokenEpoch(token) === startedTokenEpoch
    && sessions.get(token) === session
  )

  const withLoadSlot = async (load) => {
    if (activeLoads >= limit) {
      await new Promise((resolve) => loadWaiters.push(resolve))
    }
    activeLoads += 1
    try {
      return await load()
    } finally {
      activeLoads -= 1
      loadWaiters.shift()?.()
    }
  }

  /** The AbortSignal every load for this token is bound to, or null. */
  const sessionSignal = (token) => sessionAborters.get(token)?.signal ?? null

  /**
   * Make every session-owned in-flight load for this token unusable.
   * ⚠️ Called by close, closeAll and session replacement — after any of these,
   *    no late plaintext may be delivered even if bytes were already on the way.
   */
  const abortSession = (token) => {
    const aborter = sessionAborters.get(token)
    sessionAborters.delete(token)
    if (!aborter || aborter.signal?.aborted) return
    try { aborter.abort(previewSessionInvalidatedError()) } catch { /* already aborted */ }
  }

  const clearTokenCache = (token) => {
    const prefix = `${token}:`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
  }

  const open = (token, session) => {
    bumpToken(token)
    // Replacing a session cancels the work the replaced one owned; the new
    // session starts with its own controller and shares nothing with the old.
    abortSession(token)
    clearTokenCache(token)
    sessionAborters.set(token, new AbortController())
    sessions.set(token, session)
  }

  const close = (token) => {
    bumpToken(token)
    sessions.delete(token)
    abortSession(token)
    clearTokenCache(token)
  }

  const closeAll = () => {
    globalEpoch += 1
    sessions.clear()
    for (const token of [...sessionAborters.keys()]) abortSession(token)
    sessionAborters.clear()
    cache.clear()
    tokenEpochs.clear()
  }

  const getOrRecover = async (token, recover) => {
    const current = sessions.get(token)
    if (current) return { ok: true, session: current, rehydrated: false }
    if (recoveries.has(token)) return recoveries.get(token)

    const startedTokenEpoch = tokenEpoch(token)
    const startedGlobalEpoch = globalEpoch
    const pending = (async () => {
      let result
      try { result = await recover(token) } catch { result = null }
      if (globalEpoch !== startedGlobalEpoch || tokenEpoch(token) !== startedTokenEpoch) {
        return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_SESSION_LOST }
      }
      if (!result?.session || result.token !== token) {
        return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_SESSION_REHYDRATE_FAILED }
      }
      open(token, result.session)
      return { ok: true, session: result.session, rehydrated: true }
    })().finally(() => recoveries.delete(token))
    recoveries.set(token, pending)
    return pending
  }

  const readChunk = async (token, index, load) => {
    const activeSession = sessions.get(token)
    if (!activeSession) throw previewSessionInvalidatedError('preview session unavailable')
    const startedTokenEpoch = tokenEpoch(token)
    const startedGlobalEpoch = globalEpoch
    const key = cacheKey(token, index)
    if (cache.has(key)) {
      const existing = cache.get(key)
      cache.delete(key)
      cache.set(key, existing)
      onCacheEvent?.('hit')
      const value = await existing.promise
      if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
        throw previewSessionInvalidatedError()
      }
      return value
    }

    onCacheEvent?.('miss')
    while (cache.size >= limit) cache.delete(cache.keys().next().value)
    const pending = withLoadSlot(async () => {
      if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
        throw previewSessionInvalidatedError()
      }
      // ★ The session's signal, not the caller's: this Promise is shared with
      //   every other Range response that wants the same chunk.
      return load(index, { signal: sessionSignal(token) })
    })
    const entry = { promise: pending, size: 0 }
    cache.set(key, entry)
    try {
      const value = await pending
      if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
        if (cache.get(key) === entry) cache.delete(key)
        throw previewSessionInvalidatedError()
      }
      entry.size = Math.max(0, Number(value?.byteLength) || 0)
      if (entry.size > byteLimit) {
        cache.delete(key)
      } else {
        while ([...cache.values()].reduce((sum, item) => sum + item.size, 0) > byteLimit) {
          const oldest = cache.keys().next().value
          if (oldest === key && cache.size === 1) break
          cache.delete(oldest)
        }
      }
      return value
    } catch (err) {
      if (cache.get(key) === entry) cache.delete(key)
      throw err
    }
  }

  return {
    open,
    close,
    closeAll,
    get: (token) => sessions.get(token) ?? null,
    getOrRecover,
    readChunk,
    sessionSignal,
    cacheSize: () => cache.size,
    cacheBytes: () => [...cache.values()].reduce((sum, item) => sum + item.size, 0),
    sessionCount: () => sessions.size,
    cachedChunkIndexes: (token) => {
      const prefix = `${token}:`
      return [...cache.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => Number(key.slice(prefix.length)))
        .sort((a, b) => a - b)
    },
  }
}
