// tests/downloadStreamWorker.test.js — AEGIS Drive (IDEA1) · cross-browser streaming ZIP, worker protocol
//
// The page streams one download through the EXISTING same-origin Drive Service Worker:
//   page opens an ephemeral session (CSPRNG token + MessagePort) → a hidden same-origin navigation to
//   <scope>__aegis-download/<token> → the worker answers it with a ReadableStream → page writes are
//   transferred over the port with credit-based backpressure → close ends the stream, abort errors it.
// These tests drive the real worker-side state and the real page-side sink over a real MessageChannel and
// read the real Response body; only the Service Worker event plumbing (controller.postMessage, the
// FetchEvent) is replaced by direct calls to the same handler functions the worker file wires.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDownloadStreamWorkerState, handleDownloadStreamMessage, handleDownloadStreamFetch,
  downloadTokenFromPath, downloadUrlFor, attachmentDisposition,
  DOWNLOAD_PATH_SEGMENT, DOWNLOAD_STREAM_LIMITS, DOWNLOAD_STREAM_MESSAGE,
} from '../src/lib/downloadStreamWorkerState.js'
import { openWorkerStreamSink, supportsWorkerStreamDownload } from '../src/lib/downloadStreamSession.js'

const ORIGIN = 'https://drive.test'
const SCOPE = '/drive/'
const TOKEN = '0123456789abcdef0123456789abcdef'
const MiB = 1024 * 1024
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await tick() }

function bytesOf(n, seed = 1) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + seed) & 0xff
  return b
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
async function readAll(response) {
  const reader = response.body.getReader()
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return concat(parts)
    parts.push(value)
  }
}
/** Settles to the bytes or to the Error — no rejection is ever left unobserved. */
const outcome = (promise) => promise.then((v) => v, (e) => (e instanceof Error ? e : new Error(String(e))))
const isPending = async (promise) => {
  const marker = Symbol('pending')
  return (await Promise.race([promise.then(() => 'resolved', () => 'rejected'), tick().then(() => marker)])) === marker
}

/** One page ↔ worker pair. `h.state` can be swapped to model a worker restart (all memory lost). */
function harness({ limits = DOWNLOAD_STREAM_LIMITS, respondOnTrigger = true, stateOptions = {} } = {}) {
  const h = { limits, responses: [], triggered: [], removed: 0 }
  h.state = createDownloadStreamWorkerState({ limits, ...stateOptions })
  h.controller = {
    postMessage(msg, ports = []) {
      handleDownloadStreamMessage(h.state, msg, ports, (payload) => ports[0]?.postMessage(payload))
    },
  }
  h.fetch = (url, init) => handleDownloadStreamFetch(h.state, new Request(new URL(url, ORIGIN).href, init), { origin: ORIGIN, scopePath: SCOPE })
  h.trigger = (url) => {
    h.triggered.push(url)
    if (respondOnTrigger) h.responses.push(h.fetch(url))
    return () => { h.removed += 1 }
  }
  h.open = (opts = {}) => openWorkerStreamSink({
    filename: 'AEGIS-Files-20261005-010203.zip', totalBytes: 0, source: 'files', base: SCOPE,
    ensureWorker: async () => ({ ok: true, controller: h.controller }), trigger: h.trigger, limits,
    startTimeoutMs: 300, keepaliveMs: 0, frameLingerMs: 0, ...opts,
  })
  return h
}

/* ── 5 / 12: exact namespace only ───────────────────────────────── */

test('WS-5 only the exact <scope>__aegis-download/<32 hex> path is a download token', () => {
  assert.equal(DOWNLOAD_PATH_SEGMENT, '__aegis-download')
  assert.equal(downloadUrlFor(TOKEN, SCOPE), `/drive/__aegis-download/${TOKEN}`)
  assert.equal(downloadTokenFromPath(`/drive/__aegis-download/${TOKEN}`, SCOPE), TOKEN)
  for (const p of [
    `/drive/__aegis-download/${TOKEN}/`, `/drive/__aegis-download/${TOKEN}/x`, `/drive/x/__aegis-download/${TOKEN}`,
    `/__aegis-download/${TOKEN}`, `/drive/__aegis-download/${TOKEN.toUpperCase()}`, `/drive/__aegis-download/${TOKEN}0`,
    '/drive/__aegis-download/', '/drive/__aegis-download/abc', `/drive/__vault_preview/${TOKEN}`, '/drive/', '',
  ]) {
    assert.equal(downloadTokenFromPath(p, SCOPE), null, p)
  }
})

