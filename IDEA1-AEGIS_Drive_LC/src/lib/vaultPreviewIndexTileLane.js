// D-1 read-only derivative lane. Network/decode work here never occupies the original thumbnail scheduler's workers.
// A verified result is held until the original scheduler publishes its URL; misses enter that scheduler once.
export function createDerivativeTileLane({ tryTile, onReady, onFallback, maxConcurrentJobs, unlockedState = null, onChange = null }) {
  if (typeof tryTile !== 'function' || typeof onReady !== 'function' || typeof onFallback !== 'function') throw new TypeError('tile lane callbacks')
  if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) throw new RangeError('maxConcurrentJobs')
  const jobs = new Map()
  let cleared = false
  let running = 0
  const purged = () => cleared || Boolean(unlockedState?.isPurged?.())

  function pump() {
    if (purged()) return
    for (const [key, job] of jobs) {
      if (running >= maxConcurrentJobs) break
      if (job.state !== 'queued') continue
      const ctrl = new AbortController()
      job.ctrl = ctrl
      job.state = 'running'
      running++
      try { unlockedState?.registerAbort?.(ctrl) } catch { cancel(key); continue }
      Promise.resolve().then(() => tryTile(key, { signal: ctrl.signal })).then(
        (result) => {
          if (jobs.get(key) !== job || purged() || ctrl.signal.aborted) { result?.bytes?.fill?.(0); return }
          if (result) {
            job.state = 'staged'
            job.result = result
            try { onReady(key, job.options) } catch { result.bytes?.fill?.(0); jobs.delete(key); running--; try { onFallback(key, job.options) } catch { /* original path unavailable */ } }
          } else {
            jobs.delete(key); running--
            try { onFallback(key, job.options) } catch { /* original path unavailable */ }
          }
          onChange?.()
          pump()
        },
        () => {
          if (jobs.get(key) !== job) return
          jobs.delete(key); running--
          if (!purged() && !ctrl.signal.aborted) { try { onFallback(key, job.options) } catch { /* original path unavailable */ } }
          onChange?.(); pump()
        },
      )
    }
    onChange?.()
  }

  function observe(key, options = {}) {
    if (purged() || jobs.has(key)) return
    jobs.set(key, { state: 'queued', options, ctrl: null, result: null })
    pump()
  }

  function take(key) {
    const job = jobs.get(key)
    if (!job || job.state !== 'staged') return null
    jobs.delete(key); running--
    const result = job.result
    job.result = null
    pump()
    return result
  }

  function cancel(key) {
    const job = jobs.get(key)
    if (!job) return
    job.ctrl?.abort()
    if (job.state === 'running' || job.state === 'staged') running--
    job.result?.bytes?.fill?.(0)
    jobs.delete(key)
    onChange?.(); pump()
  }

  function releaseFolder(folderId) {
    for (const [key, job] of [...jobs]) if (job.options.folderId === folderId) cancel(key)
  }

  function releaseAll() {
    cleared = true
    for (const key of [...jobs.keys()]) cancel(key)
  }

  try { unlockedState?.registerDisposer?.(releaseAll) } catch { cleared = true }

  function snapshot() {
    const out = new Map()
    for (const [key, job] of jobs) out.set(key, { state: job.state === 'staged' ? 'running' : job.state, url: null, failed: false, reason: null, folderId: job.options.folderId ?? null })
    return out
  }
  function stats() { return { running, queued: [...jobs.values()].filter((j) => j.state === 'queued').length, staged: [...jobs.values()].filter((j) => j.state === 'staged').length } }
  return { observe, take, cancel, releaseFolder, releaseAll, snapshot, stats, hasStaged: (key) => jobs.get(key)?.state === 'staged' }
}

// Compose the independent derivative lane with the existing original scheduler. Ownership of a completed
// key stays with the original scheduler, so a render refresh cannot restage a derivative indefinitely.
export function createDerivativeFirstScheduler({ original, tryTile, maxConcurrentJobs, unlockedState = null, onChange = null, getCurrentSourceBlobId = null }) {
  const sources = new Map() // node id → { sourceBlobId, folderId }
  let combined
  const current = (key, expected) => !getCurrentSourceBlobId || getCurrentSourceBlobId(key) === expected
  const lane = createDerivativeTileLane({
    tryTile,
    maxConcurrentJobs,
    unlockedState,
    onChange,
    onReady: (key, options) => {
      if (!current(key, sources.get(key)?.sourceBlobId)) { combined.cancel(key); return }
      original.observe(key, { ...options, estimateBytes: 256 * 1024, eligible: true })
    },
    onFallback: (key, options) => {
      if (!current(key, sources.get(key)?.sourceBlobId)) { combined.cancel(key); return }
      original.observe(key, options)
    },
  })

  function cancel(key) {
    lane.cancel(key)
    original.cancel(key)
    sources.delete(key)
  }
  function observe(key, options = {}) {
    if (!options.sourceBlobId) { cancel(key); return }
    const previous = sources.get(key)
    if (previous && previous.sourceBlobId !== options.sourceBlobId) cancel(key)
    if (!current(key, options.sourceBlobId)) { cancel(key); return }
    sources.set(key, { sourceBlobId: options.sourceBlobId, folderId: options.folderId ?? null })
    if (original.snapshot().has(key)) original.observe(key, lane.hasStaged(key) ? { ...options, estimateBytes: 256 * 1024, eligible: true } : options)
    else lane.observe(key, options)
  }
  function take(key) {
    const result = lane.take(key)
    if (!result) return null
    if (!current(key, sources.get(key)?.sourceBlobId)) { result.bytes?.fill?.(0); cancel(key); return null }
    return result
  }
  function reconcileVisible(keys) {
    for (const key of [...sources.keys()]) if (!keys.has(key)) cancel(key)
  }
  function releaseFolder(folderId) {
    for (const [key, source] of [...sources]) if (source.folderId === folderId) cancel(key)
    original.releaseFolder(folderId)
  }
  async function releaseAll() {
    lane.releaseAll()
    sources.clear()
    await original.releaseAll()
  }
  combined = {
    observe, take, cancel, reconcileVisible, releaseFolder, releaseAll,
    snapshot: () => new Map([...lane.snapshot(), ...original.snapshot()]),
    stats: () => original.stats(),
    derivativeStats: () => lane.stats(),
  }
  return combined
}
