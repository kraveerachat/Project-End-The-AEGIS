// tests/apiFetchStream.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 4
//
// spec §9/§10: Normal Files ZIP entries must never be buffered whole (apiFetchBytes reads the full body
// with arrayBuffer()). apiFetchStream returns the response body unread, same-origin with the session
// cookie, maps errors like apiFetchBytes, and owns no timeout — the Files source owns the idle timer.
import test from 'node:test'
import assert from 'node:assert/strict'

import { apiFetchStream, registerUnauthorizedHandler } from '../src/lib/api.js'

function streamResponse(status = 200, { body = 'abc', headers = { 'Content-Length': '3' } } = {}) {
  const stream = body === null ? null : new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(body)); c.close() },
  })
  return new Response(stream, { status, headers })
}

test('AFS-1 returns ok, status, headers and the unread body; never calls arrayBuffer()', async (t) => {
  const res = streamResponse(200)
  const ab = t.mock.method(res, 'arrayBuffer')
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => res)
  const out = await apiFetchStream('/api/files/f1/download')
  assert.equal(out.ok, true)
  assert.equal(out.status, 200)
  assert.equal(out.errorKind, null)
  assert.equal(out.headers.get('Content-Length'), '3')
  assert.equal(out.body, res.body)
  assert.equal(res.bodyUsed, false)
  assert.equal(ab.mock.callCount(), 0)
  const [url, init] = fetchMock.mock.calls[0].arguments
  assert.ok(String(url).endsWith('api/files/f1/download'))
  assert.equal(init.credentials, 'include')
})

test('AFS-2 the caller signal is passed through; an abort maps to network', async (t) => {
  const ctrl = new AbortController()
  const fetchMock = t.mock.method(globalThis, 'fetch', (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  const pending = apiFetchStream('/api/files/f1/download', { signal: ctrl.signal })
  assert.equal(fetchMock.mock.calls[0].arguments[1].signal, ctrl.signal)
  ctrl.abort()
  const out = await pending
  assert.equal(out.ok, false)
  assert.equal(out.errorKind, 'network')
  assert.equal(out.body, null)
})

test('AFS-3 401 maps to unauthorized and calls the registered handler', async (t) => {
  let called = 0
  registerUnauthorizedHandler(() => { called += 1 })
  t.after(() => registerUnauthorizedHandler(null))
  t.mock.method(globalThis, 'fetch', async () => streamResponse(401))
  const out = await apiFetchStream('/api/files/f1/download')
  assert.equal(out.ok, false)
  assert.equal(out.status, 401)
  assert.equal(out.errorKind, 'unauthorized')
  assert.equal(out.body, null)
  assert.equal(called, 1)
})

test('AFS-4 403 forbidden, 500 server, thrown fetch network', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamResponse(403))
  assert.equal((await apiFetchStream('/x')).errorKind, 'forbidden')
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => streamResponse(500))
  const s = await apiFetchStream('/x')
  assert.equal(s.errorKind, 'server')
  assert.equal(s.status, 500)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('failed to fetch') })
  const n = await apiFetchStream('/x')
  assert.equal(n.errorKind, 'network')
  assert.equal(n.status, 0)
})

test('AFS-5 no internal timeout: a response 10 minutes later still succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolveFetch
  let seenSignal
  t.mock.method(globalThis, 'fetch', (url, init) => {
    seenSignal = init.signal
    return new Promise((r) => { resolveFetch = r })
  })
  let settled = false
  const pending = apiFetchStream('/x').then((v) => { settled = true; return v })
  t.mock.timers.tick(10 * 60_000)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(seenSignal, undefined, 'no internal controller is created')
  resolveFetch(streamResponse(200))
  const out = await pending
  assert.equal(out.ok, true)
})

test('AFS-6 a null body is returned as-is for the source layer to reject', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamResponse(200, { body: null }))
  const out = await apiFetchStream('/x')
  assert.equal(out.ok, true)
  assert.equal(out.body, null)
})
