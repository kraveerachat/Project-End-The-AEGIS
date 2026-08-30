import {
  PREVIEW_FAILURE_REASON, previewSessionInvalidatedError,
} from './vaultPreviewErrors.js'

const cacheKey = (token, index) => `${token}:${index}`

/** Hard production ceilings. Smaller values may be injected by tests only. */
export const MAX_PREVIEW_CACHED_CHUNKS = 3
export const MAX_PREVIEW_CONCURRENT_LOADS = 2
export const MAX_PREVIEW_PLAINTEXT_CACHE_BYTES = 64 * 1024 * 1024

const prefetchDiscardedError = () => {
  const error = new DOMException('stale preview prefetch discarded', 'AbortError')
  try { error.previewPrefetchDiscarded = true } catch { /* immutable DOMException */ }
  return error
}

/**
 * All state here is ordinary process memory owned by the Service Worker. A
 * worker restart creates a fresh instance: no key and no plaintext survives.
 *
 * Cache capacity and load concurrency are deliberately independent. The cache
 * retains at most three resolved plaintext chunks, while the scheduler permits
 * only two ciphertext-fetch/decrypt jobs. The 64 MiB byte ceiling is always
 * authoritative, so a deployment using 32 MiB plaintext chunks retains two.
 */
export function createPreviewWorkerState({
  maxCachedChunks = MAX_PREVIEW_CACHED_CHUNKS,
  maxConcurrentLoads = MAX_PREVIEW_CONCURRENT_LOADS,
  maxPlaintextBytes = MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
  onCacheEvent,
  onDiagnostic,
} = {}) {
  const cacheLimit = Math.min(
    MAX_PREVIEW_CACHED_CHUNKS,
    Math.max(1, Math.floor(Number(maxCachedChunks) || MAX_PREVIEW_CACHED_CHUNKS)),
  )
  const loadLimit = Math.min(
    MAX_PREVIEW_CONCURRENT_LOADS,
    Math.max(1, Math.floor(Number(maxConcurrentLoads) || MAX_PREVIEW_CONCURRENT_LOADS)),
  )
  const byteLimit = Math.min(
    MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
    Math.max(1, Math.floor(Number(maxPlaintextBytes) || MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)),
  )

  const sessions = new Map()
  // Resolved plaintext only. Pending work belongs in `inflight`, so queued work
  // can never evict a plaintext chunk or masquerade as retained memory.
  const cache = new Map()
  const inflight = new Map()
  // A prefetched integrity failure is not announced until the player actually
  // demands that chunk, but it must not be forgotten and silently retried.
  const prefetchedIntegrityFailures = new Map()
  const recoveries = new Map()
  const tokenEpochs = new Map()
  const sessionAborters = new Map()
  const queue = []
  let globalEpoch = 0
  let activeLoads = 0

  const tokenEpoch = (token) => tokenEpochs.get(token) ?? 0
  const bumpToken = (token) => tokenEpochs.set(token, tokenEpoch(token) + 1)
  const lifecycleMatches = (token, session, startedTokenEpoch, startedGlobalEpoch) => (
    globalEpoch === startedGlobalEpoch
    && tokenEpoch(token) === startedTokenEpoch
    && sessions.get(token) === session
  )

  /** The AbortSignal every load for this token ultimately belongs to. */
  const sessionSignal = (token) => sessionAborters.get(token)?.signal ?? null

  const cacheBytes = () => [...cache.values()].reduce((sum, item) => sum + item.size, 0)

  const touchCache = (key, entry) => {
    cache.delete(key)
    cache.set(key, entry)
  }

  const retainPlaintext = (key, value, source) => {
    const size = Math.max(0, Number(value?.byteLength) || 0)
    cache.delete(key)
    if (size > byteLimit) return
    cache.set(key, { value, size, source })
    while (cache.size > cacheLimit || cacheBytes() > byteLimit) {
      cache.delete(cache.keys().next().value)
    }
  }

  const removeQueuedJob = (job) => {
    const at = queue.indexOf(job)
    if (at >= 0) queue.splice(at, 1)
  }

  const jobFields = (job, extra = {}) => ({
    ...(job.priority === 'demand'
      ? { demandChunkIndex: job.index }
      : { prefetchedChunkIndex: job.index }),
    ...extra,
  })

  const schedule = () => {
    while (activeLoads < loadLimit && queue.length) {
      const demandAt = queue.findIndex((job) => job.priority === 'demand')
      const at = demandAt >= 0 ? demandAt : 0
      const [job] = queue.splice(at, 1)
      if (job.settled || inflight.get(job.key) !== job) continue
      if (!lifecycleMatches(job.token, job.session, job.tokenEpoch, job.globalEpoch)) {
        inflight.delete(job.key)
        job.settled = true
        job.detachOwner()
        job.reject(previewSessionInvalidatedError())
        continue
      }

      job.status = 'active'
      activeLoads += 1
      const signal = job.priority === 'demand'
        ? sessionSignal(job.token)
        : job.aborter.signal
      onDiagnostic?.('load-start', jobFields(job, {
        queueWaitDurationMs: Math.max(0, Date.now() - job.queuedAt),
        activeLoadCount: activeLoads,
      }))

      ;(async () => {
        try {
          const value = await job.load(job.index, { signal, priority: job.priority })
          if (!lifecycleMatches(job.token, job.session, job.tokenEpoch, job.globalEpoch)) {
            throw previewSessionInvalidatedError()
          }
          retainPlaintext(
            job.key,
            value,
            job.wasPrefetched && !job.consumedByDemand ? 'prefetch' : 'demand',
          )
          job.resolve(value)
        } catch (error) {
          if (job.consumedByDemand
            && error?.previewFailure === PREVIEW_FAILURE_REASON.INTEGRITY_FAILED) {
            // Integrity is fatal only once relevant to live demand. Stop every
            // remaining speculative load for this session before it can retain
            // future plaintext that playback will never consume.
            discardStalePrefetch(job.token, new Set())
          }
          if (job.wasPrefetched
            && error?.previewFailure === PREVIEW_FAILURE_REASON.INTEGRITY_FAILED
            && lifecycleMatches(job.token, job.session, job.tokenEpoch, job.globalEpoch)) {
            prefetchedIntegrityFailures.set(job.key, error)
          }
          job.reject(error)
        } finally {
          job.settled = true
          job.detachOwner()
          if (inflight.get(job.key) === job) inflight.delete(job.key)
          activeLoads -= 1
          onDiagnostic?.('load-complete', jobFields(job, { activeLoadCount: activeLoads }))
          schedule()
        }
      })()
    }
  }

  const createJob = (token, index, load, priority) => {
    const activeSession = sessions.get(token)
    if (!activeSession) throw previewSessionInvalidatedError('preview session unavailable')
    const key = cacheKey(token, index)
    let resolveJob
    let rejectJob
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve
      rejectJob = reject
    })
    // A speculative job may fail or be discarded before anything demands it.
    // Mark the shared Promise handled while preserving its rejection for a
    // later consumer that explicitly awaits the original Promise.
    promise.catch(() => {})
    const aborter = new AbortController()
    const ownerSignal = sessionSignal(token)
    const abortFromSession = () => {
      if (!aborter.signal.aborted) aborter.abort(ownerSignal?.reason ?? previewSessionInvalidatedError())
    }
    if (ownerSignal?.aborted) abortFromSession()
    else ownerSignal?.addEventListener?.('abort', abortFromSession, { once: true })
    const detachOwner = () => ownerSignal?.removeEventListener?.('abort', abortFromSession)

    const job = {
      token,
      index,
      key,
      load,
      priority,
      wasPrefetched: priority === 'prefetch',
      consumedByDemand: priority === 'demand',
      session: activeSession,
      tokenEpoch: tokenEpoch(token),
      globalEpoch,
      queuedAt: Date.now(),
      status: 'queued',
      settled: false,
      aborter,
      detachOwner,
      promise,
      resolve: resolveJob,
      reject: rejectJob,
    }
    inflight.set(key, job)
    queue.push(job)
    schedule()
    return job
  }

  const discardJob = (job) => {
    if (job.settled || job.priority !== 'prefetch') return
    if (job.status === 'queued') {
      removeQueuedJob(job)
      if (inflight.get(job.key) === job) inflight.delete(job.key)
      job.settled = true
      job.detachOwner()
      job.reject(prefetchDiscardedError())
      return
    }
    if (!job.aborter.signal.aborted) job.aborter.abort(prefetchDiscardedError())
  }

  const discardStalePrefetch = (token, keepIndexes) => {
    for (const job of [...inflight.values()]) {
      if (job.token === token && job.priority === 'prefetch' && !keepIndexes.has(job.index)) {
        discardJob(job)
      }
    }
  }

  const clearTokenState = (token) => {
    const prefix = `${token}:`
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
    for (const key of [...prefetchedIntegrityFailures.keys()]) {
      if (key.startsWith(prefix)) prefetchedIntegrityFailures.delete(key)
    }
    for (const job of [...inflight.values()]) {
      if (job.token === token && job.status === 'queued') {
        removeQueuedJob(job)
        job.settled = true
        job.detachOwner()
        job.reject(previewSessionInvalidatedError())
      }
      if (job.token === token && inflight.get(job.key) === job) inflight.delete(job.key)
    }
  }

  const abortSession = (token) => {
    const aborter = sessionAborters.get(token)
    sessionAborters.delete(token)
    if (!aborter || aborter.signal?.aborted) return
    try { aborter.abort(previewSessionInvalidatedError()) } catch { /* already aborted */ }
  }

  const open = (token, session) => {
    bumpToken(token)
    abortSession(token)
    clearTokenState(token)
    sessionAborters.set(token, new AbortController())
    sessions.set(token, session)
  }

  const close = (token) => {
    bumpToken(token)
    sessions.delete(token)
    abortSession(token)
    clearTokenState(token)
  }

  const closeAll = () => {
    globalEpoch += 1
    sessions.clear()
    for (const token of [...sessionAborters.keys()]) abortSession(token)
    sessionAborters.clear()
    for (const job of [...inflight.values()]) {
      if (job.status === 'queued') {
        removeQueuedJob(job)
        job.settled = true
        job.detachOwner()
        job.reject(previewSessionInvalidatedError())
      }
    }
    inflight.clear()
    cache.clear()
    prefetchedIntegrityFailures.clear()
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

  const demandJob = (token, index, load) => {
    const key = cacheKey(token, index)
    const knownIntegrityFailure = prefetchedIntegrityFailures.get(key)
    if (knownIntegrityFailure) return Promise.reject(knownIntegrityFailure)

    if (cache.has(key)) {
      const entry = cache.get(key)
      touchCache(key, entry)
      if (entry.source === 'prefetch') {
        entry.source = 'demand'
        onCacheEvent?.('prefetch-hit')
      } else {
        onCacheEvent?.('hit')
      }
      return Promise.resolve(entry.value)
    }

    if (inflight.has(key)) {
      const job = inflight.get(key)
      if (job.priority === 'prefetch') {
        job.priority = 'demand'
        job.consumedByDemand = true
        onCacheEvent?.('prefetch-hit')
        if (job.status === 'queued') {
          removeQueuedJob(job)
          queue.unshift(job)
          schedule()
        }
      } else {
        onCacheEvent?.('hit')
      }
      return job.promise
    }

    onCacheEvent?.('miss')
    return createJob(token, index, load, 'demand').promise
  }

  const schedulePrefetch = (token, indexes, load) => {
    const activeSession = sessions.get(token)
    if (!activeSession) return
    const chunkCount = Math.max(0, Math.floor(Number(activeSession.blob?.chunkCount) || 0))
    const unique = [...new Set(indexes)]
      .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < chunkCount)
      .slice(0, 2)
    for (const index of unique) {
      const key = cacheKey(token, index)
      if (cache.has(key) || inflight.has(key) || prefetchedIntegrityFailures.has(key)) continue
      onCacheEvent?.('prefetch-miss')
      createJob(token, index, load, 'prefetch')
    }
  }

  const readChunk = async (
    token,
    index,
    load,
    { prefetchIndexes = [], expectedSession = null } = {},
  ) => {
    const activeSession = sessions.get(token)
    if (!activeSession || (expectedSession && activeSession !== expectedSession)) {
      throw previewSessionInvalidatedError('preview session closed')
    }
    const startedTokenEpoch = tokenEpoch(token)
    const startedGlobalEpoch = globalEpoch
    const knownIntegrityFailure = prefetchedIntegrityFailures.get(cacheKey(token, index))
    if (knownIntegrityFailure) {
      discardStalePrefetch(token, new Set())
      throw knownIntegrityFailure
    }
    const wantedPrefetch = new Set(
      [...new Set(prefetchIndexes)]
        .filter((candidate) => Number.isSafeInteger(candidate) && candidate !== index)
        .slice(0, 2),
    )

    // Establish demand first. If a slot is free it starts synchronously; stale
    // speculative work is then discarded so a full scheduler frees a slot for
    // a seek before new look-ahead is admitted.
    const pending = demandJob(token, index, load)
    discardStalePrefetch(token, wantedPrefetch)
    schedulePrefetch(token, [...wantedPrefetch], load)
    schedule()

    const value = await pending
    if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
      throw previewSessionInvalidatedError()
    }
    return value
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
    cacheBytes,
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
