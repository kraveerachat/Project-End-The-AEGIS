// src/lib/vaultPlainChunkStream.js — AEGIS Drive (IDEA1) · PR220-R2 · decrypted V2 chunks as a pull iterator
//
// downloadVaultV2 pushes each authenticated plaintext chunk into a sink. Previews want to PULL:
// read the first chunk, decide, then continue or stop. This adapter turns the push into a pull
// with a one-chunk hand-off — the producer's write() resolves as soon as the consumer takes the
// chunk, so at most one decrypted chunk waits here and nothing is accumulated.
//   • the download itself is unchanged (same fetch, same AAD, same size checks)
//   • return() / the caller's signal aborts the download immediately; a failed download surfaces
//     as a thrown error on the next pull — never as a silently shorter image
//   • no storage, no retention: a taken chunk belongs to the consumer

const abortError = () => Object.assign(new Error('plain chunk stream aborted'), { name: 'AbortError' })

/**
 * @param {{ run: (sink: object, signal: AbortSignal) => Promise<{ ok: boolean, reason?: string }>, signal?: AbortSignal }} p
 * @returns {AsyncIterator<Uint8Array> & { return: () => Promise<{ done: true, value: undefined }> }}
 */
export function openVaultPlainChunks({ run, signal = null }) {
  const ctrl = new AbortController()
  const onOuterAbort = () => ctrl.abort()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener?.('abort', onOuterAbort, { once: true })

  let pending = null     // { bytes, resolve, reject } — the one chunk waiting for the consumer
  let wake = null
  let finished = false
  let failure = null
  const notify = () => { const w = wake; wake = null; w?.() }

  const sink = {
    kind: 'stream',
    write(bytes) {
      if (ctrl.signal.aborted) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        pending = { bytes, resolve, reject }
        notify()
      })
    },
    async close() {},
    async abort() {},
  }

  run(sink, ctrl.signal).then(
    (res) => { if (!res?.ok) failure = Object.assign(new Error(res?.reason ?? 'download failed'), { code: res?.reason ?? 'DOWNLOAD' }) },
    (err) => { failure = err ?? new Error('download failed') },
  ).finally(() => {
    finished = true
    signal?.removeEventListener?.('abort', onOuterAbort)
    notify()
  })

  const iterator = {
    async next() {
      for (;;) {
        if (ctrl.signal.aborted) throw abortError()
        if (pending) {
          const { bytes, resolve } = pending
          pending = null
          resolve()
          return { value: bytes, done: false }
        }
        if (finished) {
          if (failure) throw failure
          return { value: undefined, done: true }
        }
        await new Promise((r) => { wake = r })
      }
    },
    async return() {
      if (!finished) ctrl.abort()
      if (pending) { pending.reject(abortError()); pending = null }
      signal?.removeEventListener?.('abort', onOuterAbort)
      notify()
      return { value: undefined, done: true }
    },
    [Symbol.asyncIterator]() { return iterator },
  }
  // an outer abort must also release a consumer that is currently waiting
  ctrl.signal.addEventListener('abort', notify, { once: true })
  return iterator
}