test('WS-12 unrelated requests are not answered (null = pass through to the network)', () => {
  const h = harness()
  for (const url of [
    '/drive/', '/drive/index.html', '/drive/api/files', `/drive/api/files/x/download`, '/drive/assets/index-abc.js',
    `/drive/__vault_preview/${TOKEN}`, `https://evil.test/drive/__aegis-download/${TOKEN}`, `/drive/vault-preview-sw.js`,
  ]) {
    assert.equal(h.fetch(url), null, url)
  }
})

test('WS-12b an unknown token inside the namespace is answered 404 no-store, never forwarded', () => {
  const h = harness()
  const res = h.fetch(`/drive/__aegis-download/${TOKEN}`)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
})

/* ── 6: filename / headers ─────────────────────────────────────── */

test('WS-6 the download response carries zip/attachment/no-store/nosniff and the exact length', async () => {
  const h = harness()
  const data = bytesOf(1000)
  const opened = await h.open({ totalBytes: data.length })
  assert.equal(opened.ok, true)
  assert.equal(h.triggered.length, 1)
  assert.match(h.triggered[0], /^\/drive\/__aegis-download\/[0-9a-f]{32}$/)
  const res = h.responses[0]
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Type'), 'application/zip')
  assert.equal(res.headers.get('Content-Disposition'), `attachment; filename="AEGIS-Files-20261005-010203.zip"; filename*=UTF-8''AEGIS-Files-20261005-010203.zip`)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(res.headers.get('Content-Length'), '1000')
  const body = readAll(res)
  await opened.sink.write(data)
  await opened.sink.close()
  assert.deepEqual(await body, data)
})

test('WS-6b the attachment filename cannot inject header syntax or a path', () => {
  const v = attachmentDisposition('..\\a/b"c\r\nSet-Cookie: x;ไฟล์.zip')
  assert.doesNotMatch(v, /[\r\n]/)
  const ascii = /filename="([^"]*)"/.exec(v)[1]
  assert.doesNotMatch(ascii, /["\\/]/)
  assert.match(v, /^attachment; filename="[^"]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/)
  assert.equal(attachmentDisposition(''), `attachment; filename="download.zip"; filename*=UTF-8''download.zip`)
})

/* ── 7 / 8: order, close ───────────────────────────────────────── */

test('WS-7 bytes arrive in order, including writes larger than one port message', async () => {
  const limits = { ...DOWNLOAD_STREAM_LIMITS, maxMessageBytes: 4096, windowBytes: 8192, highWaterBytes: 16384 }
  const h = harness({ limits })
  const parts = [bytesOf(10, 1), bytesOf(0), bytesOf(10_000, 2), bytesOf(1, 3), bytesOf(70_000, 4)]
  const expected = concat(parts)
  const opened = await h.open({ totalBytes: expected.length })
  const body = readAll(h.responses[0])
  for (const p of parts) await opened.sink.write(p)
  await opened.sink.close()
  assert.deepEqual(await body, expected)
})

test('WS-7b a write never retains the caller buffer (the zip writer may reuse it)', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 4 })
  const body = readAll(h.responses[0])
  const buf = new Uint8Array([1, 2, 3, 4])
  await opened.sink.write(buf)
  buf.fill(9)
  assert.equal(buf.byteLength, 4, 'the caller buffer is not detached')
  await opened.sink.close()
  assert.deepEqual([...await body], [1, 2, 3, 4])
})

test('WS-8 close ends the stream and removes the session; the URL cannot be replayed', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 3 })
  const body = readAll(h.responses[0])
  await opened.sink.write(bytesOf(3))
  await opened.sink.close()
  assert.equal((await body).length, 3)
  assert.equal(h.state.sessionCount(), 0)
  assert.equal(h.fetch(h.triggered[0]).status, 404)
})

test('WS-8b close before the declared length errors the stream instead of ending it cleanly', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 10 })
  const body = outcome(readAll(h.responses[0]))
  await opened.sink.write(bytesOf(4))
  await assert.rejects(opened.sink.close())
  assert.ok((await body) instanceof Error)
  assert.equal(h.state.sessionCount(), 0)
})

test('WS-8c a write beyond the declared length errors the stream', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 2 })
  const body = outcome(readAll(h.responses[0]))
  await opened.sink.write(bytesOf(3)).catch(() => {})
  await settle()
  assert.ok((await body) instanceof Error)
  await assert.rejects(opened.sink.close())
})

/* ── 9 / 10: abort ─────────────────────────────────────────────── */

