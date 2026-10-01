/**
 * Own one upstream MJPEG reader for the lifetime of an Express response.
 * AbortController alone is not sufficient after undici has returned headers:
 * explicitly cancelling the reader makes the Detection Engine observe the
 * disconnect and release its viewer-demand camera.
 */
export function createUpstreamLifecycle(controller) {
  let closed = false
  let reader = null

  const cancelReader = () => {
    if (!reader) return
    try {
      const pending = reader.cancel()
      pending?.catch?.(() => {})
    } catch {
      // Reader may already be closed/cancelled. Cleanup remains idempotent.
    }
  }

  return {
    get closed() { return closed },
    get signal() { return controller.signal },
    attachReader(nextReader) {
      reader = nextReader
      if (closed) cancelReader()
    },
    abort() {
      if (closed) return
      closed = true
      controller.abort()
      cancelReader()
    },
  }
}

/** Writable progress, browser disconnect or server-side upstream abort must
 * wake the proxy loop so idle/revocation cleanup cannot strand its demand. */
export function waitForDrainOrClose(response, lifecycle) {
  if (lifecycle.closed || response.destroyed) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      response.off('drain', finish)
      response.off('close', finish)
      lifecycle.signal?.removeEventListener('abort', finish)
      resolve()
    }
    response.once('drain', finish)
    response.once('close', finish)
    lifecycle.signal?.addEventListener('abort', finish, { once: true })
    if (lifecycle.closed || response.destroyed) finish()
  })
}
