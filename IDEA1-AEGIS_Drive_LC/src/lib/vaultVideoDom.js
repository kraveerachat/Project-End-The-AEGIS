// Browser-only video frame helpers. Source media stays in an ephemeral Object URL
// or the encrypted range-preview virtual URL; only the JPEG poster is returned.

function waitFor(video, eventName, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('VIDEO_DECODE')) }
    const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
    const cleanup = () => {
      video.removeEventListener(eventName, done)
      video.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
    }
    video.addEventListener(eventName, done, { once: true })
    video.addEventListener('error', failed, { once: true })
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

export async function attachPosterVideo({ url, muted = true, preload = 'metadata', signal = null }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const video = document.createElement('video')
  video.muted = muted
  video.preload = preload
  video.playsInline = true
  video.tabIndex = -1
  video.setAttribute?.('aria-hidden', 'true')
  if (video.style) {
    video.style.position = 'fixed'
    video.style.width = '1px'
    video.style.height = '1px'
    video.style.opacity = '0'
    video.style.pointerEvents = 'none'
  }
  // Some browser engines will not advance a detached media element far enough
  // to expose a drawable frame. Connect the decoder off-screen, and arm the
  // readiness listeners before assigning src so tiny local blobs cannot win
  // the event race.
  document.body.append(video)
  const cleanup = () => {
    try { video.pause() } catch { /* best effort */ }
    video.removeAttribute('src')
    try { video.load() } catch { /* best effort */ }
    try { video.remove() } catch { /* best effort */ }
  }
  const ready = waitFor(video, 'loadeddata', signal)
  try {
    video.src = url
    try { video.load() } catch { /* assigning src already initiated loading */ }
    await ready
  } catch (err) {
    cleanup()
    throw err
  }
  return {
    element: video,
    seekTo: async (seconds) => {
      if (seconds <= 0 || !Number.isFinite(video.duration)) return
      video.currentTime = Math.min(seconds, Math.max(0, video.duration - 0.01))
      await waitFor(video, 'seeked', signal)
    },
    cleanup,
  }
}

export async function drawPosterFrame(video, { maxEdge = 640, quality = 0.82 } = {}) {
  const sourceWidth = Math.max(1, Number(video.videoWidth) || 1)
  const sourceHeight = Math.max(1, Number(video.videoHeight) || 1)
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('CANVAS_UNAVAILABLE')
  context.drawImage(video, 0, 0, width, height)
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('POSTER_ENCODE')), 'image/jpeg', quality)
  })
  return new Uint8Array(await blob.arrayBuffer())
}