test('WS-9 abort errors the stream (never a clean end) and removes the session', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 100 })
  const body = readAll(h.responses[0])
  await opened.sink.write(bytesOf(10))
  await opened.sink.abort()
  await assert.rejects(body)
  await settle()
  assert.equal(h.state.sessionCount(), 0)
  assert.equal(h.removed, 1, 'the hidden frame is removed')
  await assert.rejects(opened.sink.write(bytesOf(1)))
  await assert.rejects(opened.sink.close())
  assert.equal(h.fetch(h.triggered[0]).status, 404)
})

test('WS-9b the page signal aborts an in-flight transfer even while a write waits for credit', async () => {
  const limits = { ...DOWNLOAD_STREAM_LIMITS, maxMessageBytes: 1024, windowBytes: 1024, highWaterBytes: 1024 }
  const h = harness({ limits })
  const ctrl = new AbortController()
  const opened = await h.open({ totalBytes: 1 * MiB, signal: ctrl.signal })
  const body = readAll(h.responses[0]).catch((e) => e)
  // nobody reads fast enough → this write blocks on credit; reading has started so the body is consumed
  const write = opened.sink.write(bytesOf(64 * 1024))
  ctrl.abort()
  await assert.rejects(write)
  assert.ok((await body) instanceof Error)
  await settle()
  assert.equal(h.state.sessionCount(), 0)
})

test('WS-9c the browser cancelling the download fails the next write', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 100 })
  await h.responses[0].body.cancel('user cancelled in the download bar')
  await settle()
  await assert.rejects(opened.sink.write(bytesOf(10)))
  assert.equal(h.state.sessionCount(), 0)
})

/* ── 11: bounded backpressure ──────────────────────────────────── */

test('WS-11 a producer that is not read cannot queue more than highWater + window in the worker', async () => {
  const limits = { ...DOWNLOAD_STREAM_LIMITS, highWaterBytes: 64 * 1024, windowBytes: 32 * 1024, maxMessageBytes: 16 * 1024 }
  const h = harness({ limits })
  const total = 4 * MiB
  const opened = await h.open({ totalBytes: total })
  const token = h.triggered[0].split('/').pop()
  let written = 0
  const producer = (async () => {
    while (written < total) {
      await opened.sink.write(bytesOf(16 * 1024, written))
      written += 16 * 1024
    }
  })()
  await settle(200)
  assert.ok(await isPending(producer), 'the producer is held back')
  assert.ok(written < 256 * 1024, `producer stopped early (wrote ${written})`)
  const queued = h.state.queuedBytes(token)
  assert.ok(queued > 0 && queued <= limits.highWaterBytes + limits.windowBytes, `queued ${queued}`)
  // a reader appears: credit flows again and everything arrives in order
  const body = readAll(h.responses[0])
  await producer
  await opened.sink.close()
  assert.equal(written, total)
  const got = await body
  assert.equal(got.length, total)
  assert.deepEqual(got.subarray(16 * 1024, 32 * 1024), bytesOf(16 * 1024, 16 * 1024))
})

test('WS-11b a producer that ignores credit is cut off as a protocol violation', async () => {
  const limits = { ...DOWNLOAD_STREAM_LIMITS, highWaterBytes: 4096, windowBytes: 4096, maxMessageBytes: 4096 }
  const state = createDownloadStreamWorkerState({ limits })
  const channel = new MessageChannel()
  const seen = []
  channel.port1.onmessage = (e) => seen.push(e.data)
  handleDownloadStreamMessage(state, { type: DOWNLOAD_STREAM_MESSAGE.OPEN, token: TOKEN, filename: 'a.zip', totalBytes: 1 * MiB, source: 'files' }, [channel.port2], () => {})
  const res = handleDownloadStreamFetch(state, new Request(`${ORIGIN}/drive/__aegis-download/${TOKEN}`), { origin: ORIGIN, scopePath: SCOPE })
  for (let i = 0; i < 20; i += 1) {
    const b = bytesOf(4096, i)
    channel.port1.postMessage({ type: 'chunk', bytes: b.buffer }, [b.buffer])
  }
  await settle()
  assert.ok(seen.some((m) => m.type === 'failed' && m.reason === 'protocol'), JSON.stringify(seen))
  assert.equal(state.sessionCount(), 0)
  await assert.rejects(readAll(res))
  channel.port1.close()
})

/* ── 13: worker restart / lost session ─────────────────────────── */

test('WS-13 a worker that lost its memory before the navigation fails the open closed', async () => {
  const h = harness()
  const fresh = createDownloadStreamWorkerState()
  const navigate = h.trigger
  h.trigger = (url) => { h.state = fresh; return navigate(url) } // restart between "opened" and the hidden navigation
  const res = await h.open({ totalBytes: 10 })
  assert.deepEqual(res, { ok: false, reason: 'stream-unavailable' })
  assert.equal(h.responses[0].status, 404)
  assert.equal(h.removed, 1)
})

