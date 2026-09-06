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

/** Resolve on either writable progress or disconnect, so backpressure cannot
 * strand the proxy loop forever after the browser closes its tab. */
export function waitForDrainOrClose(response, lifecycle) {
  if (lifecycle.closed || response.destroyed) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      response.off('drain', finish)
      response.off('close', finish)
      resolve()
    }
    response.once('drain', finish)
    response.once('close', finish)
    if (lifecycle.closed || response.destroyed) finish()
  })
}
