// src/lib/vaultImageReduceWorker.js — AEGIS Drive (IDEA1) · PR220-R2 · dedicated worker for reduced image decode
//
// One worker per preview job; the main thread terminates it after the result or on abort, which
// is the strongest release of the decoder, its frame and the canvas. Decrypted chunks arrive by
// transfer and are fed straight into the decoder's stream — this file keeps no copy, has no
// network or storage access, and posts back only the bounded poster.
import { runReducedDecode } from './vaultImageReduceCore.js'

let controller = null

self.onmessage = async (event) => {
  const msg = event.data
  if (msg?.type === 'start') {
    const data = new ReadableStream({ start(c) { controller = c } })
    try {
      const out = await runReducedDecode({
        ImageDecoder: self.ImageDecoder, OffscreenCanvas: self.OffscreenCanvas, data,
        mime: msg.mime, desiredWidth: msg.desiredWidth, desiredHeight: msg.desiredHeight, maxEdge: msg.maxEdge,
      })
      self.postMessage({ type: 'done', bytes: out.buffer, width: out.width, height: out.height, decodedWidth: out.decodedWidth, decodedHeight: out.decodedHeight }, [out.buffer])
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.name ?? 'Error') })
    } finally {
      controller = null
    }
  } else if (msg?.type === 'chunk') {
    controller?.enqueue(new Uint8Array(msg.buf))
  } else if (msg?.type === 'end') {
    controller?.close()
  }
}