test('WS-13b a worker restart mid-stream is detected by the keepalive and fails the next write', async () => {
  const h = harness()
  const opened = await h.open({ totalBytes: 1 * MiB, keepaliveMs: 10, keepaliveTimeoutMs: 200 })
  readAll(h.responses[0]).catch(() => {})
  await opened.sink.write(bytesOf(10))
  h.state = createDownloadStreamWorkerState() // the old session is gone with the old worker
  await new Promise((r) => setTimeout(r, 60))
  await assert.rejects(opened.sink.write(bytesOf(10)))
  await assert.rejects(opened.sink.close())
})

test('WS-13c a worker that never answers the open fails within the start deadline', async () => {
  const h = harness()
  h.controller = { postMessage() { /* dead worker */ } }
  const res = await h.open({ totalBytes: 1, startTimeoutMs: 30 })
  assert.deepEqual(res, { ok: false, reason: 'stream-unavailable' })
  assert.equal(h.triggered.length, 0, 'no navigation without an opened session')
})

test('WS-13d no worker controller → stream-unavailable without touching the page', async () => {
  const h = harness()
  const res = await h.open({ ensureWorker: async () => ({ ok: false, reason: 'unsupported-browser' }) })
  assert.deepEqual(res, { ok: false, reason: 'stream-unavailable' })
  assert.equal(h.triggered.length, 0)
})

/* ── lifecycle ─────────────────────────────────────────────────── */

test('WS-14 a pending session that is never fetched expires', async () => {
  const limits = { ...DOWNLOAD_STREAM_LIMITS, pendingTtlMs: 20 }
  const h = harness({ limits, respondOnTrigger: false })
  const res = await h.open({ totalBytes: 1, startTimeoutMs: 200 })
  assert.equal(res.ok, false)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(h.state.sessionCount(), 0)
})

test('WS-15 closeAll({ source: "vault" }) errors only Vault downloads', async () => {
  const h = harness()
  const files = await h.open({ totalBytes: 10, source: 'files' })
  const vault = await h.open({ totalBytes: 10, source: 'vault', filename: 'AEGIS-Vault-export-x.zip' })
  const filesBody = readAll(h.responses[0])
  const vaultBody = outcome(readAll(h.responses[1]))
  h.state.closeAll({ source: 'vault' })
  assert.ok((await vaultBody) instanceof Error)
  await settle()
  await assert.rejects(vault.sink.write(bytesOf(1)))
  await files.sink.write(bytesOf(10))
  await files.sink.close()
  assert.equal((await filesBody).length, 10)
})

test('WS-16 the session count is bounded', async () => {
  const limits = { ...DOWNLOAD_STREAM_LIMITS, maxSessions: 1 }
  const h = harness({ limits })
  const a = await h.open({ totalBytes: 1 })
  assert.equal(a.ok, true)
  const b = await h.open({ totalBytes: 1 })
  assert.deepEqual(b, { ok: false, reason: 'stream-unavailable' })
  await a.sink.abort()
})

test('WS-17 keepalive answers report whether the exact token is alive', async () => {
  const h = harness()
  const replies = []
  handleDownloadStreamMessage(h.state, { type: DOWNLOAD_STREAM_MESSAGE.KEEPALIVE, token: TOKEN }, [], (p) => replies.push(p))
  assert.deepEqual(replies, [{ ok: true, has: false }])
  assert.equal(handleDownloadStreamMessage(h.state, { type: 'vault-preview-open' }, [], () => {}), false, 'other messages are not ours')
})

/* ── capability ────────────────────────────────────────────────── */

test('WS-18 capability: secure context + service worker + streams + MessageChannel + document', () => {
  const ok = { isSecureContext: true, navigator: { serviceWorker: {} }, ReadableStream, MessageChannel, document: { body: {} } }
  assert.equal(supportsWorkerStreamDownload(ok), true)
  assert.equal(supportsWorkerStreamDownload({ ...ok, isSecureContext: false }), false)
  assert.equal(supportsWorkerStreamDownload({ ...ok, isSecureContext: undefined }), false)
  assert.equal(supportsWorkerStreamDownload({ ...ok, navigator: {} }), false)
  assert.equal(supportsWorkerStreamDownload({ ...ok, ReadableStream: undefined }), false)
  assert.equal(supportsWorkerStreamDownload({ ...ok, MessageChannel: undefined }), false)
  assert.equal(supportsWorkerStreamDownload({ ...ok, document: undefined }), false)
  assert.equal(supportsWorkerStreamDownload(null), false)
})
