// src/lib/vaultImageReduceCore.js — AEGIS Drive (IDEA1) · PR220-R2 · reduced decode → bounded poster (worker core)
//
// Runs inside the dedicated preview worker (vaultImageReduceWorker.js). Runtime classes are
// injected so the lifecycle is testable without a browser.
//   • the decoder is asked for desiredWidth/desiredHeight — for JPEG, Chromium decodes at the
//     DCT scale that fits (down to 1/8) and FAILS rather than silently decoding full size when
//     even 1/8 would exceed the request (measured PR220-R2). The caller still verifies the
//     returned size (noteReducedDecodeResult) because "desired" is best-effort by spec.
//   • geometry follows displayWidth/displayHeight — the EXIF-oriented size. drawImage(VideoFrame)
//     applies the frame's rotation/flip in the measured engine, matching createImageBitmap's
//     default imageOrientation on the normal lane (verified with an orientation-6 fixture).
//   • frame and decoder are closed in finally; the worker itself is terminated by the caller.

/**
 * @param {{ ImageDecoder: Function, OffscreenCanvas: Function, data: ReadableStream<Uint8Array>,
 *           mime: string, desiredWidth: number, desiredHeight: number, maxEdge: number }} p
 * @returns {Promise<{ buffer: ArrayBuffer, width: number, height: number, decodedWidth: number, decodedHeight: number }>}
 */
export async function runReducedDecode({ ImageDecoder, OffscreenCanvas, data, mime, desiredWidth, desiredHeight, maxEdge }) {
  let decoder = null
  let frame = null
  try {
    decoder = new ImageDecoder({ data, type: mime, desiredWidth, desiredHeight, preferAnimation: false })
    frame = (await decoder.decode({ frameIndex: 0 })).image
    const decodedWidth = frame.codedWidth
    const decodedHeight = frame.codedHeight
    const w = frame.displayWidth
    const h = frame.displayHeight
    const scale = Math.min(1, maxEdge / Math.max(w, h))
    const width = Math.max(1, Math.round(w * scale))
    const height = Math.max(1, Math.round(h * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(frame, 0, 0, width, height)
    frame.close()
    frame = null
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
    const buffer = await blob.arrayBuffer()
    return { buffer, width, height, decodedWidth, decodedHeight }
  } finally {
    try { frame?.close() } catch { /* already closed */ }
    try { decoder?.close() } catch { /* already closed */ }
  }
}
