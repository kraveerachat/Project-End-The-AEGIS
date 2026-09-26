// Client-only admission for decoded Vault images. It owns no bytes, storage, or network.

const abortError = () => {
  const error = new Error('Image decode admission aborted')
  error.name = 'AbortError'
  return error
}

export function estimateImageDecodeReservation({ pixels, inputBytes, posterMaxEdge }) {
  const safePixels = Math.max(0, Number(pixels) || 0)
  const safeInput = Math.max(0, Number(inputBytes) || 0)
  const edge = Math.max(0, Number(posterMaxEdge) || 0)
  return safeInput + safePixels * 4 + edge * edge * 4
}

export function createImageDecodeAdmission({ limits, liveMemoryBytes = () => 0 } = {}) {
  if (!limits) throw new TypeError('createImageDecodeAdmission: limits are required')
  const queue = []
  const running = new Set()
  let closed = false

  const stats = () => {
    let runningNormal = 0
    let runningHighRes = 0
    let reservedBytes = 0
    for (const entry of running) {
      if (entry.lane === 'high-res') runningHighRes += 1
      else runningNormal += 1
      reservedBytes += entry.reservedBytes
    }
    return { runningNormal, runningHighRes, queued: queue.length, reservedBytes }
  }

  const canEnter = (entry) => {
    const current = stats()
    if (entry.lane === 'normal' && current.runningNormal >= limits.maxConcurrentJobs) return false
    if (entry.lane === 'high-res' && current.runningHighRes >= limits.imageHighResMaxConcurrentJobs) return false
    const live = Math.max(0, Number(liveMemoryBytes()) || 0)
    return live + current.reservedBytes + entry.reservedBytes <= limits.memoryCeilingBytes
  }

  function removeQueued(entry) {
    const index = queue.indexOf(entry)
    if (index !== -1) queue.splice(index, 1)
    entry.signal?.removeEventListener('abort', entry.onAbort)
  }

  function pump() {
    if (closed) return
    for (let index = 0; index < queue.length;) {
      const entry = queue[index]
      if (!canEnter(entry)) { index += 1; continue }
      queue.splice(index, 1)
      entry.signal?.removeEventListener('abort', entry.onAbort)
      running.add(entry)
      let released = false
      entry.resolve({
        lane: entry.lane,
        reservedBytes: entry.reservedBytes,
        release() {
          if (released) return
          released = true
          running.delete(entry)
          pump()
        },
      })
    }
  }

  function acquire({ pixels, inputBytes = 0, signal = null } = {}) {
    if (closed || signal?.aborted) return Promise.reject(abortError())
    const lane = pixels <= limits.imageNormalMaxDecodedPixels ? 'normal' : 'high-res'
    const reservedBytes = estimateImageDecodeReservation({ pixels, inputBytes, posterMaxEdge: limits.posterMaxEdge })
    return new Promise((resolve, reject) => {
      const entry = { lane, reservedBytes, signal, resolve, reject, onAbort: null }
      entry.onAbort = () => {
        removeQueued(entry)
        reject(abortError())
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      queue.push(entry)
      pump()
    })
  }

  function notifyMemoryChanged() { pump() }

  async function releaseAll() {
    closed = true
    for (const entry of queue.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.reject(abortError())
    }
    running.clear()
  }

  return { acquire, notifyMemoryChanged, releaseAll, stats }
}

